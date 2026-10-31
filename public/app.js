import { NAMES as names, DEFAULT_SETTINGS, WEIGHTED_INDEX } from './engine.js';
const colors = ['#f4c768', '#6aa9ff', '#c6a0f6', '#f78d98', '#d4e294', '#e9ab74', '#67d5ef', '#63e0bb'];
const shortNames = ['Binance Fut.', 'Bybit', 'OKX', 'Hyperliquid', 'Deribit', 'Kraken Fut.', 'Binance Spot', 'Weighted'];
const $ = (id) => document.getElementById(id);
const priceFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const countFormat = new Intl.NumberFormat('en-US');
let state = null, history = [], hidden = new Set(), frozenAt = null, frozenHistory = null, pointer = null, scheduled = false, recentKey = '';
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

function accept(next) {
  if (!next.series || !next.settings) return;
  if (state && next.epoch < state.epoch && !next.history) return;
  const newSession = !state || state.epoch !== next.epoch;
  if (newSession) { history = []; configureInputs(next.settings); frozenAt = null; frozenHistory = null; updatePause(); recentKey = ''; }
  if (next.history) history = next.history;
  if (next.point && (!history.length || next.point.at > history.at(-1).at)) history.push(next.point);
  if (history.length > 2600) history.splice(0, history.length - 2600);
  const visibilityChanged = next.series.some((s, i) => hidden.has(i) === s.enabled);
  state = next;
  hidden = new Set(next.series.flatMap((s, i) => s.enabled ? [] : [i]));
  $('clock').textContent = `${time(next.at)} UTC`;
  $('mode').textContent = next.mode === 'demo' ? 'DEMO · SYNTHETIC' : 'PUBLIC FUTURES + SPOT TRADES';
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
    rows[i].status.textContent = s.status + (!s.ready && s.price > 0 ? ' · held' : '');
    rows[i].price.textContent = s.price > 0 ? priceFormat.format(s.price) : '—';
    rows[i].move.textContent = s.ready ? pct(s.move) : '—';
    rows[i].move.className = s.ready ? (s.move > 0 ? 'positive' : s.move < 0 ? 'negative' : '') : '';
    counterRows[i].up.textContent = countFormat.format(s.up);
    counterRows[i].down.textContent = countFormat.format(s.down);
    counterRows[i].total.textContent = countFormat.format(s.up + s.down);
  });
  const key = JSON.stringify(next.recent.slice(-10));
  if (key !== recentKey) {
    recentKey = key; $('recent').replaceChildren();
    for (const event of next.recent.slice(-10).reverse()) {
      const li = document.createElement('li'), stamp = document.createElement('time'), name = document.createElement('span'), direction = document.createElement('span'), move = document.createElement('span');
      stamp.textContent = time(event.at, true); name.textContent = shortNames[event.series]; name.style.color = colors[event.series];
      direction.textContent = event.direction > 0 ? 'UP' : 'DOWN'; direction.className = event.direction > 0 ? 'positive' : 'negative';
      move.textContent = pct(event.move, 3); move.className = 'move'; li.append(stamp, name, direction, move); $('recent').append(li);
    }
    if (!next.recent.length) { const li = document.createElement('li'); li.className = 'hint'; li.textContent = 'Waiting for a threshold crossing'; $('recent').append(li); }
  }
  $('empty').hidden = history.some((p) => p.prices.some((value) => value > 0));
  const seconds = Math.max(0, Math.floor((next.at - next.point.at + (history.length ? next.point.at - history[0].at : 0)) / 1000));
  $('session').textContent = `${seconds}s chart history · counts since reset`;
  if (!frozenAt || visibilityChanged) requestDraw();
}

const worker = new Worker(new URL('./feed-worker.js', import.meta.url), { type: 'module' });
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
$('pause').addEventListener('click', () => { frozenAt = frozenAt ? null : state?.at; frozenHistory = frozenAt ? history.slice() : null; updatePause(); requestDraw(); });

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
  const points = (frozenHistory || history).filter((p) => p.at >= start && p.at <= end);
  const visible = names.map((_, i) => i).filter((i) => !hidden.has(i));
  let inspected = null;
  for (const [canvas, key] of plots) {
    const rect = canvas.getBoundingClientRect(), width = rect.width, height = rect.height, dpr = Math.min(devicePixelRatio || 1, 2);
    if (!width || !height) continue;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) { canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr); }
    const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
    const left = 82, right = 17, top = 10, bottom = 25, plotWidth = width - left - right, plotHeight = height - top - bottom;
    let min = Infinity, max = -Infinity;
    for (const p of points) for (const i of visible) if ((key === 'prices' ? p.prices[i] > 0 : p.ready[i]) && Number.isFinite(p[key][i])) { min = Math.min(min, p[key][i]); max = Math.max(max, p[key][i]); }
    if (key === 'moves') { max = Math.max(Math.abs(min), Math.abs(max), state.settings.threshold * 1.65); if (!Number.isFinite(max)) max = state.settings.threshold * 1.65; min = -max; }
    else if (!Number.isFinite(min)) { min = 79990; max = 80010; }
    else { const pad = Math.max(.4, (max - min) * .1); min -= pad; max += pad; }
    const x = (at) => left + (at - start) / (end - start) * plotWidth;
    const y = (value) => top + (max - value) / (max - min || 1) * plotHeight;
    ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif'; ctx.lineWidth = 1;
    if (key === 'moves') {
      ctx.fillStyle = '#63e0bb09'; ctx.fillRect(left, top, plotWidth, Math.max(0, y(state.settings.threshold) - top));
      ctx.fillStyle = '#fb927e08'; ctx.fillRect(left, y(-state.settings.threshold), plotWidth, Math.max(0, top + plotHeight - y(-state.settings.threshold)));
    }
    for (let j = 0; j <= 4; j++) {
      const value = min + (max - min) * j / 4, yy = Math.round(y(value)) + .5;
      ctx.strokeStyle = '#252e3a'; ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(width - right, yy); ctx.stroke();
      ctx.fillStyle = '#a1acba'; ctx.textAlign = 'right'; ctx.fillText(key === 'prices' ? priceFormat.format(value) : `${value.toFixed(3)}%`, left - 8, yy + 3);
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
      ctx.strokeStyle = colors[i]; ctx.lineWidth = i === WEIGHTED_INDEX ? 2.4 : 1.2; ctx.globalAlpha = i === WEIGHTED_INDEX ? 1 : .85;
      if (key === 'prices') {
        for (const ready of [false, true]) {
          ctx.setLineDash(ready ? [] : [4, 4]); ctx.globalAlpha = ready ? 1 : .62; ctx.beginPath();
          for (let j = 1; j < points.length; j++) {
            const before = points[j - 1], p = points[j];
            if (!(before.prices[i] > 0 && p.prices[i] > 0)) continue;
            const segmentReady = before.ready[i] && p.ready[i] && p.at - before.at < 400;
            if (segmentReady !== ready) continue;
            ctx.moveTo(x(before.at), y(before.prices[i])); ctx.lineTo(x(p.at), y(before.prices[i])); ctx.lineTo(x(p.at), y(p.prices[i]));
          }
          ctx.stroke();
        }
        ctx.setLineDash([]);
      } else {
        ctx.beginPath(); let previous = null;
        for (const p of points) {
          if (!p.ready[i]) { previous = null; continue; }
          const xx = x(p.at), yy = y(p[key][i]);
          if (previous && p.at - previous.at < 400) { ctx.lineTo(xx, y(previous[key][i])); ctx.lineTo(xx, yy); } else ctx.moveTo(xx, yy);
          previous = p;
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if (key === 'moves') for (let j = 1; j < points.length; j++) {
        const p = points[j], before = points[j - 1]; if (!p.ready[i]) continue; if (p.up[i] === before.up[i] && p.down[i] === before.down[i]) continue;
        const xx = x(p.at), yy = y(p.moves[i]); ctx.fillStyle = colors[i]; ctx.beginPath(); ctx.arc(xx, yy, i === WEIGHTED_INDEX ? 3.5 : 2.5, 0, Math.PI * 2); ctx.fill();
      }
    }
    if (pointer && pointer.canvas === canvas && points.length && pointer.x >= left && pointer.x <= width - right) {
      inspected = nearest(points, start + (pointer.x - left) / plotWidth * (end - start));
      ctx.strokeStyle = '#a1acba'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x(inspected.at), top); ctx.lineTo(x(inspected.at), height - bottom); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.restore();
  }
  $('tooltip').hidden = !inspected;
  if (inspected) {
    $('tooltip').replaceChildren(); const heading = document.createElement('header'); heading.textContent = `${time(inspected.at, true)} UTC · * held price`; $('tooltip').append(heading);
    for (const i of visible) {
      const row = document.createElement('div'); row.className = 'tip-row'; const name = document.createElement('span'), price = document.createElement('span'), move = document.createElement('span');
      name.textContent = shortNames[i]; name.style.color = colors[i]; price.textContent = inspected.prices[i] > 0 ? priceFormat.format(inspected.prices[i]) + (inspected.ready[i] ? '' : '*') : '—'; move.textContent = inspected.ready[i] ? pct(inspected.moves[i]) : '—'; row.append(name, price, move); $('tooltip').append(row);
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
