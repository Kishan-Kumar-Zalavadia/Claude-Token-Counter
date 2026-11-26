(() => {
	'use strict';

	// Pure logic for the five-hour session window. No DOM, no storage, no timers: everything takes
	// `now` as an argument, so it can be tested with a manual clock.
	//
	// A session window is exactly one of:
	//   null                         never reported: the UI says "Waiting for session usage data"
	//   { utilization, resets_at,    reported by the server. utilization is a PERCENT (0..100).
	//     received_at, source }      0 is a real value here, because the entry was explicitly reported.
	//   { expired: true, resets_at } the reported window has ended; nothing is known about the new one.
	//
	// "Missing" is never converted into 0%: parse functions return null instead of a number.

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

	function isFiniteNumber(n) {
		return typeof n === 'number' && Number.isFinite(n);
	}

	function clampPercent(p) {
		return Math.max(0, Math.min(100, p));
	}

	function toIso(ms) {
		return new Date(ms).toISOString();
	}

	/**
	 * /api/organizations/{org}/usage -> window | null.
	 * There `five_hour.utilization` is already a percent (0..100). The free plan can answer with
	 * nothing usable: that is "no data" (null), never 0%.
	 */
	function parseUsageEndpoint(raw, now) {
		const w = raw && typeof raw === 'object' ? raw.five_hour : null;
		if (!w || typeof w !== 'object') return null;
		if (!isFiniteNumber(w.utilization)) return null;
		let resets_at = null;
		if (typeof w.resets_at === 'string' && Number.isFinite(Date.parse(w.resets_at))) resets_at = new Date(Date.parse(w.resets_at)).toISOString();
		return { utilization: clampPercent(w.utilization), resets_at, received_at: now, source: 'usage' };
	}

	/**
	 * `message_limit` (old SSE) or the limits message of the Connect stream (new interface), both in
	 * the same shape: { windows: { '5h': { utilization: FRACTION 0..1, resets_at: EPOCH SECONDS } } }.
	 * The fraction is converted to a percent exactly once, here.
	 *
	 * The bridge only reports utilization 0 for a window the server really reported (proto3 leaves a
	 * 0.0 out, the bridge restores it when the entry has a status or a reset time). A window absent
	 * from `windows` is "not reported" and gives null.
	 */
	function parseMessageLimit(raw, now) {
		const w = raw && raw.windows && typeof raw.windows === 'object' ? raw.windows['5h'] : null;
		if (!w || typeof w !== 'object') return null;
		if (!isFiniteNumber(w.utilization)) return null;
		// A fraction. Anything outside 0..1 is not what the parser expects: refuse it instead of guessing.
		if (w.utilization < 0 || w.utilization > 1.0001) return null;
		let resets_at = null;
		if (isFiniteNumber(w.resets_at) && w.resets_at > 0) resets_at = toIso(w.resets_at * 1000);
		return { utilization: clampPercent(w.utilization * 100), resets_at, received_at: now, source: 'event' };
	}

	function resetMsOf(w) {
		if (!w || w.expired || !w.resets_at) return null;
		const ms = Date.parse(w.resets_at);
		return Number.isFinite(ms) ? ms : null;
	}

	/** Has this window ended at `now`? A window with no reset time cannot outlive five hours. */
	function hasEnded(w, now) {
		if (!w || w.expired) return false;
		const resetMs = resetMsOf(w);
		if (resetMs !== null) return now >= resetMs;
		return isFiniteNumber(w.received_at) && now - w.received_at >= FIVE_HOURS_MS;
	}

	/** Turns an ended window into { expired: true }. Returns the same object when nothing changed. */
	function expire(w, now) {
		if (!hasEnded(w, now)) return w;
		return { expired: true, resets_at: w.resets_at || null };
	}

	/**
	 * Merge an incoming window into the current state.
	 * Returns { state, accepted, reason }.
	 *  - an incoming window that has already ended is not shown (stale event)
	 *  - an incoming window that belongs to an OLDER window than the current one is ignored
	 */
	function mergeWindow(current, incoming, now) {
		if (!incoming) return { state: current, accepted: false, reason: 'no_window' };
		if (hasEnded(incoming, now)) return { state: current, accepted: false, reason: 'incoming_already_ended' };
		const cur = current && !current.expired ? current : null;
		const curReset = resetMsOf(cur);
		const inReset = resetMsOf(incoming);
		if (curReset !== null && inReset !== null && inReset < curReset) {
			return { state: current, accepted: false, reason: 'older_window' };
		}
		return { state: incoming, accepted: true, reason: 'ok' };
	}

	/** One-decimal percent text without a trailing ".0": 65 -> "65", 64.6 -> "64.6", 0.04 -> "0". */
	function fmtPercent(p) {
		const r = Math.round(p * 10) / 10;
		return Number.isInteger(r) ? String(r) : r.toFixed(1);
	}

	function pad2(n) {
		return String(n).padStart(2, '0');
	}

	/** 16338000 -> "04h 33m". Rounded UP to whole minutes, so it reaches 00h 00m exactly when the window resets. */
	function formatCountdown(ms) {
		const total = Math.max(0, Math.ceil(ms / 60000));
		const h = Math.floor(total / 60);
		const m = total % 60;
		return `${pad2(h)}h ${pad2(m)}m`;
	}

	function formatClock(ms) {
		try {
			return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
		} catch {
			return '';
		}
	}

	/**
	 * Everything the dashboard shows, as plain data.
	 * status: 'waiting' (never reported) | 'live' | 'expired'
	 */
	function computeView(state, now, ctx = {}) {
		const view = {
			status: 'waiting',
			pct: null,
			pctText: '--',
			usedText: '',
			leftText: '',
			barWidth: 0,
			level: 'ok',
			resetLabel: 'RESETS IN',
			countdownText: '',
			remainingMs: null,
			updatedText: '',
			message: '',
			hint: ''
		};

		const w = expire(state, now);

		if (!w) {
			view.message = 'Waiting for session usage data';
			view.resetLabel = '';
			view.countdownText = 'Reset time unavailable';
			view.hint = ctx.orgFailed
				? 'Could not identify your Claude account yet.'
				: 'Claude reports usage with its replies: send a message to receive it.';
			return view;
		}

		if (w.expired) {
			view.status = 'expired';
			view.message = 'Session window ended';
			view.resetLabel = '';
			view.countdownText = '';
			view.hint = 'Previous usage is no longer shown. Waiting for new session usage data.';
			return view;
		}

		const pct = clampPercent(w.utilization);
		view.status = 'live';
		view.pct = pct;
		view.pctText = `${fmtPercent(pct)}%`;
		view.usedText = `${fmtPercent(pct)}% USED`;
		view.leftText = `${fmtPercent(100 - pct)}% LEFT`;
		view.barWidth = pct;
		view.level = pct >= 95 ? 'full' : pct >= 80 ? 'warn' : 'ok';

		const resetMs = resetMsOf(w);
		if (resetMs !== null) {
			view.remainingMs = Math.max(0, resetMs - now);
			view.countdownText = formatCountdown(view.remainingMs);
		} else {
			view.resetLabel = '';
			view.countdownText = 'Reset time unavailable';
		}

		if (isFiniteNumber(w.received_at)) view.updatedText = `Last updated: ${formatClock(w.received_at)}`;
		if (w.source === 'cache') view.hint = 'Restored from your last session; updates with Claude\'s next reply.';
		return view;
	}

	CC.core = Object.freeze({
		FIVE_HOURS_MS,
		parseUsageEndpoint,
		parseMessageLimit,
		resetMsOf,
		hasEnded,
		expire,
		mergeWindow,
		fmtPercent,
		formatCountdown,
		formatClock,
		computeView
	});
	if (typeof module !== 'undefined' && module.exports) module.exports = CC.core;
})();
