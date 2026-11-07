import test from 'node:test';
import assert from 'node:assert/strict';
import { Monitor, POLYMARKET_INDEX, POLYMARKET_15M_INDEX, PREDICTFUN_INDEX } from '../public/engine.js';
import { StreamConnection } from '../public/streams.js';

test('delayed heartbeat timers preserve healthy sockets and silent feeds recover', async t => {
  for (const [index, subscription, response, ping] of [
    [1, { op: 'subscribe', args: ['publicTrade.BTCUSDT'] }, '{"op":"pong"}', { op: 'ping' }],
    [4, { jsonrpc: '2.0', id: 1, method: 'public/subscribe', params: { channels: ['trades.BTC_USDC-PERPETUAL.100ms'] } }, '{"jsonrpc":"2.0","id":2,"result":{"version":"1.2.26"}}', { jsonrpc: '2.0', id: 2, method: 'public/test', params: {} }],
    [5, { event: 'subscribe', feed: 'trade', product_ids: ['PF_XBTUSD'] }, '{"feed":"heartbeat","time":1800000000000}', null],
  ]) await t.test(String(index), t => {
    let clock = 0, nextTimer = 0;
    const timers = new Map(), sockets = [], connections = [];
    const schedule = (callback, interval) => { const id = ++nextTimer; timers.set(id, { callback, interval }); return id; };
    t.mock.method(performance, 'now', () => clock);
    t.mock.method(globalThis, 'setTimeout', callback => schedule(callback, false));
    t.mock.method(globalThis, 'setInterval', callback => schedule(callback, true));
    t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
    t.mock.method(globalThis, 'clearInterval', id => timers.delete(id));
    const originalWebSocket = globalThis.WebSocket;
    t.after(() => { globalThis.WebSocket = originalWebSocket; });
    globalThis.WebSocket = class {
      constructor() { this.closed = false; this.bufferedAmount = 0; this.sent = []; sockets.push(this); }
      send(frame) { this.sent.push(frame); }
      close() { this.closed = true; }
    };
    const monitor = new Monitor();
    const connectionEvent = monitor.connection.bind(monitor);
    t.mock.method(monitor, 'connection', (i, connected) => { connections.push(connected); connectionEvent(i, connected); });
    const connection = new StreamConnection(index, monitor), socket = sockets[0];
    socket.onopen();
    assert.deepEqual(JSON.parse(socket.sent[0]), subscription);
    if (index === 5) assert.deepEqual(socket.sent.map(JSON.parse), [subscription, { event: 'subscribe', feed: 'heartbeat' }]);
    const heartbeat = [...timers.values()].find(timer => timer.interval).callback;
    clock += 60000; heartbeat(); // One callback after a minute of browser throttling.
    assert.equal(socket.closed, false);
    if (ping) assert.deepEqual(JSON.parse(socket.sent.at(-1)), ping);
    else assert.equal(socket.sent.length, 2); // Server heartbeat needs no unsupported JSON ping.
    socket.onmessage({ data: response });
    for (let i = 0; i < 6; i++) { clock += 5000; heartbeat(); }
    assert.equal(socket.closed, false);
    socket.onmessage({ data: response }); // Incoming health messages replenish the allowance.
    for (let i = 0; i < 6; i++) { clock += 5000; heartbeat(); }
    assert.equal(socket.closed, false);
    clock += 5000; heartbeat();
    assert.equal(monitor.state(performance.timeOrigin + clock).series[index].price, 0); // Health frames never seed a trade baseline.
    assert.equal(socket.closed, true);
    assert.deepEqual(connections, [true, false]);
    assert.equal(timers.size, 1); // Recovery has one pending retry, with old timers canceled.
    connection.close();
    assert.equal(timers.size, 0);
  });
});

test('venue subscription failures retire the socket and schedule recovery', t => {
  const sockets = [], monitor = new Monitor();
  const originalWebSocket = globalThis.WebSocket;
  t.after(() => { globalThis.WebSocket = originalWebSocket; });
  globalThis.WebSocket = class {
    constructor() { this.bufferedAmount = 0; sockets.push(this); }
    send() {}
    close() { this.closed = true; }
  };
  for (const [index, frame] of [
    [4, { jsonrpc: '2.0', id: 1, error: { code: 13778, message: 'raw_subscriptions_not_available_for_unauthorized' } }],
    [5, { event: 'subscribed_failed', feed: 'trade', product_ids: ['PF_XBTUSD'] }],
    [5, { event: 'alert', message: 'Bad websocket message' }],
  ]) {
    const connection = new StreamConnection(index, monitor), socket = sockets.at(-1);
    try {
      socket.onopen(); socket.onmessage({ data: JSON.stringify(frame) });
      assert.equal(socket.closed, true);
      assert.equal(monitor.state(Date.now()).series[index].connected, false);
    } finally { connection.close(); }
  }
});

test('Polymarket 5m stream resolves active 5m market and auto-switches when expired', async t => {
  let clock = 60000, nextTimer = 0;
  const baseOrigin = 1800000000000;
  const timers = new Map(), sockets = [], fetchedUrls = [];
  const schedule = (callback, delay, interval) => { const id = ++nextTimer; timers.set(id, { callback, delay, interval }); return id; };
  t.mock.method(performance, 'now', () => clock);
  const originalTimeOrigin = Object.getOwnPropertyDescriptor(performance, 'timeOrigin') || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(performance), 'timeOrigin');
  Object.defineProperty(performance, 'timeOrigin', { value: baseOrigin, configurable: true });
  t.after(() => { if (originalTimeOrigin) Object.defineProperty(performance, 'timeOrigin', originalTimeOrigin); });
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => schedule(callback, delay, false));
  t.mock.method(globalThis, 'setInterval', (callback, delay) => schedule(callback, delay, true));
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  t.mock.method(globalThis, 'clearInterval', id => timers.delete(id));
  t.mock.method(globalThis, 'fetch', async url => {
    fetchedUrls.push(String(url));
    const slug = String(url).split('slug=')[1];
    const windowSec = Number(slug.split('-').at(-1));
    return {
      ok: true,
      json: async () => [{
        slug,
        outcomes: '["Up", "Down"]',
        clobTokenIds: JSON.stringify([`up-${windowSec}`, `down-${windowSec}`]),
        endDate: new Date((windowSec + 300) * 1000).toISOString(),
        acceptingOrders: true,
        closed: false,
      }],
    };
  });
  const originalWebSocket = globalThis.WebSocket;
  t.after(() => { globalThis.WebSocket = originalWebSocket; });
  globalThis.WebSocket = class {
    static CONNECTING = 0; static OPEN = 1;
    constructor(url) { this.url = url; this.closed = false; this.readyState = 1; this.bufferedAmount = 0; this.sent = []; sockets.push(this); }
    send(frame) { this.sent.push(frame); }
    close() { this.closed = true; this.readyState = 3; }
  };
  const monitor = new Monitor(undefined, baseOrigin + clock);
  const connection = new StreamConnection(POLYMARKET_INDEX, monitor);
  t.after(() => connection.close());
  sockets[0].onopen();
  await new Promise(resolve => queueMicrotask(resolve));
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(fetchedUrls.length, 1);
  assert.ok(fetchedUrls[0].endsWith('btc-updown-5m-1800000000'));
  assert.deepEqual(JSON.parse(sockets[0].sent[0]), { type: 'market', assets_ids: ['up-1800000000'] });
  sockets[0].onmessage({ data: JSON.stringify({ event_type: 'last_trade_price', asset_id: 'up-1800000000', price: '0.64', timestamp: String(baseOrigin + clock), transaction_hash: 'tx-1' }) });
  assert.equal(monitor.state(baseOrigin + clock).series[POLYMARKET_INDEX].price, .64);
  // Advance to 5m market expiry and fire the scheduled expiry rollover timer.
  clock = 300025;
  const expiryTimer = [...timers.values()].find(item => !item.interval && item.delay < 300000);
  assert.ok(expiryTimer);
  expiryTimer.callback();
  assert.equal(sockets[0].closed, true);
  assert.equal(sockets.length, 2);
  sockets[1].onopen();
  await new Promise(resolve => queueMicrotask(resolve));
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(fetchedUrls.length, 2);
  assert.ok(fetchedUrls[1].endsWith('btc-updown-5m-1800000300'));
  assert.deepEqual(JSON.parse(sockets[1].sent[0]), { type: 'market', assets_ids: ['up-1800000300'] });
  const state = monitor.state(baseOrigin + clock).series[POLYMARKET_INDEX];
  assert.equal(state.slug, 'btc-updown-5m-1800000300');
  assert.equal(state.price, 0);
});

test('Polymarket 15m stream resolves active 15m market and auto-switches when expired', async t => {
  let clock = 60000, nextTimer = 0;
  const baseOrigin = 1800000000000;
  const timers = new Map(), sockets = [], fetchedUrls = [];
  const schedule = (callback, delay, interval) => { const id = ++nextTimer; timers.set(id, { callback, delay, interval }); return id; };
  t.mock.method(performance, 'now', () => clock);
  const originalTimeOrigin = Object.getOwnPropertyDescriptor(performance, 'timeOrigin') || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(performance), 'timeOrigin');
  Object.defineProperty(performance, 'timeOrigin', { value: baseOrigin, configurable: true });
  t.after(() => { if (originalTimeOrigin) Object.defineProperty(performance, 'timeOrigin', originalTimeOrigin); });
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => schedule(callback, delay, false));
  t.mock.method(globalThis, 'setInterval', (callback, delay) => schedule(callback, delay, true));
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  t.mock.method(globalThis, 'clearInterval', id => timers.delete(id));
  t.mock.method(globalThis, 'fetch', async url => {
    fetchedUrls.push(String(url));
    const slug = String(url).split('slug=')[1];
    const windowSec = Number(slug.split('-').at(-1));
    return {
      ok: true,
      json: async () => [{
        slug,
        outcomes: '["Up", "Down"]',
        clobTokenIds: JSON.stringify([`up-15m-${windowSec}`, `down-15m-${windowSec}`]),
        endDate: new Date((windowSec + 900) * 1000).toISOString(),
        acceptingOrders: true,
        closed: false,
      }],
    };
  });
  const originalWebSocket = globalThis.WebSocket;
  t.after(() => { globalThis.WebSocket = originalWebSocket; });
  globalThis.WebSocket = class {
    static CONNECTING = 0; static OPEN = 1;
    constructor(url) { this.url = url; this.closed = false; this.readyState = 1; this.bufferedAmount = 0; this.sent = []; sockets.push(this); }
    send(frame) { this.sent.push(frame); }
    close() { this.closed = true; this.readyState = 3; }
  };
  const monitor = new Monitor(undefined, baseOrigin + clock);
  const connection = new StreamConnection(POLYMARKET_15M_INDEX, monitor);
  t.after(() => connection.close());
  sockets[0].onopen();
  await new Promise(resolve => queueMicrotask(resolve));
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(fetchedUrls.length, 1);
  assert.ok(fetchedUrls[0].endsWith('btc-updown-15m-1800000000'));
  assert.deepEqual(JSON.parse(sockets[0].sent[0]), { type: 'market', assets_ids: ['up-15m-1800000000'] });
  sockets[0].onmessage({ data: JSON.stringify({ event_type: 'last_trade_price', asset_id: 'up-15m-1800000000', price: '0.64', timestamp: String(baseOrigin + clock), transaction_hash: 'tx-1' }) });
  assert.equal(monitor.state(baseOrigin + clock).series[POLYMARKET_15M_INDEX].price, .64);
  // Advance to 15m market expiry and fire the scheduled expiry rollover timer.
  clock = 900025;
  const expiryTimer = [...timers.values()].find(item => !item.interval && item.delay < 900000);
  assert.ok(expiryTimer);
  expiryTimer.callback();
  assert.equal(sockets[0].closed, true);
  assert.equal(sockets.length, 2);
  sockets[1].onopen();
  await new Promise(resolve => queueMicrotask(resolve));
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(fetchedUrls.length, 2);
  assert.ok(fetchedUrls[1].endsWith('btc-updown-15m-1800000900'));
  assert.deepEqual(JSON.parse(sockets[1].sent[0]), { type: 'market', assets_ids: ['up-15m-1800000900'] });
  const state = monitor.state(baseOrigin + clock).series[POLYMARKET_15M_INDEX];
  assert.equal(state.slug, 'btc-updown-15m-1800000900');
  assert.equal(state.price, 0);
});

test('Predict.fun 5m stream resolves active 5m market, echoes server heartbeats and auto-switches when expired', async t => {
  let clock = 60000, nextTimer = 0;
  const baseOrigin = 1800000000000;
  const timers = new Map(), sockets = [], fetchedUrls = [];
  const schedule = (callback, delay, interval) => { const id = ++nextTimer; timers.set(id, { callback, delay, interval }); return id; };
  t.mock.method(performance, 'now', () => clock);
  const originalTimeOrigin = Object.getOwnPropertyDescriptor(performance, 'timeOrigin') || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(performance), 'timeOrigin');
  Object.defineProperty(performance, 'timeOrigin', { value: baseOrigin, configurable: true });
  t.after(() => { if (originalTimeOrigin) Object.defineProperty(performance, 'timeOrigin', originalTimeOrigin); });
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => schedule(callback, delay, false));
  t.mock.method(globalThis, 'setInterval', (callback, delay) => schedule(callback, delay, true));
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  t.mock.method(globalThis, 'clearInterval', id => timers.delete(id));
  t.mock.method(globalThis, 'fetch', async url => {
    fetchedUrls.push(String(url));
    const windowSec = Number(String(url).split('-').at(-1));
    const marketId = windowSec === 1800000000 ? 4304695 : 4304700;
    const endsAt = new Date((windowSec + 300) * 1000).toISOString();
    return {
      ok: true,
      text: async () => `<meta property="og:image" content="https://predict.fun/api/generate/image/market.png?marketId=${marketId}&amp;categoryId=btc-updown-5m-${windowSec}"/>{\\"isTradingEnabled\\":true,\\"status\\":\\"REGISTERED\\",\\"endsAt\\":\\"${endsAt}\\"}`,
    };
  });
  const originalWebSocket = globalThis.WebSocket;
  t.after(() => { globalThis.WebSocket = originalWebSocket; });
  globalThis.WebSocket = class {
    static CONNECTING = 0; static OPEN = 1;
    constructor(url) { this.url = url; this.closed = false; this.readyState = 1; this.bufferedAmount = 0; this.sent = []; sockets.push(this); }
    send(frame) { this.sent.push(frame); }
    close() { this.closed = true; this.readyState = 3; }
  };
  const monitor = new Monitor(undefined, baseOrigin + clock);
  const connection = new StreamConnection(PREDICTFUN_INDEX, monitor);
  t.after(() => connection.close());
  sockets[0].onopen();
  await new Promise(resolve => queueMicrotask(resolve));
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(fetchedUrls.length, 1);
  assert.ok(fetchedUrls[0].endsWith('btc-updown-5m-1800000000'));
  assert.deepEqual(JSON.parse(sockets[0].sent[0]), { method: 'subscribe', requestId: 1, params: ['predictOrderbook/4304695'] });
  sockets[0].onmessage({ data: JSON.stringify({ type: 'M', topic: 'heartbeat', data: baseOrigin + clock }) });
  assert.deepEqual(JSON.parse(sockets[0].sent[1]), { method: 'heartbeat', data: baseOrigin + clock });
  sockets[0].onmessage({ data: JSON.stringify({ type: 'M', topic: 'predictOrderbook/4304695', data: { marketId: 4304695, updateTimestampMs: baseOrigin + clock, lastOrderSettled: { id: 'ord-1', price: '0.58', marketId: 4304695 } } }) });
  assert.equal(monitor.state(baseOrigin + clock).series[PREDICTFUN_INDEX].price, .58);
  clock = 300025;
  const expiryTimer = [...timers.values()].find(item => !item.interval && item.delay < 300000);
  assert.ok(expiryTimer);
  expiryTimer.callback();
  assert.equal(sockets[0].closed, true);
  assert.equal(sockets.length, 2);
  sockets[1].onopen();
  await new Promise(resolve => queueMicrotask(resolve));
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(fetchedUrls.length, 2);
  assert.ok(fetchedUrls[1].endsWith('btc-updown-5m-1800000300'));
  assert.deepEqual(JSON.parse(sockets[1].sent[0]), { method: 'subscribe', requestId: 1, params: ['predictOrderbook/4304700'] });
  const state = monitor.state(baseOrigin + clock).series[PREDICTFUN_INDEX];
  assert.equal(state.slug, 'btc-updown-5m-1800000300');
  assert.equal(state.price, 0);
});
