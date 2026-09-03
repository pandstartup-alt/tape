/* A hash-linked purchase ledger.

   Each entry stores the hash of the one before it, so changing any past record
   breaks every hash after it and `verify()` reports exactly where. That is the
   property people mean by "on a blockchain" — tamper evidence — without gas
   fees, wallets, or a public chain. It is NOT published to any network, and
   this file makes no claim that it is. */
import crypto from 'node:crypto';
import { data, save } from './store.js';

const GENESIS = '0'.repeat(64);

const hashOf = (e) =>
  crypto.createHash('sha256')
    .update([e.index, e.ts, e.orderId, e.userId, e.amount, e.days, e.method, e.prevHash].join('|'))
    .digest('hex');

const chain = () => {
  const d = data();
  if (!Array.isArray(d.ledger)) d.ledger = [];
  return d.ledger;
};

/* Keep the customer's address out of the record — the ledger is for showing
   activity, not for exposing who bought. */
const maskEmail = (email) => {
  const [name, domain] = String(email || '').split('@');
  if (!domain) return 'member';
  const head = name.slice(0, 2);
  return head + '•'.repeat(Math.max(2, name.length - 2)) + '@' + domain;
};

export function record({ orderId, userId, email, amount, days, method }) {
  const c = chain();
  const prev = c[c.length - 1];
  const entry = {
    index: c.length,
    ts: Date.now(),
    orderId: String(orderId || ''),
    userId: String(userId || ''),
    who: maskEmail(email),
    amount: Number(amount) || 0,
    days: Number(days) || 0,
    method: method || 'midtrans',
    prevHash: prev ? prev.hash : GENESIS
  };
  entry.hash = hashOf(entry);
  c.push(entry);
  save();
  return entry;
}

/* Walk the chain and report the first link that does not add up. */
export function verify() {
  const c = chain();
  let prevHash = GENESIS;
  for (let i = 0; i < c.length; i++) {
    const e = c[i];
    if (e.index !== i) return { ok: false, brokenAt: i, why: 'index out of order' };
    if (e.prevHash !== prevHash) return { ok: false, brokenAt: i, why: 'previous hash does not match' };
    if (hashOf(e) !== e.hash) return { ok: false, brokenAt: i, why: 'record was altered' };
    prevHash = e.hash;
  }
  return { ok: true, length: c.length, head: prevHash };
}

export const all = () => chain().slice().reverse();          // newest first

export const totals = () => {
  const c = chain();
  return {
    count: c.length,
    revenue: c.reduce((a, e) => a + (e.amount || 0), 0),
    head: c.length ? c[c.length - 1].hash : GENESIS
  };
};

/* Anonymised view for the public page — no ids, no order numbers. */
export const publicFeed = (limit = 12) =>
  chain().slice(-limit).reverse().map((e) => ({
    index: e.index,
    ts: e.ts,
    who: e.who,
    days: e.days,
    amount: e.amount,
    hash: e.hash.slice(0, 16)
  }));
