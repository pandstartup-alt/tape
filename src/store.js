/* Tiny JSON-file store: no native modules, nothing to compile, survives restarts.
   Good for the first few hundred users. When you outgrow it, swap this one file
   for Postgres — everything else talks to it through these functions only. */
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(process.cwd(), 'data');
const FILE = path.join(DIR, 'db.json');

const EMPTY = { users: [], orders: [], signals: [], news: [], chat: [] };

let db = EMPTY;
let writing = false;
let dirty = false;

export function load() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    if (fs.existsSync(FILE)) {
      db = Object.assign({}, EMPTY, JSON.parse(fs.readFileSync(FILE, 'utf8')));
    } else {
      db = structuredClone(EMPTY);
      flush();
    }
  } catch (e) {
    console.error('[store] could not load, starting empty:', e.message);
    db = structuredClone(EMPTY);
  }
  return db;
}

/* Write through a temp file then rename, so a crash mid-write cannot leave a
   half-written db.json behind. Coalesced so a burst of writes costs one flush. */
function flush() {
  if (writing) { dirty = true; return; }
  writing = true;
  const tmp = FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error('[store] write failed:', e.message);
  } finally {
    writing = false;
    if (dirty) { dirty = false; setTimeout(flush, 20); }
  }
}

export const data = () => db;
export const save = () => flush();

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 9);

/* ── users ──────────────────────────────────────────────────────────────── */
export const findUserByEmail = (email) =>
  db.users.find((u) => u.email === String(email || '').trim().toLowerCase());

export const findUserById = (id) => db.users.find((u) => u.id === id);

export function createUser({ email, hash }) {
  const user = {
    id: uid(),
    email: String(email).trim().toLowerCase(),
    hash,
    role: 'user',
    paidUntil: 0,
    createdAt: Date.now()
  };
  db.users.push(user);
  save();
  return user;
}

export const isPaid = (user) =>
  !!user && (user.role === 'admin' || (user.paidUntil || 0) > Date.now());

/* Extends from whichever is later: now, or the end of the current period, so
   paying again before expiry stacks instead of throwing away paid days. */
export function grantAccess(userId, days) {
  const u = findUserById(userId);
  if (!u) return null;
  const from = Math.max(Date.now(), u.paidUntil || 0);
  u.paidUntil = from + days * 24 * 60 * 60 * 1000;
  save();
  return u;
}

/* ── orders ─────────────────────────────────────────────────────────────── */
export function createOrder(o) {
  const order = Object.assign({ id: uid(), status: 'pending', createdAt: Date.now() }, o);
  db.orders.push(order);
  save();
  return order;
}

export const findOrder = (orderId) => db.orders.find((o) => o.orderId === orderId);

/* ── content ────────────────────────────────────────────────────────────── */
export function addSignal(sig) {
  db.signals.unshift(Object.assign({ id: uid(), ts: Date.now(), status: 'OPEN' }, sig));
  db.signals = db.signals.slice(0, 200);
  save();
  return db.signals[0];
}

export function updateSignal(id, patch) {
  const s = db.signals.find((x) => x.id === id);
  if (!s) return null;
  Object.assign(s, patch);
  save();
  return s;
}

export function removeSignal(id) {
  const before = db.signals.length;
  db.signals = db.signals.filter((x) => x.id !== id);
  if (db.signals.length !== before) save();
  return before !== db.signals.length;
}

export function addNews(item) {
  db.news.unshift(Object.assign({ id: uid(), ts: Date.now() }, item));
  db.news = db.news.slice(0, 200);
  save();
  return db.news[0];
}

export function removeNews(id) {
  const before = db.news.length;
  db.news = db.news.filter((x) => x.id !== id);
  if (db.news.length !== before) save();
  return before !== db.news.length;
}

export function addChat(msg) {
  db.chat.push(Object.assign({ id: uid(), ts: Date.now() }, msg));
  db.chat = db.chat.slice(-300);
  save();
  return db.chat[db.chat.length - 1];
}
