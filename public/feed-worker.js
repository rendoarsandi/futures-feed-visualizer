import { Monitor, DEFAULT_SETTINGS, SPOT_INDEX, validateSettings } from './engine.js';
import { StreamConnection } from './streams.js';
const now = () => performance.timeOrigin + performance.now();
let monitor = null, connections = [], ticker = null, awaitingPaint = false, visible = true;
function closeStreams() { for (const connection of connections) connection?.close(); connections = []; }
function openStreams() {
  if (monitor.demo) return;
  monitor.feeds.forEach((_, i) => {
    const active = monitor.enabled[i] && (i === SPOT_INDEX || monitor.settings.weights[i] > 0);
    if (active && !connections[i]) connections[i] = new StreamConnection(i, monitor);
    else if (!active && connections[i]) { connections[i].close(); connections[i] = null; }
  });
}
function publish() {
  // A blocked renderer receives at most one pending chart update. Counting
  // continues synchronously for every accepted execution in this worker.
  if (visible && !awaitingPaint && monitor) { awaitingPaint = true; postMessage({ type: 'state', state: monitor.state(now()) }); }
  else if (monitor) monitor.state(now()); // Health may rearm, never create live entries.
}
self.onmessage = ({ data }) => {
  try {
    if (data.type === 'ack') { awaitingPaint = false; return; }
    if (data.type === 'start') {
      closeStreams(); clearInterval(ticker); awaitingPaint = false;
      monitor = new Monitor(DEFAULT_SETTINGS, now(), data.demo === true); openStreams();
      ticker = setInterval(publish, 50); publish();
    } else if (data.type === 'visibility' && monitor) {
      visible = data.visible === true;
      if (visible) {
        for (const connection of connections) connection?.resume();
        publish();
      }
    } else if (data.type === 'settings' && monitor) {
      const settings = validateSettings(data.settings);
      const changedWeights = settings.weights.some((w, i) => w !== monitor.settings.weights[i]);
      if (changedWeights) closeStreams();
      monitor.reset(settings, now());
      if (changedWeights) openStreams();
      postMessage({ type: 'applied', request: data.request }); awaitingPaint = false; publish();
    } else if (data.type === 'market' && monitor) {
      monitor.setEnabled(data.index, data.enabled, now()); openStreams();
      postMessage({ type: 'applied', request: data.request }); awaitingPaint = false; publish();
    } else if (data.type === 'stop') {
      closeStreams(); clearInterval(ticker); self.close();
    }
  } catch (error) { postMessage({ type: 'error', request: data.request, message: error.message }); }
};
