import test from 'node:test';
import assert from 'node:assert/strict';
import { Monitor } from '../public/engine.js';
import { StreamConnection } from '../public/streams.js';

test('delayed heartbeat timers preserve healthy sockets and silent feeds recover', async t => {
  for (const [index, subscription, response, ping] of [
    [1, { op: 'subscribe', args: ['publicTrade.BTCUSDT'] }, '{"op":"pong"}', { op: 'ping' }],
    [4, { jsonrpc: '2.0', id: 1, method: 'public/subscribe', params: { channels: ['trades.BTC-PERPETUAL.100ms'] } }, '{"jsonrpc":"2.0","id":2,"result":{"version":"1.2.26"}}', { jsonrpc: '2.0', id: 2, method: 'public/test', params: {} }],
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
