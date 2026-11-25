// Executed-trade window, weighted quorum, realized volatility, and signal counters.
// Receipt time owns the rolling window; event age is diagnostic.
export const SPOT_INDEX = 6;
export const POLYMARKET_INDEX = 7;
export const POLYMARKET_ETH_INDEX = 8;
export const WEIGHTED_INDEX = 9;
export const IDS = ['binance', 'bybit', 'okx', 'hyperliquid', 'deribit', 'kraken-futures', 'binance-spot', 'polymarket-5m', 'polymarket-eth-5m', 'weighted'];
export const NAMES = ['Binance Futures', 'Bybit', 'OKX', 'Hyperliquid', 'Deribit', 'Kraken Futures', 'Binance Spot', 'Polymarket BTC 5m', 'Polymarket ETH 5m', 'Weighted'];
export const DEFAULT_SETTINGS = {
  lookbackMs: 200,
  threshold: .01,
  cooldownMs: 1000,
  dynamicVol: false,
  dynamicVolMult: 2,
  weights: [1, 1, 1, 1, 1, 1],
};
const DIGITS = /^\d+$/;
const VOL_SLOW_SEC = 240;
const VOL_FAST_SEC = 60;
const VOL_MIN_WARM_SEC = 60;
const MAX_SIGNALS = 240;
const isPrediction = index => index === POLYMARKET_INDEX || index === POLYMARKET_ETH_INDEX;

export function validateSettings(settings) {
  if (!Number.isInteger(settings?.lookbackMs) || settings.lookbackMs < 100 || settings.lookbackMs > 15000) throw new Error('Lookback must be 100–15000 ms');
  if (!Number.isFinite(settings.threshold) || settings.threshold < .000001 || settings.threshold > 10) throw new Error('Threshold must be 0.000001–10 percent');
  const cooldownMs = settings.cooldownMs === undefined ? DEFAULT_SETTINGS.cooldownMs : settings.cooldownMs;
  if (!Number.isInteger(cooldownMs) || cooldownMs < 0 || cooldownMs > 60000) throw new Error('Cooldown must be 0–60000 ms');
  const dynamicVol = Boolean(settings.dynamicVol);
  const dynamicVolMult = settings.dynamicVolMult === undefined ? DEFAULT_SETTINGS.dynamicVolMult : settings.dynamicVolMult;
  if (!Number.isFinite(dynamicVolMult) || dynamicVolMult < .5 || dynamicVolMult > 10) throw new Error('Dynamic multiplier must be 0.5–10x');
  if (!Array.isArray(settings.weights) || settings.weights.length !== SPOT_INDEX || settings.weights.some(w => !Number.isFinite(w) || w < 0 || w > 1000) || settings.weights.filter(w => w > 0).length < 2) throw new Error('At least two weights must be positive; each must be 0–1000');
  return {
    lookbackMs: settings.lookbackMs,
    threshold: settings.threshold,
    cooldownMs,
    dynamicVol,
    dynamicVolMult: Math.round(dynamicVolMult * 100) / 100,
    weights: settings.weights.slice(),
  };
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
    if (this.count && bucket === latestBucket) {
      // Multi-trade batches share receipt time: keep the settled end-of-batch
      // price on the anchor without advancing its timestamp or spending slots.
      const last = this.index(this.count - 1);
      if (at === this.times[last]) this.prices[last] = price;
      this.latestAt = at; this.latestPrice = price; return;
    }
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

// 1-second realized return squares in a fixed 240s ring (60s fast / 240s slow).
class VolRing {
  constructor() { this.secs = new Float64Array(VOL_SLOW_SEC); this.sq = new Float64Array(VOL_SLOW_SEC); this.reset(); }
  reset() { this.secs.fill(0); this.sq.fill(0); this.firstSec = this.curSec = this.curGap = this.prevClose = this.curClose = 0; }
  invalidateAnchor() { this.curSec = this.curGap = this.prevClose = this.curClose = 0; }
  record(at, price) {
    if (!(price > 0) || !Number.isFinite(price) || !(at > 0)) return;
    const sec = Math.floor(at / 1000);
    if (sec <= 0) return;
    if (!this.firstSec || sec < this.firstSec) {
      this.reset();
      this.firstSec = this.curSec = sec;
      this.curClose = price;
      return;
    }
    if (!this.curSec) { this.curSec = sec; this.curClose = price; return; }
    if (sec < this.curSec) return;
    if (sec > this.curSec) {
      this.curGap = sec - this.curSec;
      this.prevClose = this.curClose;
      this.curSec = sec;
    }
    this.curClose = price;
    if (this.prevClose > 0) {
      const retPct = (price - this.prevClose) / this.prevClose * 100;
      const sqPct = retPct * retPct;
      if (this.curGap <= 1) {
        const slot = sec % VOL_SLOW_SEC;
        this.secs[slot] = sec; this.sq[slot] = sqPct;
      } else {
        const perSecSq = sqPct / this.curGap;
        const startSec = sec - Math.min(this.curGap, VOL_SLOW_SEC) + 1;
        for (let s = startSec; s <= sec; s++) {
          const slot = s % VOL_SLOW_SEC;
          this.secs[slot] = s; this.sq[slot] = perSecSq;
        }
      }
    }
  }
  volatilityPct(now, lookbackMs) {
    if (!this.firstSec || !(now > 0)) return { volPct: 0, volReady: false };
    let nowSec = Math.floor(now / 1000);
    if (this.curSec > nowSec) nowSec = this.curSec;
    const spanSec = nowSec - this.firstSec;
    if (spanSec < VOL_MIN_WARM_SEC) return { volPct: 0, volReady: false };
    const slowCutoff = nowSec - VOL_SLOW_SEC;
    const fastCutoff = nowSec - VOL_FAST_SEC;
    let slowSum = 0, fastSum = 0;
    for (let i = 0; i < VOL_SLOW_SEC; i++) {
      const s = this.secs[i];
      if (!s || s > nowSec || s <= slowCutoff) continue;
      const v = this.sq[i];
      slowSum += v;
      if (s > fastCutoff) fastSum += v;
    }
    const slowDenom = Math.min(VOL_SLOW_SEC, spanSec);
    const fastDenom = Math.min(VOL_FAST_SEC, spanSec);
    const sigma1s = Math.max(Math.sqrt(fastSum / fastDenom), Math.sqrt(slowSum / slowDenom));
    const lookbackSec = lookbackMs > 0 ? lookbackMs / 1000 : 1.5;
    const volPct = sigma1s * Math.sqrt(lookbackSec);
    if (!Number.isFinite(volPct)) return { volPct: 0, volReady: false };
    return { volPct, volReady: true };
  }
}

export function effectiveThreshold(settings, volPct, volReady) {
  const floor = settings.threshold;
  if (!settings.dynamicVol || !volReady || !(volPct > 0) || !Number.isFinite(volPct)) {
    return { effective: floor, dynamic: 0, active: false };
  }
  const dynamic = settings.dynamicVolMult * volPct;
  if (dynamic > floor) return { effective: dynamic, dynamic, active: true };
  return { effective: floor, dynamic, active: false };
}

function integerID(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const id = String(value);
  return DIGITS.test(id) && id.length <= 19 && (id.length < 19 || id <= '9223372036854775807') ? id : null;
}

// JSON.parse source text preserves exact numeric Binance/Hyperliquid trade IDs.
// Older engines reject unsafe numeric IDs rather than silently rounding them.
export function decodeFrame(raw) {
  if (typeof raw !== 'string' || raw.length > 1024 * 1024 || raw === 'pong' || raw === 'PONG') return null;
  try {
    return JSON.parse(raw, (key, value, context) => (key === 'a' || key === 't' || key === 'tid') && typeof value === 'number' && context?.source ? context.source : value);
  } catch { return null; }
}

export function parseTrades(index, frame, assetId = null) {
  if (!frame || frame.isSnapshot || frame.data?.isSnapshot) return [];
  let trades = [];
  if (index === 0) {
    const t = frame.stream ? frame.data : frame;
    if (t?.e === 'aggTrade' && t.s === 'BTCUSDT') trades = [{ price: t.p, eventMS: t.T, id: integerID(t.a), kind: 'aggTrade' }];
  } else if (index === SPOT_INDEX) {
    const t = frame.stream ? frame.data : frame;
    if (t?.e === 'trade' && t.s === 'BTCUSDT') trades = [{ price: t.p, eventMS: t.T, id: integerID(t.t), kind: 'trade' }];
    else if (t?.e === 'aggTrade' && t.s === 'BTCUSDT') trades = [{ price: t.p, eventMS: t.T, id: integerID(t.a), kind: 'aggTrade' }];
  } else if (index === 1 && frame.topic === 'publicTrade.BTCUSDT' && Array.isArray(frame.data)) {
    // Bybit labels the live public-trade channel 'snapshot'; these are executions.
    trades = frame.data.filter(t => t?.s === 'BTCUSDT').map(t => ({ price: t.p, eventMS: t.T, id: typeof t.i === 'string' ? t.i : null }));
  } else if (index === 2 && frame.arg?.channel === 'trades' && frame.arg.instId === 'BTC-USDT-SWAP' && Array.isArray(frame.data)) {
    trades = frame.data.filter(t => t?.instId === 'BTC-USDT-SWAP').map(t => ({ price: t.px, eventMS: t.ts, id: typeof t.tradeId === 'string' ? t.tradeId : null }));
  } else if (index === 3 && frame.channel === 'trades' && Array.isArray(frame.data)) {
    trades = frame.data.filter(t => t?.coin === 'BTC').map(t => ({ price: t.px, eventMS: t.time, id: integerID(t.tid) }));
  } else if (index === 4 && frame.method === 'subscription' && frame.params?.channel === 'trades.BTC_USDC-PERPETUAL.100ms' && Array.isArray(frame.params.data)) {
    trades = frame.params.data.filter(t => t?.instrument_name === 'BTC_USDC-PERPETUAL').map(t => ({ price: t.price, eventMS: t.timestamp, id: typeof t.trade_id === 'string' ? t.trade_id : null }));
  } else if (index === 5 && frame.feed === 'trade' && frame.product_id === 'PF_XBTUSD') {
    // trade_snapshot is historical bootstrap data, never a live execution.
    trades = [{ price: frame.price, eventMS: frame.time, id: typeof frame.uid === 'string' ? frame.uid : null }];
  } else if (isPrediction(index)) {
    const events = Array.isArray(frame) ? frame : [frame];
    trades = events
      .filter(t => t?.event_type === 'last_trade_price' && typeof t.asset_id === 'string' && t.asset_id && (!assetId || t.asset_id === assetId))
      .map(t => ({ price: t.price, eventMS: t.timestamp, id: typeof t.transaction_hash === 'string' ? t.transaction_hash : null }));
  }
  return trades;
}

class TradeFeed {
  constructor(index) {
    this.index = index;
    this.ring = new SampleRing();
    this.vol = new VolRing();
    this.seen = new Set();
    this.keys = new Array(2048);
    this.session = 0;
    this.connected = false;
    this.assetId = null;
    this.slug = null;
    this.expiresAt = 0;
    this.lagMS = 0;
    this.reset();
  }
  reset() {
    this.ring.reset();
    this.vol.reset();
    this.seen.clear();
    this.keys.fill(undefined);
    this.next = this.latestEventMS = 0;
    this.lastID = null;
    this.lastKind = '';
    this.session++;
    this.lagMS = 0;
  }
  accept(trade, at) {
    const price = Number(trade.price), eventMS = Number(trade.eventMS), id = trade.id, kind = trade.kind || '';
    if (!this.connected || (this.expiresAt && at >= this.expiresAt) || !Number.isFinite(price) || price <= 0 || (isPrediction(this.index) && price > 1) || !Number.isSafeInteger(eventMS) || eventMS <= 0 || typeof id !== 'string' || !id || eventMS < this.latestEventMS) return null;
    const key = `${kind}:${eventMS}:${id}`;
    if (this.seen.has(key)) return null;
    let gap = 0, kindChanged = false;
    if (this.index === 0 || this.index === SPOT_INDEX) {
      const numeric = integerID(id);
      if (numeric === null) return null;
      const n = BigInt(numeric);
      if (this.lastKind && kind && kind !== this.lastKind) {
        kindChanged = true;
      } else {
        if (this.lastID !== null && n <= this.lastID) return null;
        if (this.lastID !== null && n - this.lastID > 1n) gap = Number(n - this.lastID - 1n);
      }
      this.lastID = n;
      if (kind) this.lastKind = kind;
    }
    const clockBack = Boolean(this.ring.count && at < this.ring.latestAt);
    if (gap || kindChanged || clockBack) {
      this.ring.reset();
      if (clockBack) this.vol.reset();
      else this.vol.invalidateAnchor();
      this.session++;
      this.lagMS = 0;
    }
    this.seen.delete(this.keys[this.next]); this.keys[this.next] = key; this.next = (this.next + 1) % this.keys.length; this.seen.add(key);
    this.latestEventMS = eventMS;
    if (!isPrediction(this.index)) this.vol.record(at, price);
    this.ring.push(at, price);
    const rawLag = Math.max(0, Math.min(at - eventMS, 5000));
    this.lagMS = this.lagMS === 0 ? rawLag : Math.round(this.lagMS * 0.8 + rawLag * 0.2);
    return { gap };
  }
  snapshot(now, lookback) {
    const ring = this.ring;
    const vol = isPrediction(this.index) ? { volPct: 0, volReady: false } : this.vol.volatilityPct(now, lookback);
    const snap = {
      connected: this.connected,
      ready: false,
      price: ring.latestPrice,
      updatedAt: ring.latestAt,
      move: 0,
      lag: this.connected ? this.lagMS : 0,
      volPct: vol.volPct,
      volReady: vol.volReady,
      streamKind: this.lastKind,
    };
    if (!this.connected || (this.expiresAt && now >= this.expiresAt) || !ring.count || now < ring.latestAt) return snap;
    const baseline = ring.baseline(now - lookback);
    if (!baseline || now - ring.times[ring.head] < lookback) return snap;
    snap.ready = true; snap.baseline = baseline.price; snap.move = (ring.latestPrice - baseline.price) / baseline.price * 100;
    return snap;
  }
}

class Counter {
  constructor() { this.up = this.down = this.missed = 0; this.armed = false; this.lastSignalAt = -Infinity; }
  evaluate(snap, trade, threshold, at = 0, cooldownMs = 0) {
    if (!snap.ready || !snap.connected) { this.armed = false; return 0; }
    const absMove = Math.abs(snap.move);
    const rearmBand = cooldownMs > 0 ? threshold * .5 : threshold;
    if (absMove < rearmBand) { this.armed = true; return 0; }
    if (absMove < threshold) return 0;
    if (!trade || !this.armed) return 0;
    if (cooldownMs > 0 && at - this.lastSignalAt < cooldownMs) return 0;
    this.armed = false;
    this.lastSignalAt = at;
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
    this.counters = IDS.map(() => new Counter()); this.recent = []; this.signals = []; this.lastPrices = IDS.map(() => 0); this.lastUpdates = IDS.map(() => 0);
    this.lastLoggedAt = IDS.map(() => -Infinity);
  }
  market(index, info) {
    const feed = this.feeds[index];
    if (!feed) return;
    const nextSlug = info?.slug || null, nextAsset = info?.assetId || null, nextExpires = Number(info?.expiresAt) || 0;
    if (feed.slug !== nextSlug || feed.assetId !== nextAsset) {
      feed.reset();
      this.lastPrices[index] = 0;
      this.lastUpdates[index] = 0;
    }
    feed.slug = nextSlug; feed.assetId = nextAsset; feed.expiresAt = nextExpires;
  }
  connection(index, connected) {
    const feed = this.feeds[index];
    if (connected && !this.enabled[index]) return;
    if (connected) feed.reset();
    feed.connected = connected;
    this.counters[index].armed = false;
    if (index < SPOT_INDEX) this.counters[WEIGHTED_INDEX].armed = false;
  }
  setEnabled(index, enabled, at) {
    if (!Number.isInteger(index) || index < 0 || index >= IDS.length || typeof enabled !== 'boolean') throw new Error('Invalid market toggle');
    if (this.enabled[index] === enabled) return;
    this.enabled[index] = enabled; this.enabledAt[index] = at;
    this.counters[index].armed = false;
    if (index < this.feeds.length) this.connection(index, false);
  }
  record(index, snap, at, trade) {
    // 5m prediction markets are visual-only feeds without simulated buy counters.
    if (!this.enabled[index] || isPrediction(index)) return;
    if (this.settings.dynamicVol && !snap.volReady) {
      this.counters[index].armed = false;
      return;
    }
    const { effective } = effectiveThreshold(this.settings, snap.volPct, snap.volReady);
    const direction = this.counters[index].evaluate(snap, trade, effective, at, this.settings.cooldownMs);
    if (direction) {
      const event = { at, series: index, direction, move: snap.move, threshold: effective };
      this.signals.push(event);
      if (this.signals.length > MAX_SIGNALS) this.signals.shift();
      // Space each market independently; counters still evaluate every execution.
      if (at - this.lastLoggedAt[index] >= 1000) {
        this.lastLoggedAt[index] = at;
        this.recent.push(event);
        if (this.recent.length > 60) this.recent.shift();
      }
    }
  }
  frame(index, raw, at) {
    if (!this.enabled[index]) return 0;
    const feed = this.feeds[index]; let accepted = 0;
    const frame = decodeFrame(raw);
    if (frame?.success === false || frame?.event === 'error' || frame?.event === 'subscribed_failed' || frame?.event === 'alert' || frame?.error || (frame?.code && String(frame.code) !== '0')) return -1;
    for (const trade of parseTrades(index, frame, feed.assetId)) {
      const session = feed.session, result = feed.accept(trade, at);
      if (!result) continue;
      accepted++;
      if (session !== feed.session) {
        this.counters[index].armed = false;
        if (index < SPOT_INDEX) this.counters[WEIGHTED_INDEX].armed = false;
      }
      if (result.gap) {
        this.counters[index].missed += result.gap;
        if (index < SPOT_INDEX) this.counters[WEIGHTED_INDEX].missed++;
      }
      this.record(index, feed.snapshot(at, this.settings.lookbackMs), at, true);
      // Spot and 5m prediction markets cannot trigger or disarm weighted futures signals.
      if (index < SPOT_INDEX) this.record(WEIGHTED_INDEX, this.weighted(at), at, true);
    }
    return accepted;
  }
  weighted(now, snapshots = null) {
    const s = { ready: false, connected: false, price: 0, move: 0, updatedAt: 0, lag: 0, volPct: 0, volReady: false };
    if (!this.enabled[WEIGHTED_INDEX]) return s;
    let total = 0, available = 0, count = 0, connected = 0, lagWeight = 0, volWeighted = 0, volAvailable = 0;
    this.settings.weights.forEach((w, i) => {
      if (!w) return; total += w;
      const feed = this.feeds[i];
      const part = snapshots ? snapshots[i] : feed.snapshot(now, this.settings.lookbackMs); if (part.connected) connected++;
      if (!part.ready || !part.connected) return;
      count++; available += w; s.price += w * part.price; s.move += w * part.move; lagWeight += w * (part.lag || 0);
      if (part.volReady && Number.isFinite(part.volPct)) { volWeighted += w * part.volPct; volAvailable += w; }
      s.updatedAt = s.updatedAt ? Math.min(s.updatedAt, part.updatedAt) : part.updatedAt;
    });
    s.connected = connected >= 2;
    if (available) { s.price /= available; s.move /= available; }
    s.ready = count >= 2 && total > 0 && available >= total * .5 && Number.isFinite(s.move) && Number.isFinite(s.price);
    s.lag = s.ready ? Math.round(lagWeight / available) : 0;
    if (volAvailable > 0 && volAvailable >= available * .5) {
      const vp = volWeighted / volAvailable;
      if (Number.isFinite(vp)) { s.volPct = vp; s.volReady = true; }
    }
    return s;
  }
  demoSnapshots(at) {
    const seconds = (at - this.startedAt) / 1000;
    const lookbackSec = this.settings.lookbackMs / 1000;
    const all = this.feeds.map((_, i) => {
      const enabled = this.enabled[i] && (i >= SPOT_INDEX || this.settings.weights[i] > 0);
      const ready = at - Math.max(this.startedAt, this.enabledAt[i]) >= this.settings.lookbackMs;
      const phase = seconds - i * .045;
      const price = isPrediction(i)
        ? t => .5 + (i === POLYMARKET_ETH_INDEX ? -.02 : 0) + .18 * Math.sin(t * 2 * Math.PI / 5) + .03 * Math.sin(t * 2 * Math.PI / 1.7)
        : t => 80000 + (i - 1) * 3 + 52 * Math.sin(t * 2 * Math.PI / 5) + 9 * Math.sin(t * 2 * Math.PI / 1.7);
      const p = price(phase), base = price(phase - lookbackSec);
      const lag = enabled ? (i === SPOT_INDEX ? 0 : i === POLYMARKET_INDEX ? 100 : i === POLYMARKET_ETH_INDEX ? 110 : i * 45) : 0;
      const volPct = !isPrediction(i) && enabled && ready ? 0.018 * Math.sqrt(lookbackSec) : 0;
      return {
        connected: enabled,
        ready: enabled && ready,
        price: enabled ? p : 0,
        move: enabled ? (p - base) / base * 100 : 0,
        updatedAt: enabled ? at : 0,
        lag,
        volPct,
        volReady: !isPrediction(i) && enabled && ready,
        streamKind: i === SPOT_INDEX ? 'trade' : i === 0 ? 'aggTrade' : '',
      };
    });
    all.push(this.weighted(at, all));
    return all;
  }
  state(at) {
    const all = this.demo ? this.demoSnapshots(at) : [...this.feeds.map(f => f.snapshot(at, this.settings.lookbackMs)), this.weighted(at)];
    const point = { at, prices: [], moves: [], ready: [], up: [], down: [], lags: [], eff: [] };
    const series = all.map((snap, i) => {
      this.record(i, snap, at, this.demo);
      if (snap.price > 0) this.lastPrices[i] = snap.price;
      if (snap.updatedAt) this.lastUpdates[i] = snap.updatedAt;
      const c = this.counters[i], ready = snap.ready && snap.connected;
      const eff = isPrediction(i) ? { effective: this.settings.threshold, dynamic: 0, active: false } : effectiveThreshold(this.settings, snap.volPct, snap.volReady);
      const volWarming = !isPrediction(i) && this.settings.dynamicVol && ready && !snap.volReady;
      const status = !this.enabled[i] ? 'disconnected' : i < SPOT_INDEX && this.settings.weights[i] === 0 ? 'off' : volWarming ? 'vol warm' : ready ? 'ready' : snap.connected ? 'waiting' : 'connecting';
      point.prices.push(this.lastPrices[i]); point.moves.push(snap.move); point.ready.push(ready); point.up.push(c.up); point.down.push(c.down); point.lags.push(snap.lag || 0); point.eff.push(eff.effective);
      const item = {
        id: IDS[i],
        name: NAMES[i],
        enabled: this.enabled[i],
        price: this.lastPrices[i],
        move: snap.move,
        status,
        ready,
        connected: snap.connected,
        updatedAt: this.lastUpdates[i],
        up: c.up,
        down: c.down,
        missed: c.missed,
        armed: c.armed,
        lag: snap.lag || 0,
        volPct: snap.volPct || 0,
        volReady: Boolean(snap.volReady),
        effectiveThreshold: eff.effective,
        dynamicThreshold: eff.dynamic,
        dynamicActive: eff.active,
        streamKind: snap.streamKind || '',
      };
      if (isPrediction(i)) {
        const windowMs = 300000;
        const windowSec = Math.floor(at / windowMs) * (windowMs / 1000);
        const prefix = i === POLYMARKET_ETH_INDEX ? 'eth-updown-5m-' : 'btc-updown-5m-';
        item.slug = this.demo ? `${prefix}${windowSec}` : this.feeds[i].slug;
        item.expiresAt = this.demo ? (windowSec + windowMs / 1000) * 1000 : this.feeds[i].expiresAt;
      }
      return item;
    });
    return { mode: this.demo ? 'demo' : 'live', epoch: this.epoch, at, settings: this.settings, point, series, recent: this.recent.slice(), signals: this.signals.slice() };
  }
}
