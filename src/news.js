/* Crypto headlines, pulled once by the server and shared with every viewer.
   Doing this here rather than in each browser means one set of requests no
   matter how many people are watching, and everyone sees the same feed. */
import { EventEmitter } from 'node:events';

const RSS2JSON = 'https://api.rss2json.com/v1/api.json?rss_url=';

export const FEEDS = [
  { src: 'COINDESK',        url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { src: 'COINTELEGRAPH',   url: 'https://cointelegraph.com/rss' },
  { src: 'WATCHER GURU',    url: 'https://watcher.guru/news/feed' },
  { src: 'DECRYPT',         url: 'https://decrypt.co/feed' },
  { src: 'THE BLOCK',       url: 'https://www.theblock.co/rss.xml' },
  { src: 'BITCOIN MAG',     url: 'https://bitcoinmagazine.com/feed' },
  { src: 'CRYPTOSLATE',     url: 'https://cryptoslate.com/feed/' },
  { src: 'BEINCRYPTO',      url: 'https://beincrypto.com/feed/' },
  { src: 'U.TODAY',         url: 'https://u.today/rss' },
  { src: 'BITCOIN.COM',     url: 'https://news.bitcoin.com/feed/' }
];

const TOPICS = [
  { tag: 'BTC',        w: 4, rx: /\b(bitcoin|btc|satoshi)\b/i },
  { tag: 'ETF',        w: 3, rx: /\b(etf|etfs|inflow|outflow|blackrock|ibit|grayscale)\b/i },
  { tag: 'MACRO',      w: 3, rx: /\b(fed|fomc|rate cut|rate hike|inflation|cpi|treasury|dollar|recession|tariff)\b/i },
  { tag: 'MINING',     w: 3, rx: /\b(mining|miner|miners|hashrate|hash rate|halving)\b/i },
  { tag: 'FLOWS',      w: 3, rx: /\b(whale|whales|liquidation|liquidated|short squeeze|all-time high|ath)\b/i },
  { tag: 'REGULATION', w: 2, rx: /\b(sec|cftc|regulator|regulation|lawsuit|custody|approval|approve|ban|g20)\w*/i },
  { tag: 'EXCHANGE',   w: 2, rx: /\b(binance|coinbase|kraken|bybit|okx|tether|exchange)\b/i },
  { tag: 'CRYPTO',     w: 1, rx: /\b(crypto|blockchain|ethereum|eth|xrp|solana|stablecoin|defi|altcoin)\b/i }
];

const BULL_RX = /\b(surge\w*|rally|rallies|soar\w*|jump\w*|record|approv\w*|adopt\w*|inflow\w*|accumulat\w*|bullish|gains?|rises?|breakout|greenlight|upgrade\w*|buy\w*|top\w*)\b/gi;
const BEAR_RX = /\b(crash\w*|plunge\w*|drop\w*|falls?|fell|slides?|dump\w*|bans?|banned|reject\w*|hack\w*|exploit\w*|outflow\w*|liquidat\w*|bearish|declin\w*|slump\w*|fraud|probe|froze|freeze|seiz\w*|lawsuit|sued|selloff)\b/gi;

const strip = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ');

const parseWhen = (s) => {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return Date.parse(s.replace(' ', 'T') + 'Z');
  const t = Date.parse(s);
  return isNaN(t) ? Date.now() : t;
};

/* Used to spot the same story reported by several outlets. */
const titleKey = (t) =>
  String(t).toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean).slice(0, 6).join(' ');

export function score(text) {
  const topics = [];
  let rel = 0;
  for (const t of TOPICS) if (t.rx.test(text)) { topics.push(t.tag); rel += t.w; }
  const bull = (text.match(BULL_RX) || []).length;
  const bear = (text.match(BEAR_RX) || []).length;
  return {
    topics,
    rel,
    lean: bull > bear ? 'BULLISH' : bear > bull ? 'BEARISH' : 'NEUTRAL'
  };
}

export class News extends EventEmitter {
  constructor() {
    super();
    this.items = [];
    this.fng = null;
    this.meta = { at: 0, ok: 0, failed: [], loading: true };
    this.timer = null;
  }

  start(minutes = 5) {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), minutes * 60 * 1000);
    this.fngTimer = setInterval(() => this.pullFng(), 10 * 60 * 1000);
    this.pullFng();
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.fngTimer);
  }

  async pullFng() {
    try {
      const r = await fetch('https://api.alternative.me/fng/?limit=1');
      const j = await r.json();
      const d = j && j.data && j.data[0];
      if (d) {
        this.fng = { value: parseInt(d.value, 10), label: d.value_classification };
        this.emit('update', this.payload());
      }
    } catch (e) { /* index is optional garnish, never fatal */ }
  }

  async pullOne(feed) {
    const r = await fetch(RSS2JSON + encodeURIComponent(feed.url));
    const j = await r.json();
    if (j.status !== 'ok' || !Array.isArray(j.items)) throw new Error(feed.src);
    return j.items.map((it) => {
      const text = strip(it.title) + ' ' + strip(it.description);
      const s = score(text);
      return {
        id: it.guid || it.link,
        title: strip(it.title).trim(),
        link: it.link,
        src: feed.src,
        ts: parseWhen(it.pubDate),
        topics: s.topics,
        rel: s.rel,
        lean: s.lean
      };
    });
  }

  async refresh() {
    this.meta.loading = true;
    const failed = [];

    // One slow or broken outlet must not take the rest down with it.
    const results = await Promise.allSettled(FEEDS.map((f) => this.pullOne(f)));
    const all = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') all.push(...r.value);
      else failed.push(FEEDS[i].src);
    });

    const seenId = new Set();
    const seenTitle = new Set();
    const items = all
      .filter((n) => n.rel >= 2 && n.title)            // must be crypto-correlated
      .sort((a, b) => b.ts - a.ts)
      .filter((n) => {
        const tk = titleKey(n.title);
        if (seenId.has(n.id) || seenTitle.has(tk)) return false;
        seenId.add(n.id);
        seenTitle.add(tk);
        return true;
      })
      .slice(0, 120);

    this.items = items;
    this.meta = { at: Date.now(), ok: FEEDS.length - failed.length, failed, loading: false };
    console.log('[news] ' + items.length + ' stories from ' +
      this.meta.ok + '/' + FEEDS.length + ' feeds' +
      (failed.length ? ' (down: ' + failed.join(', ') + ')' : ''));
    this.emit('update', this.payload());
  }

  payload() {
    return { type: 'news-feed', items: this.items, meta: this.meta, fng: this.fng };
  }
}
