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
		// /usage: a valid answer (even an empty one: free plan) is repeated after an hour,
		// a failed request is retried after a minute, then 2, 4, 8 ... minutes, at most an hour.
		USAGE_POLL_MS: 60 * 60 * 1000,
		USAGE_RETRY_MS: 60 * 1000,
		RESTORE_RETRY_MS: 10 * 1000,
		RESTORE_RETRY_WINDOW_MS: 2 * 60 * 1000,
		MOUNT_LOG_THROTTLE_MS: 30 * 1000,
		// claude.ai draws the chat box a moment after the page starts: a missing composer is not
		// reported (it is not a problem yet) until this much time has passed.
		MOUNT_GRACE_MS: 15 * 1000
	});
})();
