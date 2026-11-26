(() => {
	'use strict';

	// Diagnostics. Every line starts with "[Claude Counter Rebuilt]". Nothing here ever receives a
	// cookie, a token, message text or a full organisation id (ids are shortened to 8 characters).
	//
	// To see them: open DevTools on claude.ai, Console, and filter on "Claude Counter Rebuilt".
	// Noisy codes use console.debug: enable the "Verbose" level to see those.

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	const PREFIX = '[Claude Counter Rebuilt]';
	const MAX_ENTRIES = 60;

	// code -> [console method, plain-language meaning]
	const CODES = {
		INIT: ['info', 'extension started'],
		BRIDGE_READY: ['debug', 'page-world bridge is running'],
		BRIDGE_MISSING: ['warn', 'page-world bridge did not start: no usage events can be read'],
		INTERFACE_OLD: ['info', 'old interface: /completion event-stream detected'],
		INTERFACE_NEW: ['info', 'new interface: StreamTimeline Connect stream detected'],
		SSE_LIMIT_EVENT: ['debug', 'message_limit SSE event received'],
		PROTOBUF_LIMITS: ['debug', 'protobuf limits frame parsed'],
		LIMIT_REPLAY_IGNORED: ['debug', 'replayed event ignored (same event id)'],
		GUNZIP_FAILED: ['warn', 'compressed frame could not be unpacked'],
		STREAM_UNPARSEABLE: ['warn', 'protobuf parsing failed: bytes arrived but no Connect frame was readable'],
		STREAM_DONE: ['debug', 'stream finished'],
		STREAM_READ_ENDED: ['debug', 'stream ended or was aborted (normal)'],
		USAGE_EVENT: ['info', 'usage event received'],
		SESSION_EXTRACTED: ['info', 'five-hour usage and reset time extracted'],
		NO_SESSION_WINDOW: ['warn', 'event had no five-hour (5h) window: nothing shown (never 0%)'],
		MISSING_UTILIZATION: ['warn', 'five-hour window had no usable utilization value: ignored'],
		MISSING_RESET: ['warn', 'five-hour window has no reset timestamp: "Reset time unavailable"'],
		EVENT_IGNORED: ['debug', 'usage event ignored'],
		USAGE_SAVED: ['debug', 'usage saved for this organisation'],
		USAGE_RESTORED: ['info', 'usage restored from saved data'],
		USAGE_SYNCED: ['debug', 'usage updated from another tab'],
		ORG_RESOLVED: ['info', 'organisation id resolved'],
		ORG_CHANGED: ['info', 'organisation changed: usage state reset'],
		ORG_UNRESOLVED: ['warn', 'organisation id could not be resolved'],
		USAGE_REQUEST: ['debug', '/usage requested'],
		USAGE_EMPTY: ['info', '/usage answered without a five-hour window (normal on the free plan)'],
		USAGE_OK: ['info', '/usage answered with a five-hour window'],
		USAGE_FAILED: ['warn', 'network request failed'],
		REFRESH_TRIGGERED: ['info', 'refresh triggered'],
		WINDOW_EXPIRED: ['info', 'session window ended'],
		DASHBOARD_MOUNTED: ['info', 'dashboard mounted'],
		DASHBOARD_REATTACHED: ['info', 'dashboard re-attached after the page replaced its DOM'],
		UI_MOUNT_FAILED: ['warn', 'UI mounting failed: no composer found to attach the dashboard to']
	};

	const entries = [];
	const state = {
		interface: null, // 'old' | 'new' | null
		bridgeReady: false,
		eventsReceived: 0,
		lastEventAt: null,
		lastProblem: null // last warning code
	};
	let sink = null; // tests can capture lines

	function shortId(id) {
		return typeof id === 'string' ? `${id.slice(0, 8)}…` : String(id);
	}

	function log(code, detail) {
		const meta = CODES[code] || ['debug', code];
		const [level, meaning] = meta;
		const text = detail === undefined || detail === null || detail === '' ? meaning : `${meaning} (${detail})`;
		entries.push({ at: Date.now(), code, level, text });
		if (entries.length > MAX_ENTRIES) entries.shift();
		if (level === 'warn') state.lastProblem = code;
		if (code === 'INTERFACE_OLD') state.interface = 'old';
		if (code === 'INTERFACE_NEW') state.interface = 'new';
		if (code === 'BRIDGE_READY') state.bridgeReady = true;
		if (sink) sink(level, `${PREFIX} ${code}: ${text}`);
		else {
			try {
				console[level](`${PREFIX} ${code}: ${text}`);
			} catch {
				// no console: nothing to do
			}
		}
	}

	/** One line for the dashboard tooltip. */
	function summary() {
		const parts = [];
		parts.push(`interface: ${state.interface || 'not detected yet'}`);
		parts.push(`usage events: ${state.eventsReceived}`);
		if (state.lastProblem) parts.push(`last problem: ${state.lastProblem}`);
		return parts.join(' · ');
	}

	CC.diag = {
		PREFIX,
		CODES,
		state,
		entries,
		log,
		summary,
		shortId,
		setSink(fn) {
			sink = fn;
		}
	};
})();
