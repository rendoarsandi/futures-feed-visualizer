// Port of the executed-trade window, weighted quorum and excursion counters
// from Poly-Bot 15fe010. Receipt time owns the rolling window; event age is diagnostic.
export const SPOT_INDEX = 6;
export const WEIGHTED_INDEX = 7;
export const IDS = ['binance', 'bybit', 'okx', 'hyperliquid', 'deribit', 'kraken-futures', 'binance-spot', 'weighted'];
export const NAMES = ['Binance Futures', 'Bybit', 'OKX', 'Hyperliquid', 'Deribit', 'Kraken Futures', 'Binance Spot', 'Weighted'];
export const DEFAULT_SETTINGS = { lookbackMs: 200, threshold: .01, weights: [1, 1, 1, 1, 1, 1] };
const DIGITS = /^\d+$/;

export function validateSettings(settings) {
  if (!Number.isInteger(settings?.lookbackMs) || settings.lookbackMs < 100 || settings.lookbackMs > 15000) throw new Error('Lookback must be 100–15000 ms');
  if (!Number.isFinite(settings.threshold) || settings.threshold < .000001 || settings.threshold > 10) throw new Error('Threshold must be 0.000001–10 percent');
  if (!Array.isArray(settings.weights) || settings.weights.length !== SPOT_INDEX || settings.weights.some(w => !Number.isFinite(w) || w < 0 || w > 1000) || settings.weights.filter(w => w > 0).length < 2) throw new Error('At least two weights must be positive; each must be 0–1000');
  return { lookbackMs: settings.lookbackMs, threshold: settings.threshold, weights: settings.weights.slice() };
}

class SampleRing {
  constructor() { this.times = new Float64Array(8192); this.prices = new Float64Array(8192); this.reset(); }
  reset() { this.head = this.count = this.latestAt = this.latestPrice = 0; }
  index(i) { return (this.head + i) % this.times.length; }
  anchor(at, price) {
    const i = this.index(this.count < this.times.length ? this.count++ : 0);
    this.times[i] = at; this.prices[i] = price;
    if (this.count === this.times.length && i === this.head) this.head = (this.head + 1) % this.times.length;
  }
  push(at, price) {
    const bucket = Math.floor(at / 2), latestBucket = Math.floor(this.latestAt / 2);
    if (this.count && bucket === latestBucket) { this.latestAt = at; this.latestPrice = price; return; }
    if (this.count && bucket > latestBucket + 1 && this.latestAt > this.times[this.index(this.count - 1)]) this.anchor(this.latestAt, this.latestPrice);
    this.latestAt = at; this.latestPrice = price; this.anchor(at, price);
  }
  baseline(target) {
    if (!this.count) return null;
    if (this.latestAt <= target) return { at: this.latestAt, price: this.latestPrice };
    let lo = 0, hi = this.count;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.times[this.index(mid)] > target) hi = mid; else lo = mid + 1; }
    if (!lo) return null;
    const i = this.index(lo - 1); return { at: this.times[i], price: this.prices[i] };
  }
}

function integerID(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const id = String(value);
  return DIGITS.test(id) && id.length <= 19 && (id.length < 19 || id <= '9223372036854775807') ? id : null;
}

// JSON.parse source text preserves exact numeric aggregate IDs on current browsers.
// Older engines reject unsafe numeric IDs rather than silently rounding them.
export function decodeFrame(raw) {
  if (typeof raw !== 'string' || raw.length > 1024 * 1024 || raw === 'pong') return null;
  try {
    return JSON.parse(raw, (key, value, context) => (key === 'a' || key === 'tid') && typeof value === 'number' && context?.source ? context.source : value);
  } catch { return null; }
}

export function parseTrades(index, frame) {
  if (!frame || frame.isSnapshot || frame.data?.isSnapshot) return [];
  let trades = [];
  if (index === 0 || index === SPOT_INDEX) {
    const t = frame.stream ? frame.data : frame;
    if (t?.e === 'aggTrade' && t.s === 'BTCUSDT') trades = [{ price: t.p, eventMS: t.T, id: integerID(t.a) }];
  } else if (index === 1 && frame.topic === 'publicTrade.BTCUSDT' && Array.isArray(frame.data)) {
    // Bybit labels the live public-trade channel 'snapshot'; these are executions.
    trades = frame.data.filter(t => t?.s === 'BTCUSDT').map(t => ({ price: t.p, eventMS: t.T, id: typeof t.i === 'string' ? t.i : null }));
  } else if (index === 2 && frame.arg?.channel === 'trades' && frame.arg.instId === 'BTC-USDT-SWAP' && Array.isArray(frame.data)) {
    trades = frame.data.filter(t => t?.instId === 'BTC-USDT-SWAP').map(t => ({ price: t.px, eventMS: t.ts, id: typeof t.tradeId === 'string' ? t.tradeId : null }));
  } else if (index === 3 && frame.channel === 'trades' && Array.isArray(frame.data)) {
    trades = frame.data.filter(t => t?.coin === 'BTC').map(t => ({ price: t.px, eventMS: t.time, id: integerID(t.tid) }));
  } else if (index === 4 && frame.method === 'subscription' && frame.params?.channel === 'trades.BTC-PERPETUAL.100ms' && Array.isArray(frame.params.data)) {
    trades = frame.params.data.filter(t => t?.instrument_name === 'BTC-PERPETUAL').map(t => ({ price: t.price, eventMS: t.timestamp, id: typeof t.trade_id === 'string' ? t.trade_id : null }));
  } else if (index === 5 && frame.feed === 'trade' && frame.product_id === 'PF_XBTUSD') {
    // trade_snapshot is historical bootstrap data, never a live execution.
    trades = [{ price: frame.price, eventMS: frame.time, id: typeof frame.uid === 'string' ? frame.uid : null }];
  }
  return trades;
}

class TradeFeed {
  constructor(index) { this.index = index; this.ring = new SampleRing(); this.seen = new Set(); this.keys = new Array(2048); this.session = 0; this.connected = false; this.reset(); }
  reset() { this.ring.reset(); this.seen.clear(); this.keys.fill(undefined); this.next = this.latestEventMS = 0; this.lastID = null; this.session++; }
  accept(trade, at) {
    const price = Number(trade.price), eventMS = Number(trade.eventMS), id = trade.id;
    if (!this.connected || !Number.isFinite(price) || price <= 0 || !Number.isSafeInteger(eventMS) || eventMS <= 0 || typeof id !== 'string' || !id || eventMS < this.latestEventMS) return null;
    const key = `${eventMS}:${id}`;
    if (this.seen.has(key)) return null;
    let gap = 0;
    if (this.index === 0 || this.index === SPOT_INDEX) {
      const numeric = integerID(id);
      if (numeric === null) return null;
      const n = BigInt(numeric);
      if (this.lastID !== null && n <= this.lastID) return null;
      if (this.lastID !== null && n - this.lastID > 1n) gap = Number(n - this.lastID - 1n);
      this.lastID = n;
    }
    if (gap || (this.ring.count && at < this.ring.latestAt)) { this.ring.reset(); this.session++; }
    this.seen.delete(this.keys[this.next]); this.keys[this.next] = key; this.next = (this.next + 1) % this.keys.length; this.seen.add(key);
    this.latestEventMS = eventMS; this.ring.push(at, price);
    return { gap };
  }
  snapshot(now, lookback) {
    const ring = this.ring;
    const snap = { connected: this.connected, ready: false, price: ring.latestPrice, updatedAt: ring.latestAt, move: 0 };
    if (!this.connected || !ring.count || now < ring.latestAt) return snap;
    const baseline = ring.baseline(now - lookback);
    if (!baseline || now - ring.times[ring.head] < lookback) return snap;
    snap.ready = true; snap.baseline = baseline.price; snap.move = (ring.latestPrice - baseline.price) / baseline.price * 100;
    return snap;
  }
}

class Counter {
  constructor() { this.up = this.down = this.missed = 0; this.armed = false; }
  evaluate(snap, trade, threshold) {
    if (!snap.ready || !snap.connected) { this.armed = false; return 0; }
    if (Math.abs(snap.move) < threshold) { this.armed = true; return 0; }
    if (!trade || !this.armed) return 0;
    this.armed = false;
    if (snap.move > 0) { this.up++; return 1; }
    this.down++; return -1;
  }
}

export class Monitor {
  constructor(settings = DEFAULT_SETTINGS, at = Date.now(), demo = false) {
    this.feeds = IDS.slice(0, WEIGHTED_INDEX).map((_, i) => new TradeFeed(i)); this.epoch = at; this.demo = demo;
    this.enabled = IDS.map(() => true); this.enabledAt = IDS.map(() => at);
    this.reset(settings, at);
  }
  reset(settings, at) {
    this.settings = validateSettings(settings); this.epoch = Math.max(at, (this.epoch || 0) + 1); this.startedAt = at;
    this.counters = IDS.map(() => new Counter()); this.recent = []; this.lastPrices = IDS.map(() => 0); this.lastUpdates = IDS.map(() => 0);
    this.lastLoggedAt = IDS.map(() => -Infinity);
  }
  connection(index, connected) {
    const feed = this.feeds[index];
    if (connected && !this.enabled[index]) return;
    if (connected) feed.reset();
    feed.connected = connected;
    this.counters[index].armed = false;
    if (index !== SPOT_INDEX) this.counters[WEIGHTED_INDEX].armed = false;
  }
  setEnabled(index, enabled, at) {
    if (!Number.isInteger(index) || index < 0 || index >= IDS.length || typeof enabled !== 'boolean') throw new Error('Invalid market toggle');
    if (this.enabled[index] === enabled) return;
    this.enabled[index] = enabled; this.enabledAt[index] = at;
    this.counters[index].armed = false;
    if (index < this.feeds.length) this.connection(index, false);
  }
  record(index, snap, at, trade) {
    if (!this.enabled[index]) return;
    const direction = this.counters[index].evaluate(snap, trade, this.settings.threshold);
    // Space each market independently; counters still evaluate every execution.
    if (direction && at - this.lastLoggedAt[index] >= 1000) {
      this.lastLoggedAt[index] = at;
      this.recent.push({ at, series: index, direction, move: snap.move });
      if (this.recent.length > 60) this.recent.shift();
    }
  }
  frame(index, raw, at) {
    if (!this.enabled[index]) return 0;
    const feed = this.feeds[index]; let accepted = 0;
    const frame = decodeFrame(raw);
    if (frame?.success === false || frame?.event === 'error' || frame?.event === 'subscribed_failed' || frame?.event === 'alert' || frame?.error || (frame?.code && String(frame.code) !== '0')) return -1;
    for (const trade of parseTrades(index, frame)) {
      const session = feed.session, result = feed.accept(trade, at);
      if (!result) continue;
      accepted++;
      if (session !== feed.session) {
        this.counters[index].armed = false;
        if (index !== SPOT_INDEX) this.counters[WEIGHTED_INDEX].armed = false;
      }
      if (result.gap) {
        this.counters[index].missed += result.gap;
        if (index !== SPOT_INDEX) this.counters[WEIGHTED_INDEX].missed++;
      }
      this.record(index, feed.snapshot(at, this.settings.lookbackMs), at, true);
      // Spot has its own counters and cannot trigger or disarm futures signals.
      if (index !== SPOT_INDEX) this.record(WEIGHTED_INDEX, this.weighted(at), at, true);
    }
    return accepted;
  }
  weighted(now, snapshots = null) {
    const s = { ready: false, connected: false, price: 0, move: 0, updatedAt: 0 };
    if (!this.enabled[WEIGHTED_INDEX]) return s;
    let total = 0, available = 0, count = 0, connected = 0;
    this.settings.weights.forEach((w, i) => {
      if (!w) return; total += w;
      const feed = this.feeds[i];
      const part = snapshots ? snapshots[i] : feed.snapshot(now, this.settings.lookbackMs); if (part.connected) connected++;
      if (!part.ready || !part.connected) return;
      count++; available += w; s.price += w * part.price; s.move += w * part.move;
      s.updatedAt = s.updatedAt ? Math.min(s.updatedAt, part.updatedAt) : part.updatedAt;
    });
    s.connected = connected >= 2;
    if (available) { s.price /= available; s.move /= available; }
    s.ready = count >= 2 && total > 0 && available >= total * .5 && Number.isFinite(s.move) && Number.isFinite(s.price);
    return s;
  }
  demoSnapshots(at) {
    const seconds = (at - this.startedAt) / 1000;
    const all = this.feeds.map((_, i) => {
      const enabled = this.enabled[i] && (i === SPOT_INDEX || this.settings.weights[i] > 0);
      const ready = at - Math.max(this.startedAt, this.enabledAt[i]) >= this.settings.lookbackMs;
      const phase = seconds - i * .045;
      const price = t => 80000 + (i - 1) * 3 + 52 * Math.sin(t * 2 * Math.PI / 5) + 9 * Math.sin(t * 2 * Math.PI / 1.7);
      const p = price(phase), base = price(phase - this.settings.lookbackMs / 1000);
      return { connected: enabled, ready: enabled && ready, price: enabled ? p : 0, move: enabled ? (p - base) / base * 100 : 0, updatedAt: enabled ? at : 0 };
    });
    all.push(this.weighted(at, all));
    return all;
  }
  state(at) {
    const all = this.demo ? this.demoSnapshots(at) : [...this.feeds.map(f => f.snapshot(at, this.settings.lookbackMs)), this.weighted(at)];
    const point = { at, prices: [], moves: [], ready: [], up: [], down: [] };
    const series = all.map((snap, i) => {
      this.record(i, snap, at, this.demo);
      if (snap.price > 0) this.lastPrices[i] = snap.price;
      if (snap.updatedAt) this.lastUpdates[i] = snap.updatedAt;
      const c = this.counters[i], ready = snap.ready && snap.connected;
      const status = !this.enabled[i] ? 'disconnected' : i < SPOT_INDEX && this.settings.weights[i] === 0 ? 'off' : ready ? 'ready' : snap.connected ? 'waiting' : 'connecting';
      point.prices.push(this.lastPrices[i]); point.moves.push(snap.move); point.ready.push(ready); point.up.push(c.up); point.down.push(c.down);
      return { id: IDS[i], name: NAMES[i], enabled: this.enabled[i], price: this.lastPrices[i], move: snap.move, status, ready, connected: snap.connected, updatedAt: this.lastUpdates[i], up: c.up, down: c.down, missed: c.missed, armed: c.armed };
    });
    return { mode: this.demo ? 'demo' : 'live', epoch: this.epoch, at, settings: this.settings, point, series, recent: this.recent.slice() };
  }
}
