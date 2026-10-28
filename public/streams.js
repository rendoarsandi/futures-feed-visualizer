export const VENUES = [
  { urls: ['wss://fstream.binance.com/market/ws/btcusdt@aggTrade', 'wss://fstream.binance.com/market/stream?streams=btcusdt@aggTrade'] },
  { urls: ['wss://stream.bybit.com/v5/public/linear', 'wss://stream.bytick.com/v5/public/linear'], subscribe: { op: 'subscribe', args: ['publicTrade.BTCUSDT'] }, ping: { op: 'ping' } },
  { urls: ['wss://ws.okx.com/ws/v5/public', 'wss://wsaws.okx.com/ws/v5/public'], subscribe: { op: 'subscribe', args: [{ channel: 'trades', instId: 'BTC-USDT-SWAP' }] }, ping: 'ping' },
  { urls: ['wss://api.hyperliquid.xyz/ws'], subscribe: { method: 'subscribe', subscription: { type: 'trades', coin: 'BTC' } }, ping: { method: 'ping' } },
];

// Browser-native WebSockets answer Binance control PING frames automatically.
// Control frames are not exposed to JavaScript, so Binance quiet prices cannot
// be used as a heartbeat watchdog. Other venues provide explicit text PONGs.
export class StreamConnection {
  constructor(index, monitor) { this.index = index; this.monitor = monitor; this.candidate = 0; this.delay = 1000; this.stopped = false; this.connect(); }
  connect() {
    if (this.stopped) return;
    const venue = VENUES[this.index];
    const socket = new WebSocket(venue.urls[this.candidate % venue.urls.length]);
    this.socket = socket;
    let lastFrame = performance.now();
    const send = data => socket.send(typeof data === 'string' ? data : JSON.stringify(data));
    const fail = () => {
      if (this.socket !== socket || this.stopped) return;
      this.clearTimers(); socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      socket.close(); this.socket = null; this.monitor.connection(this.index, false);
      this.candidate++; this.retry = setTimeout(() => this.connect(), this.delay); this.delay = Math.min(15000, this.delay * 2);
    };
    this.deadline = setTimeout(fail, 10000);
    socket.onopen = () => {
      if (this.socket !== socket || this.stopped) return;
      clearTimeout(this.deadline); this.delay = 1000; lastFrame = performance.now();
      this.monitor.connection(this.index, true);
      if (venue.subscribe) send(venue.subscribe);
      if (venue.ping) this.heartbeat = setInterval(() => {
        if (socket.bufferedAmount > 65536 || performance.now() - lastFrame > 30000) { fail(); return; }
        try { send(venue.ping); } catch { fail(); }
      }, 5000);
      this.rotation = setTimeout(fail, 23 * 60 * 60 * 1000);
    };
    socket.onmessage = event => {
      if (this.socket !== socket || this.stopped) return;
      const at = performance.timeOrigin + performance.now(); lastFrame = performance.now();
      if (typeof event.data !== 'string' || event.data.length > 1024 * 1024) { fail(); return; }
      if (this.monitor.frame(this.index, event.data, at) < 0) fail();
    };
    socket.onerror = socket.onclose = fail;
  }
  clearTimers() { clearTimeout(this.deadline); clearTimeout(this.retry); clearTimeout(this.rotation); clearInterval(this.heartbeat); }
  close() {
    this.stopped = true; this.clearTimers();
    if (this.socket) { this.socket.onopen = this.socket.onmessage = this.socket.onerror = this.socket.onclose = null; this.socket.close(); this.socket = null; }
    this.monitor.connection(this.index, false);
  }
}
