/* Candles and indicators, straight from Binance REST.
   Replaces the TradingView embed, which refuses to render from this domain.
   The server fetches once and shares with everyone, same as the news. */
import { EventEmitter } from 'node:events';

const HOSTS = [
  'https://api.binance.com',
  'https://data-api.binance.vision'
];

const INTERVAL = '5m';
const LIMIT = 120;

const sma = (vals, n) => {
  if (vals.length < n) return null;
  let s = 0;
  for (let i = vals.length - n; i < vals.length; i++) s += vals[i];
  return s / n;
};

/* Wilder's RSI, the standard 14-period version. */
function rsi(closes, n = 14) {
  if (closes.length < n + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + (d > 0 ? d : 0)) / n;
    loss = (loss * (n - 1) + (d < 0 ? -d : 0)) / n;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

export class Klines extends EventEmitter {
  constructor() {
    super();
    this.candles = [];
    this.tech = null;
    this.host = 0;
    this.timer = null;
  }

  start(seconds = 60) {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), seconds * 1000);
  }

  stop() { clearInterval(this.timer); }

  async refresh() {
    for (let attempt = 0; attempt < HOSTS.length; attempt++) {
      const host = HOSTS[(this.host + attempt) % HOSTS.length];
      try {
        const url = host + '/api/v3/klines?symbol=BTCUSDT&interval=' + INTERVAL + '&limit=' + LIMIT;
        const res = await fetch(url);
        if (!res.ok) throw new Error('status ' + res.status);
        const raw = await res.json();
        if (!Array.isArray(raw) || !raw.length) throw new Error('empty');

        this.candles = raw.map((k) => ({
          t: k[0],
          o: parseFloat(k[1]),
          h: parseFloat(k[2]),
          l: parseFloat(k[3]),
          c: parseFloat(k[4]),
          v: parseFloat(k[5])
        }));
        this.host = (this.host + attempt) % HOSTS.length;   // remember what worked
        this.computeTech();
        this.emit('update', this.payload());
        return;
      } catch (e) {
        if (attempt === HOSTS.length - 1) console.warn('[klines] all hosts failed:', e.message);
      }
    }
  }

  /* The live trade stream keeps the newest candle moving between REST pulls. */
  applyTrade(price) {
    const last = this.candles[this.candles.length - 1];
    if (!last || !Number.isFinite(price)) return;
    last.c = price;
    if (price > last.h) last.h = price;
    if (price < last.l) last.l = price;
  }

  computeTech() {
    const closes = this.candles.map((c) => c.c);
    if (closes.length < 20) { this.tech = null; return; }

    const price = closes[closes.length - 1];
    const ma20 = sma(closes, 20);
    const ma50 = sma(closes, 50);
    const r = rsi(closes, 14);

    // Each reading votes; the tally becomes the headline call.
    const votes = [];
    if (ma20 !== null) votes.push(price > ma20 ? 1 : -1);
    if (ma50 !== null) votes.push(price > ma50 ? 1 : -1);
    if (ma20 !== null && ma50 !== null) votes.push(ma20 > ma50 ? 1 : -1);
    if (r !== null) votes.push(r > 55 ? 1 : r < 45 ? -1 : 0);

    const score = votes.reduce((a, b) => a + b, 0);
    const buy = votes.filter((v) => v > 0).length;
    const sell = votes.filter((v) => v < 0).length;
    const neutral = votes.filter((v) => v === 0).length;

    this.tech = {
      price,
      ma20, ma50,
      rsi: r,
      buy, sell, neutral,
      summary: score >= 3 ? 'STRONG BUY' : score > 0 ? 'BUY'
             : score <= -3 ? 'STRONG SELL' : score < 0 ? 'SELL' : 'NEUTRAL',
      score
    };
  }

  payload() {
    return { type: 'chart', candles: this.candles, tech: this.tech, interval: INTERVAL };
  }
}
