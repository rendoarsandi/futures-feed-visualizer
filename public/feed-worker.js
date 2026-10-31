import { Monitor, DEFAULT_SETTINGS, SPOT_INDEX, validateSettings } from './engine.js';
import { StreamConnection } from './streams.js';
const now = () => performance.timeOrigin + performance.now();
let monitor = null, connections = [], ticker = null, awaitingPaint = false;
function closeStreams() { for (const connection of connections) connection?.close(); connections = []; }
function openStreams() { if (!monitor.demo) connections = monitor.feeds.map((_, i) => i === SPOT_INDEX || monitor.settings.weights[i] > 0 ? new StreamConnection(i, monitor) : null); }
function publish() {
  // A blocked renderer receives at most one pending chart update. Counting
  // continues synchronously for every accepted execution in this worker.
  if (!awaitingPaint && monitor) { awaitingPaint = true; postMessage({ type: 'state', state: monitor.state(now()) }); }
  else if (monitor) monitor.state(now()); // Health may rearm, never create live entries.
}
self.onmessage = ({ data }) => {
  try {
    if (data.type === 'ack') { awaitingPaint = false; return; }
    if (data.type === 'start') {
      closeStreams(); clearInterval(ticker); awaitingPaint = false;
      monitor = new Monitor(DEFAULT_SETTINGS, now(), data.demo === true); openStreams();
      ticker = setInterval(publish, 50); publish();
    } else if (data.type === 'settings' && monitor) {
      const settings = validateSettings(data.settings);
      const changedWeights = settings.weights.some((w, i) => w !== monitor.settings.weights[i]);
      if (changedWeights) closeStreams();
      monitor.reset(settings, now());
      if (changedWeights) openStreams();
      postMessage({ type: 'applied', request: data.request }); awaitingPaint = false; publish();
    } else if (data.type === 'stop') {
      closeStreams(); clearInterval(ticker); self.close();
    }
  } catch (error) { postMessage({ type: 'error', request: data.request, message: error.message }); }
};
