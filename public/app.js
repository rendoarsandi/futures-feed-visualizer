import { NAMES as names, DEFAULT_SETTINGS, SPOT_INDEX, POLYMARKET_INDEX, POLYMARKET_ETH_INDEX, WEIGHTED_INDEX } from './engine.js';

const colors = ['#f4c768', '#6aa9ff', '#c6a0f6', '#f78d98', '#d4e294', '#e9ab74', '#67d5ef', '#ff79c6', '#e056fd', '#63e0bb'];
const shortNames = ['Binance Fut.', 'Bybit', 'OKX', 'Hyperliquid', 'Deribit', 'Kraken Fut.', 'Binance Spot', 'Poly BTC 5m', 'Poly ETH 5m', 'Weighted'];
const isPrediction = (i) => i === POLYMARKET_INDEX || i === POLYMARKET_ETH_INDEX;
const VIEW_FILTERS = {
  all: { label: 'All', match: () => true },
  'spot-fut': { label: 'Spot vs Fut', match: (i) => i === 0 || i === SPOT_INDEX },
  futures: { label: 'Futures', match: (i) => i < SPOT_INDEX || i === WEIGHTED_INDEX },
  poly: { label: '5m Poly', match: (i) => i === 0 || i === SPOT_INDEX || i === WEIGHTED_INDEX || isPrediction(i) },
};
const $ = (id) => document.getElementById(id);
const priceFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const countFormat = new Intl.NumberFormat('en-US');
const formatPrice = (i, value) => isPrediction(i) ? `${(value * 100).toFixed(1)}¢` : priceFormat.format(value);
const expiryLabel = (s, at) => {
  if (!s.enabled || !s.expiresAt) return '';
  const sec = Math.max(0, Math.ceil((s.expiresAt - at) / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')} left`;
};

let state = null, history = [], hidden = new Set(), frozenAt = null, frozenHistory = null, pointer = null, scheduled = false, recentKey = '', syncLag = true;
let activeView = 'all', hoveredSeries = -1;
const smoothLags = new Float64Array(names.length);
const visualDelays = new Float64Array(names.length);
const recentSyncAt = new Map();
const lastRecentSyncAt = new Float64Array(names.length);
const recentEventKey = (e) => `${e.series}:${e.at}:${e.direction}:${e.move}`;
const pointAt = (p, i) => syncLag ? (p.syncAt ? p.syncAt[i] : p.at + visualDelays[i]) : p.at;
const rows = [], counterRows = [];
const time = (at, millis = false) => new Date(at).toISOString().slice(11, millis ? 23 : 19);
const pct = (value, decimals = 4) => `${value > 0 ? '+' : ''}${value.toFixed(decimals)}%`;
const fmtThreshold = (v) => v >= 0.1 ? v.toFixed(3) : v >= 0.01 ? v.toFixed(4) : v.toFixed(5);

function isInView(i) {
  return (VIEW_FILTERS[activeView] || VIEW_FILTERS.all).match(i);
}

function setHover(index) {
  if (hoveredSeries === index) return;
  hoveredSeries = index;
  rows.forEach((r, i) => r.tr.classList.toggle('focused', i === hoveredSeries));
  counterRows.forEach((r, i) => { if (r) r.tr.classList.toggle('focused', i === hoveredSeries); });
  requestDraw();
}

for (let i = 0; i < names.length; i++) {
  const row = document.createElement('tr');
  row.className = i === WEIGHTED_INDEX ? 'weighted' : '';
  row.addEventListener('pointerenter', () => setHover(i));
  row.addEventListener('pointerleave', () => setHover(-1));
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
  rows.push({ tr: row, button, status, price, move });

  if (isPrediction(i)) { counterRows.push(null); continue; }
  const c = document.createElement('tr'); c.className = row.className;
  c.addEventListener('pointerenter', () => setHover(i));
  c.addEventListener('pointerleave', () => setHover(-1));
  const cn = document.createElement('td'); cn.className = 'counter-name';
  const cs = swatch.cloneNode(); cn.append(cs, document.createTextNode(shortNames[i]));
  const up = document.createElement('td'), down = document.createElement('td'), total = document.createElement('td');
  up.className = 'positive'; down.className = 'negative'; total.className = 'total-cell';
  const totalBar = document.createElement('span'); totalBar.className = 'total-bar';
  const totalVal = document.createElement('span'); totalVal.className = 'total-val';
  total.append(totalBar, totalVal);
  up.textContent = down.textContent = totalVal.textContent = '0';
  c.append(cn, up, down, total); $('counters').append(c); counterRows.push({ tr: c, up, down, totalBar, totalVal });
}

function updateDynamicMultVisibility() {
  $('dynamic-mult-wrap').hidden = !$('dynamic-vol').checked;
}
$('dynamic-vol').addEventListener('change', updateDynamicMultVisibility);

function configureInputs(settings) {
  $('threshold').value = settings.threshold;
  $('lookback').value = settings.lookbackMs;
  $('cooldown').value = settings.cooldownMs ?? DEFAULT_SETTINGS.cooldownMs;
  $('dynamic-vol').checked = Boolean(settings.dynamicVol);
  $('dynamic-mult').value = settings.dynamicVolMult ?? DEFAULT_SETTINGS.dynamicVolMult;
  updateDynamicMultVisibility();
  settings.weights.forEach((w, i) => { $(`weight-${i}`).value = w; });
}

function updateViewDimming() {
  rows.forEach((r, i) => r.tr.classList.toggle('dimmed', !isInView(i)));
  counterRows.forEach((r, i) => { if (r) r.tr.classList.toggle('dimmed', !isInView(i)); });
  $('recent-scope').textContent = `${(VIEW_FILTERS[activeView] || VIEW_FILTERS.all).label} · UTC`;
}

document.querySelectorAll('.view-filter button').forEach((btn) => {
  btn.addEventListener('click', () => {
    activeView = btn.dataset.view || 'all';
    document.querySelectorAll('.view-filter button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    updateViewDimming();
    recentKey = '';
    renderRecent();
    requestDraw();
  });
});

function renderRecent() {
  if (!state) return;
  const now = frozenAt || state.at;
  const visible = [];
  for (const event of state.recent) {
    if (!isInView(event.series)) continue;
    const frozenSyncAt = recentSyncAt.get(recentEventKey(event));
    const displayAt = syncLag ? (frozenSyncAt ?? Math.round(event.at)) : Math.round(event.at);
    if (displayAt <= now) {
      visible.push({ ...event, displayAt });
    }
  }
  visible.sort((a, b) => a.displayAt - b.displayAt || a.at - b.at);
  // Compute arrival order within same-direction 500ms clusters.
  for (let idx = 0; idx < visible.length; idx++) {
    const ev = visible[idx];
    let firstAt = ev.at;
    let clusterSize = 1;
    for (let k = idx - 1; k >= 0; k--) {
      if (ev.at - visible[k].at > 500) break;
      if (visible[k].direction === ev.direction) {
        firstAt = Math.min(firstAt, visible[k].at);
        clusterSize++;
      }
    }
    for (let k = idx + 1; k < visible.length; k++) {
      if (visible[k].at - ev.at > 500) break;
      if (visible[k].direction === ev.direction) clusterSize++;
    }
    ev.clusterSize = clusterSize;
    ev.leadDelta = Math.max(0, Math.round(ev.at - firstAt));
  }
  const latest = visible.slice(-12).reverse();
  const key = `${activeView}:${syncLag ? 's' : 'u'}:` + latest.map(e => `${e.series}:${e.displayAt}:${e.direction}:${e.move}:${e.leadDelta}:${e.clusterSize}`).join('|');
  if (key === recentKey) return;
  recentKey = key;
  $('recent').replaceChildren();
  for (const event of latest) {
    const li = document.createElement('li');
    const stamp = document.createElement('time');
    const name = document.createElement('span');
    const direction = document.createElement('span');
    const move = document.createElement('span');
    const lead = document.createElement('span');
    stamp.textContent = time(event.displayAt, true);
    name.className = 'sig-venue'; name.textContent = shortNames[event.series]; name.style.color = colors[event.series];
    direction.textContent = event.direction > 0 ? '▲ UP' : '▼ DN';
    direction.className = `sig-dir ${event.direction > 0 ? 'up' : 'down'}`;
    move.textContent = pct(event.move, 3); move.className = 'move';
    lead.className = 'lead-tag';
    if (event.clusterSize > 1) {
      if (event.leadDelta === 0) { lead.textContent = '1st'; lead.classList.add('first'); }
      else { lead.textContent = `+${event.leadDelta}ms`; }
    }
    li.append(stamp, name, direction, move, lead);
    $('recent').append(li);
  }
  if (!latest.length) {
    const li = document.createElement('li');
    li.className = 'hint';
    li.textContent = 'Waiting for a threshold crossing';
    $('recent').append(li);
  }
}

function accept(next) {
  if (!next.series || !next.settings) return;
  if (state && next.epoch < state.epoch && !next.history) return;
  const newSession = !state || state.epoch !== next.epoch;
  if (newSession) {
    history = []; configureInputs(next.settings); frozenAt = null; frozenHistory = null; updatePause(); recentKey = '';
    smoothLags.fill(0); visualDelays.fill(0); recentSyncAt.clear(); lastRecentSyncAt.fill(0);
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
    if (!hidden.has(i) && isInView(i) && next.series[i]?.connected) {
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
  $('sync').textContent = syncLag && targetMaxLag >= 1 ? `Sync lag · ${Math.round(targetMaxLag)}ms` : 'Sync lag';

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
  $('mode').textContent = next.mode === 'demo' ? 'DEMO · SYNTHETIC' : 'PUBLIC TRADES';
  $('mode').classList.toggle('demo', next.mode === 'demo');
  $('move-title').textContent = `${next.settings.lookbackMs} ms movement`;
  $('move-column').textContent = `Δ ${next.settings.lookbackMs}ms`;

  // Show Spot vs Futures live spread in price chart header when both have prices.
  const binFut = next.series[0], binSpot = next.series[SPOT_INDEX];
  if (binFut?.price > 0 && binSpot?.price > 0) {
    const spread = binFut.price - binSpot.price;
    const spreadSign = spread >= 0 ? '+' : '';
    $('price-meta').textContent = `Fut−Spot ${spreadSign}$${spread.toFixed(2)}`;
  } else {
    $('price-meta').textContent = '';
  }

  // Dynamic volatility & threshold caption.
  const focusIdx = hoveredSeries >= 0 && !isPrediction(hoveredSeries) ? hoveredSeries : (activeView === 'spot-fut' ? SPOT_INDEX : WEIGHTED_INDEX);
  const focusSeries = next.series[focusIdx] || next.series[0];
  if (next.settings.dynamicVol) {
    if (focusSeries?.volReady) {
      $('threshold-caption').textContent = `Floor ±${next.settings.threshold}% · Dyn ${next.settings.dynamicVolMult}× (±${fmtThreshold(focusSeries.effectiveThreshold)}%)`;
    } else {
      $('threshold-caption').textContent = `Floor ±${next.settings.threshold}% · Warming 60s/240s vol…`;
    }
  } else {
    $('threshold-caption').textContent = `Threshold ±${next.settings.threshold}%` + (next.settings.cooldownMs > 0 ? ` · ${next.settings.cooldownMs}ms cd` : '');
  }

  const cdText = next.settings.cooldownMs > 0
    ? `${next.settings.cooldownMs} ms cooldown · re-arms inside ±${fmtThreshold(next.settings.threshold * 0.5)}%`
    : `No cooldown · re-arms inside ±${next.settings.threshold}%`;
  const dynNote = next.settings.dynamicVol ? ` · Dynamic Vol ${next.settings.dynamicVolMult}× (60s/240s)` : '';
  $('rearm-caption').textContent = `${cdText}${dynNote}. No orders are placed.`;
  $('weight-summary').textContent = next.settings.weights.join(' : ');
  $('ready-count').textContent = `${next.series.slice(0, WEIGHTED_INDEX).filter((s) => s.ready).length} / ${WEIGHTED_INDEX} ready`;

  const missed = next.series.reduce((sum, s) => sum + s.missed, 0);
  $('gap-warning').hidden = !missed;
  $('gap-warning').textContent = `Missing Binance executions detected. Affected counters pause and re-arm after a fresh baseline.`;

  let maxTotal = 0;
  for (let i = 0; i < next.series.length; i++) {
    if (!isPrediction(i)) maxTotal = Math.max(maxTotal, next.series[i].up + next.series[i].down);
  }

  next.series.forEach((s, i) => {
    rows[i].button.disabled = Boolean(rows[i].pending);
    rows[i].button.setAttribute('aria-pressed', String(s.enabled));
    rows[i].button.setAttribute('aria-label', `${i === WEIGHTED_INDEX ? s.enabled ? 'Disable' : 'Enable' : s.enabled ? 'Disconnect' : 'Reconnect'} ${names[i]}`);
    const parts = [s.status];
    if (!s.ready && s.price > 0) parts.push('held');
    if (i === SPOT_INDEX && s.connected) parts.push(s.streamKind === 'aggTrade' ? '@aggTrade' : '@trade');
    else if ((i === 0 || i === 4) && s.connected) parts.push('100ms');
    if (s.connected && s.lag) parts.push(`${s.lag}ms`);
    if (next.settings.dynamicVol && !isPrediction(i) && s.volReady && s.dynamicActive) parts.push(`dyn ±${fmtThreshold(s.effectiveThreshold)}%`);
    if (isPrediction(i)) { const exp = expiryLabel(s, next.at); if (exp) parts.push(exp); }
    const nextStatus = parts.join(' · ');
    if (rows[i].status.textContent !== nextStatus) rows[i].status.textContent = nextStatus;
    rows[i].status.classList.toggle('vol-active', Boolean(next.settings.dynamicVol && s.dynamicActive));
    const nextPrice = s.price > 0 ? formatPrice(i, s.price) : '—';
    if (rows[i].price.textContent !== nextPrice) rows[i].price.textContent = nextPrice;
    const nextMove = s.ready ? pct(s.move) : '—';
    if (rows[i].move.textContent !== nextMove) rows[i].move.textContent = nextMove;
    const nextMoveClass = s.ready ? (s.move > 0 ? 'positive' : s.move < 0 ? 'negative' : '') : '';
    if (rows[i].move.className !== nextMoveClass) rows[i].move.className = nextMoveClass;
    if (counterRows[i]) {
      const tot = s.up + s.down;
      counterRows[i].up.textContent = countFormat.format(s.up);
      counterRows[i].down.textContent = countFormat.format(s.down);
      counterRows[i].totalVal.textContent = countFormat.format(tot);
      counterRows[i].totalBar.style.width = maxTotal > 0 ? `${Math.round((tot / maxTotal) * 100)}%` : '0%';
    }
  });

  if (next.recent) {
    const activeKeys = new Set();
    for (const event of next.recent) {
      const key = recentEventKey(event);
      activeKeys.add(key);
      if (!recentSyncAt.has(key)) {
        const delay = visualDelays[event.series] || 0;
        const synced = Math.max(lastRecentSyncAt[event.series] + 1, Math.round(event.at + delay));
        lastRecentSyncAt[event.series] = synced;
        recentSyncAt.set(key, synced);
      }
    }
    for (const key of recentSyncAt.keys()) {
      if (!activeKeys.has(key)) recentSyncAt.delete(key);
    }
  }
  renderRecent();
  $('empty').hidden = history.some((p) => p.prices.some((value) => value > 0));
  const seconds = Math.max(0, Math.floor((next.at - next.point.at + (history.length ? next.point.at - history[0].at : 0)) / 1000));
  $('session').textContent = `${seconds}s history · counts since reset`;
  if (!frozenAt || visibilityChanged) requestDraw();
}

const worker = new Worker(new URL('./feed-worker.js?v=6', import.meta.url), { type: 'module' });
let requestID = 0;
const requests = new Map();
worker.onmessage = ({ data }) => {
  if (data.type === 'state') {
    try {
      accept(data.state);
      const connected = data.state.series.slice(0, WEIGHTED_INDEX).filter(s => s.connected).length;
      $('connection').textContent = data.state.mode === 'demo' ? 'Offline synthetic preview' : `${connected} / ${WEIGHTED_INDEX} connected`;
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
    threshold: Number($('threshold').value),
    lookbackMs: Number($('lookback').value),
    cooldownMs: Number($('cooldown').value),
    dynamicVol: $('dynamic-vol').checked,
    dynamicVolMult: Number($('dynamic-mult').value),
    weights: DEFAULT_SETTINGS.weights.map((_, i) => Number($(`weight-${i}`).value)),
  };
  $('apply').disabled = $('reset').disabled = true; $('form-status').textContent = 'Applying…'; $('form-status').className = '';
  try {
    await sendRequest('settings', { settings });
    $('form-status').textContent = 'Session reset';
  } catch (error) { $('form-status').className = 'error'; $('form-status').textContent = error.message; }
  finally { $('apply').disabled = $('reset').disabled = false; }
}
$('settings').addEventListener('submit', (event) => { event.preventDefault(); applySettings(); });
$('reset').addEventListener('click', () => applySettings(true));
$('window').addEventListener('change', requestDraw);
function updatePause() { $('pause').textContent = frozenAt ? 'Resume' : 'Pause'; $('pause').setAttribute('aria-pressed', String(Boolean(frozenAt))); }
$('pause').addEventListener('click', () => { frozenAt = frozenAt ? null : state?.at; frozenHistory = frozenAt ? history.slice() : null; updatePause(); renderRecent(); requestDraw(); });
$('sync').addEventListener('click', () => { syncLag = !syncLag; $('sync').setAttribute('aria-pressed', String(syncLag)); renderRecent(); requestDraw(); });

function requestDraw() { if (scheduled) return; scheduled = true; requestAnimationFrame(() => { scheduled = false; draw(); }); }
const plots = [[$('price-chart'), 'prices'], [$('move-chart'), 'moves']];
const observer = new ResizeObserver(requestDraw); for (const [canvas] of plots) observer.observe(canvas.parentElement);
function clearPointer() {
  if (!pointer) return;
  pointer = null;
  $('tooltip').hidden = true;
  requestDraw();
}
for (const [canvas] of plots) {
  canvas.addEventListener('pointermove', (event) => { const rect = canvas.getBoundingClientRect(); pointer = { canvas, x: event.clientX - rect.left, screenX: event.clientX, screenY: event.clientY }; requestDraw(); });
  canvas.addEventListener('pointerleave', clearPointer);
  canvas.addEventListener('pointercancel', clearPointer);
}
window.addEventListener('scroll', clearPointer, { passive: true });
document.querySelector('aside')?.addEventListener('scroll', clearPointer, { passive: true });

function nearest(points, at) {
  let lo = 0, hi = points.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (points[mid].at < at) lo = mid + 1; else hi = mid; }
  if (lo > 0 && at - points[lo - 1].at < points[lo].at - at) lo--;
  return points[lo];
}

function drawTriangle(ctx, x, y, size, up, fill) {
  ctx.beginPath();
  if (up) {
    ctx.moveTo(x, y - size);
    ctx.lineTo(x + size * 0.9, y + size * 0.75);
    ctx.lineTo(x - size * 0.9, y + size * 0.75);
  } else {
    ctx.moveTo(x, y + size);
    ctx.lineTo(x + size * 0.9, y - size * 0.75);
    ctx.lineTo(x - size * 0.9, y - size * 0.75);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1.25;
  ctx.strokeStyle = '#0d1117';
  ctx.stroke();
}

function drawAxisPill(ctx, text, xRight, yCenter, bg, fg) {
  ctx.font = '600 10.5px -apple-system, BlinkMacSystemFont, sans-serif';
  const padX = 5, h = 16, w = ctx.measureText(text).width + padX * 2;
  const rx = xRight - w - 4, ry = yCenter - h / 2;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(rx, ry, w, h, 3) : ctx.rect(rx, ry, w, h);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textAlign = 'right';
  ctx.fillText(text, xRight - 4 - padX, yCenter + 3.5);
}

function draw() {
  if (!state) return;
  const end = frozenAt || state.at, start = end - Number($('window').value) * 1000;
  const allHistory = frozenHistory || history;
  const delays = syncLag ? visualDelays : new Float64Array(names.length);
  const points = allHistory.filter((p) => p.at >= start - 2500 && p.at <= end + 500);
  const visible = names.map((_, i) => i).filter((i) => !hidden.has(i) && isInView(i));
  const predictionVisible = visible.filter(isPrediction);
  const btcVisible = visible.filter((i) => !isPrediction(i)), polyVisible = predictionVisible.length > 0;
  const visibleSet = new Set(visible);
  const visibleSignals = (state.signals || []).filter((sig) => {
    if (!visibleSet.has(sig.series) || isPrediction(sig.series)) return false;
    const sigAt = sig.at + (syncLag ? visualDelays[sig.series] : 0);
    return sigAt >= start && sigAt <= end;
  });

  // Determine active dynamic threshold to display on move chart (if enabled).
  const dynRefIndex = hoveredSeries >= 0 && !isPrediction(hoveredSeries) && visibleSet.has(hoveredSeries)
    ? hoveredSeries
    : (visibleSet.has(WEIGHTED_INDEX) ? WEIGHTED_INDEX : btcVisible[0]);
  const dynRefSeries = dynRefIndex !== undefined ? state.series[dynRefIndex] : null;
  const showDynBand = Boolean(state.settings.dynamicVol && dynRefSeries?.volReady && dynRefSeries.dynamicActive);
  const activeDynLevel = showDynBand ? dynRefSeries.effectiveThreshold : 0;

  let inspected = null;
  for (const [canvas, key] of plots) {
    const rect = canvas.getBoundingClientRect(), width = rect.width, height = rect.height, dpr = Math.min(devicePixelRatio || 1, 2);
    if (!width || !height) continue;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const left = 82, right = polyVisible ? 58 : 18, top = 12, bottom = 24, plotWidth = width - left - right, plotHeight = height - top - bottom;
    if (plotWidth <= 10 || plotHeight <= 10) continue;

    let min = Infinity, max = -Infinity, polyMin = Infinity, polyMax = -Infinity;
    for (const p of points) for (const i of btcVisible) {
      const pAt = pointAt(p, i);
      if (pAt < start || pAt > end) continue;
      if ((key === 'prices' ? p.prices[i] > 0 : p.ready[i]) && Number.isFinite(p[key][i])) {
        min = Math.min(min, p[key][i]); max = Math.max(max, p[key][i]);
      }
    }
    if (key === 'moves') {
      for (const sig of visibleSignals) {
        if (Number.isFinite(sig.move)) { min = Math.min(min, sig.move); max = Math.max(max, sig.move); }
      }
    }
    if (!Number.isFinite(min)) {
      for (const p of points) for (const i of btcVisible) {
        if ((key === 'prices' ? p.prices[i] > 0 : p.ready[i]) && Number.isFinite(p[key][i])) {
          min = Math.min(min, p[key][i]); max = Math.max(max, p[key][i]);
        }
      }
    }
    if (key === 'moves') {
      const refThresh = Math.max(state.settings.threshold, activeDynLevel);
      max = Math.max(Math.abs(min), Math.abs(max), refThresh * 1.65);
      if (!Number.isFinite(max)) max = refThresh * 1.65;
      max *= 1.08;
      min = -max;
    } else if (!Number.isFinite(min)) {
      min = 79990; max = 80010;
    } else {
      const pad = Math.max(0.4, (max - min) * 0.12); min -= pad; max += pad;
    }

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
      if (key === 'moves') {
        polyMax = Math.max(Math.abs(polyMin), Math.abs(polyMax), 0.5);
        if (!Number.isFinite(polyMax)) polyMax = 0.5;
        polyMin = -polyMax;
      } else if (!Number.isFinite(polyMin)) {
        polyMin = 0; polyMax = 1;
      } else {
        const span = Math.max(0.04, polyMax - polyMin), pad = span * 0.15;
        polyMin = Math.max(0, polyMin - pad); polyMax = Math.min(1, polyMax + pad);
        if (polyMax - polyMin < 0.04) { const mid = (polyMin + polyMax) / 2; polyMin = Math.max(0, mid - 0.02); polyMax = Math.min(1, polyMin + 0.04); }
      }
    }

    const x = (at) => left + (at - start) / (end - start) * plotWidth;
    const y = (value) => top + (max - value) / (max - min || 1) * plotHeight;
    const yFor = (i, value) => {
      const lo = isPrediction(i) ? polyMin : min, hi = isPrediction(i) ? polyMax : max;
      return top + (hi - value) / (hi - lo || 1) * plotHeight;
    };

    ctx.font = '11.5px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.lineWidth = 1;

    // Trigger zone shading on move chart.
    if (key === 'moves') {
      const triggerLevel = showDynBand ? activeDynLevel : state.settings.threshold;
      const yPos = Math.max(top, y(triggerLevel));
      const yNeg = Math.min(top + plotHeight, y(-triggerLevel));
      ctx.fillStyle = 'rgba(92, 224, 174, 0.065)';
      ctx.fillRect(left, top, plotWidth, Math.max(0, yPos - top));
      ctx.fillStyle = 'rgba(251, 139, 120, 0.06)';
      ctx.fillRect(left, yNeg, plotWidth, Math.max(0, top + plotHeight - yNeg));
    }

    // Horizontal grid & axis labels.
    for (let j = 0; j <= 4; j++) {
      const value = min + (max - min) * j / 4, yy = Math.round(y(value)) + 0.5;
      const isZero = key === 'moves' && j === 2;
      ctx.strokeStyle = isZero ? '#384659' : '#1e2733';
      ctx.lineWidth = isZero ? 1.2 : 1;
      ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(width - right, yy); ctx.stroke();
      ctx.fillStyle = isZero ? '#c9d5e3' : '#8ea0b5';
      ctx.textAlign = 'right';
      ctx.fillText(key === 'prices' ? priceFormat.format(value) : `${value.toFixed(3)}%`, left - 8, yy + 3.5);
      if (polyVisible) {
        const pv = polyMin + (polyMax - polyMin) * j / 4;
        ctx.fillStyle = predictionVisible.length === 1 ? colors[predictionVisible[0]] : '#8ea0b5';
        ctx.textAlign = 'left';
        ctx.fillText(key === 'prices' ? formatPrice(predictionVisible[0], pv) : `${pv.toFixed(2)}%`, width - right + 6, yy + 3.5);
      }
    }

    // Vertical time grid.
    const timeTicks = plotWidth < 400 ? 2 : 4;
    ctx.lineWidth = 1;
    for (let j = 0; j <= timeTicks; j++) {
      const at = start + (end - start) * j / timeTicks, xx = Math.round(x(at)) + 0.5;
      ctx.strokeStyle = '#19212c';
      ctx.beginPath(); ctx.moveTo(xx, top); ctx.lineTo(xx, height - bottom); ctx.stroke();
      ctx.fillStyle = '#8ea0b5';
      ctx.textAlign = j === 0 ? 'left' : j === timeTicks ? 'right' : 'center';
      ctx.fillText(time(at), xx, height - 7);
    }

    // Threshold lines + axis pills on move chart.
    if (key === 'moves') {
      const baseT = state.settings.threshold;
      for (const sign of [-1, 1]) {
        const yy = Math.round(y(sign * baseT)) + 0.5;
        ctx.strokeStyle = sign > 0 ? 'rgba(92, 224, 174, 0.55)' : 'rgba(251, 139, 120, 0.55)';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(width - right, yy); ctx.stroke();
        ctx.setLineDash([]);
        if (!showDynBand) {
          drawAxisPill(ctx, `${sign > 0 ? '+' : '−'}${baseT}%`, left, yy, sign > 0 ? '#18362b' : '#3a2020', sign > 0 ? '#78ecc0' : '#ff9f8e');
        }
      }
      if (showDynBand) {
        for (const sign of [-1, 1]) {
          const yy = Math.round(y(sign * activeDynLevel)) + 0.5;
          ctx.strokeStyle = 'rgba(242, 196, 122, 0.8)';
          ctx.lineWidth = 1.4;
          ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(width - right, yy); ctx.stroke();
          ctx.setLineDash([]);
          drawAxisPill(ctx, `${sign > 0 ? '+' : '−'}${fmtThreshold(activeDynLevel)}%`, left, yy, '#3b2e17', '#f7d28d');
        }
      }
    }

    // Plot curves inside clip region. Draw hovered series last so it stays on top.
    const drawOrder = hoveredSeries >= 0 && visibleSet.has(hoveredSeries)
      ? [...visible.filter((i) => i !== hoveredSeries), hoveredSeries]
      : visible;

    ctx.save();
    ctx.beginPath(); ctx.rect(left, top, plotWidth, plotHeight); ctx.clip();

    const tipEndpoints = [];
    for (const i of drawOrder) {
      const isFocused = hoveredSeries === i;
      const isDimmed = hoveredSeries >= 0 && hoveredSeries !== i;
      const baseAlpha = isDimmed ? 0.14 : (isFocused || i === WEIGHTED_INDEX || isPrediction(i) || activeView === 'spot-fut' ? 1 : 0.88);
      const lineWidth = isFocused ? 2.6 : i === WEIGHTED_INDEX ? 2.4 : activeView === 'spot-fut' ? 2.1 : isPrediction(i) ? 1.8 : 1.35;
      ctx.strokeStyle = colors[i];
      ctx.lineWidth = lineWidth;
      let tipX = -1, tipY = -1, tipVal = 0;

      if (key === 'prices') {
        for (const ready of [false, true]) {
          ctx.setLineDash(ready ? [] : [4, 4]);
          ctx.globalAlpha = ready ? baseAlpha : baseAlpha * 0.55;
          ctx.beginPath();
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
            lastDrawnAt = end;
          }
          ctx.stroke();
          if (ready && lastDrawnAt > -Infinity) {
            tipX = x(lastDrawnAt); tipY = yFor(i, lastDrawnPrice); tipVal = lastDrawnPrice;
          }
        }
        ctx.setLineDash([]);
      } else {
        ctx.globalAlpha = baseAlpha;
        ctx.beginPath();
        let previous = null, lastDrawnAt = -Infinity, lastDrawnMove = 0;
        for (const p of points) {
          if (!p.ready[i]) { previous = null; continue; }
          const pAt = pointAt(p, i);
          if (pAt > end) {
            if (previous && p.at - previous.at < 400) {
              ctx.lineTo(x(end), yFor(i, previous[key][i]));
              lastDrawnAt = end; lastDrawnMove = previous[key][i];
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
          lastDrawnAt = end;
        }
        ctx.stroke();
        if (lastDrawnAt > -Infinity) {
          tipX = x(lastDrawnAt); tipY = yFor(i, lastDrawnMove); tipVal = lastDrawnMove;
        }
      }

      // Crisp endpoint dot for active/focused curves.
      if (tipX >= left && tipX <= width - right && !isDimmed) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = colors[i];
        ctx.beginPath();
        ctx.arc(tipX, tipY, isFocused || i === WEIGHTED_INDEX || activeView === 'spot-fut' ? 3.2 : 2.1, 0, Math.PI * 2);
        ctx.fill();
        if (key === 'prices' && (isFocused || activeView === 'spot-fut')) {
          tipEndpoints.push({ i, y: tipY, val: tipVal });
        }
      }
      ctx.globalAlpha = 1;
    }

    // Draw exact signal crossing triangles from state.signals on move chart.
    if (key === 'moves') {
      for (const sig of visibleSignals) {
        const isDimmed = hoveredSeries >= 0 && hoveredSeries !== sig.series;
        ctx.globalAlpha = isDimmed ? 0.15 : 1;
        const sigAt = sig.at + (syncLag ? visualDelays[sig.series] : 0);
        const xx = x(sigAt);
        const yy = Math.max(top + 6, Math.min(top + plotHeight - 6, yFor(sig.series, sig.move)));
        const sz = hoveredSeries === sig.series || sig.series === WEIGHTED_INDEX || activeView === 'spot-fut' ? 5.2 : 4.2;
        drawTriangle(ctx, xx, yy, sz, sig.direction > 0, colors[sig.series]);
      }
      ctx.globalAlpha = 1;
    }

    // Inline end-of-line price labels when comparing 2 lines (Spot vs Fut) or hovering a feed.
    if (key === 'prices' && tipEndpoints.length > 0 && tipEndpoints.length <= 2) {
      tipEndpoints.sort((a, b) => a.y - b.y);
      if (tipEndpoints.length === 2 && tipEndpoints[1].y - tipEndpoints[0].y < 18) {
        const mid = (tipEndpoints[0].y + tipEndpoints[1].y) / 2;
        tipEndpoints[0].y = mid - 9;
        tipEndpoints[1].y = mid + 9;
      }
      for (const ep of tipEndpoints) {
        const label = `${shortNames[ep.i]} ${formatPrice(ep.i, ep.val)}`;
        ctx.font = '600 11px -apple-system, BlinkMacSystemFont, sans-serif';
        const padX = 6, h = 18, w = ctx.measureText(label).width + padX * 2;
        const rx = width - right - w - 6;
        const ry = Math.max(top + 2, Math.min(top + plotHeight - h - 2, ep.y - h / 2));
        ctx.fillStyle = 'rgba(13, 17, 23, 0.88)';
        ctx.strokeStyle = colors[ep.i];
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(rx, ry, w, h, 4) : ctx.rect(rx, ry, w, h);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = colors[ep.i];
        ctx.textAlign = 'left';
        ctx.fillText(label, rx + padX, ry + 12.5);
      }
    }

    // Crosshair inspection line.
    if (pointer && pointer.canvas === canvas && allHistory.length && pointer.x >= left && pointer.x <= width - right) {
      const targetAt = start + (pointer.x - left) / plotWidth * (end - start);
      inspected = nearest(allHistory, targetAt);
      const inspectAt = inspected ? inspected.at : targetAt;
      ctx.strokeStyle = '#9eb0c4';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x(inspectAt), top); ctx.lineTo(x(inspectAt), height - bottom); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  $('tooltip').hidden = !inspected;
  if (inspected) {
    $('tooltip').replaceChildren();
    const heading = document.createElement('header');
    heading.textContent = `${time(inspected.at, true)} UTC · * held price`;
    $('tooltip').append(heading);
    for (const i of visible) {
      const delay = delays[i];
      const p_i = delay && allHistory.length ? nearest(allHistory, inspected.at - delay) : inspected;
      const row = document.createElement('div'); row.className = 'tip-row';
      const name = document.createElement('span'), price = document.createElement('span'), move = document.createElement('span');
      name.textContent = shortNames[i]; name.style.color = colors[i];
      price.textContent = p_i && p_i.prices[i] > 0 ? formatPrice(i, p_i.prices[i]) + (p_i.ready[i] ? '' : '*') : '—';
      move.textContent = p_i && p_i.ready[i] ? pct(p_i.moves[i]) : '—';
      if (p_i && p_i.ready[i]) move.className = p_i.moves[i] > 0 ? 'positive' : p_i.moves[i] < 0 ? 'negative' : '';
      row.append(name, price, move);
      $('tooltip').append(row);
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
