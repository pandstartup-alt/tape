/* The whole point of this file: the SERVER holds the only Binance connection.
   Browsers never see raw trades, so a free user has nothing to reconstruct the
   alerts from. Free sockets get aggregate percentages; paid sockets also get
   `alert` and `print` events. That is what makes the paywall real rather than
   a flag someone can flip in DevTools. */
import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';

const WINDOW_MS = 60_000;
const SNAPSHOT_MS = 250;

const N = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

const TIERS = [
  { key: 'humpback', name: 'HUMPBACK', glyph: '🐋', drama: 3, min: () => N(process.env.TIER_HUMPBACK, 500000) },
  { key: 'whale',    name: 'WHALE',    glyph: '🐳', drama: 2, min: () => N(process.env.TIER_WHALE, 100000) },
  { key: 'shark',    name: 'SHARK',    glyph: '🦈', drama: 1, min: () => N(process.env.TIER_SHARK, 50000) },
  { key: 'dolphin',  name: 'DOLPHIN',  glyph: '🐬', drama: 0, min: () => N(process.env.TIER_DOLPHIN, 10000) }
];

const tierOf = (usd) => TIERS.find((t) => usd >= t.min()) || null;

export class Market extends EventEmitter {
  constructor() {
    super();
    this.trades = [];          // rolling 60s window of {t, usd, buy}
    this.price = null;
    this.dir = 0;
    this.status = 'connecting';
    this.ws = null;
    this.idx = 0;
    this.fails = 0;
    this.timers = {};
    this.endpoints = [
      process.env.BINANCE_WS || 'wss://stream.binance.com:9443/ws/btcusdt@trade',
      process.env.BINANCE_WS_FALLBACK || 'wss://data-stream.binance.vision/ws/btcusdt@trade'
    ];
  }

  start() {
    this.connect();
    this.timers.snap = setInterval(() => this.emit('flow', this.snapshot()), SNAPSHOT_MS);
  }

  stop() {
    clearInterval(this.timers.snap);
    clearTimeout(this.timers.retry);
    clearTimeout(this.timers.guard);
    if (this.ws) { try { this.ws.close(); } catch (e) {} }
  }

  connect() {
    const url = this.endpoints[this.idx % this.endpoints.length];
    this.status = this.fails ? 'reconnecting' : 'connecting';
    const ws = new WebSocket(url);
    this.ws = ws;

    // A handshake that never completes must not wedge the stream forever.
    clearTimeout(this.timers.guard);
    this.timers.guard = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) { try { ws.terminate(); } catch (e) {} }
    }, 8000);

    ws.on('open', () => {
      clearTimeout(this.timers.guard);
      this.fails = 0;
      this.status = 'live';
      console.log('[market] live on', url);
    });

    ws.on('message', (raw) => {
      let d;
      try { d = JSON.parse(raw.toString()); } catch (e) { return; }
      if (!d || d.p === undefined) return;
      const p = parseFloat(d.p);
      const q = parseFloat(d.q);
      if (!Number.isFinite(p) || !Number.isFinite(q)) return;

      const usd = p * q;
      const buy = d.m === false;             // m = buyer is maker → taker sold
      const t = d.T || Date.now();

      this.trades.push({ t, usd, buy });
      if (this.price !== null && p !== this.price) this.dir = p > this.price ? 1 : -1;
      this.price = p;

      const tier = tierOf(usd);
      if (tier) {
        // paid-only payload — never sent to a free socket
        this.emit('alert', {
          id: String(t) + ':' + String(d.t),
          tier: { key: tier.key, name: tier.name, glyph: tier.glyph, drama: tier.drama },
          usd, qty: q, price: p, buy, ts: t
        });
      }
    });

    ws.on('error', () => { try { ws.terminate(); } catch (e) {} });

    ws.on('close', () => {
      clearTimeout(this.timers.guard);
      this.status = 'down';
      this.fails++;
      this.idx++;                             // rotate endpoint
      clearTimeout(this.timers.retry);
      this.timers.retry = setTimeout(() => this.connect(), Math.min(800 * this.fails, 8000));
    });
  }

  /* Aggregate only. Safe to hand to anyone — it contains no individual trade. */
  snapshot() {
    const cut = Date.now() - WINDOW_MS;
    let i = 0;
    while (i < this.trades.length && this.trades[i].t < cut) i++;
    if (i) this.trades.splice(0, i);

    let b = 0, s = 0;
    for (const tr of this.trades) { if (tr.buy) b += tr.usd; else s += tr.usd; }
    const tot = b + s;

    return {
      type: 'flow',
      status: this.status,
      price: this.price,
      dir: this.dir,
      buyPct: tot ? (b / tot) * 100 : 50,
      sellPct: tot ? (s / tot) * 100 : 50,
      buyUsd: b,
      sellUsd: s,
      trades: this.trades.length,
      live: tot > 0
    };
  }
}
