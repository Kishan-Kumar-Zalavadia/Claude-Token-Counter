'use strict';

// The real bridge.js and the real content scripts, a fake DOM, recorded frames and a manual clock.

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const fixtures = require('./fixtures/frames.json');
const proto = require('./helpers/proto');
const { createE2E, ORG, OTHER_ORG, CONV, FIXTURE_RESET_MS } = require('./helpers/e2e-harness');
const { STREAM_URL } = require('./helpers/bridge-harness');

const frame = (name) => proto.fromHex(fixtures.frames[name].hex);
const H = 3600 * 1000;
const MIN = 60 * 1000;

const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));
test.afterEach(() => {
	assert.deepEqual(unhandled.splice(0), [], 'unhandled rejection');
});

/** A limits frame for "now + resetInMs": window 5h, utilization fraction (null = left out like proto3 does for 0). */
function limitsFrame(env, { fiveH = [0.2, 3 * H], sevenD = [0.1, 48 * H], cursor } = {}) {
	const nowS = Math.floor(env.clock.now / 1000);
	const windows = [];
	if (fiveH) windows.push(['5h', 1, nowS + Math.floor(fiveH[1] / 1000), fiveH[0]]);
	if (sevenD) windows.push(['7d', 1, nowS + Math.floor(sevenD[1] / 1000), sevenD[0]]);
	return proto.connectFrame(0, proto.limitsPayload({ windows, ...(cursor ? { cursor } : {}) }));
}

function sse(env, { fiveH = [0.2, 3 * H], sevenD = [0.1, 48 * H] } = {}) {
	const nowS = Math.floor(env.clock.now / 1000);
	const windows = {};
	if (fiveH) windows['5h'] = { status: 'within_limit', resets_at: fiveH[1] === null ? null : nowS + Math.floor(fiveH[1] / 1000), utilization: fiveH[0] };
	if (sevenD) windows['7d'] = { status: 'within_limit', resets_at: nowS + Math.floor(sevenD[1] / 1000), utilization: sevenD[0] };
	const message_limit = { type: 'within_limit', windows };
	return [Buffer.from(`event: message_limit\ndata: ${JSON.stringify({ type: 'message_limit', message_limit })}\n\n`)];
}

// =========================================================================================================
// OLD INTERFACE: /completion + text/event-stream + message_limit
// =========================================================================================================

test('O01 a /completion event-stream is detected as the old interface', async () => {
	const env = createE2E();
	await env.reply(sse(env), { url: `https://claude.ai/api/organizations/${ORG}/chat_conversations/${CONV}/completion` });
	assert.equal(env.diagLines('INTERFACE_OLD').length, 1);
	assert.equal(env.CC.diag.state.interface, 'old');
	assert.equal(env.diagLines('INTERFACE_NEW').length, 0);
});

test('O02 SSE message_limit: five-hour utilization and reset time are read and shown', async () => {
	const env = createE2E();
	await env.reply(sse(env, { fiveH: [0.65, 4 * H + 32 * MIN + 18000] }), { url: `https://claude.ai/api/organizations/${ORG}/chat_conversations/${CONV}/completion` });
	assert.equal(env.text('.ccr-pct'), '65%');
	assert.equal(env.text('.ccr-used'), '65% USED');
	assert.equal(env.text('.ccr-left'), '35% LEFT');
	assert.equal(env.text('.ccr-countdown'), '04h 33m');
	assert.match(env.text('.ccr-updated'), /^Last updated: \d{1,2}:\d{2}/);
	assert.equal(env.dashboard().querySelector('.ccr-fill').style.width, '65%');
});

test('O03 the countdown is kept current every second but shown in whole minutes (no seconds)', async () => {
	const env = createE2E();
	await env.reply(sse(env, { fiveH: [0.3, 2 * H] }), { url: `https://claude.ai/api/organizations/${ORG}/chat_conversations/${CONV}/completion` });
	assert.equal(env.text('.ccr-countdown'), '02h 00m');
	assert.ok(!/\ds/.test(env.text('.ccr-countdown')), 'no seconds shown');
	await env.advance(1000);
	assert.equal(env.text('.ccr-countdown'), '02h 00m', 'a few seconds do not change a rounded-up minute');
	await env.advance(59 * 1000);
	assert.equal(env.text('.ccr-countdown'), '01h 59m');
	await env.advance(60 * 1000);
	assert.equal(env.text('.ccr-countdown'), '01h 58m');
});

test('O04 an SSE window explicitly reported at 0 shows 0% (a real zero)', async () => {
	const env = createE2E();
	await env.reply(sse(env, { fiveH: [0, 5 * H] }), { url: `https://claude.ai/api/organizations/${ORG}/chat_conversations/${CONV}/completion` });
	assert.equal(env.text('.ccr-pct'), '0%');
	assert.equal(env.text('.ccr-left'), '100% LEFT');
});

test('O05 an SSE window without a utilization number is NOT shown as 0%', async () => {
	const env = createE2E();
	const body = { type: 'message_limit', message_limit: { windows: { '5h': { status: 'within_limit', resets_at: Math.floor(env.clock.now / 1000) + 3600 } } } };
	await env.reply([Buffer.from(`data: ${JSON.stringify(body)}\n\n`)], { url: `https://claude.ai/api/organizations/${ORG}/chat_conversations/${CONV}/completion` });
	assert.match(env.visibleText(), /Waiting for session usage data/);
	assert.ok(!/\b0%/.test(env.visibleText()));
	assert.equal(env.diagLines('MISSING_UTILIZATION').length, 1);
});

// =========================================================================================================
// NEW INTERFACE: StreamTimeline, Connect frames, protobuf
// =========================================================================================================

test('N01 a StreamTimeline request is detected as the new interface', async () => {
	const env = createE2E();
	await env.reply([frame('keepalive')]);
	assert.equal(env.diagLines('INTERFACE_NEW').length, 1);
	assert.equal(env.CC.diag.state.interface, 'new');
});

test('N02 recorded real frames: 5h = 76%, reset 2026-10-11T20:10:00Z, countdown 04h 32m 18s', async () => {
	const env = createE2E();
	await env.reply([frame('limits_5h_first')]);
	assert.equal(env.text('.ccr-pct'), '76%');
	assert.equal(env.text('.ccr-left'), '24% LEFT');
	assert.equal(env.text('.ccr-countdown'), '04h 33m');
	// the weekly value of the same frame (25%) is not what is shown
	assert.ok(!/\b25%/.test(env.visibleText()));
	assert.equal(env.savedFor(ORG).usage.resets_at, '2026-10-11T20:10:00.000Z');
});

test('N03 the usage event is identified inside a stream of other frames', async () => {
	const env = createE2E();
	await env.reply([frame('keepalive'), frame('text_delta_emoji'), frame('limits_7d_first'), frame('keepalive'), frame('end_cadence')]);
	assert.equal(env.text('.ccr-pct'), '76%');
	assert.equal(env.diagLines('SESSION_EXTRACTED').length, 1);
});

test('N04 partial network chunks: one byte at a time gives the same result', async () => {
	const env = createE2E();
	const bytes = frame('limits_5h_first');
	await env.reply(Array.from(bytes, (b) => Buffer.from([b])));
	assert.equal(env.text('.ccr-pct'), '76%');
	assert.equal(env.diagLines('SESSION_EXTRACTED').length, 1);
});

test('N05 multiple frames in one chunk are all processed (two replies, second wins)', async () => {
	const env = createE2E();
	const a = limitsFrame(env, { fiveH: [0.2, 3 * H] });
	const b = limitsFrame(env, { fiveH: [0.4, 3 * H] });
	await env.reply([Buffer.concat([a, b])]);
	assert.equal(env.text('.ccr-pct'), '40%');
	assert.equal(env.diagLines('SESSION_EXTRACTED').length, 2);
});

test('N06 replayed events are de-duplicated by event id, not by percentage', async () => {
	const env = createE2E();
	const f = frame('limits_5h_first');
	await env.reply([f, f]); // same event twice in one stream
	await env.reply([f]); // and again after the stream was reopened
	assert.equal(env.diagLines('SESSION_EXTRACTED').length, 1);
	assert.equal(env.diagLines('LIMIT_REPLAY_IGNORED').length, 2);
});

test('N07 a NEW event with identical rounded limits is a new reply and is applied', async () => {
	const env = createE2E();
	await env.reply([frame('limits_5h_first'), frame('limits_5h_first_turn2')]);
	assert.equal(env.diagLines('SESSION_EXTRACTED').length, 2, 'different event ids, same 76%');
});

test('N08 reconnected stream: replay ignored, then a genuinely newer event updates the bar', async () => {
	const env = createE2E();
	const first = limitsFrame(env, { fiveH: [0.3, 3 * H], cursor: '1791743563668-0' });
	await env.reply([first]);
	assert.equal(env.text('.ccr-pct'), '30%');
	await env.reply([first]); // reconnect replays it
	assert.equal(env.text('.ccr-pct'), '30%');
	await env.reply([limitsFrame(env, { fiveH: [0.35, 3 * H], cursor: '1791743999999-0' })]);
	assert.equal(env.text('.ccr-pct'), '35%');
});

test('N09 compressed frames do not break the parser; limits after them are still read', async () => {
	const env = createE2E();
	const snapshot = proto.connectFrame(1, zlib.gzipSync(proto.snapshotPayload('1791743563000-0', 'Hello', 2)));
	const broken = proto.connectFrame(1, Buffer.from('this is not gzip'));
	await env.reply([snapshot, broken, frame('limits_5h_first')]);
	assert.equal(env.text('.ccr-pct'), '76%');
	assert.equal(env.diagLines('GUNZIP_FAILED').length >= 1, true, 'the corrupt frame was reported, not thrown');
});

test('N10 invalid frames are safely ignored: garbage, truncated, absurd length', async () => {
	const env = createE2E();
	const garbage = proto.connectFrame(0, Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
	const truncated = frame('limits_5h_first').subarray(0, 40);
	await env.reply([garbage, truncated]);
	assert.match(env.visibleText(), /Waiting for session usage data/);
	// an absurd frame length stops parsing quietly
	await env.reply([Buffer.from([0, 0xff, 0xff, 0xff, 0xff, 1, 2, 3])]);
	assert.equal(env.diagLines('STREAM_UNPARSEABLE').length, 1);
	// and the very next good stream still works
	await env.reply([frame('limits_5h_first')]);
	assert.equal(env.text('.ccr-pct'), '76%');
});

test('N11 empty frames, keep-alives and end-of-stream frames produce nothing and break nothing', async () => {
	const env = createE2E();
	await env.reply([proto.connectFrame(0, Buffer.alloc(0)), frame('keepalive'), frame('end_cadence'), proto.endFrame({ error: { code: 'unavailable', message: 'x' }, metadata: {} })]);
	assert.match(env.visibleText(), /Waiting for session usage data/);
	assert.equal(env.diagLines('SESSION_EXTRACTED').length, 0);
});

test('N12 a weekly-only event changes nothing and is never a 0% session', async () => {
	const env = createE2E();
	await env.reply([limitsFrame(env, { fiveH: null, sevenD: [0.5, 48 * H] })]);
	assert.match(env.visibleText(), /Waiting for session usage data/);
	assert.ok(!/\b0%/.test(env.visibleText()));
	assert.equal(env.diagLines('NO_SESSION_WINDOW').length, 1);
});

test('N13 proto3: a five-hour window reported WITHOUT a double is a real 0%; a window not reported at all is not', async () => {
	const env = createE2E();
	await env.reply([limitsFrame(env, { fiveH: [null, 5 * H], sevenD: null })]);
	assert.equal(env.text('.ccr-pct'), '0%');
	assert.equal(env.text('.ccr-left'), '100% LEFT');

	const env2 = createE2E();
	await env2.reply([limitsFrame(env2, { fiveH: null, sevenD: [0.4, 40 * H] })]);
	assert.equal(env2.text('.ccr-pct'), '--');
});

test('N14 old and new interface events in the same page both work (either may be served)', async () => {
	const env = createE2E();
	await env.reply(sse(env, { fiveH: [0.2, 3 * H] }), { url: `https://claude.ai/api/organizations/${ORG}/chat_conversations/${CONV}/completion` });
	assert.equal(env.text('.ccr-pct'), '20%');
	await env.reply([limitsFrame(env, { fiveH: [0.3, 3 * H] })]);
	assert.equal(env.text('.ccr-pct'), '30%');
});

test('N15 an older window arriving late does not replace a newer one', async () => {
	const env = createE2E();
	await env.reply([limitsFrame(env, { fiveH: [0.3, 4 * H] })]);
	await env.reply([limitsFrame(env, { fiveH: [0.9, 1 * H] })]); // resets earlier = an older window
	assert.equal(env.text('.ccr-pct'), '30%');
	assert.equal(env.diagLines('EVENT_IGNORED').length >= 1, true);
});

// =========================================================================================================
// FREE ACCOUNT
// =========================================================================================================

test('F01 /usage returns an empty answer: no false 0%, nothing is invented', async () => {
	const env = createE2E({ usage: { status: 200, body: {} } });
	await env.flush();
	await env.advance(2000);
	assert.equal(env.server.usageRequests.length, 1);
	assert.match(env.visibleText(), /Waiting for session usage data/);
	assert.ok(!/\b0\s*%/.test(env.visibleText()));
	assert.equal(env.text('.ccr-pct'), '--');
	assert.equal(env.diagLines('USAGE_EMPTY').length, 1);
});

test('F02 an empty /usage is not polled again and again: once, then once an hour', async () => {
	const env = createE2E({ usage: { status: 200, body: { five_hour: null, seven_day: null } } });
	await env.flush();
	await env.advance(59 * MIN);
	assert.equal(env.server.usageRequests.length, 1, 'one request in the first 59 minutes');
	await env.advance(2 * MIN);
	assert.equal(env.server.usageRequests.length, 2, 'the next one only after the hour');
});

test('F03 a failing /usage backs off: 1, 2, 4, 8 ... minutes, never faster, capped at an hour', async () => {
	const env = createE2E({ usage: { status: 500, body: {} } });
	await env.flush();
	await env.advance(2 * H + 10 * MIN);
	const times = env.server.usageRequests.map((r) => Math.round((r.at - env.server.usageRequests[0].at) / MIN));
	const gaps = times.slice(1).map((t, i) => t - times[i]);
	assert.deepEqual(gaps.slice(0, 6), [1, 2, 4, 8, 16, 32]);
	assert.ok(gaps.every((g) => g >= 1 && g <= 60), `gaps: ${gaps}`);
	assert.ok(env.server.usageRequests.length <= 12, `requests: ${env.server.usageRequests.length}`);
	assert.match(env.visibleText(), /Waiting for session usage data/);
});

test('F04 a hidden tab does not poll', async () => {
	const env = createE2E({ usage: { status: 500, body: {} } });
	env.dom.document.hidden = true;
	await env.flush();
	await env.advance(30 * MIN);
	assert.equal(env.server.usageRequests.length, 0);
	env.dom.document.hidden = false;
	await env.advance(2000);
	assert.equal(env.server.usageRequests.length, 1);
});

test('F05 a valid StreamTimeline event supplies the data when /usage has none, and it is saved for this organisation', async () => {
	const env = createE2E({ usage: { status: 200, body: {} } });
	await env.flush();
	assert.equal(env.text('.ccr-pct'), '--');
	await env.reply([frame('limits_5h_first')]);
	assert.equal(env.text('.ccr-pct'), '76%');
	const saved = env.savedFor(ORG);
	assert.equal(saved.orgId, ORG);
	assert.equal(saved.usage.utilization, 76);
	assert.equal(saved.usage.resets_at, '2026-10-11T20:10:00.000Z');
	assert.equal(env.savedFor(OTHER_ORG), undefined);
});

test('F06 an empty /usage never deletes what is known or saved', async () => {
	const env = createE2E({ usage: { status: 200, body: {} } });
	await env.reply([frame('limits_5h_first')]);
	env.server.usage.body = {};
	await env.advance(61 * MIN - 5 * 60 * 1000); // an hourly poll happens while the window is live
	assert.equal(env.text('.ccr-pct'), '76%');
	assert.equal(env.savedFor(ORG).usage.utilization, 76);
});

test('F07 after a reload the usage and the reset time are restored from storage, with no request needed', async () => {
	const first = createE2E();
	await first.reply([frame('limits_5h_first')]);
	const storage = JSON.parse(JSON.stringify(first.storage));

	await first.advance(10 * MIN);
	const second = createE2E({ storage, startMs: first.clock.now, usage: { status: 200, body: {} } });
	await second.flush();
	assert.equal(second.text('.ccr-pct'), '76%');
	assert.equal(second.text('.ccr-countdown'), '04h 23m', 'continues from the absolute reset time');
	assert.equal(second.server.usageRequests.length, 0, 'a live saved window needs no /usage request');
	assert.equal(second.diagLines('USAGE_RESTORED').length, 1);
});

test('F08 saved usage of another organisation is never shown, and is left untouched', async () => {
	const first = createE2E();
	await first.reply([frame('limits_5h_first')]);
	const storage = JSON.parse(JSON.stringify(first.storage));

	const other = createE2E({ storage, cookie: `lastActiveOrg=${OTHER_ORG}`, startMs: first.clock.now });
	await other.flush();
	assert.match(other.visibleText(), /Waiting for session usage data/);
	assert.equal(other.text('.ccr-pct'), '--');
	assert.equal(JSON.stringify(other.storage[`ccr_usage_v1_${ORG}`]), JSON.stringify(storage[`ccr_usage_v1_${ORG}`]));
});

test('F09 switching account while the page is open: the previous account\'s usage disappears, its own saved usage appears', async () => {
	const seed = createE2E({ cookie: `lastActiveOrg=${OTHER_ORG}` });
	await seed.reply([limitsFrame(seed, { fiveH: [0.55, 2 * H] })]);
	const storage = JSON.parse(JSON.stringify(seed.storage));

	const env = createE2E({ storage, startMs: seed.clock.now });
	await env.reply([limitsFrame(env, { fiveH: [0.1, 4 * H] })]);
	assert.equal(env.text('.ccr-pct'), '10%');
	await env.pageRequest(`https://claude.ai/api/organizations/${OTHER_ORG}/chat_conversations`);
	await env.advance(1000);
	assert.equal(env.text('.ccr-pct'), '55%', 'the other account\'s own saved usage');
	assert.equal(env.savedFor(ORG).usage.utilization, 10, 'the first account\'s data was not overwritten');
	assert.equal(env.diagLines('ORG_CHANGED').length, 1);
});

test('F10 a saved window that ended while the page was closed is not shown; fresh data is requested once', async () => {
	const first = createE2E();
	await first.reply([frame('limits_5h_first')]);
	const storage = JSON.parse(JSON.stringify(first.storage));

	const later = createE2E({ storage, startMs: FIXTURE_RESET_MS + 2 * H, usage: { status: 200, body: {} } });
	await later.flush();
	await later.advance(2000);
	assert.ok(!/76/.test(later.visibleText()), 'the old 76% is gone');
	assert.ok(!/\b0\s*%/.test(later.visibleText()), 'and it is not replaced by a fake 0%');
	assert.match(later.visibleText(), /Session window ended/);
	assert.equal(later.server.usageRequests.length, 1);
	await later.advance(30 * MIN);
	assert.equal(later.server.usageRequests.length, 1, 'the free plan is asked once, then left alone');
});

test('F11 a paid plan: /usage supplies the percent (already 0..100, not multiplied again)', async () => {
	const resets = new Date(FIXTURE_RESET_MS).toISOString();
	const env = createE2E({ usage: { status: 200, body: { five_hour: { utilization: 65, resets_at: resets }, seven_day: { utilization: 20, resets_at: resets } } } });
	await env.flush();
	await env.advance(2000);
	assert.equal(env.text('.ccr-pct'), '65%');
	assert.equal(env.text('.ccr-countdown'), '04h 33m');
});

test('F12 the organisation id comes from the page\'s own requests when the cookie is unreadable', async () => {
	const env = createE2E({ cookie: '' });
	await env.flush();
	assert.equal(env.diagLines('ORG_UNRESOLVED').length, 1);
	await env.pageRequest(`https://claude.ai/api/organizations/${ORG}/chat_conversations`);
	await env.reply([frame('limits_5h_first')]);
	assert.equal(env.savedFor(ORG).usage.utilization, 76);
	assert.equal(env.diagLines('ORG_RESOLVED').length, 1);
});

test('F13 an unresolvable organisation is reported, never guessed: no storage key is written', async () => {
	const env = createE2E({ cookie: '' });
	await env.reply([frame('limits_5h_first')]);
	assert.equal(env.text('.ccr-pct'), '76%', 'live data is still shown');
	assert.deepEqual(Object.keys(env.storage), [], 'but nothing is saved without knowing the account');
});

test('F14 with several organisations and none marked active, none is guessed', async () => {
	const env = createE2E({ cookie: '' });
	env.server.organizations = [{ uuid: ORG }, { uuid: OTHER_ORG }];
	await env.flush();
	await env.advance(2000);
	assert.equal(env.diagLines('ORG_RESOLVED').length, 0);
	assert.equal(env.diagLines('ORG_UNRESOLVED').length, 1);
});

test('F15 another tab of the same account receives newer data: this tab follows', async () => {
	const env = createE2E();
	await env.reply([limitsFrame(env, { fiveH: [0.2, 3 * H] })]);
	const newer = { ...env.savedFor(ORG).usage, utilization: 42, received_at: env.clock.now + 1000 };
	env.chrome.storage.local.set({ [`ccr_usage_v1_${ORG}`]: { orgId: ORG, usage: newer, savedAt: env.clock.now } });
	await env.flush();
	await env.advance(1000);
	assert.equal(env.text('.ccr-pct'), '42%');
});

// =========================================================================================================
// UI
// =========================================================================================================

test('UI01 the dashboard sits directly below the composer\'s input area, on a new conversation', async () => {
	const env = createE2E({ pathname: '/new' });
	const { flow, box } = env.composer;
	assert.equal(env.dashboards().length, 1);
	assert.equal(flow.nextElementSibling, env.dashboard());
	assert.equal(env.dashboard().parentElement, box);
});

test('UI02 the dashboard appears on an existing conversation too', async () => {
	const env = createE2E({ pathname: `/chat/${CONV}` });
	assert.equal(env.dashboards().length, 1);
	assert.equal(env.composer.flow.nextElementSibling, env.dashboard());
});

test('UI03 it is mounted once and never duplicated, even when asked repeatedly or loaded twice', async () => {
	const env = createE2E();
	for (let i = 0; i < 5; i++) {
		env.CC.__started = false; // simulate the script being injected again
		env.loadContent();
	}
	await env.advance(3000);
	env.dom.fireMutations();
	await env.advance(200);
	assert.equal(env.dashboards().length, 1);
});

test('UI04 the page replaces the composer (route change): the dashboard is re-attached to the new one', async () => {
	const env = createE2E({ pathname: '/new' });
	const old = env.composer;
	old.box.remove(); // the page throws the old composer away
	const next = env.dom.buildComposer();
	env.navigate(`/chat/${CONV}`);
	env.dom.fireMutations();
	await env.advance(200);
	assert.equal(env.dashboards().length, 1);
	assert.equal(next.flow.nextElementSibling, env.dashboard());
	assert.equal(env.diagLines('DASHBOARD_REATTACHED').length >= 1, true);
});

test('UI05 the dashboard keeps its data across conversation switches', async () => {
	const env = createE2E();
	await env.reply([frame('limits_5h_first')]);
	for (const p of ['/new', `/chat/${CONV}`, '/chat/aaaaaaaa-0000-4000-8000-000000000002', '/recents', `/chat/${CONV}`]) {
		env.composer.box.remove();
		env.dom.buildComposer();
		env.navigate(p);
		env.dom.fireMutations();
		await env.advance(1200);
		assert.equal(env.dashboards().length, 1, p);
		assert.equal(env.text('.ccr-pct'), '76%', p);
	}
});

test('UI06 survives a full page refresh: a new page shows the saved usage straight away', async () => {
	const first = createE2E();
	await first.reply([frame('limits_5h_first')]);
	const reloaded = createE2E({ storage: JSON.parse(JSON.stringify(first.storage)), startMs: first.clock.now });
	await reloaded.flush();
	assert.equal(reloaded.dashboards().length, 1);
	assert.equal(reloaded.text('.ccr-pct'), '76%');
});

test('UI07 no composer yet: silent during the start-up grace period, reported once afterwards; mounts as soon as it exists', async () => {
	const env = createE2E({ withComposer: false });
	await env.advance(10000);
	assert.equal(env.dashboards().length, 0);
	assert.equal(env.diagLines('UI_MOUNT_FAILED').length, 0, 'the page is still starting: not a warning (Chrome lists warnings as extension errors)');
	await env.advance(10000);
	assert.equal(env.diagLines('UI_MOUNT_FAILED').length, 1);
	await env.advance(10000);
	assert.equal(env.diagLines('UI_MOUNT_FAILED').length, 1, 'throttled, not once per second');
	env.dom.buildComposer();
	env.dom.fireMutations();
	await env.advance(200);
	assert.equal(env.dashboards().length, 1);
});

test('UI07b a composer that appears a moment after start-up (normal) produces no warning at all', async () => {
	const env = createE2E({ withComposer: false });
	await env.advance(1500);
	env.dom.buildComposer();
	env.dom.fireMutations();
	await env.advance(300);
	assert.equal(env.dashboards().length, 1);
	assert.equal(env.logs.filter((l) => l.level === 'warn' || l.level === 'error').length, 0);
});

test('UI08 only text is written to the page (no markup injection from data)', async () => {
	const env = createE2E();
	await env.reply([frame('limits_5h_first')]);
	const html = JSON.stringify(env.dashboard(), (k, v) => (k === 'ownerDocument' || k === 'parentElement' ? undefined : v));
	assert.ok(!/<script|onerror|innerHTML/i.test(html));
});

// =========================================================================================================
// COUNTDOWN
// =========================================================================================================

test('C01 five hours, one hour, ten minutes, one second remaining', async () => {
	const env = createE2E();
	await env.reply([limitsFrame(env, { fiveH: [0.1, 5 * H] })]);
	assert.equal(env.text('.ccr-countdown'), '05h 00m');
	await env.advance(4 * H);
	assert.equal(env.text('.ccr-countdown'), '01h 00m');
	await env.advance(50 * MIN);
	assert.equal(env.text('.ccr-countdown'), '00h 10m');
	await env.advance(10 * MIN - 1000);
	assert.equal(env.text('.ccr-countdown'), '00h 01m');
});

test('C02 the session expires: the old percentage goes away, a refresh is triggered, nothing is faked', async () => {
	const env = createE2E({ usage: { status: 200, body: {} } });
	await env.reply([limitsFrame(env, { fiveH: [0.8, 10 * MIN] })]);
	await env.advance(2000);
	const before = env.server.usageRequests.length;
	assert.equal(env.text('.ccr-pct'), '80%');
	await env.advance(10 * MIN);
	assert.match(env.visibleText(), /Session window ended/);
	assert.ok(!/80/.test(env.visibleText()));
	assert.ok(!/\b0\s*%/.test(env.visibleText()));
	assert.equal(env.diagLines('WINDOW_EXPIRED').length, 1);
	assert.equal(env.server.usageRequests.length, before + 1, 'exactly one refresh at the end of the window');
	await env.advance(20 * MIN);
	assert.equal(env.server.usageRequests.length, before + 1, 'and no polling loop afterwards');
});

test('C03 after the window ended, the next event starts a fresh one', async () => {
	const env = createE2E();
	await env.reply([limitsFrame(env, { fiveH: [0.8, 10 * MIN] })]);
	await env.advance(11 * MIN);
	assert.match(env.visibleText(), /Session window ended/);
	await env.reply([limitsFrame(env, { fiveH: [0.02, 5 * H] })]);
	assert.equal(env.text('.ccr-pct'), '2%');
	assert.equal(env.text('.ccr-countdown'), '05h 00m');
});

test('C04 the computer sleeps for three hours: the countdown is right on wake-up (absolute timestamps)', async () => {
	const env = createE2E();
	await env.reply([limitsFrame(env, { fiveH: [0.5, 4 * H] })]);
	env.clock.jump(3 * H); // no timers run while asleep
	env.dom.document.hidden = false;
	env.window.dispatchEvent({ type: 'pageshow' });
	await env.flush();
	assert.equal(env.text('.ccr-countdown'), '01h 00m');
});

test('C05 the computer sleeps past the reset: it wakes up expired and asks for fresh data', async () => {
	const env = createE2E({ usage: { status: 200, body: {} } });
	await env.reply([limitsFrame(env, { fiveH: [0.5, 1 * H] })]);
	const before = env.server.usageRequests.length;
	env.clock.jump(2 * H);
	await env.advance(1000);
	assert.match(env.visibleText(), /Session window ended/);
	assert.ok(!/50/.test(env.visibleText()));
	assert.equal(env.server.usageRequests.length, before + 1);
});

test('C06 the reset timestamp is updated by a newer event', async () => {
	const env = createE2E();
	await env.reply([limitsFrame(env, { fiveH: [0.5, 1 * H] })]);
	assert.equal(env.text('.ccr-countdown'), '01h 00m');
	await env.reply([limitsFrame(env, { fiveH: [0.05, 5 * H] })]);
	assert.equal(env.text('.ccr-countdown'), '05h 00m');
});

test('C07 the reset timestamp is missing: "Reset time unavailable", percent still shown, never a made-up countdown', async () => {
	const env = createE2E();
	const nowS = Math.floor(env.clock.now / 1000);
	const body = { type: 'message_limit', message_limit: { windows: { '5h': { status: 'within_limit', utilization: 0.4, resets_at: null } } } };
	void nowS;
	await env.reply([Buffer.from(`data: ${JSON.stringify(body)}\n\n`)], { url: `https://claude.ai/api/organizations/${ORG}/chat_conversations/${CONV}/completion` });
	assert.equal(env.text('.ccr-pct'), '40%');
	assert.equal(env.text('.ccr-countdown'), 'Reset time unavailable');
	assert.equal(env.diagLines('MISSING_RESET').length, 1);
	await env.advance(5 * 1000);
	assert.equal(env.text('.ccr-countdown'), 'Reset time unavailable', 'it does not start counting from the moment the page opened');
});

test('C08 the countdown never starts from the extension start or page open time', async () => {
	const early = createE2E();
	await early.reply([frame('limits_5h_first')]);
	const late = createE2E({ startMs: FIXTURE_RESET_MS - (4 * 3600 + 32 * 60 + 18) * 1000 + 2 * H });
	await late.reply([frame('limits_5h_first')]);
	assert.equal(early.text('.ccr-countdown'), '04h 33m');
	assert.equal(late.text('.ccr-countdown'), '02h 33m');
});

// =========================================================================================================
// REGRESSION: the extension must not disturb claude.ai
// =========================================================================================================

test('R01 the page\'s response is untouched: same object, identical bytes, readable after our clone was read', async () => {
	const env = createE2E();
	const bytes = await env.reply([frame('limits_5h_first'), frame('end_cadence')]);
	assert.deepEqual(Buffer.from(bytes), Buffer.concat([frame('limits_5h_first'), frame('end_cadence')]));
});

test('R02 sending: request arguments reach the page\'s fetch unchanged', async () => {
	let seen;
	const env = createE2E();
	env.bridge.window.fetch = null; // not used: build a dedicated bridge below
	const { createBridgeEnv } = require('./helpers/bridge-harness');
	const body = JSON.stringify({ prompt: 'hello' });
	const headers = { 'content-type': 'application/json', authorization: 'Bearer SECRET-TOKEN-123' };
	const b = createBridgeEnv({
		originalFetch: async (...args) => {
			seen = args;
			return new Response('{}', { headers: { 'content-type': 'application/json' } });
		}
	});
	const url = `https://claude.ai/api/organizations/${ORG}/chat_conversations/${CONV}/completion`;
	const opts = { method: 'POST', body, headers };
	await b.fetch(url, opts);
	assert.equal(seen[0], url);
	assert.equal(seen[1], opts, 'the very same options object');
	assert.equal(seen[1].body, body);
});

test('R03 a failing fetch fails exactly as it would without the extension', async () => {
	const { createBridgeEnv } = require('./helpers/bridge-harness');
	const boom = new TypeError('Failed to fetch');
	const b = createBridgeEnv({ originalFetch: async () => Promise.reject(boom) });
	await assert.rejects(() => b.fetch(STREAM_URL, { method: 'POST' }), (e) => e === boom);
});

test('R04 a stream the page aborts half-way does not raise anything', async () => {
	const env = createE2E();
	const bytes = frame('limits_5h_first');
	await env.reply([bytes.subarray(0, 30)]);
	assert.match(env.visibleText(), /Waiting for session usage data/);
});

test('R05 a message from another window or without the marker is ignored', async () => {
	const env = createE2E();
	const before = env.visibleText();
	for (const fn of [] ) fn();
	env.window.postMessage({ type: 'cc:message_limit', payload: { windows: { '5h': { utilization: 0.99, resets_at: 1791749400 } } } });
	await env.flush();
	assert.equal(env.visibleText(), before, 'no marker: ignored');
});

test('R06 other API traffic produces no usage state', async () => {
	const env = createE2E();
	await env.pageRequest(`https://claude.ai/api/organizations/${ORG}/chat_conversations/${CONV}?tree=true`);
	await env.pageRequest('https://claude.ai/api/event_logging/batch');
	assert.match(env.visibleText(), /Waiting for session usage data/);
});

// =========================================================================================================
// DIAGNOSTICS AND PRIVACY
// =========================================================================================================

test('D01 every log line carries the prefix, and the key events are logged', async () => {
	const env = createE2E();
	await env.reply([frame('limits_5h_first')]);
	await env.advance(1500);
	for (const l of env.logs) assert.ok(l.text.startsWith('[Claude Counter Rebuilt]'), l.text);
	for (const code of ['INIT', 'DASHBOARD_MOUNTED', 'ORG_RESOLVED', 'INTERFACE_NEW', 'USAGE_EVENT', 'SESSION_EXTRACTED', 'USAGE_SAVED']) {
		assert.ok(env.diagLines(code).length >= 1, code);
	}
});

test('D02 no credential, token or full organisation id is ever logged', async () => {
	const env = createE2E({ cookie: `lastActiveOrg=${ORG}; sessionKey=sk-ant-SECRETVALUE; other=1` });
	await env.reply([frame('limits_5h_first')]);
	await env.advance(5000);
	const all = env.logs.map((l) => l.text).join('\n');
	assert.ok(!all.includes('SECRETVALUE'));
	assert.ok(!all.includes('sk-ant'));
	assert.ok(!all.includes(ORG), 'full organisation id');
	assert.ok(all.includes(ORG.slice(0, 8)), 'shortened id is logged');
});

test('D03 the cases the person must be able to tell apart are each reported with their own code', async () => {
	const none = createE2E();
	await none.flush();
	assert.equal(none.CC.diag.state.eventsReceived, 0); // 1. no usage event received

	const old = createE2E();
	await old.reply(sse(old), { url: `https://claude.ai/api/organizations/${ORG}/chat_conversations/${CONV}/completion` });
	assert.equal(old.CC.diag.state.interface, 'old'); // 2. old mechanism

	const neu = createE2E();
	await neu.reply([frame('keepalive')]);
	assert.equal(neu.CC.diag.state.interface, 'new'); // 3. new mechanism

	const bad = createE2E();
	await bad.reply([Buffer.from([0, 0xff, 0xff, 0xff, 0xff, 1])]);
	assert.equal(bad.diagLines('STREAM_UNPARSEABLE').length, 1); // 4. protobuf parsing failed

	const noUtil = createE2E();
	await noUtil.reply([Buffer.from(`data: ${JSON.stringify({ type: 'message_limit', message_limit: { windows: { '5h': { resets_at: 1791749400 } } } })}\n\n`)], { url: `https://claude.ai/api/organizations/${ORG}/chat_conversations/${CONV}/completion` });
	assert.equal(noUtil.diagLines('MISSING_UTILIZATION').length, 1); // 5. missing utilization

	const noReset = createE2E();
	await noReset.reply([Buffer.from(`data: ${JSON.stringify({ type: 'message_limit', message_limit: { windows: { '5h': { utilization: 0.1 } } } })}\n\n`)], { url: `https://claude.ai/api/organizations/${ORG}/chat_conversations/${CONV}/completion` });
	assert.equal(noReset.diagLines('MISSING_RESET').length, 1); // 6. missing reset timestamp

	const noOrg = createE2E({ cookie: '' });
	await noOrg.flush();
	assert.equal(noOrg.diagLines('ORG_UNRESOLVED').length, 1); // 7. organisation id failed

	const net = createE2E({ usage: { status: 500, body: {} } });
	await net.flush();
	await net.advance(2000);
	assert.equal(net.diagLines('USAGE_FAILED').length, 1); // 8. network request failed

	const noUi = createE2E({ withComposer: false });
	await noUi.advance(20000);
	assert.equal(noUi.diagLines('UI_MOUNT_FAILED').length, 1); // 9. UI mounting failed
});

test('D04 the dashboard tooltip summarises the diagnosis', async () => {
	const env = createE2E();
	await env.reply([frame('limits_5h_first')]);
	await env.advance(1000);
	assert.match(env.dashboard().getAttribute('title'), /interface: new/);
	assert.match(env.dashboard().getAttribute('title'), /usage events: 1/);
});
