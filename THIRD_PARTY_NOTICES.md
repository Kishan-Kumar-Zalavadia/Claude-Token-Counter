# Third-party notices

## claude-counter (MIT)

- Project: <https://github.com/she-llac/claude-counter> (Copyright (c) 2025 Claude Counter contributors)
- Used for: the overall architecture (page-world fetch wrapper that reads a **clone** of Claude's
  responses, content script, `/usage` handling, `lastActiveOrg` organisation lookup) and the icons in `icons/`.
- License: MIT, reproduced in `LICENSE`.

## claude-counter pull request #60, "Support for the new unified Claude.ai interface" (MIT, unmerged upstream)

- Used for: the Connect frame parser, the minimal protobuf reader, the limits-message extraction
  (structured field numbers plus the `"5h"` / `"7d"` key fallback), gzip handling, event-id
  de-duplication, and the recorded frames in `tests/fixtures/frames.json` and the test helpers
  `tests/helpers/{proto,fake-clock,fake-chrome,fake-dom,bridge-harness}.js` (adapted).
- The parser block in `src/injected/bridge.js` between "const utf8" and "function isReplayedEvent" is
  carried over unchanged so the upstream tests still apply.
- License: the repository's MIT license (`LICENSE`).

## Not included

The original extension's vendored tokenizer (`gpt-tokenizer`, `o200k_base`) is **not** part of this
project, because token counting is not a feature here.
