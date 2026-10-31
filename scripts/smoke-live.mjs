// Explicit live smoke check; the unit test suite never contacts exchanges.
import { Monitor, IDS, WEIGHTED_INDEX } from '../public/engine.js';
import { StreamConnection } from '../public/streams.js';
const now = () => performance.timeOrigin + performance.now();
const duration = Number(process.env.LIVE_MS || 15000);
const required = process.env.LIVE_VENUES ? process.env.LIVE_VENUES.split(',') : [];
if (!Number.isInteger(duration) || duration < 1000 || duration > 300000 || required.some(id => !IDS.slice(0, WEIGHTED_INDEX).includes(id))) {
  throw new Error('Use LIVE_MS=1000–300000 and comma-separated live venue IDs in LIVE_VENUES');
}
const monitor = new Monitor(undefined, now());
const executions = monitor.feeds.map(() => 0);
const frame = monitor.frame.bind(monitor);
monitor.frame = (index, raw, at) => {
  const accepted = frame(index, raw, at);
  if (accepted > 0) executions[index] += accepted;
  return accepted;
};
const connections = monitor.feeds.map((_, i) => new StreamConnection(i, monitor));
const timer = setInterval(() => monitor.state(now()), 50);
setTimeout(() => {
  const state = monitor.state(now());
  console.table(state.series.map((s, i) => ({ venue: s.name, connected: s.connected, ready: s.ready, executions: executions[i] ?? '—', price: s.price, up: s.up, down: s.down })));
  for (const connection of connections) connection.close();
  clearInterval(timer);
  if (required.length ? required.some(id => !executions[IDS.indexOf(id)] || !state.series[IDS.indexOf(id)].ready) : !state.series[WEIGHTED_INDEX].ready) process.exitCode = 1;
}, duration);
