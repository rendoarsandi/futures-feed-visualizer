import test from 'node:test';
import assert from 'node:assert/strict';
import { Monitor, DEFAULT_SETTINGS, SPOT_INDEX, WEIGHTED_INDEX } from '../public/engine.js';
const START = 1800000000000;
function wire(venue, price, at, id, overrides = {}) {
  const ms = Math.floor(at);
  const messages = [
    { e: 'aggTrade', E: ms, s: 'BTCUSDT', p: String(price), T: ms, a: String(id) },
    { topic: 'publicTrade.BTCUSDT', type: 'snapshot', data: [{ s: 'BTCUSDT', S: 'Buy', p: String(price), T: ms, i: String(id) }] },
    { arg: { channel: 'trades', instId: 'BTC-USDT-SWAP' }, data: [{ instId: 'BTC-USDT-SWAP', px: String(price), ts: String(ms), tradeId: String(id) }] },
    { channel: 'trades', data: [{ coin: 'BTC', px: String(price), time: ms, tid: String(id) }] },
  ];
  return JSON.stringify({ ...messages[venue === SPOT_INDEX ? 0 : venue], ...overrides });
}
function send(m, venue, price, at, id) { return m.frame(venue, wire(venue, price, at, id), at); }
function warm(m, prices = [100, 200, 300, 400, 100]) {
  prices.forEach((price, i) => { m.connection(i, true); send(m, i, price, START, 1); send(m, i, price, START + 200, 2); });
  m.state(START + 200);
}
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('wire executions retain quiet prices, reject replay/order errors and rebuild known Binance ID gaps', async t => {
  for (const venue of [0, SPOT_INDEX]) for (const gap of [1, 6000]) for (const contiguous of [true, false]) await t.test(`${venue}: ${gap}ms contiguous=${contiguous}`, () => {
    const m = new Monitor(DEFAULT_SETTINGS, START); warm(m);
    const at = START + 200 + gap;
    if (gap > 200) { const quiet = m.state(at - 1); assert.equal(quiet.series[venue].ready, true); assert.equal(quiet.series[venue].move, 0); }
    const id = contiguous ? 3 : 4;
    send(m, venue, 110, at, id);
    let state = m.state(at);
    assert.equal(state.series[venue].ready, contiguous);
    assert.equal(state.series[venue].up, contiguous ? 1 : 0);
    assert.equal(state.series[venue].price, 110);
    assert.equal(state.series[venue].missed, contiguous ? 0 : 1);
    send(m, venue, 900, at + 1, id); send(m, venue, 900, at + 2, id - 1);
    state = m.state(at + 2);
    assert.equal(state.series[venue].price, 110); assert.equal(state.series[venue].updatedAt, at);
    send(m, venue, 110, at + 200, id + 1);
    state = m.state(at + 200);
    assert.equal(state.series[venue].ready, true); assert.equal(state.series[venue].move, 0);
    send(m, venue, 110.02, at + 201, id + 2);
    assert.equal(m.state(at + 201).series[venue].up, contiguous ? 2 : 1);
  });
});

test('weighted returns use each venue baseline and require two contributors with half the configured weight', () => {
  const m = new Monitor({ ...DEFAULT_SETTINGS, weights: [4, 2, 1, 1] }, START); warm(m);
  [101, 204, 297, 400].forEach((price, i) => send(m, i, price, START + 300, 3));
  let s = m.state(START + 300); close(s.series[WEIGHTED_INDEX].move, .875); close(s.series[WEIGHTED_INDEX].price, 188.625);
  m.connection(0, false); s = m.state(START + 300);
  assert.equal(s.series[WEIGHTED_INDEX].ready, true); close(s.series[WEIGHTED_INDEX].move, .75); close(s.series[WEIGHTED_INDEX].price, 276.25);
  assert.equal(s.series[0].price, 101); assert.equal(s.series[0].ready, false); assert.equal(s.series[0].armed, false);
  m.connection(1, false); assert.equal(m.state(START + 300).series[WEIGHTED_INDEX].ready, false);
  m.connection(0, true); send(m, 0, 100, START + 400, 1); send(m, 0, 100, START + 600, 2);
  m.connection(2, false); m.connection(3, false);
  assert.equal(m.state(START + 600).series[WEIGHTED_INDEX].ready, false); // One venue's 50% is insufficient.
});

test('spot prices, gaps and connection changes leave the weighted signal independent', () => {
  const m = new Monitor(DEFAULT_SETTINGS, START); warm(m);
  const before = m.state(START + 200).series[WEIGHTED_INDEX];
  send(m, SPOT_INDEX, 1000, START + 201, 3);
  let state = m.state(START + 201);
  assert.equal(state.series[SPOT_INDEX].up, 1);
  assert.deepEqual(state.series[WEIGHTED_INDEX], before);
  send(m, SPOT_INDEX, 2000, START + 202, 5);
  state = m.state(START + 202);
  assert.equal(state.series[SPOT_INDEX].missed, 1);
  assert.equal(state.series[SPOT_INDEX].ready, false);
  assert.deepEqual(state.series[WEIGHTED_INDEX], before);
  m.connection(SPOT_INDEX, false); m.connection(SPOT_INDEX, true);
  assert.deepEqual(m.state(START + 203).series[WEIGHTED_INDEX], before);
  m.connection(0, false); m.connection(1, false); m.connection(2, false);
  send(m, SPOT_INDEX, 500, START + 204, 1);
  send(m, SPOT_INDEX, 500, START + 404, 2);
  state = m.state(START + 404);
  assert.equal(state.series[SPOT_INDEX].ready, true);
  assert.equal(state.series[WEIGHTED_INDEX].ready, false); // Spot cannot supply a second contributor.
});

test('a spot execution cannot trigger weighted movement caused by an aging futures baseline', () => {
  const m = new Monitor(DEFAULT_SETTINGS, START);
  for (let i = 0; i < 4; i++) {
    m.connection(i, true);
    send(m, i, 100, START, 1);
    send(m, i, 99, START + 100, 2);
    send(m, i, 100, START + 200, 3);
  }
  m.state(START + 250); // Futures movement is zero; weighted is armed.
  m.connection(SPOT_INDEX, true);
  send(m, SPOT_INDEX, 500, START + 301, 1);
  let weighted = m.state(START + 301).series[WEIGHTED_INDEX];
  assert.ok(weighted.move > 1);
  assert.equal(weighted.armed, true);
  assert.equal(weighted.up, 0);
  send(m, 0, 100, START + 302, 4);
  weighted = m.state(START + 302).series[WEIGHTED_INDEX];
  assert.equal(weighted.up, 1); // A futures execution authorizes the entry.
});

test('only valid current-session executions affect price; event age does not exclude ordered trades', () => {
  const m = new Monitor(DEFAULT_SETTINGS, START); warm(m);
  for (let i = 0; i <= SPOT_INDEX; i++) {
    const before = m.state(START + 201).series[i];
    assert.equal(m.frame(i, wire(i, 900, START + 201, 9, { isSnapshot: true }), START + 201), 0);
    assert.equal(m.frame(i, wire(i, 'NaN', START + 201, 3), START + 201), 0);
    assert.equal(m.frame(i, wire(i, -1, START + 201, 3), START + 201), 0);
    assert.equal(m.frame(i, '{broken', START + 201), 0);
    assert.equal(m.frame(i, '{"e":"bookTicker","s":"BTCUSDT","a":"9001","b":"9000"}', START + 201), 0);
    assert.equal(m.state(START + 201).series[i].price, before.price);
    // Receipt is ten seconds later than execution; the event is ordered.
    assert.equal(m.frame(i, wire(i, before.price, START + 300, 3), START + 10300), 1);
    assert.equal(m.state(START + 10300).series[i].ready, true);
    // The same event at another receipt is a replay, even for UUID-based venues.
    assert.equal(m.frame(i, wire(i, 900, START + 300, 3), START + 10301), 0);
    assert.equal(m.frame(i, wire(i, 900, START + 200, 4), START + 10302), 0);
    m.connection(i, false); m.connection(i, true);
    assert.equal(m.state(START + 10303).series[i].ready, false);
  }
});

test('counters process every execution without a chart tick and rearm only inside threshold', () => {
  const m = new Monitor(DEFAULT_SETTINGS, START); warm(m);
  send(m, 0, 100.02, START + 201, 3);
  send(m, 0, 100.03, START + 202, 4);
  send(m, 0, 99.98, START + 203, 5); // Crossing direction outside the band does not rearm.
  send(m, 0, 100, START + 204, 6);
  send(m, 0, 99.98, START + 205, 7);
  const state = m.state(START + 206);
  assert.equal(state.series[0].up, 1); assert.equal(state.series[0].down, 1);
  const before = state.series[0].up + state.series[0].down;
  m.state(START + 500); m.state(START + 600);
  assert.equal(m.state(START + 700).series[0].up + m.state(START + 700).series[0].down, before);
});

test('maximum lookback survives bursts and quiet intervals retain the exact final tick', () => {
  const m = new Monitor({ ...DEFAULT_SETTINGS, lookbackMs: 15000 }, START); m.connection(0, true);
  for (let i = 0; i <= 50000; i++) send(m, 0, 100 + i / 1000, START + i * .4, i);
  const s = m.state(START + 20000).series[0]; assert.equal(s.ready, true); close(s.move, (150 - 112.5) / 112.5 * 100);
  // Two trades share a 2ms bucket; the last one must survive a quiet window.
  const n = new Monitor(DEFAULT_SETTINGS, START); n.connection(0, true);
  send(n, 0, 100, START, 1); send(n, 0, 100, START + 200, 2); send(n, 0, 110, START + 201, 3);
  assert.equal(n.state(START + 10000).series[0].move, 0);
  send(n, 0, 121, START + 10001, 4); close(n.state(START + 10001).series[0].move, 10);
});

test('aggregate IDs remain exact at the signed int64 boundary', async t => {
  for (const venue of [0, SPOT_INDEX]) await t.test(String(venue), () => {
    const m = new Monitor(DEFAULT_SETTINGS, START); m.connection(venue, true);
    for (const [offset, id] of [[0, '9223372036854775804'], [200, '9223372036854775805']]) {
      const raw = wire(venue, 100, START + offset, id).replace(`"${id}"`, id);
      assert.equal(m.frame(venue, raw, START + offset), 1);
    }
    const id = '9223372036854775807';
    assert.equal(m.frame(venue, wire(venue, 110, START + 201, id).replace(`"${id}"`, id), START + 201), 1);
    assert.equal(m.state(START + 201).series[venue].ready, false);
    assert.equal(m.state(START + 201).series[venue].missed, 1);
  });
});

test('recent log spaces each market independently without dropping simultaneous entries or counts', () => {
  const m = new Monitor(DEFAULT_SETTINGS, START); warm(m);
  const prices = [100, 200, 300, 400];
  const burst = (offset, id, factor) => prices.forEach((price, i) => send(m, i, price * factor, START + offset, id));
  burst(201, 3, 1.001);
  let state = m.state(START + 201);
  assert.deepEqual(state.recent.map(e => e.series).sort(), [0, 1, 2, 3, WEIGHTED_INDEX]);
  assert.ok(state.recent.every(e => e.at === START + 201));
  m.state(START + 1000);
  burst(1000, 4, 1.001);
  burst(1200, 5, 1.002); // Same-market entries at 999ms are suppressed.
  assert.equal(m.state(START + 1200).recent.length, 5);
  burst(1201, 6, 1.001);
  burst(1201, 7, 1.002); // Exactly one second is eligible for every market.
  state = m.state(START + 1201);
  assert.equal(state.recent.length, 10);
  assert.deepEqual(state.recent.slice(5).map(e => e.series).sort(), [0, 1, 2, 3, WEIGHTED_INDEX]);
  assert.ok(state.recent.slice(5).every(e => e.at === START + 1201));
  assert.deepEqual(state.series.slice(0, 4).map(s => s.up + s.down), [3, 3, 3, 3]);
  m.reset(DEFAULT_SETTINGS, START + 1300);
  m.state(START + 1500);
  send(m, 0, 101, START + 1501, 8);
  assert.deepEqual(m.state(START + 1501).recent.filter(e => e.series === 0).map(e => e.at), [START + 1501]);
});
