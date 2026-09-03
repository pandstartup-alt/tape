import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import http from 'node:http';
import { WebSocketServer } from 'ws';

import * as store from './store.js';
import { Market } from './market.js';
import { News } from './news.js';
import { Klines } from './klines.js';
import * as pay from './payments.js';
import {
  sign, register, login, publicUser, userFromToken,
  attachUser, requireUser, requireAdmin
} from './auth.js';

store.load();

/* Promote the configured admin email if that account exists. */
const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
if (adminEmail) {
  const a = store.findUserByEmail(adminEmail);
  if (a && a.role !== 'admin') {
    a.role = 'admin';
    store.save();
    console.log('[boot] promoted', adminEmail, 'to admin');
  } else if (!a) {
    console.log('[boot] admin pending — register', adminEmail, 'then restart to promote it');
  }
}

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(attachUser);
app.disable('x-powered-by');

const ok = (res, body) => res.json(Object.assign({ ok: true }, body));
const bad = (res, code, msg) => res.status(code).json({ error: msg });

/* ── auth ───────────────────────────────────────────────────────────────── */
app.post('/api/register', async (req, res) => {
  try {
    const u = await register(req.body.email, req.body.password);
    if (adminEmail && u.email === adminEmail) { u.role = 'admin'; store.save(); }
    ok(res, { token: sign(u), user: publicUser(u) });
  } catch (e) { bad(res, 400, e.message); }
});

app.post('/api/login', async (req, res) => {
  try {
    const u = await login(req.body.email, req.body.password);
    ok(res, { token: sign(u), user: publicUser(u) });
  } catch (e) { bad(res, 401, e.message); }
});

app.get('/api/me', requireUser, (req, res) => ok(res, { user: publicUser(req.user) }));

/* ── payments ───────────────────────────────────────────────────────────── */
app.get('/api/plan', (_req, res) => ok(res, { plan: pay.planInfo() }));

app.post('/api/payments/create', requireUser, async (req, res) => {
  try {
    ok(res, { payment: await pay.createPayment(req.user) });
  } catch (e) { bad(res, 400, e.message); }
});

/* Midtrans calls this. Paste PUBLIC_URL + /api/payments/webhook into the
   Midtrans dashboard under Payment Notification URL. */
app.post('/api/payments/webhook', (req, res) => {
  const result = pay.handleNotification(req.body || {});
  if (!result.ok) {
    console.warn('[pay] rejected notification:', result.reason);
    return res.status(403).json({ error: result.reason });
  }
  if (result.granted) {
    console.log('[pay] access granted to', result.userId);
    pushEntitlement(result.userId);
  }
  res.json({ ok: true });
});

app.post('/api/payments/sync', requireUser, async (req, res) => {
  try {
    const r = await pay.syncOrder(String(req.body.orderId || ''));
    if (r.granted) pushEntitlement(req.user.id);
    ok(res, Object.assign(r, { user: publicUser(store.findUserById(req.user.id)) }));
  } catch (e) { bad(res, 400, e.message); }
});

/* ── content ────────────────────────────────────────────────────────────── */
/* Manual refresh, throttled so a hammered button can't spam the feeds. */
app.post('/api/news/refresh', (_req, res) => {
  if (Date.now() - (news.meta.at || 0) < 60_000) {
    return ok(res, { refreshed: false, reason: 'refreshed less than a minute ago' });
  }
  news.refresh();
  ok(res, { refreshed: true });
});

app.get('/api/content', (_req, res) => {
  const d = store.data();
  ok(res, { signals: d.signals, news: d.news, chat: d.chat });
});

app.post('/api/signals', requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!String(b.entry || '').trim()) return bad(res, 400, 'Entry is required');
  const sig = store.addSignal({
    side: b.side === 'SHORT' ? 'SHORT' : 'LONG',
    pair: String(b.pair || 'BTC/USDT').slice(0, 24),
    entry: String(b.entry).slice(0, 24),
    target: String(b.target || '').slice(0, 24),
    stop: String(b.stop || '').slice(0, 24),
    note: String(b.note || '').slice(0, 400)
  });
  broadcast({ type: 'signal', signal: sig });
  ok(res, { signal: sig });
});

app.patch('/api/signals/:id', requireAdmin, (req, res) => {
  const s = store.updateSignal(req.params.id, { status: String(req.body.status || 'OPEN').slice(0, 20) });
  if (!s) return bad(res, 404, 'No such signal');
  broadcast({ type: 'signal-update', signal: s });
  ok(res, { signal: s });
});

app.delete('/api/signals/:id', requireAdmin, (req, res) => {
  if (!store.removeSignal(req.params.id)) return bad(res, 404, 'No such signal');
  broadcast({ type: 'signal-remove', id: req.params.id });
  ok(res, {});
});

/* News is broadcast-only by design: admin writes, everyone reads. */
app.post('/api/news', requireAdmin, (req, res) => {
  const text = String((req.body || {}).text || '').trim();
  if (!text) return bad(res, 400, 'Empty note');
  const item = store.addNews({ text: text.slice(0, 500), src: 'ADMIN' });
  broadcast({ type: 'news', item });
  ok(res, { item });
});

app.delete('/api/news/:id', requireAdmin, (req, res) => {
  if (!store.removeNews(req.params.id)) return bad(res, 404, 'No such item');
  broadcast({ type: 'news-remove', id: req.params.id });
  ok(res, {});
});

app.post('/api/chat', requireUser, (req, res) => {
  const text = String((req.body || {}).text || '').trim();
  if (!text) return bad(res, 400, 'Empty message');
  const msg = store.addChat({
    nick: req.user.email.split('@')[0],
    role: req.user.role,
    text: text.slice(0, 500)
  });
  broadcast({ type: 'chat', msg });
  ok(res, { msg });
});

/* ── admin ──────────────────────────────────────────────────────────────── */
app.get('/api/admin/users', requireAdmin, (_req, res) => {
  const d = store.data();
  ok(res, {
    users: d.users.map((u) => ({
      id: u.id, email: u.email, role: u.role,
      paid: store.isPaid(u), paidUntil: u.paidUntil || 0, createdAt: u.createdAt
    })),
    orders: d.orders.slice(-100).reverse()
  });
});

/* Manual override, for when someone pays you outside the gateway. */
app.post('/api/admin/grant', requireAdmin, (req, res) => {
  const u = store.findUserByEmail(req.body.email);
  if (!u) return bad(res, 404, 'No user with that email');
  const days = parseInt(req.body.days, 10);
  store.grantAccess(u.id, Number.isFinite(days) ? days : 30);
  pushEntitlement(u.id);
  ok(res, { user: publicUser(store.findUserById(u.id)) });
});

/* ── static frontends ───────────────────────────────────────────────────── */
app.use(express.static(path.join(process.cwd(), 'public'), { extensions: ['html'] }));

/* ── sockets ────────────────────────────────────────────────────────────── */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/live' });
const market = new Market();
const news = new News();
const klines = new Klines();

/* Every socket carries the entitlement decided at connect time (and refreshed
   when a payment lands). Alerts are filtered per socket — a free client is
   never sent the data, so there is nothing client-side to unlock. */
wss.on('connection', (ws, req) => {
  const token = new URL(req.url, 'http://x').searchParams.get('token');
  const user = userFromToken(token);
  ws.uid = user ? user.id : null;
  ws.paid = store.isPaid(user);

  ws.send(JSON.stringify({
    type: 'hello',
    paid: ws.paid,
    user: user ? publicUser(user) : null,
    plan: pay.planInfo(),
    content: store.data()
      ? { signals: store.data().signals, news: store.data().news, chat: store.data().chat }
      : null
  }));
  ws.send(JSON.stringify(market.snapshot()));
  ws.send(JSON.stringify(news.payload()));
  ws.send(JSON.stringify(klines.payload()));

  ws.on('pong', () => { ws.alive = true; });
  ws.alive = true;
});

const send = (ws, obj) => {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (e) {}
  }
};

function broadcast(obj, paidOnly = false) {
  for (const ws of wss.clients) {
    if (paidOnly && !ws.paid) continue;
    send(ws, obj);
  }
}

/* Re-evaluate a user's sockets the moment their payment settles, so access
   starts immediately without a reload. */
function pushEntitlement(userId) {
  const u = store.findUserById(userId);
  if (!u) return;
  const paid = store.isPaid(u);
  for (const ws of wss.clients) {
    if (ws.uid !== userId) continue;
    ws.paid = paid;
    send(ws, { type: 'entitlement', paid, user: publicUser(u) });
  }
}

market.on('flow', (snap) => broadcast(snap));          // free: aggregates only
market.on('alert', (a) => broadcast({ type: 'alert', alert: a }, true));   // paid only
market.start();

news.on('update', (p) => broadcast(p));                // headlines: free for everyone
news.start(5);

// candles are free too — only the size alerts are paid
klines.on('update', (p) => broadcast(p));
klines.start(60);

// keep the forming candle moving between REST pulls, and push it twice a second
market.on('flow', (snap) => { if (snap.price) klines.applyTrade(snap.price); });
setInterval(() => {
  if (klines.candles.length) {
    const last = klines.candles[klines.candles.length - 1];
    broadcast({ type: 'candle-tick', candle: last });
  }
}, 2000);

/* Drop sockets that stopped answering, and re-check expiry once a minute. */
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.alive === false) { ws.terminate(); continue; }
    ws.alive = false;
    try { ws.ping(); } catch (e) {}
    if (ws.uid) {
      const stillPaid = store.isPaid(store.findUserById(ws.uid));
      if (stillPaid !== ws.paid) {
        ws.paid = stillPaid;
        send(ws, { type: 'entitlement', paid: stillPaid });
      }
    }
  }
}, 30_000);

const PORT = parseInt(process.env.PORT || '8080', 10);
server.listen(PORT, () => {
  const p = pay.planInfo();
  console.log('[boot] TAPE server on http://localhost:' + PORT);
  console.log('[boot] payments:', p.configured ? (p.sandbox ? 'SANDBOX' : 'PRODUCTION') : 'NOT CONFIGURED');
  console.log('[boot] webhook URL to paste into Midtrans:',
    (process.env.PUBLIC_URL || 'http://localhost:' + PORT) + '/api/payments/webhook');
});

const shutdown = () => {
  clearInterval(heartbeat);
  market.stop();
  news.stop();
  klines.stop();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
