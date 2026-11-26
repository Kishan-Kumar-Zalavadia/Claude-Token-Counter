'use strict';

// End-to-end harness. The REAL files run together:
//   src/injected/bridge.js            (page world, wraps fetch)       -> createBridgeEnv()
//   src/content/{constants,diag,usage-core,bridge-client,ui,main}.js  -> one vm context, fake DOM
// The two worlds are joined with a message bus that behaves like window.postMessage, the fake
// Claude "server" answers fetches (streams and /usage), and a manual clock drives Date and timers.
// Nothing here is a copy of the logic under test.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createFakeDom } = require('./fake-dom');
const { createClock } = require('./fake-clock');
const { createFakeChrome } = require('./fake-chrome');
const { createBridgeEnv, streamResponse, readAll, settle, STREAM_URL } = require('./bridge-harness');

const SRC = path.join(__dirname, '../../src');
const CONTENT_FILES = ['content/constants.js', 'content/diag.js', 'content/usage-core.js', 'content/bridge-client.js', 'content/ui.js', 'content/main.js'];

const ORG = 'fda3f0e1-4fb4-4c97-97f9-c2274f34ec6d';
const OTHER_ORG = '0b6a1f52-2d7e-4c11-9a6b-5f1d2c3e4a99';
const CONV = 'd017d8c7-6458-4449-884f-64980589c699';

// 1791749400 is the reset time of the recorded frames (2026-10-11T20:10:00Z).
const FIXTURE_RESET_MS = 1791749400 * 1000;

function createE2E({
	startMs = FIXTURE_RESET_MS - (4 * 3600 + 32 * 60 + 18) * 1000, // 04h 32m 18s before the recorded reset
	storage = {},
	cookie = `lastActiveOrg=${ORG}`,
	pathname = `/chat/${CONV}`,
	withComposer = true,
	usage = { status: 200, body: {} }, // what GET /usage answers
	contentFetch = null,
	load = true
} = {}) {
	const dom = createFakeDom();
	const clock = createClock(startMs);
	const fake = createFakeChrome(storage);
	const logs = [];
	const server = { usage: { ...usage }, usageRequests: [], streams: [], organizations: null, openResponses: [] };

	// ---- page world -----------------------------------------------------------------------------
	const bridge = createBridgeEnv({
		originalFetch: async (url, opts = {}) => {
			if (/\/usage$/.test(String(url))) {
				server.usageRequests.push({ at: clock.now, url: String(url) });
				return new Response(JSON.stringify(server.usage.body), { status: server.usage.status, headers: { 'content-type': 'application/json' } });
			}
			if (server.openResponses.length) return server.openResponses.shift();
			if (String(url).includes('StreamTimeline')) {
				const next = server.streams.shift();
				return streamResponse(next ? next.chunks : [], { contentType: next?.contentType || 'application/connect+proto' });
			}
			if (String(url).includes('/completion')) {
				const next = server.streams.shift();
				return streamResponse(next ? next.chunks : [], { contentType: next?.contentType || 'text/event-stream; charset=utf-8' });
			}
			return new Response('{}', { headers: { 'content-type': 'application/json' } });
		}
	});

	// ---- content world --------------------------------------------------------------------------
	const listeners = {};
	const window = {
		location: { pathname },
		innerWidth: 1280,
		innerHeight: 800,
		addEventListener(type, fn) {
			(listeners[type] = listeners[type] || []).push(fn);
		},
		removeEventListener(type, fn) {
			listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
		},
		dispatchEvent(event) {
			for (const fn of listeners[event.type] || []) fn(event);
		},
		// content script -> page world (requests) and to itself (bridge-client listens on the same window)
		postMessage(data) {
			setImmediate(() => {
				for (const fn of listeners.message || []) fn({ source: window, data });
				if (data && data.type === 'cc:request') bridge.window.postMessage(data);
			});
		}
	};

	// page world -> content script
	const bridgePost = bridge.window.postMessage.bind(bridge.window);
	bridge.window.postMessage = (data, ...rest) => {
		bridgePost(data, ...rest);
		setImmediate(() => {
			for (const fn of listeners.message || []) fn({ source: window, data });
		});
	};
	dom.document.documentElement.dataset.ccBridgeReady = bridge.documentElement.dataset.ccBridgeReady;
	dom.document.cookie = cookie;

	const consoleSpy = {};
	for (const level of ['log', 'info', 'debug', 'warn', 'error']) consoleSpy[level] = (...args) => logs.push({ level, text: args.join(' ') });

	const context = vm.createContext({
		window,
		document: dom.document,
		location: window.location,
		navigator: { userAgent: 'test-agent' },
		chrome: fake.chrome,
		console: consoleSpy,
		MutationObserver: dom.MutationObserver,
		Date: clock.Date,
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		setInterval: clock.setInterval,
		clearInterval: clock.clearInterval,
		Math,
		JSON,
		Object,
		Array,
		Number,
		String,
		Promise,
		Set,
		Map,
		Error,
		RegExp,
		Intl,
		encodeURIComponent,
		decodeURIComponent,
		fetch:
			contentFetch ||
			(async (url) => {
				if (String(url).endsWith('/api/organizations') && server.organizations) {
					return new Response(JSON.stringify(server.organizations), { status: 200 });
				}
				throw new Error('content-script fetch not available in test');
			})
	});
	context.globalThis = context;

	function loadContent() {
		for (const file of CONTENT_FILES) {
			vm.runInContext(fs.readFileSync(path.join(SRC, file), 'utf8'), context, { filename: file });
		}
	}

	const env = {
		dom,
		clock,
		server,
		bridge,
		window,
		context,
		logs,
		chrome: fake.chrome,
		storage: fake.data,
		get CC() {
			return context.ClaudeCounter;
		},
		loadContent,
		composer: withComposer ? dom.buildComposer() : null,

		/** Claude replies: the stream the page would read. Returns the bytes the page itself received. */
		async reply(chunks, { url = STREAM_URL, contentType } = {}) {
			server.streams.push({ chunks, contentType });
			const response = await bridge.fetch(url, { method: 'POST', body: new Uint8Array([0, 0, 0, 0, 0]) });
			const bytes = await readAll(response);
			await settle(25);
			await clock.flush();
			return bytes;
		},

		/** A request the page makes to an API url (this is what reveals the organisation id). */
		async pageRequest(url) {
			await bridge.fetch(url, { method: 'GET' });
			await settle(10);
			await clock.flush();
		},

		/**
		 * The person sends a message: a POST the page makes. `open: true` keeps the reply streaming
		 * until close() so the "reply in progress" state can be looked at.
		 */
		async send(url, { open = false, contentType = 'text/event-stream; charset=utf-8', method = 'POST' } = {}) {
			let controller;
			if (open) {
				const body = new ReadableStream({ start: (c) => (controller = c) });
				server.openResponses.push(new Response(body, { status: 200, headers: { 'content-type': contentType } }));
			}
			const response = await bridge.fetch(url, { method, body: '{}' });
			await settle(10);
			await clock.flush();
			return {
				response,
				push: (chunk) => controller.enqueue(new Uint8Array(chunk)),
				async close() {
					controller.close();
					await settle(25);
					await clock.flush();
				}
			};
		},

		async advance(ms) {
			await clock.advance(ms);
		},
		async flush() {
			await settle(15);
			await clock.flush();
		},

		navigate(pathName) {
			window.location.pathname = pathName;
			window.dispatchEvent({ type: 'cc:urlchange' });
		},

		dashboards: () => dom.document.querySelectorAll('[data-ccr="dashboard"]'),
		dashboard() {
			return dom.document.querySelector('[data-ccr="dashboard"]');
		},
		text(selector) {
			const root = env.dashboard();
			const node = root && root.querySelector(selector);
			return node ? node.textContent : null;
		},
		/** All the text the person can see in the dashboard (hidden rows excluded). */
		visibleText() {
			const root = env.dashboard();
			if (!root) return '';
			const out = [];
			const walk = (node) => {
				for (const child of node.children) {
					if (child.nodeType !== 1) continue;
					if (child.classList.contains('ccr-hidden')) continue;
					if (child.children.length === 0 && child.textContent) out.push(child.textContent);
					walk(child);
				}
			};
			walk(root);
			return out.join(' | ');
		},
		savedFor: (orgId) => fake.data[`ccr_usage_v1_${orgId}`],
		diagLines: (code) => logs.filter((l) => l.text.includes(`[Claude Counter Rebuilt] ${code}:`))
	};

	if (load) loadContent();
	return env;
}

module.exports = { createE2E, ORG, OTHER_ORG, CONV, FIXTURE_RESET_MS };
