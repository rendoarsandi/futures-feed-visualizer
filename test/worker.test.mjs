import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { SPOT_INDEX, WEIGHTED_INDEX } from '../public/engine.js';
const moduleURL = new URL('../public/feed-worker.js', import.meta.url).href;

test('actual worker publishes an offline session, applies settings atomically and bounds pending chart messages', { timeout: 10000 }, async t => {
  const bootstrap = `
    const { parentPort } = require('node:worker_threads');
    globalThis.self = globalThis;
    globalThis.close = () => process.exit(0);
    globalThis.postMessage = data => parentPort.postMessage(data);
    globalThis.WebSocket = class { constructor() { throw new Error('Demo must never open a socket'); } };
    import(${JSON.stringify(moduleURL)}).then(() => {
      parentPort.on('message', data => globalThis.onmessage({ data }));
      parentPort.postMessage({ type: 'ready' });
    });
  `;
  const worker = new Worker(bootstrap, { eval: true });
  t.after(() => worker.terminate());
  await once(worker, 'message');
  const next = () => once(worker, 'message').then(([data]) => data);
  let wait = next(); worker.postMessage({ type: 'start', demo: true });
  const initial = await wait;
  assert.equal(initial.type, 'state'); assert.equal(initial.state.mode, 'demo'); assert.equal(initial.state.settings.lookbackMs, 200);
  assert.ok(initial.state.series.find(s => s.id === 'binance-spot').price > 0);
  assert.ok(Number.isFinite(initial.state.series.find(s => s.id === 'weighted').price));
  // Without an acknowledgement, no further chart states may queue up.
  let extra = 0;
  const count = data => { if (data.type === 'state') extra++; };
  worker.on('message', count);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(extra, 0); worker.off('message', count);
  wait = next(); worker.postMessage({ type: 'ack' });
  const current = await wait; assert.equal(current.type, 'state'); assert.ok(current.state.at > initial.state.at);
  wait = next(); worker.postMessage({ type: 'settings', request: 1, settings: { lookbackMs: 300, threshold: 0, weights: [1, 1, 1, 1, 1, 1] } });
  const invalid = await wait; assert.equal(invalid.type, 'error'); assert.equal(invalid.request, 1);
  wait = next(); worker.postMessage({ type: 'ack' });
  const unchanged = await wait; assert.equal(unchanged.state.epoch, initial.state.epoch); assert.equal(unchanged.state.settings.threshold, .01);
  const applied = next();
  const updated = new Promise(resolve => {
    const listen = data => { if (data.type === 'state') { worker.off('message', listen); resolve(data); } };
    worker.on('message', listen);
  });
  worker.postMessage({ type: 'settings', request: 2, settings: { lookbackMs: 300, threshold: .015, weights: [1, 2, 1, 1, 2, 3] } });
  assert.equal((await applied).type, 'applied');
  const state = (await updated).state;
  assert.equal(state.settings.lookbackMs, 300); assert.equal(state.settings.threshold, .015); assert.ok(state.epoch > initial.state.epoch);
  assert.ok(state.series.every(s => s.up === 0 && s.down === 0));
  const exit = once(worker, 'exit'); worker.postMessage({ type: 'stop' }); await exit;
});

test('live worker disconnects crossed-out markets, preserves toggles through settings and closes sockets', { timeout: 10000 }, async t => {
  const bootstrap = `
    const { parentPort } = require('node:worker_threads');
    const sockets = [];
    globalThis.self = globalThis;
    globalThis.close = () => {
      parentPort.postMessage({ type: 'stopped', allClosed: sockets.every(s => s.closed) });
      process.exit(0);
    };
    globalThis.postMessage = data => parentPort.postMessage(data);
    globalThis.WebSocket = class {
      static CONNECTING = 0; static OPEN = 1;
      constructor(url) { this.url = url; this.closed = false; this.readyState = 1; sockets.push(this); queueMicrotask(() => this.onopen?.()); }
      send() {}
      close() { this.closed = true; this.readyState = 3; }
    };
    import(${JSON.stringify(moduleURL)}).then(() => {
      parentPort.on('message', data => {
        if (data.type === 'inspect') parentPort.postMessage({ type: 'sockets', sockets: sockets.map(s => ({ url: s.url, closed: s.closed })) });
        else if (data.type === 'trade') {
          sockets.find(s => new URL(s.url).hostname === 'fstream.binance.com' && !s.closed).onmessage({ data: JSON.stringify(data.frame) });
          parentPort.postMessage({ type: 'delivered' });
        } else if (data.type === 'drop') {
          sockets.find(s => new URL(s.url).hostname === 'stream.bybit.com' && !s.closed).close();
          parentPort.postMessage({ type: 'dropped' });
        }
        else globalThis.onmessage({ data });
      });
      parentPort.postMessage({ type: 'ready' });
    });
  `;
  const worker = new Worker(bootstrap, { eval: true });
  t.after(() => worker.terminate());
  const next = type => new Promise(resolve => {
    const listen = data => { if (data.type === type) { worker.off('message', listen); resolve(data); } };
    worker.on('message', listen);
  });
  await next('ready');
  let wait = next('state'); worker.postMessage({ type: 'start' }); await wait;
  const inspect = () => { const wait = next('sockets'); worker.postMessage({ type: 'inspect' }); return wait; };
  let sockets = (await inspect()).sockets;
  assert.equal(sockets.filter(s => !s.closed).length, 7);
  assert.ok(sockets.some(s => new URL(s.url).hostname === 'stream.binance.com' && !s.closed));
  let backgroundStates = 0;
  const count = data => { if (data.type === 'state') backgroundStates++; };
  worker.on('message', count);
  worker.postMessage({ type: 'visibility', visible: false });
  worker.postMessage({ type: 'ack' }); // Retire the initial state; hidden delivery must stay suppressed.
  const trade = async (id, price) => {
    const wait = next('delivered');
    worker.postMessage({ type: 'trade', frame: { e: 'aggTrade', s: 'BTCUSDT', a: String(id), p: String(price), T: Date.now() } });
    await wait;
  };
  await trade(1, 100);
  await new Promise(resolve => setTimeout(resolve, 250));
  await trade(2, 100); await trade(3, 100.02);
  wait = next('dropped'); worker.postMessage({ type: 'drop' }); await wait;
  assert.equal(backgroundStates, 0); worker.off('message', count);
  wait = next('state'); worker.postMessage({ type: 'visibility', visible: true });
  const resumed = (await wait).state;
  assert.equal(resumed.series[0].up, 1); // Hidden, unacknowledged UI does not block execution counting.
  assert.equal(resumed.series[0].price, 100.02);
  sockets = (await inspect()).sockets;
  assert.equal(sockets.filter(s => !s.closed).length, 7);
  assert.equal(sockets.filter(s => new URL(s.url).hostname === 'fstream.binance.com').length, 1);
  assert.equal(sockets.filter(s => new URL(s.url).hostname === 'stream.bybit.com').length, 2);
  const connectedSockets = sockets.length;
  let request = 0;
  const control = async (type, payload) => {
    const applied = next('applied'), state = next('state');
    worker.postMessage({ type, request: ++request, ...payload });
    await applied; return (await state).state;
  };
  let state = await control('market', { index: SPOT_INDEX, enabled: false });
  assert.equal(state.series[SPOT_INDEX].status, 'disconnected');
  sockets = (await inspect()).sockets;
  assert.equal(sockets.length, connectedSockets); // Toggling one market does not replace the others.
  assert.equal(sockets.filter(s => !s.closed).length, 6);
  assert.ok(sockets.filter(s => new URL(s.url).hostname === 'stream.binance.com').every(s => s.closed));
  state = await control('settings', { settings: { lookbackMs: 200, threshold: .01, weights: [0, 0, 0, 0, 1, 1] } });
  assert.equal(state.series[SPOT_INDEX].enabled, false);
  sockets = (await inspect()).sockets;
  assert.ok(sockets.slice(0, 7).every(s => s.closed));
  let active = sockets.filter(s => !s.closed);
  assert.equal(active.length, 2);
  assert.deepEqual(active.map(s => new URL(s.url).hostname).sort(), ['futures.kraken.com', 'www.deribit.com']);
  await control('settings', { settings: { lookbackMs: 300, threshold: .01, weights: [0, 0, 0, 0, 1, 1] } });
  assert.deepEqual((await inspect()).sockets, sockets); // Resetting parameters cannot reopen a disabled feed.
  await control('market', { index: SPOT_INDEX, enabled: true });
  sockets = (await inspect()).sockets;
  active = sockets.filter(s => !s.closed);
  assert.equal(active.length, 3);
  assert.ok(active.some(s => new URL(s.url).hostname === 'stream.binance.com'));
  assert.ok(active.every(s => !['fstream.binance.com', 'stream.bybit.com'].includes(new URL(s.url).hostname)));
  state = await control('market', { index: WEIGHTED_INDEX, enabled: false });
  assert.equal(state.series[WEIGHTED_INDEX].status, 'disconnected');
  assert.deepEqual((await inspect()).sockets, sockets); // Weighted has no socket of its own.
  wait = next('stopped'); const exit = once(worker, 'exit'); worker.postMessage({ type: 'stop' });
  assert.equal((await wait).allClosed, true);
  await exit;
});
