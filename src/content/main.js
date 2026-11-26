(() => {
	'use strict';

	// Orchestration: where usage data comes from, which account it belongs to, how it is saved and
	// restored, when /usage may be asked, and what happens when the five-hour window ends.
	//
	// Sources of the five-hour window, newest wins (an older window never replaces a newer one):
	//   1. limits events from claude.ai's own replies   (old: SSE message_limit, new: StreamTimeline)
	//   2. /api/organizations/{org}/usage                (paid plans; the free plan often reports nothing)
	//   3. the copy saved for THIS organisation          (so a reload does not start empty)

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});
	if (CC.__started) return;
	CC.__started = true;

	const { core, diag, CONST } = CC;
	const ORG_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

	let state = null; // the five-hour window: null | live window | { expired: true }
	let currentOrgId = null;
	let orgFailed = false;
	let orgLookupInFlight = false;
	let nextOrgLookupMs = 0;

	let usageFetchInFlight = false;
	let usageFailures = 0;
	let refreshing = false; // a manual refresh is running (the button spins)
	let note = null; // { text, until }: a short message shown in place of "Last updated"
	let lastStreamRefreshMs = 0;
	let lastUsageRequestMs = 0;
	let lastManualMs = 0;
	let pending = null; // { kind: 'old' | 'new', until }: a reply is (probably) running
	let nextUsageAttemptMs = Infinity; // set once the saved copy has been looked at
	let restoredFor = null;
	let restoreInFlight = false;
	let lastRestoreAttemptMs = 0;
	const startedAtMs = Date.now();

	const dashboard = new CC.ui.Dashboard();

	// ---- storage ----------------------------------------------------------------------------------

	function storageArea() {
		try {
			return typeof chrome !== 'undefined' && chrome.storage?.local ? chrome.storage.local : null;
		} catch {
			return null;
		}
	}

	const storageKey = (orgId) => `${CONST.STORAGE_PREFIX}${orgId}`;

	function isValidSavedWindow(w) {
		if (!w || typeof w !== 'object') return false;
		if (w.expired === true) return true;
		if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization) || w.utilization < 0 || w.utilization > 100) return false;
		if (w.resets_at !== null && w.resets_at !== undefined && !Number.isFinite(Date.parse(w.resets_at))) return false;
		return true;
	}

	/** Save the window for the current organisation only. Never for "unknown" and never an empty value. */
	function persist() {
		const area = storageArea();
		if (!area || !currentOrgId || !state) return;
		try {
			area.set({ [storageKey(currentOrgId)]: { orgId: currentOrgId, usage: state, savedAt: Date.now() } });
			diag.log('USAGE_SAVED', diag.shortId(currentOrgId));
		} catch {
			// storage can be unavailable (extension reloaded); the live data still works
		}
	}

	function readSaved(orgId) {
		return new Promise((resolve) => {
			const area = storageArea();
			if (!area) return resolve(null);
			try {
				area.get([storageKey(orgId)], (result) => resolve(result?.[storageKey(orgId)] || null));
			} catch {
				resolve(null);
			}
		});
	}

	/** Restore this organisation's saved window, if nothing newer is known yet. */
	async function restoreSaved() {
		if (restoreInFlight || !currentOrgId) return false;
		const orgId = currentOrgId;
		restoreInFlight = true;
		lastRestoreAttemptMs = Date.now();
		let entry;
		try {
			entry = await readSaved(orgId);
		} finally {
			restoreInFlight = false;
		}
		// The account changed while reading, or a live event arrived first: leave it alone.
		if (orgId !== currentOrgId || (state && !state.expired)) return false;
		if (!entry || entry.orgId !== orgId || !isValidSavedWindow(entry.usage)) return false;

		const now = Date.now();
		let restored = entry.usage.expired ? { expired: true, resets_at: entry.usage.resets_at || null } : { ...entry.usage, source: 'cache' };
		restored = core.expire(restored, now);
		state = restored;
		restoredFor = orgId;
		diag.log('USAGE_RESTORED', restored.expired ? 'window had ended' : `${core.fmtPercent(restored.utilization)}%`);
		if (restored.expired) {
			// The saved window ended while the page was closed: never show it, ask for fresh data.
			nextUsageAttemptMs = now;
			diag.log('WINDOW_EXPIRED', 'saved window already ended');
		}
		render();
		return true;
	}

	// Another tab of the same account received newer data: use it.
	try {
		chrome?.storage?.onChanged?.addListener((changes, area) => {
			if (area && area !== 'local') return;
			if (!currentOrgId) return;
			const change = changes[storageKey(currentOrgId)];
			const incoming = change?.newValue?.usage;
			if (!change?.newValue || change.newValue.orgId !== currentOrgId || !isValidSavedWindow(incoming) || incoming.expired) return;
			if (state && !state.expired && (incoming.received_at || 0) <= (state.received_at || 0)) return;
			const merged = core.mergeWindow(state, incoming, Date.now());
			if (!merged.accepted) return;
			state = merged.state;
			diag.log('USAGE_SYNCED');
			render();
		});
	} catch {
		// no storage events: not essential
	}

	// ---- organisation ----------------------------------------------------------------------------

	function readCookieOrg() {
		try {
			const raw = document.cookie
				.split('; ')
				.find((row) => row.startsWith('lastActiveOrg='))
				?.split('=')[1];
			const id = raw ? decodeURIComponent(raw) : null;
			return id && ORG_ID_RE.test(id) ? id : null;
		} catch {
			return null;
		}
	}

	/** Switch to an organisation. A different account never inherits the previous one's usage. */
	function setOrg(id, how) {
		if (typeof id !== 'string' || !ORG_ID_RE.test(id) || id === currentOrgId) return false;
		const switching = currentOrgId !== null;
		currentOrgId = id;
		orgFailed = false;
		restoredFor = null;
		if (switching) {
			state = null;
			usageFailures = 0;
			nextUsageAttemptMs = Infinity;
			diag.log('ORG_CHANGED', `${diag.shortId(id)} via ${how}`);
		} else {
			diag.log('ORG_RESOLVED', `${diag.shortId(id)} via ${how}`);
		}
		afterOrgKnown();
		return true;
	}

	async function resolveOrg() {
		if (currentOrgId) return currentOrgId;
		const cookieOrg = readCookieOrg();
		if (cookieOrg) {
			setOrg(cookieOrg, 'cookie');
			return currentOrgId;
		}
		if (orgLookupInFlight || Date.now() < nextOrgLookupMs) return null;
		orgLookupInFlight = true;
		try {
			const res = await fetch('https://claude.ai/api/organizations', { credentials: 'include' });
			if (res.ok) {
				const orgs = await res.json();
				if (Array.isArray(orgs)) {
					// Only trust an unambiguous answer: one organisation, or one marked active.
					const active = orgs.filter((o) => o && o.active);
					const pick = orgs.length === 1 ? orgs[0] : active.length === 1 ? active[0] : null;
					const id = pick && (pick.uuid || pick.id);
					if (id) setOrg(id, 'organizations list');
				}
			}
		} catch {
			// handled below
		} finally {
			orgLookupInFlight = false;
		}
		if (!currentOrgId) {
			nextOrgLookupMs = Date.now() + 30 * 1000;
			if (!orgFailed) {
				orgFailed = true;
				diag.log('ORG_UNRESOLVED', 'no cookie, no page request seen, no unambiguous organisation list');
			}
		}
		return currentOrgId;
	}

	async function afterOrgKnown() {
		await restoreSaved();
		// Ask /usage once if the window is still unknown or ended (it may report nothing: free plan).
		if (!state || state.expired) nextUsageAttemptMs = Math.min(nextUsageAttemptMs, Date.now());
		else if (nextUsageAttemptMs === Infinity) nextUsageAttemptMs = Date.now() + CONST.USAGE_POLL_MS;
	}

	// ---- applying data ----------------------------------------------------------------------------

	function apply(incoming, origin) {
		const now = Date.now();
		const merged = core.mergeWindow(state, incoming, now);
		if (!merged.accepted) {
			diag.log('EVENT_IGNORED', `${origin}: ${merged.reason}`);
			return false;
		}
		state = merged.state;
		nextUsageAttemptMs = now + CONST.USAGE_POLL_MS;
		persist();
		diag.log('SESSION_EXTRACTED', `${core.fmtPercent(state.utilization)}% used, resets ${state.resets_at || 'unknown'} (${origin})`);
		render();
		return true;
	}

	/** A limits event from a reply: old SSE `message_limit` or the new StreamTimeline limits message. */
	function handleMessageLimit(raw) {
		diag.state.eventsReceived += 1;
		diag.state.lastEventAt = Date.now();
		diag.log('USAGE_EVENT');
		pending = null; // Claude has just reported: no longer waiting
		if (!raw || !raw.windows || typeof raw.windows !== 'object' || !raw.windows['5h']) {
			// Weekly-only or empty: say so, change nothing. This is NOT a 0% session.
			diag.log('NO_SESSION_WINDOW');
			return;
		}
		const parsed = core.parseMessageLimit(raw, Date.now());
		if (!parsed) {
			diag.log('MISSING_UTILIZATION');
			return;
		}
		if (!parsed.resets_at) diag.log('MISSING_RESET');
		apply(parsed, 'event');
	}

	// ---- /usage -----------------------------------------------------------------------------------

	/**
	 * Ask /usage once. Returns 'updated' | 'no_data' | 'older' | 'failed' | 'busy' | 'no_org'.
	 * Scheduled calls re-arm the 2-minute timer; failures back off.
	 */
	async function refreshUsage(reason) {
		const now = Date.now();
		nextUsageAttemptMs = now + CONST.USAGE_RETRY_MS; // assume failure until a valid answer arrives
		if (usageFetchInFlight) return 'busy';
		const orgId = await resolveOrg();
		if (!orgId) return 'no_org';

		usageFetchInFlight = true;
		lastUsageRequestMs = Date.now();
		diag.log('REFRESH_TRIGGERED', reason || 'scheduled');
		diag.log('USAGE_REQUEST', diag.shortId(orgId));
		let raw = null;
		let problem = null;
		try {
			raw = await CC.bridge.requestUsage(orgId);
		} catch (e) {
			problem = e && e.message ? e.message : 'bridge error';
			// Only when the bridge itself is not answering is a direct request worth trying.
			if (!CC.bridge.isBridgeReady() || /timed out/.test(problem)) {
				try {
					const res = await fetch(`https://claude.ai/api/organizations/${orgId}/usage`, { credentials: 'include' });
					if (res.ok) {
						raw = await res.json();
						problem = null;
					} else {
						problem = `HTTP ${res.status}`;
					}
				} catch (e2) {
					problem = e2 && e2.message ? e2.message : 'network error';
				}
			}
		} finally {
			usageFetchInFlight = false;
		}

		if (orgId !== currentOrgId) return 'no_org'; // the account changed meanwhile

		if (!raw || typeof raw !== 'object') {
			usageFailures += 1;
			nextUsageAttemptMs = Date.now() + Math.min(CONST.USAGE_RETRY_MS * 2 ** (usageFailures - 1), CONST.USAGE_RETRY_MAX_MS);
			diag.log('USAGE_FAILED', problem || 'no usable answer');
			return 'failed';
		}
		usageFailures = 0;
		nextUsageAttemptMs = Date.now() + CONST.USAGE_POLL_MS;

		const parsed = core.parseUsageEndpoint(raw, Date.now());
		if (!parsed) {
			// Reachable but empty (free plan): a real answer, not an error and not 0%. Keep everything known.
			// Key names only (never values), so it is possible to see what the endpoint does send.
			diag.log('USAGE_EMPTY', `fields: ${Object.keys(raw).slice(0, 8).join(',') || 'none'}`);
			return 'no_data';
		}
		diag.log('USAGE_OK');
		return apply(parsed, 'usage') ? 'updated' : 'older';
	}

	function setNote(text) {
		note = { text, until: Date.now() + CONST.NOTE_MS };
		render();
	}

	/** The refresh button. */
	async function manualRefresh() {
		const now = Date.now();
		if (refreshing || now - lastManualMs < CONST.MANUAL_COOLDOWN_MS) return;
		lastManualMs = now;
		refreshing = true;
		render();
		let result = 'failed';
		try {
			result = await refreshUsage('manual refresh button');
		} catch {
			result = 'failed';
		}
		refreshing = false;
		const clock = core.formatClock(Date.now());
		const text = {
			updated: `Updated ${clock}`,
			older: `Checked ${clock}: no newer data`,
			no_data: `Checked ${clock}: free plan, usage updates after each reply`,
			failed: `Checked ${clock}: request failed`,
			busy: `Checked ${clock}: request already running`,
			no_org: `Checked ${clock}: account not identified`
		}[result];
		setNote(text);
	}

	/** A reply finished: Claude has just counted it, so look soon (not more than every 20 s). */
	let streamEndTimer = null;
	function onStreamEnd() {
		if (streamEndTimer || document.hidden) return;
		const now = Date.now();
		if (now - lastStreamRefreshMs < CONST.STREAM_END_MIN_GAP_MS) return;
		streamEndTimer = setTimeout(() => {
			streamEndTimer = null;
			// Any /usage request in the last 20 s already saw this reply: do not repeat it.
			if (Date.now() - lastUsageRequestMs < CONST.STREAM_END_MIN_GAP_MS) return;
			lastStreamRefreshMs = Date.now();
			refreshUsage('reply finished').catch(() => {});
		}, CONST.STREAM_END_DELAY_MS);
	}

	// ---- rendering and the clock -------------------------------------------------------------------

	function render() {
		const now = Date.now();
		if (note && now >= note.until) note = null;
		if (pending && now >= pending.until) pending = null;
		dashboard.render(state, now, { orgFailed, refreshing, note: note ? note.text : '', pending: !!pending });
	}

	function tick() {
		const now = Date.now();

		// The window ended (also after the computer slept: this compares absolute timestamps).
		const ended = core.expire(state, now);
		if (ended !== state) {
			state = ended;
			diag.log('WINDOW_EXPIRED');
			persist();
			nextUsageAttemptMs = now;
		}

		if (!currentOrgId) {
			resolveOrg().catch(() => {});
		} else if (!state && now - startedAtMs < CONST.RESTORE_RETRY_WINDOW_MS && now - lastRestoreAttemptMs >= CONST.RESTORE_RETRY_MS) {
			restoreSaved().catch(() => {});
		}

		if (!document.hidden && now >= nextUsageAttemptMs) {
			refreshUsage(state && state.expired ? 'session window ended' : 'scheduled').catch(() => {});
		}

		dashboard.ensureMounted();
		render();
	}

	// ---- wiring --------------------------------------------------------------------------------------

	dashboard.onRefresh = () => manualRefresh().catch(() => {});
	CC.bridge.on('cc:message_limit', handleMessageLimit);
	CC.bridge.on('cc:stream_end', (payload) => {
		// The old interface streams the reply on the send request itself: its end is the reply's end.
		if (payload && payload.kind === 'sse') pending = null;
		onStreamEnd();
	});
	CC.bridge.on('cc:reply_start', (payload) => {
		const kind = payload && payload.kind === 'old' ? 'old' : 'new';
		pending = { kind, until: Date.now() + (kind === 'old' ? CONST.PENDING_OLD_MAX_MS : CONST.PENDING_NEW_MAX_MS) };
		diag.log('REPLY_STARTED', kind);
		render();
	});
	CC.bridge.on('cc:org_detected', (payload) => {
		// The id the page itself uses is the authority, over cookie and anything else.
		if (payload?.orgId) setOrg(payload.orgId, 'page request');
	});
	CC.bridge.on('cc:diag', (payload) => {
		if (payload && typeof payload.code === 'string') diag.log(payload.code, typeof payload.detail === 'string' ? payload.detail : undefined);
	});
	CC.bridge.on('cc:bridge_ready', () => diag.log('BRIDGE_READY'));

	function onNavigate() {
		dashboard.ensureMounted();
		if (currentOrgId && !state && Date.now() - lastRestoreAttemptMs > 2000) restoreSaved().catch(() => {});
		render();
	}

	let lastPath = window.location.pathname;
	function onUrlMaybeChanged() {
		const current = window.location.pathname;
		if (current === lastPath) return;
		lastPath = current;
		onNavigate();
	}
	window.addEventListener('cc:urlchange', onUrlMaybeChanged);
	window.addEventListener('popstate', onUrlMaybeChanged);
	document.addEventListener('visibilitychange', () => {
		if (!document.hidden) tick(); // after sleep or a background tab: catch up at once
	});
	window.addEventListener('pageshow', () => tick());

	diag.log('INIT');
	dashboard.mount();
	dashboard.observe();
	render();
	resolveOrg().catch(() => {});

	if (!CC.bridge.isBridgeReady()) {
		setTimeout(() => {
			if (!CC.bridge.isBridgeReady() && !diag.state.bridgeReady) diag.log('BRIDGE_MISSING');
		}, 3000);
	}

	setInterval(tick, 1000);
})();
