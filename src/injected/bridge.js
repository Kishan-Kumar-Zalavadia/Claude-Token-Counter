(() => {
	'use strict';

	// Claude Counter Rebuilt: page-world bridge (runs in the MAIN world at document_start).
	//
	// Derived from claude-counter (MIT) and its PR #60 (new unified interface support).
	// Reads Claude's own usage-limit data from a CLONE of the page's responses and hands it to the
	// content script with window.postMessage. The page's own response is never read, locked or
	// modified; every failure here is swallowed so claude.ai keeps working.
	//
	//   old interface  POST .../completion          text/event-stream   `message_limit` SSE events
	//   new interface  POST .../ConversationService/StreamTimeline   application/connect+proto
	//
	// Messages posted (all carry { cc: 'ClaudeCounter' }):
	//   cc:message_limit  { windows: { '5h': {status, resets_at, utilization}, '7d': ... } }
	//   cc:org_detected   { orgId }
	//   cc:urlchange      (a window CustomEvent, SPA navigation)
	//   cc:diag           { code, detail }   diagnostics only, never credentials or message text
	//   cc:bridge_ready   {}
	//   cc:response       answer to a cc:request of kind 'usage'

	const CC_MARKER = 'ClaudeCounter';
	const RPC_STREAM_TIMELINE = 'ConversationService/StreamTimeline';
	const MAX_CONNECT_FRAME_BYTES = 4 * 1024 * 1024;
	const MAX_GUNZIP_BYTES = 4 * 1024 * 1024;

	if (window.__ccBridgeInstalled) return;
	window.__ccBridgeInstalled = true;

	// Capture original fetch before anyone else can wrap it
	const originalFetch = window.fetch;

	function post(type, payload) {
		window.postMessage({ cc: CC_MARKER, type, payload }, '*');
	}

	function diag(code, detail) {
		try {
			post('cc:diag', { code, detail: detail === undefined ? null : detail });
		} catch {
			// diagnostics must never break anything
		}
	}

	// Wrap history methods early to detect SPA navigation (before frameworks cache them)
	const originalPushState = history.pushState.bind(history);
	const originalReplaceState = history.replaceState.bind(history);

	history.pushState = function (...args) {
		const result = originalPushState(...args);
		window.dispatchEvent(new CustomEvent('cc:urlchange'));
		return result;
	};

	history.replaceState = function (...args) {
		const result = originalReplaceState(...args);
		window.dispatchEvent(new CustomEvent('cc:urlchange'));
		return result;
	};

	let announcedOld = false;
	let announcedNew = false;
	let lastOrgId = null;

	window.fetch = async (...args) => {
		const url = toAbsoluteUrl(args[0]);

		// The organisation id the page itself is using: the most reliable account identifier.
		const orgMatch = url && url.match(/^https:\/\/claude\.ai\/api\/organizations\/([^/?]+)/);
		if (orgMatch && orgMatch[1] && orgMatch[1] !== lastOrgId) {
			lastOrgId = orgMatch[1];
			post('cc:org_detected', { orgId: lastOrgId });
		}

		// A message is being sent. Only a notice: nothing about the request is read or changed.
		//   old interface: POST .../completion        (certain: the reply streams on this very request)
		//   new interface: POST .../PerformAction     (also fires when a chat is opened: treated as a hint)
		try {
			const method = String((args[1] && args[1].method) || (typeof Request !== 'undefined' && args[0] instanceof Request ? args[0].method : 'GET')).toUpperCase();
			if (method === 'POST' && url) {
				if (/\/(retry_)?completion(\?|$)/.test(url)) post('cc:reply_start', { kind: 'old' });
				else if (url.includes('ConversationService/PerformAction')) post('cc:reply_start', { kind: 'new' });
			}
		} catch {
			// never break the page
		}

		const response = await originalFetch.apply(window, args);

		try {
			const contentType = response.headers.get('content-type') || '';
			if (contentType.includes('event-stream')) {
				if (!announcedOld && url && url.includes('/completion')) {
					announcedOld = true;
					diag('INTERFACE_OLD');
				}
				handleEventStream(response);
			}

			// New interface: Connect stream carrying the same limit data in protobuf frames.
			if (url && url.includes(RPC_STREAM_TIMELINE)) {
				if (!announcedNew) {
					announcedNew = true;
					diag('INTERFACE_NEW');
				}
				handleConnectStream(response);
			}
		} catch {
			// never break the page
		}

		return response;
	};

	function toAbsoluteUrl(input) {
		if (typeof input === 'string') {
			if (input.startsWith('/')) return `https://claude.ai${input}`;
			return input;
		}
		if (input instanceof URL) return input.href;
		if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
		return '';
	}

	// Old interface: SSE lines "data: {json}"; the `message_limit` event carries the windows.
	async function handleEventStream(response) {
		try {
			const cloned = response.clone();
			const reader = cloned.body?.getReader?.();
			if (!reader) return;
			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				// A line that never ends would grow without bound: drop it.
				if (buffer.length > MAX_CONNECT_FRAME_BYTES) buffer = '';
				const lines = buffer.split(/\r\n|\r|\n/);
				buffer = lines.pop() || '';
				for (const line of lines) {
					if (!line.startsWith('data:')) continue;
					const raw = line.slice(5).trim();
					if (!raw) continue;
					try {
						const json = JSON.parse(raw);
						if (json?.type === 'message_limit' && json.message_limit) {
							diag('SSE_LIMIT_EVENT');
							post('cc:message_limit', json.message_limit);
						}
					} catch {
						// not JSON: ignore
					}
				}
			}
		} catch {
			// best-effort; aborted streams are normal
		}
		post('cc:stream_end', { kind: 'sse' });
	}

	// ---------------------------------------------------------------------------------------------
	// New interface: Connect stream (StreamTimeline)
	//
	// Frame: flags(1) | length(4, big-endian) | payload.
	//   flags 0x00 plain protobuf, 0x01 gzip-compressed protobuf, 0x02 end of stream (JSON trailer).
	// The limits arrive once per assistant turn in a plain frame. Everything here is best-effort:
	// the page's own response is never consumed (we read response.clone()) and errors are swallowed.
	// ---------------------------------------------------------------------------------------------
	const utf8 = new TextDecoder('utf-8');

	function createConnectParser(onFrame) {
		let buffer = new Uint8Array(0);
		let broken = false;

		return {
			push(chunk) {
				if (broken || !chunk || !chunk.length) return;
				if (buffer.length === 0) {
					buffer = chunk;
				} else {
					const merged = new Uint8Array(buffer.length + chunk.length);
					merged.set(buffer, 0);
					merged.set(chunk, buffer.length);
					buffer = merged;
				}

				while (buffer.length >= 5) {
					const flags = buffer[0];
					const length = ((buffer[1] << 24) | (buffer[2] << 16) | (buffer[3] << 8) | buffer[4]) >>> 0;
					if (length > MAX_CONNECT_FRAME_BYTES) {
						// Not a stream we understand; stop parsing it instead of buffering forever.
						broken = true;
						buffer = new Uint8Array(0);
						return;
					}
					if (buffer.length < 5 + length) break;
					const payload = buffer.slice(5, 5 + length);
					buffer = buffer.subarray(5 + length);
					try {
						onFrame(flags, payload);
					} catch {
						// ignore
					}
				}
			}
		};
	}

	// Minimal protobuf wire reader. Returns [{ num, wire, value }]; value is a Number (varint),
	// or the raw bytes (fixed64 / length-delimited / fixed32). Throws on malformed input.
	function readVarint(bytes, pos) {
		let result = 0;
		let multiplier = 1;
		for (let i = 0; i < 10; i++) {
			if (pos.i >= bytes.length) throw new Error('truncated varint');
			const b = bytes[pos.i++];
			result += (b & 0x7f) * multiplier;
			if (!(b & 0x80)) return result;
			multiplier *= 128;
		}
		throw new Error('varint too long');
	}

	function readFields(bytes) {
		const pos = { i: 0 };
		const fields = [];
		while (pos.i < bytes.length) {
			const tag = readVarint(bytes, pos);
			const num = Math.floor(tag / 8);
			const wire = tag % 8;
			if (num < 1) throw new Error('bad field number');
			if (wire === 0) {
				fields.push({ num, wire, value: readVarint(bytes, pos) });
			} else if (wire === 1) {
				if (pos.i + 8 > bytes.length) throw new Error('truncated fixed64');
				fields.push({ num, wire, value: bytes.subarray(pos.i, pos.i + 8) });
				pos.i += 8;
			} else if (wire === 2) {
				const length = readVarint(bytes, pos);
				if (pos.i + length > bytes.length) throw new Error('truncated field');
				fields.push({ num, wire, value: bytes.subarray(pos.i, pos.i + length) });
				pos.i += length;
			} else if (wire === 5) {
				if (pos.i + 4 > bytes.length) throw new Error('truncated fixed32');
				fields.push({ num, wire, value: bytes.subarray(pos.i, pos.i + 4) });
				pos.i += 4;
			} else {
				throw new Error('unsupported wire type');
			}
		}
		return fields;
	}

	function firstField(fields, num, wire) {
		return fields.find((f) => f.num === num && f.wire === wire) || null;
	}

	function doubleOf(bytes) {
		return new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);
	}

	// One window entry: { 1: key ("5h" | "7d"), 2: { 1: status, 2: { 1: resets_at }, 3: utilization } }
	function readWindowEntry(bytes, { strictKeys }) {
		const fields = readFields(bytes);
		const keyField = firstField(fields, 1, 2);
		const valueField = firstField(fields, 2, 2);
		if (!keyField || !valueField) return null;

		const key = utf8.decode(keyField.value);
		if (strictKeys ? key !== '5h' && key !== '7d' : !/^[0-9a-z_]{1,16}$/i.test(key)) return null;

		const value = readFields(valueField.value);
		const utilizationField = firstField(value, 3, 1);
		let utilization;
		if (utilizationField) {
			utilization = doubleOf(utilizationField.value);
		} else if (!strictKeys && (firstField(value, 1, 0) || firstField(value, 2, 2))) {
			// protobuf leaves out a double that is 0, so an entry with a status or reset time but no
			// double is a window with nothing used
			utilization = 0;
		} else {
			return null;
		}
		if (!Number.isFinite(utilization)) return null;
		if (strictKeys && (utilization < 0 || utilization > 10)) return null;

		const statusField = firstField(value, 1, 0);
		const resetsField = firstField(value, 2, 2);
		let resetsAt = null;
		if (resetsField) {
			const inner = firstField(readFields(resetsField.value), 1, 0);
			if (inner) resetsAt = inner.value;
		}

		return { key, window: { status: statusField ? statusField.value : null, resets_at: resetsAt, utilization } };
	}

	// Limits message -> same shape as the SSE `message_limit` object (windows keyed by "5h" / "7d",
	// utilization as a fraction, resets_at in epoch seconds), so the content script needs no change.
	function readLimitsMessage(bytes, { windowField, strictKeys }) {
		const fields = readFields(bytes);
		const windows = {};
		for (const field of fields) {
			if (field.wire !== 2) continue;
			if (windowField !== null && field.num !== windowField) continue;
			let entry = null;
			try {
				entry = readWindowEntry(field.value, { strictKeys });
			} catch {
				entry = null;
			}
			if (entry) windows[entry.key] = entry.window;
		}
		if (Object.keys(windows).length === 0) return null;

		const result = { windows };
		const claim = firstField(fields, 9, 2);
		if (claim) result.representativeClaim = utf8.decode(claim.value);
		const overage = firstField(fields, 6, 2);
		if (overage) result.overageDisabledReason = utf8.decode(overage.value);
		return result;
	}

	// Primary: follow the field numbers seen in captures: frame { 1: event { 4: limits { 13: window... } } }.
	function extractLimitsStructured(payload) {
		for (const top of readFields(payload)) {
			if (top.num !== 1 || top.wire !== 2) continue;
			for (const eventField of readFields(top.value)) {
				if (eventField.num !== 4 || eventField.wire !== 2) continue;
				const limits = readLimitsMessage(eventField.value, { windowField: 13, strictKeys: false });
				if (limits) return limits;
			}
		}
		return null;
	}

	function containsAscii(bytes, text) {
		outer: for (let i = 0; i + text.length <= bytes.length; i++) {
			for (let j = 0; j < text.length; j++) {
				if (bytes[i + j] !== text.charCodeAt(j)) continue outer;
			}
			return true;
		}
		return false;
	}

	// Fallback if the field numbers ever change (the API is v1alpha): look for window entries keyed
	// "5h" / "7d" anywhere in the message tree.
	function scanForLimits(bytes, depth) {
		if (depth > 6) return null;
		let fields;
		try {
			fields = readFields(bytes);
		} catch {
			return null;
		}
		const limits = readLimitsMessageSafe(bytes);
		if (limits) return limits;
		for (const field of fields) {
			if (field.wire !== 2 || field.value.length < 4) continue;
			const nested = scanForLimits(field.value, depth + 1);
			if (nested) return nested;
		}
		return null;
	}

	function readLimitsMessageSafe(bytes) {
		try {
			return readLimitsMessage(bytes, { windowField: null, strictKeys: true });
		} catch {
			return null;
		}
	}

	function extractLimits(payload) {
		try {
			const structured = extractLimitsStructured(payload);
			if (structured) return structured;
		} catch {
			// fall through to the heuristic
		}
		if (containsAscii(payload, '5h') || containsAscii(payload, '7d')) {
			return scanForLimits(payload, 0);
		}
		return null;
	}

	async function gunzip(bytes) {
		if (typeof DecompressionStream !== 'function' || typeof Blob !== 'function') return null;
		const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
		const chunks = [];
		let total = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.length;
			if (total > MAX_GUNZIP_BYTES) {
				reader.cancel().catch(() => {});
				return null;
			}
			chunks.push(value);
		}
		const out = new Uint8Array(total);
		let offset = 0;
		for (const c of chunks) {
			out.set(c, offset);
			offset += c.length;
		}
		return out;
	}

	// The server may send an event again when the stream is reopened. Every event carries an id
	// (field 10, "<milliseconds>-<n>"); a limits event whose id was seen before is that replay, not a
	// new reply. Comparing the limits themselves would not do: two replies in a row can leave them
	// unchanged (they are rounded to whole percent).
	const MAX_SEEN_EVENTS = 32;
	const seenEventIds = new Set();

	function eventIdOf(payload) {
		try {
			for (const top of readFields(payload)) {
				if (top.num !== 1 || top.wire !== 2) continue;
				const idField = firstField(readFields(top.value), 10, 2);
				const inner = idField ? firstField(readFields(idField.value), 1, 2) : null;
				if (inner) return utf8.decode(inner.value);
			}
		} catch {
			// no id
		}
		return null;
	}

	function isReplayedEvent(bytes) {
		const id = eventIdOf(bytes);
		if (!id) return false;
		if (seenEventIds.has(id)) return true;
		seenEventIds.add(id);
		if (seenEventIds.size > MAX_SEEN_EVENTS) seenEventIds.delete(seenEventIds.values().next().value);
		return false;
	}

	async function processConnectFrame(flags, payload, stats) {
		stats.frames += 1;
		if (flags & 0x02) {
			stats.endFrames += 1; // end of stream (JSON trailer or error)
			return;
		}
		let bytes = payload;
		if (flags & 0x01) {
			// gzip frames hold conversation snapshots; unpacking them is only a precaution.
			stats.gzipFrames += 1;
			try {
				bytes = await gunzip(payload);
			} catch {
				bytes = null;
			}
			if (!bytes) {
				diag('GUNZIP_FAILED', 'compressed frame could not be unpacked; ignored');
				return;
			}
		}
		const limits = extractLimits(bytes);
		if (limits) {
			if (isReplayedEvent(bytes)) {
				stats.replays += 1;
				diag('LIMIT_REPLAY_IGNORED', 'event id already seen');
				return;
			}
			stats.limits += 1;
			diag('PROTOBUF_LIMITS', `windows: ${Object.keys(limits.windows).join(',')}`);
			post('cc:message_limit', limits);
		}
	}

	async function handleConnectStream(response) {
		const stats = { frames: 0, endFrames: 0, gzipFrames: 0, limits: 0, replays: 0, bytes: 0 };
		try {
			const cloned = response.clone();
			const reader = cloned.body?.getReader?.();
			if (!reader) return;

			let chain = Promise.resolve();
			const parser = createConnectParser((flags, payload) => {
				chain = chain.then(() => processConnectFrame(flags, payload, stats)).catch(() => {});
			});

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				stats.bytes += value ? value.length : 0;
				parser.push(value);
			}
			await chain;
			if (stats.bytes > 0 && stats.frames === 0) {
				diag('STREAM_UNPARSEABLE', 'bytes received but no Connect frame could be read');
			} else {
				diag('STREAM_DONE', `frames=${stats.frames} limits=${stats.limits} replays=${stats.replays} gzip=${stats.gzipFrames}`);
			}
		} catch {
			// Aborted or failed streams are normal (the page reopens them); never break claude.ai.
			diag('STREAM_READ_ENDED', `frames=${stats.frames} limits=${stats.limits}`);
		}
		post('cc:stream_end', { kind: 'connect' });
	}

	// Requests from the content script. Only /usage is needed.
	window.addEventListener('message', async (event) => {
		if (event.source !== window) return;
		const data = event.data;
		if (!data || data.cc !== CC_MARKER) return;
		if (data.type !== 'cc:request') return;

		const { requestId, kind, payload } = data;
		try {
			if (kind === 'usage') {
				const orgId = payload?.orgId;
				if (!orgId || !/^[A-Za-z0-9-]{8,64}$/.test(orgId)) throw new Error('Missing or invalid orgId');
				const res = await originalFetch(`https://claude.ai/api/organizations/${orgId}/usage`, {
					method: 'GET',
					credentials: 'include'
				});
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const json = await res.json();
				window.postMessage({ cc: CC_MARKER, type: 'cc:response', requestId, ok: true, payload: json, error: null }, '*');
				return;
			}
			throw new Error(`Unknown request kind: ${kind}`);
		} catch (e) {
			window.postMessage({ cc: CC_MARKER, type: 'cc:response', requestId, ok: false, payload: null, error: e?.message || String(e) }, '*');
		}
	});

	try {
		document.documentElement.dataset.ccBridgeReady = 'true';
	} catch {}
	post('cc:bridge_ready', {});
})();
