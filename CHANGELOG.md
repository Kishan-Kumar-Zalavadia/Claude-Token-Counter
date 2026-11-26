# Changelog

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
