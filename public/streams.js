const now = () => performance.timeOrigin + performance.now();

export const VENUES = [
  { urls: ['wss://fstream.binance.com/market/ws/btcusdt@aggTrade', 'wss://fstream.binance.com/market/stream?streams=btcusdt@aggTrade'] },
  { urls: ['wss://stream.bybit.com/v5/public/linear', 'wss://stream.bytick.com/v5/public/linear'], subscribe: { op: 'subscribe', args: ['publicTrade.BTCUSDT'] }, ping: { op: 'ping' } },
  { urls: ['wss://ws.okx.com/ws/v5/public', 'wss://wsaws.okx.com/ws/v5/public'], subscribe: { op: 'subscribe', args: [{ channel: 'trades', instId: 'BTC-USDT-SWAP' }] }, ping: 'ping' },
  { urls: ['wss://api.hyperliquid.xyz/ws'], subscribe: { method: 'subscribe', subscription: { type: 'trades', coin: 'BTC' } }, ping: { method: 'ping' } },
  // Deribit's unauthenticated trade tape batches executions every 100 ms.
  { urls: ['wss://www.deribit.com/ws/api/v2'], subscribe: { jsonrpc: '2.0', id: 1, method: 'public/subscribe', params: { channels: ['trades.BTC_USDC-PERPETUAL.100ms'] } }, ping: { jsonrpc: '2.0', id: 2, method: 'public/test', params: {} } },
  { urls: ['wss://futures.kraken.com/ws/v1', 'wss://www.cryptofacilities.com/ws/v1'], subscribe: { event: 'subscribe', feed: 'trade', product_ids: ['PF_XBTUSD'] }, heartbeat: { event: 'subscribe', feed: 'heartbeat' } },
  { urls: ['wss://stream.binance.com/ws/btcusdt@aggTrade', 'wss://stream.binance.com/stream?streams=btcusdt@aggTrade'] },
  { urls: ['wss://ws-subscriptions-clob.polymarket.com/ws/market'], marketUrl: 'https://gamma-api.polymarket.com/markets?slug=btc-updown-5m-', windowMs: 300000, subscribeMarket: assetId => ({ type: 'market', assets_ids: [assetId] }), ping: 'PING' },
  { urls: ['wss://ws-subscriptions-clob.polymarket.com/ws/market'], marketUrl: 'https://gamma-api.polymarket.com/markets?slug=btc-updown-15m-', windowMs: 900000, subscribeMarket: assetId => ({ type: 'market', assets_ids: [assetId] }), ping: 'PING' },
  { urls: ['wss://ws.predict.fun/ws'], marketUrl: typeof location === 'object' && /^https?:$/.test(location.protocol) ? '/predict-market/btc-updown-5m-' : 'https://predict.fun/market/btc-updown-5m-', windowMs: 300000, subscribeMarket: assetId => ({ method: 'subscribe', requestId: 1, params: [`predictOrderbook/${assetId}`] }), echoHeartbeat: true },
];

// Browser-native WebSockets answer Binance control PING frames automatically.
// Control frames are not exposed to JavaScript, so Binance quiet prices cannot
// be used as a heartbeat watchdog. Other venues provide text responses or,
// for Kraken Futures, a subscribed server heartbeat (not a JSON ping).
export class StreamConnection {
  constructor(index, monitor) { this.index = index; this.monitor = monitor; this.candidate = 0; this.delay = 1000; this.stopped = false; this.expiresAt = 0; this.minWindowMs = 0; this.connect(); }
  async resolveMarket(venue) {
    this.controller = new AbortController();
    const at = Math.max(now(), this.minWindowMs);
    const windowSec = Math.floor(at / venue.windowMs) * (venue.windowMs / 1000);
    const fallbackExpiresAt = (windowSec + venue.windowMs / 1000) * 1000;
    const response = await fetch(`${venue.marketUrl}${windowSec}`, { signal: this.controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (venue.echoHeartbeat) {
      const raw = typeof response.text === 'function' ? await response.text() : JSON.stringify(await response.json());
      let slug = `btc-updown-5m-${windowSec}`, assetId = null, endDate = null, open = true;
      if (raw.trim().startsWith('{')) {
        const body = JSON.parse(raw), cat = body?.data || body;
        const market = Array.isArray(cat?.markets) ? cat.markets[0] : cat;
        slug = cat?.slug || market?.categorySlug || slug;
        assetId = market?.id != null ? String(market.id) : null;
        endDate = cat?.endsAt || market?.boostEndsAt || market?.endDate;
        open = cat?.status !== 'RESOLVED' && market?.status !== 'RESOLVED' && market?.tradingStatus !== 'CLOSED' && market?.isTradingEnabled !== false && market?.closed !== true;
      } else {
        slug = raw.match(/categoryId=(btc-updown-5m-\d+)/)?.[1] || slug;
        assetId = raw.match(/marketId[=\\":]+(\d+)/)?.[1] || null;
        endDate = raw.match(/\\"endsAt\\":\\"([^"\\]+)\\"/)?.[1] || null;
        const trading = raw.match(/\\"isTradingEnabled\\":(true|false)/)?.[1];
        const status = raw.match(/\\"isTradingEnabled\\":(?:true|false),\\"status\\":\\"([^"\\]+)\\"/)?.[1];
        open = trading !== 'false' && (!status || status === 'REGISTERED' || status === 'OPEN');
      }
      if (!assetId || !/^\d+$/.test(assetId) || !open) throw new Error('Predict.fun 5m market unavailable');
      const endMs = Date.parse(endDate);
      const expiresAt = Number.isFinite(endMs) && endMs > at ? endMs : fallbackExpiresAt;
      return { slug, assetId, expiresAt };
    }
    const data = await response.json();
    const market = (Array.isArray(data) ? data : data?.markets)?.[0];
    const outcomes = typeof market?.outcomes === 'string' ? JSON.parse(market.outcomes) : market?.outcomes;
    const tokens = typeof market?.clobTokenIds === 'string' ? JSON.parse(market.clobTokenIds) : market?.clobTokenIds;
    const upIndex = Array.isArray(outcomes) ? outcomes.findIndex(o => String(o).toLowerCase() === 'up') : -1;
    const assetId = Array.isArray(tokens) ? tokens[upIndex >= 0 ? upIndex : 0] : null;
    if (typeof assetId !== 'string' || !assetId || market?.closed === true || market?.acceptingOrders === false) {
      throw new Error(venue.marketUrl.includes('15m') ? 'Polymarket 15m market unavailable' : 'Polymarket 5m market unavailable');
    }
    const endMs = Date.parse(market.endDate);
    const expiresAt = Number.isFinite(endMs) && endMs > at ? endMs : fallbackExpiresAt;
    const prefix = venue.marketUrl.includes('15m') ? 'btc-updown-15m-' : 'btc-updown-5m-';
    return { slug: market.slug || `${prefix}${windowSec}`, assetId, expiresAt };
  }
  connect() {
    if (this.stopped) return;
    const venue = VENUES[this.index];
    const socket = new WebSocket(venue.urls[this.candidate % venue.urls.length]);
    this.socket = socket;
    let missedHeartbeats = 0, opened = false, market = null;
    const send = data => socket.send(typeof data === 'string' ? data : JSON.stringify(data));
    const fail = () => {
      if (this.socket !== socket || this.stopped) return;
      this.clearTimers(); socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      socket.close(); this.socket = null; this.expiresAt = 0; this.monitor.connection(this.index, false);
      this.candidate++; this.retry = setTimeout(() => this.connect(), this.delay); this.delay = Math.min(15000, this.delay * 2);
    };
    const activate = () => {
      if (this.socket !== socket || this.stopped || !opened || (venue.marketUrl && !market)) return;
      if (market && now() >= market.expiresAt) { this.rollover(market.expiresAt); return; }
      clearTimeout(this.deadline); this.delay = 1000; missedHeartbeats = 0;
      if (market) {
        this.expiresAt = market.expiresAt;
        this.monitor.market?.(this.index, market);
        this.monitor.connection(this.index, true);
        send(venue.subscribeMarket ? venue.subscribeMarket(market.assetId) : { type: 'market', assets_ids: [market.assetId] });
        this.expiry = setTimeout(() => this.rollover(market.expiresAt), Math.max(20, market.expiresAt - now() + 25));
      } else {
        this.monitor.connection(this.index, true);
        if (venue.subscribe) send(venue.subscribe);
      }
      if (venue.heartbeat) send(venue.heartbeat);
      if (venue.ping || venue.heartbeat || venue.echoHeartbeat) this.heartbeat = setInterval(() => {
        if (this.expiresAt && now() >= this.expiresAt) { this.rollover(this.expiresAt); return; }
        // Count actual heartbeat opportunities. Delayed background timers alone
        // do not prove the socket stopped responding.
        if (socket.bufferedAmount > 65536 || missedHeartbeats >= 6) { fail(); return; }
        missedHeartbeats++;
        try { if (venue.ping) send(venue.ping); } catch { fail(); }
      }, 5000);
      this.rotation = setTimeout(fail, 23 * 60 * 60 * 1000);
    };
    this.deadline = setTimeout(fail, 10000);
    if (venue.marketUrl) {
      this.resolveMarket(venue).then(info => {
        if (this.socket !== socket || this.stopped) return;
        market = info; activate();
      }).catch(fail);
    }
    socket.onopen = () => {
      if (this.socket !== socket || this.stopped) return;
      opened = true; activate();
    };
    socket.onmessage = event => {
      if (this.socket !== socket || this.stopped) return;
      const at = now(); missedHeartbeats = 0;
      if (this.expiresAt && at >= this.expiresAt) { this.rollover(this.expiresAt); return; }
      if (typeof event.data !== 'string' || event.data.length > 1024 * 1024) { fail(); return; }
      if (venue.echoHeartbeat && event.data.includes('"heartbeat"')) {
        try {
          const msg = JSON.parse(event.data);
          if (msg?.topic === 'heartbeat') send({ method: 'heartbeat', data: msg.data });
        } catch { fail(); return; }
      }
      if (this.monitor.frame(this.index, event.data, at) < 0) fail();
    };
    socket.onerror = socket.onclose = fail;
  }
  rollover(expiredAt = this.expiresAt) {
    if (this.stopped) return;
    if (expiredAt) this.minWindowMs = Math.max(this.minWindowMs, expiredAt);
    this.expiresAt = 0; this.delay = 1000; this.clearTimers();
    if (this.socket) { this.socket.onopen = this.socket.onmessage = this.socket.onerror = this.socket.onclose = null; this.socket.close(); this.socket = null; }
    this.monitor.connection(this.index, false); this.connect();
  }
  resume() {
    if (this.stopped) return;
    if (this.expiresAt && now() >= this.expiresAt) { this.rollover(this.expiresAt); return; }
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    this.clearTimers();
    if (this.socket) { this.socket.onopen = this.socket.onmessage = this.socket.onerror = this.socket.onclose = null; this.socket.close(); this.socket = null; }
    this.monitor.connection(this.index, false); this.connect();
  }
  clearTimers() { clearTimeout(this.deadline); clearTimeout(this.retry); clearTimeout(this.rotation); clearTimeout(this.expiry); clearInterval(this.heartbeat); this.controller?.abort(); this.controller = null; }
  close() {
    this.stopped = true; this.expiresAt = 0; this.clearTimers();
    if (this.socket) { this.socket.onopen = this.socket.onmessage = this.socket.onerror = this.socket.onclose = null; this.socket.close(); this.socket = null; }
    this.monitor.connection(this.index, false);
  }
}
