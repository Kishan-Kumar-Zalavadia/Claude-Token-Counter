# Changelog

## 1.2.0
- "Last updated: now" for 30 seconds after fresh usage arrives, then the real clock time. Data restored after a reload shows its real time.
- "Reply in progress: usage updates when it finishes" while a message is being answered. Old interface: exact (ends with the reply stream). New interface: only a hint, capped at 30 seconds, because the send request also fires when a chat is opened.
- Free-plan wording: the refresh button now says "free plan, usage updates after each reply" when Claude's usage endpoint has no data.
- Bridge announces sends (`cc:reply_start`); it never reads or changes the request.

## 1.1.0
- Usage is refreshed every 2 minutes while the tab is visible (was once an hour), and again shortly after every finished reply. Limits events inside a reply still update the bar immediately.
- Manual refresh button (circular arrow next to the percentage). It reports honestly what happened: updated, no newer data, Claude sent no usage data, or request failed.
- "Last updated" moves whenever fresh data is received.
- Failed requests back off 1, 2, 4, 8 minutes, then every 10 minutes at most.
- A reply-finished refresh is skipped if a /usage request already ran in the last 20 seconds.

## 1.0.3
- No more false `UI_MOUNT_FAILED` warning on the Chrome Errors page: a missing chat box is only reported after 15 s (claude.ai draws it shortly after the page starts).

## 1.0.2
- "Last updated: h:mm" is shown again, next to the title.
- When `/usage` has no five-hour data, the console now lists which field names it did send (names only, no values).

## 1.0.1
- Compact layout: thin bar and a single info line; details moved into the hover tooltip.
- Reset countdown shows hours and minutes only (rounded up), still computed from the server's reset timestamp.

## 1.0.0
- Rebuilt from claude-counter (upstream main, v0.4.2) plus its unmerged PR #60 (new unified claude.ai interface).
- Supports both interfaces: old `/completion` SSE `message_limit`, and new `ConversationService/StreamTimeline`
  (Connect frames, protobuf, gzip frames, replay de-duplication by event id).
- Dashboard simplified to what matters: five-hour session %, bar, used/left, live reset countdown, last updated.
- Free plan: an empty `/usage` is "no data" (never 0%), polled once an hour at most, failures back off; data from replies is saved per organisation and restored.
- Ended windows are never shown stale; one refresh is triggered, then the extension waits for a real event.
- Removed from the original: token counting, cache timer, weekly bar, vendored tokenizer.
- Diagnostics with the `[Claude Counter Rebuilt]` prefix; no credentials or full org ids are logged.
