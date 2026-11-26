(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	CC.DOM = Object.freeze({
		DASHBOARD_ATTR: 'data-ccr',
		DASHBOARD_VALUE: 'dashboard',
		// Anchors for the composer, tried in order. claude.ai changes these now and then; the
		// dashboard falls back through the list and reports UI_MOUNT_FAILED when none matches.
		CHAT_INPUT: '[data-testid="chat-input"], div[contenteditable="true"], textarea',
		COMPOSER_FLOW_CHILD: '.bg-surface-3 > .relative.w-full.min-w-0, .relative.w-full.min-w-0',
		COMPOSER_BOX: '.bg-surface-3, [data-cds="ChatComposer"], fieldset, form'
	});

	CC.CONST = Object.freeze({
		STORAGE_PREFIX: 'ccr_usage_v1_',
		// /usage is asked every 2 minutes while the tab is visible (also when it answers with nothing,
		// as on the free plan). A failed request backs off 1, 2, 4, 8 ... minutes, at most 10.
		USAGE_POLL_MS: 2 * 60 * 1000,
		USAGE_RETRY_MS: 60 * 1000,
		USAGE_RETRY_MAX_MS: 10 * 60 * 1000,
		// A finished reply is a good moment to look: Claude has just counted it.
		STREAM_END_DELAY_MS: 1500,
		STREAM_END_MIN_GAP_MS: 20 * 1000,
		MANUAL_COOLDOWN_MS: 3 * 1000,
		NOTE_MS: 6 * 1000,
		// "Last updated: now" is shown for this long after fresh data arrives, then the clock time.
		JUST_UPDATED_MS: 30 * 1000,
		// How long a running reply is assumed to run. The old interface says when it ends; on the new
		// interface the send request is only a hint (it also fires when a chat is opened).
		PENDING_OLD_MAX_MS: 10 * 60 * 1000,
		PENDING_NEW_MAX_MS: 30 * 1000,
		RESTORE_RETRY_MS: 10 * 1000,
		RESTORE_RETRY_WINDOW_MS: 2 * 60 * 1000,
		MOUNT_LOG_THROTTLE_MS: 30 * 1000,
		// claude.ai draws the chat box a moment after the page starts: a missing composer is not
		// reported (it is not a problem yet) until this much time has passed.
		MOUNT_GRACE_MS: 15 * 1000
	});
})();
