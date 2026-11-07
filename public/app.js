import { NAMES as names, DEFAULT_SETTINGS, POLYMARKET_INDEX, PREDICTFUN_INDEX, WEIGHTED_INDEX } from './engine.js';
const colors = ['#f4c768', '#6aa9ff', '#c6a0f6', '#f78d98', '#d4e294', '#e9ab74', '#67d5ef', '#ff79c6', '#ff9f43', '#63e0bb'];
const shortNames = ['Binance Fut.', 'Bybit', 'OKX', 'Hyperliquid', 'Deribit', 'Kraken Fut.', 'Binance Spot', 'Polymarket 5m', 'Predict.fun 5m', 'Weighted'];
const isPrediction = (i) => i === POLYMARKET_INDEX || i === PREDICTFUN_INDEX;
const $ = (id) => document.getElementById(id);
const priceFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const countFormat = new Intl.NumberFormat('en-US');
const formatPrice = (i, value) => isPrediction(i) ? `${(value * 100).toFixed(1)}¢` : priceFormat.format(value);
const expiryLabel = (s, at) => {
  if (!s.enabled || !s.expiresAt) return '';
  const sec = Math.max(0, Math.ceil((s.expiresAt - at) / 1000));
  return ` · ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')} left`;
};
let state = null, history = [], hidden = new Set(), frozenAt = null, frozenHistory = null, pointer = null, scheduled = false, recentKey = '', syncLag = true;
const smoothLags = new Float64Array(names.length);
const visualDelays = new Float64Array(names.length);
const pointAt = (p, i) => syncLag ? (p.syncAt ? p.syncAt[i] : p.at + visualDelays[i]) : p.at;
const rows = [], counterRows = [];
const time = (at, millis = false) => new Date(at).toISOString().slice(11, millis ? 23 : 19);
const pct = (value, decimals = 4) => `${value > 0 ? '+' : ''}${value.toFixed(decimals)}%`;

for (let i = 0; i < names.length; i++) {
  const row = document.createElement('tr');
  row.className = i === WEIGHTED_INDEX ? 'weighted' : '';
  const nameCell = document.createElement('td');
  const button = document.createElement('button');
  button.className = 'feed-name'; button.type = 'button'; button.setAttribute('aria-pressed', 'true');
  button.setAttribute('aria-label', `${i === WEIGHTED_INDEX ? 'Disable' : 'Disconnect'} ${names[i]}`);
  button.disabled = true;
  const swatch = document.createElement('span'); swatch.className = 'swatch'; swatch.style.backgroundColor = colors[i];
  button.append(swatch, document.createTextNode(names[i]));
  button.addEventListener('click', () => toggleMarket(i));
  const status = document.createElement('span'); status.className = 'feed-status'; status.textContent = 'connecting';
  nameCell.append(button, status);
  const price = document.createElement('td'), move = document.createElement('td');
  price.textContent = move.textContent = '—'; row.append(nameCell, price, move); $('feeds').append(row);
  rows.push({ button, status, price, move });
  if (isPrediction(i)) { counterRows.push(null); continue; }
  const c = document.createElement('tr'); c.className = row.className;
  const cn = document.createElement('td'); cn.className = 'counter-name';
  const cs = swatch.cloneNode(); cn.append(cs, document.createTextNode(shortNames[i]));
  const up = document.createElement('td'), down = document.createElement('td'), total = document.createElement('td');
  up.className = 'positive'; down.className = 'negative'; up.textContent = down.textContent = total.textContent = '0';
  c.append(cn, up, down, total); $('counters').append(c); counterRows.push({ up, down, total });
}

function configureInputs(settings) {
  $('threshold').value = settings.threshold; $('lookback').value = settings.lookbackMs;
  settings.weights.forEach((w, i) => { $(`weight-${i}`).value = w; });
}

function renderRecent() {
  if (!state) return;
  const now = frozenAt || state.at;
  const visible = [];
  for (const event of state.recent) {
    const delay = syncLag ? (visualDelays[event.series] || 0) : 0;
    const displayAt = Math.round(event.at + delay);
    if (displayAt <= now) {
      visible.push({ ...event, displayAt });
    }
  }
  visible.sort((a, b) => a.displayAt - b.displayAt || a.at - b.at);
  const latest = visible.slice(-10).reverse();
  const key = `${syncLag ? 's' : 'u'}:` + latest.map(e => `${e.series}:${e.displayAt}:${e.direction}:${e.move}`).join('|');
  if (key === recentKey) return;
  recentKey = key;
  $('recent').replaceChildren();
  for (const event of latest) {
    const li = document.createElement('li'), stamp = document.createElement('time'), name = document.createElement('span'), direction = document.createElement('span'), move = document.createElement('span');
    stamp.textContent = time(event.displayAt, true); name.textContent = shortNames[event.series]; name.style.color = colors[event.series];
    direction.textContent = event.direction > 0 ? 'UP' : 'DOWN'; direction.className = event.direction > 0 ? 'positive' : 'negative';
    move.textContent = pct(event.move, 3); move.className = 'move'; li.append(stamp, name, direction, move); $('recent').append(li);
  }
  if (!latest.length) { const li = document.createElement('li'); li.className = 'hint'; li.textContent = 'Waiting for a threshold crossing'; $('recent').append(li); }
}

function accept(next) {
  if (!next.series || !next.settings) return;
  if (state && next.epoch < state.epoch && !next.history) return;
  const newSession = !state || state.epoch !== next.epoch;
  if (newSession) {
    history = []; configureInputs(next.settings); frozenAt = null; frozenHistory = null; updatePause(); recentKey = '';
    smoothLags.fill(0); visualDelays.fill(0);
  }
  const visibilityChanged = next.series.some((s, i) => hidden.has(i) === s.enabled);
  state = next;
  hidden = new Set(next.series.flatMap((s, i) => s.enabled ? [] : [i]));

  for (let i = 0; i < names.length; i++) {
    const s = next.series[i];
    if (!s?.connected) {
      smoothLags[i] = 0;
    } else {
      const rawLag = Math.min(1000, Math.max(0, s.lag || 0));
      smoothLags[i] = smoothLags[i] === 0 ? rawLag : smoothLags[i] * 0.95 + rawLag * 0.05;
    }
  }
  let targetMaxLag = 0;
  for (let i = 0; i < WEIGHTED_INDEX; i++) {
    if (!hidden.has(i) && next.series[i]?.connected) {
      if (smoothLags[i] > targetMaxLag) targetMaxLag = smoothLags[i];
    }
  }
  for (let i = 0; i < names.length; i++) {
    const s = next.series[i];
    if (!s?.connected) {
      visualDelays[i] = 0;
    } else {
      const targetDelay = Math.max(0, targetMaxLag - smoothLags[i]);
      if (visualDelays[i] === 0 || Math.abs(visualDelays[i] - targetDelay) > 50) {
        visualDelays[i] = targetDelay;
      } else {
        const diff = targetDelay - visualDelays[i];
        if (Math.abs(diff) >= 2) {
          visualDelays[i] += Math.sign(diff) * Math.min(Math.abs(diff) * 0.08, 1.5);
        }
      }
    }
  }

  if (next.history) {
    history = next.history;
    for (let j = 0; j < history.length; j++) {
      const p = history[j];
      if (!p.syncAt) {
        p.syncAt = new Float64Array(names.length);
        const prev = j > 0 ? history[j - 1].syncAt : null;
        for (let i = 0; i < names.length; i++) {
          const delay = visualDelays[i];
          p.syncAt[i] = prev ? Math.max(prev[i] + 0.1, p.at + delay) : (p.at + delay);
        }
      }
    }
  }
  if (next.point && (!history.length || next.point.at > history.at(-1).at)) {
    const p = next.point;
    const prevPoint = history.length ? history.at(-1) : null;
    const isContiguous = prevPoint && (p.at - prevPoint.at < 1000);
    p.syncAt = new Float64Array(names.length);
    for (let i = 0; i < names.length; i++) {
      const delay = visualDelays[i];
      const prevSync = (isContiguous && prevPoint.syncAt) ? prevPoint.syncAt[i] : null;
      p.syncAt[i] = (prevSync !== null && prevSync > 0)
        ? Math.max(prevSync + 0.1, p.at + delay)
        : (p.at + delay);
    }
    history.push(p);
  }
  if (history.length > 2600) history.splice(0, history.length - 2600);
  $('clock').textContent = `${time(next.at)} UTC`;
  $('mode').textContent = next.mode === 'demo' ? 'DEMO · SYNTHETIC' : 'PUBLIC FUTURES + SPOT + 5M PREDICTION';
  $('mode').classList.toggle('demo', next.mode === 'demo');
  $('move-title').textContent = `${next.settings.lookbackMs} ms movement`;
  $('move-column').textContent = `Δ ${next.settings.lookbackMs}ms`;
  $('threshold-caption').textContent = `Signals at ±${next.settings.threshold}% · eligible periods only`;
  $('rearm-caption').textContent = `One entry per excursion. Re-arms inside ±${next.settings.threshold}%. No orders are placed.`;
  $('weight-summary').textContent = next.settings.weights.join(' : ');
  $('ready-count').textContent = `${next.series.slice(0, WEIGHTED_INDEX).filter((s) => s.ready).length} / ${WEIGHTED_INDEX} ready`;
  const missed = next.series.reduce((sum, s) => sum + s.missed, 0);
  $('gap-warning').hidden = !missed;
  $('gap-warning').textContent = `Missing Binance executions detected. Counters are incomplete; affected counters resume after a new baseline and an inside-threshold observation.`;
  next.series.forEach((s, i) => {
    rows[i].button.disabled = Boolean(rows[i].pending);
    rows[i].button.setAttribute('aria-pressed', String(s.enabled));
    rows[i].button.setAttribute('aria-label', `${i === WEIGHTED_INDEX ? s.enabled ? 'Disable' : 'Enable' : s.enabled ? 'Disconnect' : 'Reconnect'} ${names[i]}`);
    rows[i].status.textContent = s.status + (!s.ready && s.price > 0 ? ' · held' : '') + (s.connected && s.lag ? ` · ${s.lag}ms` : '') + (isPrediction(i) ? expiryLabel(s, next.at) : '');
    rows[i].price.textContent = s.price > 0 ? formatPrice(i, s.price) : '—';
    rows[i].move.textContent = s.ready ? pct(s.move) : '—';
    rows[i].move.className = s.ready ? (s.move > 0 ? 'positive' : s.move < 0 ? 'negative' : '') : '';
    if (counterRows[i]) {
      counterRows[i].up.textContent = countFormat.format(s.up);
      counterRows[i].down.textContent = countFormat.format(s.down);
      counterRows[i].total.textContent = countFormat.format(s.up + s.down);
    }
  });
  renderRecent();
  $('empty').hidden = history.some((p) => p.prices.some((value) => value > 0));
  const seconds = Math.max(0, Math.floor((next.at - next.point.at + (history.length ? next.point.at - history[0].at : 0)) / 1000));
  $('session').textContent = `${seconds}s chart history · counts since reset`;
  if (!frozenAt || visibilityChanged) requestDraw();
}

const worker = new Worker(new URL('./feed-worker.js?v=3', import.meta.url), { type: 'module' });
let requestID = 0;
const requests = new Map();
worker.onmessage = ({ data }) => {
  if (data.type === 'state') {
    try {
      accept(data.state);
      const connected = data.state.series.slice(0, WEIGHTED_INDEX).filter(s => s.connected).length;
      $('connection').textContent = data.state.mode === 'demo' ? 'Offline synthetic preview' : `${connected} public streams connected`;
      $('connection').className = `connection ${connected >= 2 || data.state.mode === 'demo' ? 'online' : 'offline'}`;
    } finally { worker.postMessage({ type: 'ack' }); }
  } else if (data.type === 'applied' || data.type === 'error') {
    const request = requests.get(data.request);
    if (request) { requests.delete(data.request); clearTimeout(request.timer); data.type === 'error' ? request.reject(new Error(data.message)) : request.resolve(); }
    else if (data.type === 'error') { $('connection').textContent = data.message; $('connection').className = 'connection offline'; }
  }
};
worker.onerror = () => { $('connection').textContent = 'Feed worker stopped · reload to reconnect'; $('connection').className = 'connection offline'; };
worker.postMessage({ type: 'start', demo: new URLSearchParams(location.search).get('demo') === '1' });
worker.postMessage({ type: 'visibility', visible: !document.hidden });
window.addEventListener('pagehide', () => { worker.terminate(); });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });

function sendRequest(type, payload) {
  return new Promise((resolve, reject) => {
    const request = ++requestID;
    const timer = setTimeout(() => { requests.delete(request); reject(new Error('Feed worker did not respond; reload to reconnect')); }, 5000);
    requests.set(request, { resolve, reject, timer }); worker.postMessage({ type, request, ...payload });
  });
}

async function toggleMarket(index) {
  if (!state) return;
  const enabled = !state.series[index].enabled;
  rows[index].pending = rows[index].button.disabled = true;
  try {
    await sendRequest('market', { index, enabled });
    requestDraw();
  } catch (error) { $('form-status').className = 'error'; $('form-status').textContent = error.message; }
  finally { rows[index].pending = rows[index].button.disabled = false; }
}

async function applySettings(resetOnly = false) {
  if (resetOnly && !state) return;
  const settings = resetOnly ? state.settings : {
    threshold: Number($('threshold').value), lookbackMs: Number($('lookback').value), weights: DEFAULT_SETTINGS.weights.map((_, i) => Number($(`weight-${i}`).value)),
  };
  $('apply').disabled = $('reset').disabled = true; $('form-status').textContent = 'Applying…'; $('form-status').className = '';
  try {
    await sendRequest('settings', { settings });
    $('form-status').textContent = 'New comparison session';
  } catch (error) { $('form-status').className = 'error'; $('form-status').textContent = error.message; }
  finally { $('apply').disabled = $('reset').disabled = false; }
}
$('settings').addEventListener('submit', (event) => { event.preventDefault(); applySettings(); });
$('reset').addEventListener('click', () => applySettings(true));
$('window').addEventListener('change', requestDraw);
function updatePause() { $('pause').textContent = frozenAt ? 'Resume chart' : 'Pause chart'; $('pause').setAttribute('aria-pressed', String(Boolean(frozenAt))); }
$('pause').addEventListener('click', () => { frozenAt = frozenAt ? null : state?.at; frozenHistory = frozenAt ? history.slice() : null; updatePause(); renderRecent(); requestDraw(); });
$('sync').addEventListener('click', () => { syncLag = !syncLag; $('sync').setAttribute('aria-pressed', String(syncLag)); renderRecent(); requestDraw(); });

function requestDraw() { if (scheduled) return; scheduled = true; requestAnimationFrame(() => { scheduled = false; draw(); }); }
const plots = [[$('price-chart'), 'prices'], [$('move-chart'), 'moves']];
const observer = new ResizeObserver(requestDraw); for (const [canvas] of plots) observer.observe(canvas.parentElement);
for (const [canvas] of plots) {
  canvas.addEventListener('pointermove', (event) => { const rect = canvas.getBoundingClientRect(); pointer = { canvas, x: event.clientX - rect.left, screenX: event.clientX, screenY: event.clientY }; requestDraw(); });
  canvas.addEventListener('pointerleave', () => { pointer = null; $('tooltip').hidden = true; requestDraw(); });
}

function nearest(points, at) {
  let lo = 0, hi = points.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (points[mid].at < at) lo = mid + 1; else hi = mid; }
  if (lo > 0 && at - points[lo - 1].at < points[lo].at - at) lo--;
  return points[lo];
}

function draw() {
  if (!state) return;
  const end = frozenAt || state.at, start = end - Number($('window').value) * 1000;
  const allHistory = frozenHistory || history;
  const delays = syncLag ? visualDelays : new Float64Array(names.length);
  const points = allHistory.filter((p) => p.at >= start - 2500 && p.at <= end + 500);
  const visible = names.map((_, i) => i).filter((i) => !hidden.has(i));
  const predictionVisible = visible.filter(isPrediction);
  const btcVisible = visible.filter((i) => !isPrediction(i)), polyVisible = predictionVisible.length > 0;
  let inspected = null;
  for (const [canvas, key] of plots) {
    const rect = canvas.getBoundingClientRect(), width = rect.width, height = rect.height, dpr = Math.min(devicePixelRatio || 1, 2);
    if (!width || !height) continue;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) { canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr); }
    const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
    const left = 82, right = polyVisible ? 58 : 17, top = 10, bottom = 25, plotWidth = width - left - right, plotHeight = height - top - bottom;
    let min = Infinity, max = -Infinity, polyMin = Infinity, polyMax = -Infinity;
    for (const p of points) for (const i of btcVisible) {
      const pAt = pointAt(p, i);
      if (pAt < start || pAt > end) continue;
      if ((key === 'prices' ? p.prices[i] > 0 : p.ready[i]) && Number.isFinite(p[key][i])) {
        min = Math.min(min, p[key][i]); max = Math.max(max, p[key][i]);
      }
    }
    if (!Number.isFinite(min)) {
      for (const p of points) for (const i of btcVisible) {
        if ((key === 'prices' ? p.prices[i] > 0 : p.ready[i]) && Number.isFinite(p[key][i])) {
          min = Math.min(min, p[key][i]); max = Math.max(max, p[key][i]);
        }
      }
    }
    if (key === 'moves') { max = Math.max(Math.abs(min), Math.abs(max), state.settings.threshold * 1.65); if (!Number.isFinite(max)) max = state.settings.threshold * 1.65; min = -max; }
    else if (!Number.isFinite(min)) { min = 79990; max = 80010; }
    else { const pad = Math.max(.4, (max - min) * .1); min -= pad; max += pad; }
    if (polyVisible) {
      for (const p of points) for (const i of predictionVisible) {
        const pAt = pointAt(p, i);
        if (pAt < start || pAt > end) continue;
        if ((key === 'prices' ? p.prices[i] > 0 : p.ready[i]) && Number.isFinite(p[key][i])) {
          polyMin = Math.min(polyMin, p[key][i]); polyMax = Math.max(polyMax, p[key][i]);
        }
      }
      if (!Number.isFinite(polyMin)) {
        for (const p of points) for (const i of predictionVisible) {
          if ((key === 'prices' ? p.prices[i] > 0 : p.ready[i]) && Number.isFinite(p[key][i])) {
            polyMin = Math.min(polyMin, p[key][i]); polyMax = Math.max(polyMax, p[key][i]);
          }
        }
      }
      if (key === 'moves') { polyMax = Math.max(Math.abs(polyMin), Math.abs(polyMax), .5); if (!Number.isFinite(polyMax)) polyMax = .5; polyMin = -polyMax; }
      else if (!Number.isFinite(polyMin)) { polyMin = 0; polyMax = 1; }
      else {
        const span = Math.max(.04, polyMax - polyMin), pad = span * .15;
        polyMin = Math.max(0, polyMin - pad); polyMax = Math.min(1, polyMax + pad);
        if (polyMax - polyMin < .04) { const mid = (polyMin + polyMax) / 2; polyMin = Math.max(0, mid - .02); polyMax = Math.min(1, polyMin + .04); }
      }
    }
    const x = (at) => left + (at - start) / (end - start) * plotWidth;
    const y = (value) => top + (max - value) / (max - min || 1) * plotHeight;
    const yFor = (i, value) => {
      const lo = isPrediction(i) ? polyMin : min, hi = isPrediction(i) ? polyMax : max;
      return top + (hi - value) / (hi - lo || 1) * plotHeight;
    };
    ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif'; ctx.lineWidth = 1;
    if (key === 'moves') {
      ctx.fillStyle = '#63e0bb09'; ctx.fillRect(left, top, plotWidth, Math.max(0, y(state.settings.threshold) - top));
      ctx.fillStyle = '#fb927e08'; ctx.fillRect(left, y(-state.settings.threshold), plotWidth, Math.max(0, top + plotHeight - y(-state.settings.threshold)));
    }
    for (let j = 0; j <= 4; j++) {
      const value = min + (max - min) * j / 4, yy = Math.round(y(value)) + .5;
      ctx.strokeStyle = '#252e3a'; ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(width - right, yy); ctx.stroke();
      ctx.fillStyle = '#a1acba'; ctx.textAlign = 'right'; ctx.fillText(key === 'prices' ? priceFormat.format(value) : `${value.toFixed(3)}%`, left - 8, yy + 3);
      if (polyVisible) {
        const pv = polyMin + (polyMax - polyMin) * j / 4;
        ctx.fillStyle = predictionVisible.length === 1 ? colors[predictionVisible[0]] : '#a1acba'; ctx.textAlign = 'left';
        ctx.fillText(key === 'prices' ? formatPrice(predictionVisible[0], pv) : `${pv.toFixed(2)}%`, width - right + 6, yy + 3);
      }
    }
    const timeTicks = plotWidth < 400 ? 2 : 4;
    for (let j = 0; j <= timeTicks; j++) {
      const at = start + (end - start) * j / timeTicks, xx = Math.round(x(at)) + .5;
      ctx.strokeStyle = '#202936'; ctx.beginPath(); ctx.moveTo(xx, top); ctx.lineTo(xx, height - bottom); ctx.stroke();
      ctx.fillStyle = '#a1acba'; ctx.textAlign = j === 0 ? 'left' : j === timeTicks ? 'right' : 'center'; ctx.fillText(time(at), xx, height - 7);
    }
    if (key === 'moves') for (const sign of [-1, 1]) {
      const yy = y(sign * state.settings.threshold); ctx.strokeStyle = '#d8e1ed8c'; ctx.setLineDash([4, 5]); ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(width - right, yy); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.save(); ctx.beginPath(); ctx.rect(left, top, plotWidth, plotHeight); ctx.clip();
    for (const i of visible) {
      ctx.strokeStyle = colors[i]; ctx.lineWidth = i === WEIGHTED_INDEX ? 2.4 : isPrediction(i) ? 1.8 : 1.2; ctx.globalAlpha = i === WEIGHTED_INDEX || isPrediction(i) ? 1 : .85;
      if (key === 'prices') {
        for (const ready of [false, true]) {
          ctx.setLineDash(ready ? [] : [4, 4]); ctx.globalAlpha = ready ? 1 : .62; ctx.beginPath();
          let lastDrawnAt = -Infinity, lastDrawnPrice = 0;
          for (let j = 1; j < points.length; j++) {
            const before = points[j - 1], p = points[j];
            if (!(before.prices[i] > 0 && p.prices[i] > 0)) continue;
            const segmentReady = before.ready[i] && p.ready[i] && p.at - before.at < 400;
            if (segmentReady !== ready) continue;
            const bAt = pointAt(before, i), pAt = pointAt(p, i);
            if (bAt >= end) continue;
            if (pAt > end) {
              ctx.moveTo(x(bAt), yFor(i, before.prices[i]));
              ctx.lineTo(x(end), yFor(i, before.prices[i]));
              lastDrawnAt = end; lastDrawnPrice = before.prices[i];
              continue;
            }
            ctx.moveTo(x(bAt), yFor(i, before.prices[i]));
            ctx.lineTo(x(pAt), yFor(i, before.prices[i]));
            ctx.lineTo(x(pAt), yFor(i, p.prices[i]));
            lastDrawnAt = pAt; lastDrawnPrice = p.prices[i];
          }
          if (lastDrawnAt > -Infinity && lastDrawnAt < end && end - lastDrawnAt < 400) {
            ctx.moveTo(x(lastDrawnAt), yFor(i, lastDrawnPrice));
            ctx.lineTo(x(end), yFor(i, lastDrawnPrice));
          }
          ctx.stroke();
        }
        ctx.setLineDash([]);
      } else {
        ctx.beginPath(); let previous = null, lastDrawnAt = -Infinity, lastDrawnMove = 0;
        for (const p of points) {
          if (!p.ready[i]) { previous = null; continue; }
          const pAt = pointAt(p, i);
          if (pAt > end) {
            if (previous && p.at - previous.at < 400) {
              ctx.lineTo(x(end), yFor(i, previous[key][i]));
              lastDrawnAt = end;
            }
            break;
          }
          const xx = x(pAt), yy = yFor(i, p[key][i]);
          if (previous && p.at - previous.at < 400) {
            ctx.lineTo(xx, yFor(i, previous[key][i])); ctx.lineTo(xx, yy);
          } else {
            ctx.moveTo(xx, yy);
          }
          previous = p;
          lastDrawnAt = pAt;
          lastDrawnMove = p[key][i];
        }
        if (lastDrawnAt > -Infinity && lastDrawnAt < end && end - lastDrawnAt < 400) {
          ctx.lineTo(x(end), yFor(i, lastDrawnMove));
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if (key === 'moves' && !isPrediction(i)) for (let j = 1; j < points.length; j++) {
        const p = points[j], before = points[j - 1]; if (!p.ready[i]) continue; if (p.up[i] === before.up[i] && p.down[i] === before.down[i]) continue;
        const pAt = pointAt(p, i); if (pAt > end) continue;
        const xx = x(pAt), yy = yFor(i, p.moves[i]); ctx.fillStyle = colors[i]; ctx.beginPath(); ctx.arc(xx, yy, i === WEIGHTED_INDEX ? 3.5 : 2.5, 0, Math.PI * 2); ctx.fill();
      }
    }
    if (pointer && pointer.canvas === canvas && allHistory.length && pointer.x >= left && pointer.x <= width - right) {
      const targetAt = start + (pointer.x - left) / plotWidth * (end - start);
      inspected = nearest(allHistory, targetAt);
      const inspectAt = inspected ? inspected.at : targetAt;
      ctx.strokeStyle = '#a1acba'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x(inspectAt), top); ctx.lineTo(x(inspectAt), height - bottom); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.restore();
  }
  $('tooltip').hidden = !inspected;
  if (inspected) {
    $('tooltip').replaceChildren(); const heading = document.createElement('header'); heading.textContent = `${time(inspected.at, true)} UTC · * held price`; $('tooltip').append(heading);
    for (const i of visible) {
      const delay = delays[i];
      const p_i = delay && allHistory.length ? nearest(allHistory, inspected.at - delay) : inspected;
      const row = document.createElement('div'); row.className = 'tip-row'; const name = document.createElement('span'), price = document.createElement('span'), move = document.createElement('span');
      name.textContent = shortNames[i]; name.style.color = colors[i]; price.textContent = p_i && p_i.prices[i] > 0 ? formatPrice(i, p_i.prices[i]) + (p_i.ready[i] ? '' : '*') : '—'; move.textContent = p_i && p_i.ready[i] ? pct(p_i.moves[i]) : '—'; row.append(name, price, move); $('tooltip').append(row);
    }
    $('tooltip').style.left = `${Math.max(6, Math.min(innerWidth - $('tooltip').offsetWidth - 8, pointer.screenX + 15))}px`;
    $('tooltip').style.top = `${Math.max(6, Math.min(innerHeight - $('tooltip').offsetHeight - 8, pointer.screenY + 15))}px`;
  }
}

function updateVisibility() {
  worker.postMessage({ type: 'visibility', visible: !document.hidden });
  if (!document.hidden) requestDraw();
}
document.addEventListener('visibilitychange', updateVisibility);
document.addEventListener('resume', updateVisibility);
window.addEventListener('online', updateVisibility);
