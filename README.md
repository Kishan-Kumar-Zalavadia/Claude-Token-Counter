<div align="center">

<img src="icons/icon128.png" alt="Claude Counter logo" width="84" height="84">

# Claude Counter

**See your real five-hour Claude session usage and a live reset countdown, right under the chat box.**
Works on claude.ai's old and new interface, including the **free plan**. No account, no API key, no tracking.

![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)
![License: MIT](https://img.shields.io/badge/license-MIT-green)
![Runs locally](https://img.shields.io/badge/data-stays%20in%20your%20browser-informational)
![No dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)

</div>

<!--
  ╔══════════════════════════════════════════════════════════════════════╗
  ║  SCREENSHOTS GO HERE                                                 ║
  ║                                                                      ║
  ║  1. Put your images in  docs/images/                                 ║
  ║  2. Remove the comment markers around the block below                ║
  ║  3. Replace the file names with yours                                ║
  ║                                                                      ║
  ║  Tips: ~1200 px wide, PNG, one hero image (dashboard under the       ║
  ║  composer, dark mode) plus a light-mode and a "waiting" shot.        ║
  ╚══════════════════════════════════════════════════════════════════════╝

<div align="center">
  <img src="docs/images/hero.png" alt="Session usage dashboard under the Claude chat box" width="820">
  <br><br>
  <img src="docs/images/dark.png"  alt="Dark mode"  width="400">
  <img src="docs/images/light.png" alt="Light mode" width="400">
</div>
-->
<img width="811" height="159" alt="Screenshot 2026-11-26 at 11 00 17 AM" src="https://github.com/user-attachments/assets/95b3f0f5-42d8-42b4-879d-40da6a9aa07d" />
<img width="817" height="156" alt="Screenshot 2026-11-26 at 11 11 04 AM" src="https://github.com/user-attachments/assets/7ba77c54-1f8f-4eaa-be52-360e2ced92a8" />



<br>

## Why

Claude shows your usage limit only when you go looking for it, and the free plan gives you no usage page at all. This extension reads the usage figures Claude already sends your browser and keeps them in view:

```
SESSION USAGE   Last updated: now                       25%  ↻
▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
25% USED   75% LEFT                           RESETS IN 04h 44m
```

It supports both the classic claude.ai interface and the **new unified interface** (the `StreamTimeline` protocol), and focuses on the one thing most people want: **session usage and when it resets**.

## Features

- **Real session usage.** The five-hour percentage straight from Claude, as a bar with *used* and *left*.
- **Live reset countdown.** Counts down to Claude's own reset time (hours and minutes), so it stays right after a refresh, a sleep or a new tab.
- **Old and new Claude interface.** Reads both the classic `/completion` stream and the new `StreamTimeline` stream.
- **Free plan support.** Reads usage from Claude's replies, which is the only place the free plan exposes it.
- **Remembers between visits.** Saved per account, restored instantly on reload, never mixed between accounts.
- **Honest about missing data.** No data shows *"Waiting for session usage data"*, never a made-up 0%.
- **Refresh button** and automatic refresh every 2 minutes (see [Good to know](#good-to-know)).
- **Compact and quiet.** One thin strip inside the composer. Follows light and dark mode.
- **Private.** Everything runs locally and talks only to `claude.ai`.

## Install

> Chrome and other Chromium browsers (Edge, Brave, …) that support Manifest V3.

1. **Download** the latest `claude-token-counter.zip` from the [Releases](../../releases) page and unzip it.
   *(Or clone this repo.)*
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the unzipped `claude-token-counter` folder.
4. Open [claude.ai](https://claude.ai). The strip appears under the chat box.

## Quick start

1. Open claude.ai. The strip shows **"Waiting for session usage data"**. This is normal.
2. **Send any message.** When Claude finishes replying, the percentage and countdown appear.
3. That's it. The value is saved, so it is there the next time you open Claude.

## Good to know

These points matter most, especially on the **free plan**:

| | |
|---|---|
| **A message is needed the first time** | On a free account Claude sends its usage figures **with a finished reply**. After installing, the strip waits until you have sent one message. Nothing is wrong. There is nothing to read yet. |
| **Free plan: updates after each reply** | Between replies the number does not move. Claude's usage endpoint returns nothing for free accounts, so no refresh can fetch it earlier. Pressing ↻ will say *"free plan, usage updates after each reply"*. |
| **Paid plans refresh live** | On Pro, Max and similar plans the usage endpoint works, so the 2-minute refresh and the ↻ button keep the number current without sending anything. |
| **Usage from other places** | Usage you spend on your phone, another browser or Claude Code is only picked up with your next reply here (free plan) or the next refresh (paid plan). |
| **When the session ends** | When the five-hour window resets, the old percentage is dropped (*"Session window ended"*). A new one appears after your next message. |
| **The reset time is Claude's** | The countdown uses the reset time Claude reported, not a timer started when you opened the page. |
| **Colours** | Blue below 80%, orange from 80%, red from 95%. |
| **No estimates** | The extension never guesses. If Claude did not send a number, you will not see one. |

## What the strip tells you

| You see | It means |
|---|---|
| `Waiting for session usage data` | No usage received yet. Send a message. |
| `Last updated: now` | Fresh data arrived in the last 30 seconds. |
| `Last updated: 10:26 AM` | Time of the last real update. |
| `Reply in progress: usage updates when it finishes` | A message is being answered. On the new interface this is a hint that lasts at most 30 seconds. |
| `Reset time unavailable` | A percentage was received without a reset time. |
| `Session window ended` | The five-hour window is over. Waiting for the next message. |
| ↻ spinning, then `Updated …` / `Checked …` | The refresh button ran, and tells you what it found. |

Hover over the strip for a one-line diagnosis.

## Troubleshooting

Open DevTools (F12) → **Console** and filter for `Claude Counter`.

| Console code | Meaning |
|---|---|
| `INTERFACE_OLD` / `INTERFACE_NEW` | Which streaming interface your account uses. |
| `USAGE_EVENT` then `SESSION_EXTRACTED` | A usage event arrived and was read. Everything is working. |
| `USAGE_EMPTY` | Claude's usage endpoint has no data for your plan (normal on free). |
| `NO_SESSION_WINDOW` | An event had only the weekly window, so nothing is shown. |
| `MISSING_UTILIZATION` / `MISSING_RESET` | An event had no percentage or no reset time. |
| `STREAM_UNPARSEABLE` | Data arrived in a format the extension could not read. Claude may have changed it. [Open an issue.](../../issues) |
| `ORG_UNRESOLVED` | Your account could not be identified, so nothing is saved. |
| `UI_MOUNT_FAILED` | The chat box was not found. claude.ai's layout may have changed (see `src/content/constants.js`). |
| `BRIDGE_MISSING` | The page script did not start. Reload the extension and the page. |

**The strip does not appear.** Reload the extension on `chrome://extensions`, then refresh claude.ai.
**It still says "Waiting" after a reply.** Check the console codes above. No `USAGE_EVENT` means Claude did not send a usage event with that reply.

## How it works

1. A small script in the page watches Claude's streaming responses by reading **a copy**. Your messages and Claude's replies are never changed.
2. Claude attaches a *limits* event to each reply: a text `message_limit` event on the old interface, a protobuf frame in the `StreamTimeline` stream on the new one. The extension decodes both.
3. The five-hour value and its reset time are shown in the strip and saved in `chrome.storage.local` under your account.
4. Every 2 minutes, after each reply and when you press ↻, it also asks Claude's usage endpoint (paid plans).

## Privacy

- All data stays in your browser. There is no server, analytics or tracking.
- Requests go only to `claude.ai`, using your existing session.
- Only the usage percentage and reset time are read. Message text is not stored or sent anywhere.
- Logs never contain cookies, tokens or full account IDs.
- The only permission is `storage`.

## Development

```bash
git clone https://github.com/<your-username>/claude-token-counter.git
cd claude-token-counter
npm test          # 130+ tests, Node 22, no dependencies
npm run verify    # checks manifest.json and every file it references
```

There is no build step: load the folder with **Load unpacked**.

```
manifest.json
src/
  injected/bridge.js     page world: reads copies of Claude's streams, Connect/protobuf parser
  content/               usage logic, storage, refresh schedule, dashboard UI
  styles.css
tests/                   end-to-end tests: real scripts, fake DOM, recorded frames, manual clock
```

The tests run the real extension scripts against recorded stream frames, a fake page and a controllable clock.

### Verification status

The automated tests pass. **This extension has not been verified against every claude.ai account type.** The free-plan behaviour described above comes from testing on a free account plus published reports. If something behaves differently for you, please open an issue.

## Contributing

Bug reports and pull requests are welcome. When reporting a problem, please include:

- your plan (free / paid) and whether you see `INTERFACE_OLD` or `INTERFACE_NEW`
- the `[Claude Counter]` lines from the console (they are safe to share)
- a screenshot of the strip

Please do not post cookies, tokens or full account IDs.

## Third-party notices

Licenses and attributions for any reused code are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Disclaimer

This is an independent project. It is **not affiliated with or endorsed by Anthropic**. It relies on how claude.ai currently behaves, which can change without notice.

## License

[MIT](LICENSE)
