'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/content/usage-core.js');

const NOW = Date.UTC(2026, 9, 11, 16, 0, 0);
const H = 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const live = (utilization, resetsMs, extra = {}) => ({ utilization, resets_at: resetsMs === null ? null : iso(resetsMs), received_at: NOW, source: 'event', ...extra });

// ---- units: fractions become percent exactly once -------------------------------------------------

test('U01 a fraction is converted to a percent once: 0.25 -> 25, 0.5 -> 50, 0.75 -> 75, 1 -> 100', () => {
	for (const [fraction, pct] of [[0.25, 25], [0.5, 50], [0.75, 75], [1, 100], [0.76, 76]]) {
		const w = core.parseMessageLimit({ windows: { '5h': { utilization: fraction, resets_at: 1791749400 } } }, NOW);
		assert.ok(Math.abs(w.utilization - pct) < 1e-9, `${fraction}`);
	}
});

test('U02 the /usage endpoint already reports a percent: it is NOT multiplied again', () => {
	const w = core.parseUsageEndpoint({ five_hour: { utilization: 65, resets_at: '2026-10-11T20:10:00+00:00' } }, NOW);
	assert.equal(w.utilization, 65);
	assert.equal(w.resets_at, '2026-10-11T20:10:00.000Z');
});

test('U03 reset time: epoch seconds from events, ISO text from /usage, both end up as ISO', () => {
	const e = core.parseMessageLimit({ windows: { '5h': { utilization: 0.1, resets_at: 1791749400 } } }, NOW);
	assert.equal(e.resets_at, '2026-10-11T20:10:00.000Z');
});

test('U04 a utilization outside 0..1 in an event is refused, not guessed (no double conversion either way)', () => {
	for (const bad of [65, 1.5, -0.1, NaN, Infinity, '0.5', null, undefined]) {
		assert.equal(core.parseMessageLimit({ windows: { '5h': { utilization: bad, resets_at: 1791749400 } } }, NOW), null, String(bad));
	}
});

// ---- zero is real, missing is not -----------------------------------------------------------------

test('U05 an explicitly reported 0 is a real 0%, shown as 0%', () => {
	const w = core.parseMessageLimit({ windows: { '5h': { status: 1, utilization: 0, resets_at: 1791749400 } } }, NOW);
	assert.equal(w.utilization, 0);
	const view = core.computeView(w, NOW);
	assert.equal(view.status, 'live');
	assert.equal(view.pctText, '0%');
	assert.equal(view.leftText, '100% LEFT');
});

test('U06 missing is never 0%: no window, weekly-only, empty, or garbage all give null', () => {
	const cases = [null, undefined, {}, { windows: {} }, { windows: { '7d': { utilization: 0.3, resets_at: 1791990000 } } }, { windows: { '5h': {} } }, { windows: { '5h': null } }, 'x', 5];
	for (const raw of cases) assert.equal(core.parseMessageLimit(raw, NOW), null, JSON.stringify(raw));
	for (const raw of [null, {}, { five_hour: null }, { five_hour: {} }, { five_hour: { utilization: null } }, { seven_day: { utilization: 20 } }, []]) {
		assert.equal(core.parseUsageEndpoint(raw, NOW), null, JSON.stringify(raw));
	}
});

test('U07 the view of "never reported" has no number at all', () => {
	const view = core.computeView(null, NOW);
	assert.equal(view.status, 'waiting');
	assert.equal(view.pct, null);
	assert.equal(view.pctText, '--');
	assert.equal(view.message, 'Waiting for session usage data');
	assert.equal(view.countdownText, 'Reset time unavailable');
	assert.equal(view.usedText + view.leftText, '');
	assert.ok(!/\b0\s*%/.test(JSON.stringify(view)), 'no 0% anywhere in the waiting view');
});

test('U08 weekly data never leaks into the session view', () => {
	const merged = core.parseMessageLimit({ windows: { '5h': { utilization: 0.2, resets_at: 1791749400 }, '7d': { utilization: 0.9, resets_at: 1791990000 } } }, NOW);
	assert.equal(merged.utilization, 20);
	assert.equal(core.parseUsageEndpoint({ five_hour: null, seven_day: { utilization: 90, resets_at: '2026-10-14T15:00:00Z' } }, NOW), null);
});

// ---- view ------------------------------------------------------------------------------------------

test('U09 view numbers: used + left add up to 100, one decimal only when needed', () => {
	for (const pct of [0, 1, 12.5, 33.3, 64.6, 65, 99.9, 100]) {
		const view = core.computeView(live(pct, NOW + H), NOW);
		const used = parseFloat(view.usedText);
		const left = parseFloat(view.leftText);
		assert.ok(Math.abs(used + left - 100) < 0.11, `${pct}: ${view.usedText} / ${view.leftText}`);
		assert.equal(view.barWidth, pct);
	}
	assert.equal(core.computeView(live(65, NOW + H), NOW).pctText, '65%');
	assert.equal(core.computeView(live(64.6, NOW + H), NOW).pctText, '64.6%');
});

test('U10 warning levels: ok below 80, warn from 80, full from 95', () => {
	const level = (p) => core.computeView(live(p, NOW + H), NOW).level;
	assert.deepEqual([level(10), level(79.9), level(80), level(94.9), level(95), level(100)], ['ok', 'ok', 'warn', 'warn', 'full', 'full']);
});

// ---- countdown formatting -----------------------------------------------------------------------------

test('U11 countdown formats (minutes, no seconds): five hours, one hour, ten minutes, one second, zero', () => {
	assert.equal(core.formatCountdown(5 * H), '05h 00m');
	assert.equal(core.formatCountdown(1 * H), '01h 00m');
	assert.equal(core.formatCountdown(10 * 60 * 1000), '00h 10m');
	assert.equal(core.formatCountdown(1000), '00h 01m');
	assert.equal(core.formatCountdown(0), '00h 00m');
	assert.equal(core.formatCountdown(-5000), '00h 00m');
	assert.equal(core.formatCountdown((4 * 3600 + 32 * 60 + 18) * 1000), '04h 33m');
});

test('U12 a part of a minute counts as the whole minute: 00h 00m is shown only at the reset itself', () => {
	assert.equal(core.formatCountdown(1), '00h 01m');
	assert.equal(core.formatCountdown(60000), '00h 01m');
	assert.equal(core.formatCountdown(60001), '00h 02m');
});

test('U13 the countdown comes from the absolute reset time: remaining = resets_at - now', () => {
	const reset = NOW + (4 * 3600 + 32 * 60 + 18) * 1000;
	const w = live(65, reset);
	assert.equal(core.computeView(w, NOW).countdownText, '04h 33m');
	assert.equal(core.computeView(w, NOW + 18 * 1000).countdownText, '04h 32m');
	assert.equal(core.computeView(w, reset - 1000).countdownText, '00h 01m');
	// installing or opening the page later changes nothing: only the timestamp matters
	assert.equal(core.computeView({ ...w, received_at: NOW - 3 * H }, NOW).countdownText, '04h 33m');
});

test('U14 missing reset time: percent still shown, countdown says so', () => {
	const view = core.computeView(live(40, null), NOW);
	assert.equal(view.status, 'live');
	assert.equal(view.pctText, '40%');
	assert.equal(view.countdownText, 'Reset time unavailable');
});

test('U15 a window without a reset time cannot outlive five hours', () => {
	const w = live(40, null);
	assert.equal(core.hasEnded(w, NOW + 5 * H - 1), false);
	assert.equal(core.hasEnded(w, NOW + 5 * H), true);
	assert.equal(core.computeView(w, NOW + 5 * H).status, 'expired');
});

// ---- expiry ---------------------------------------------------------------------------------------------

test('U16 at the reset time the window becomes expired: no stale percent, no 0% either', () => {
	const w = live(76, NOW + H);
	assert.equal(core.expire(w, NOW + H - 1), w);
	const ended = core.expire(w, NOW + H);
	assert.equal(ended.expired, true);
	const view = core.computeView(w, NOW + H);
	assert.equal(view.status, 'expired');
	assert.equal(view.pct, null);
	assert.ok(!/76/.test(JSON.stringify(view)), 'old value is gone');
	assert.ok(!/\b0\s*%/.test(JSON.stringify(view)), 'and it is not turned into 0%');
	assert.equal(core.expire(ended, NOW + 10 * H), ended, 'expired stays expired');
});

// ---- merging ----------------------------------------------------------------------------------------------

test('U17 merge: newer window accepted, same window updated, older window ignored, ended window refused', () => {
	const cur = live(50, NOW + 2 * H);
	assert.equal(core.mergeWindow(cur, live(60, NOW + 2 * H), NOW).accepted, true, 'same window, more used');
	assert.equal(core.mergeWindow(cur, live(5, NOW + 7 * H), NOW).accepted, true, 'a later window (reset updated)');
	const old = core.mergeWindow(cur, live(10, NOW + H), NOW);
	assert.equal(old.accepted, false);
	assert.equal(old.reason, 'older_window');
	assert.equal(old.state, cur);
	const ended = core.mergeWindow(cur, live(10, NOW - 1000), NOW);
	assert.equal(ended.accepted, false);
	assert.equal(ended.reason, 'incoming_already_ended');
	assert.equal(core.mergeWindow(null, live(10, NOW + H), NOW).accepted, true);
	assert.equal(core.mergeWindow({ expired: true, resets_at: iso(NOW - H) }, live(10, NOW + H), NOW).accepted, true, 'a new window replaces an ended one');
	assert.equal(core.mergeWindow(cur, null, NOW).accepted, false);
});
