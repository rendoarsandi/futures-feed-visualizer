// Explicit live smoke check; the unit test suite never contacts exchanges.
import { Monitor, WEIGHTED_INDEX } from '../public/engine.js';
import { StreamConnection } from '../public/streams.js';
const now = () => performance.timeOrigin + performance.now();
const monitor = new Monitor(undefined, now());
const connections = monitor.feeds.map((_, i) => new StreamConnection(i, monitor));
const timer = setInterval(() => monitor.state(now()), 50);
setTimeout(() => {
  const state = monitor.state(now());
  console.table(state.series.map(s => ({ venue: s.name, connected: s.connected, ready: s.ready, price: s.price, up: s.up, down: s.down })));
  for (const connection of connections) connection.close();
  clearInterval(timer);
  if (!state.series[WEIGHTED_INDEX].ready) process.exitCode = 1;
}, 15000);
