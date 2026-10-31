import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamConnection } from '../public/streams.js';

test('delayed heartbeat timers preserve healthy sockets but repeated unanswered pings recover', t => {
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
  const monitor = { connection: (index, connected) => connections.push(connected), frame: () => 0 };
  const connection = new StreamConnection(1, monitor), socket = sockets[0];
  socket.onopen();
  const heartbeat = [...timers.values()].find(timer => timer.interval).callback;
  clock += 60000; heartbeat(); // One callback after a minute of browser throttling.
  assert.equal(socket.closed, false);
  assert.equal(JSON.parse(socket.sent.at(-1)).op, 'ping');
  socket.onmessage({ data: '{"op":"pong"}' });
  for (let i = 0; i < 6; i++) { clock += 5000; heartbeat(); }
  assert.equal(socket.closed, false);
  socket.onmessage({ data: '{"op":"pong"}' }); // A response replenishes the heartbeat allowance.
  for (let i = 0; i < 6; i++) { clock += 5000; heartbeat(); }
  assert.equal(socket.closed, false);
  clock += 5000; heartbeat();
  assert.equal(socket.closed, true);
  assert.deepEqual(connections, [true, false]);
  assert.equal(timers.size, 1); // Recovery has one pending retry, with old timers canceled.
  connection.close();
  assert.equal(timers.size, 0);
});
