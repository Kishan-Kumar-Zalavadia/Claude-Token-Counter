# Reverse-engineering notes

## Sources inspected
- Upstream `she-llac/claude-counter` cloned; full tree, tags (`v0.4.1`, `v0.4.2`), history. **Upstream `main` is v0.4.2 (last commit 2026-03-21).**
- PR #60 head fetched as `origin/pr-60-unified`: 8 commits on top of a v2.0.2 commit (2026-09-03) that is itself not on main; 26 files, +4148/-161; manifest 2.1.0. **Not merged.** Its own suite (121 tests) passes.
- Limitation: the text of the issue #59 / PR #60 comment threads and of #56/#57 could not be retrieved in this environment (GitHub API/page fetches were refused or empty). Conclusions below come from the code, commit messages, tests and recorded fixtures of the PR, not from the discussions.

## Original (main, v0.4.2) architecture
- `src/injected/bridge.js` (page world) wraps `window.fetch`; for `text/event-stream` responses it reads a **clone**, parses `data:` lines and forwards `message_limit` events (`windows['5h'|'7d']`: `utilization` fraction, `resets_at` epoch seconds) by `postMessage`.
- `src/content/bridge-client.js` receives them; also asks the bridge for `GET /api/organizations/{org}/usage` (percent 0..100, ISO `resets_at`). Org id comes from the `lastActiveOrg` cookie.
- `main.js`/`ui.js` render bars and a countdown, mount with a MutationObserver, and track tokens with a vendored tokenizer.

## What broke
Accounts moved to the unified interface no longer call `/completion`; replies and limits arrive via `…/ConversationService/StreamTimeline` (`application/connect+proto`). The original only reads `text/event-stream`, so it never sees a limit event. On Free plans `/usage` can also come back without a usable `five_hour`, so there is nothing to fall back on.

## New stream (as implemented by PR #60, reused unchanged)
- Connect frames: 1 byte flags, 4-byte big-endian length, payload. `0x00` protobuf, `0x01` gzip protobuf, `0x02` end-of-stream JSON.
- A minimal protobuf reader finds the limits message (structured fields, with a fallback keyed on the `"5h"`/`"7d"` strings) and yields the same `{windows:{…}}` shape as the SSE event, so downstream code is shared.
- proto3 omits a 0.0 double: an entry that is present (status/reset set) but has no utilization is a real 0; an absent window is "not reported".
- Replays after reconnects are de-duplicated by the event id (last 32 remembered), not by percentage. Frame and gunzip sizes are capped (4 MiB). The page's own response is never touched; only a clone is read.

## Differences in this rebuild
- Parser block copied verbatim from PR #60 so its recorded-frame tests still apply; SSE handling kept.
- New: org id also taken from the page's own `/api/organizations/{id}` requests (authoritative); storage per org; never saved without a known org; cross-tab sync.
- New: `/usage` policy (empty = answered, hourly; failure back-off 1,2,4…60 min; hidden tab does not poll).
- New: window expiry by absolute timestamp (also after sleep), older-window events ignored, diagnostics codes.
- Fixed here: a corrupt gzip frame was swallowed silently; it now logs `GUNZIP_FAILED`.
- Removed: tokens, cache timer, weekly display, `hash`/`conversation` bridge requests.

## Unresolved / unverified
- Not tested against live claude.ai (no authenticated access). Composer selectors and the real StreamTimeline payload may drift.
- Whether the Free account receives limits events before the first reply completes is unknown; the UI waits instead of guessing.
