/* Midtrans Snap: one hosted checkout page that offers every payment method
   enabled on the account — QRIS, bank transfer, e-wallets, cards. Charging a
   channel directly (Core API) needs each one activated first, which is why it
   answered "Payment channel is not activated"; Snap sidesteps that.

   The server key lives here and NEVER goes to the browser. Access is granted
   only by a signed Midtrans notification or a server-to-server status check —
   never by the browser claiming it paid. */
import crypto from 'node:crypto';
import { createOrder, findOrder, grantAccess, save, data, findUserById } from './store.js';
import * as ledger from './ledger.js';

const PROD = String(process.env.MIDTRANS_PRODUCTION || 'false') === 'true';
const BASE = PROD ? 'https://api.midtrans.com' : 'https://api.sandbox.midtrans.com';
const SNAP = PROD ? 'https://app.midtrans.com/snap/v1/transactions'
                  : 'https://app.sandbox.midtrans.com/snap/v1/transactions';
const KEY = process.env.MIDTRANS_SERVER_KEY || '';

const price = () => parseInt(process.env.PLAN_PRICE_IDR || '99000', 10);
const days = () => parseInt(process.env.PLAN_DAYS || '30', 10);

export const planInfo = () => ({
  name: process.env.PLAN_NAME || 'TAPE Alerts',
  priceIdr: price(),
  days: days(),
  configured: !!KEY && !KEY.includes('xxxx'),
  sandbox: !PROD
});

const authHeader = () => 'Basic ' + Buffer.from(KEY + ':').toString('base64');

/* Opens a Snap checkout. The customer picks the method there, so nothing has
   to be activated per channel on our side. */
export async function createPayment(user) {
  if (!planInfo().configured) throw new Error('Payments are not configured on this server yet');

  const orderId = 'tape-' + user.id + '-' + Date.now().toString(36);
  const gross = price();
  const plan = planInfo();

  const res = await fetch(SNAP, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': authHeader()
    },
    body: JSON.stringify({
      transaction_details: { order_id: orderId, gross_amount: gross },
      customer_details: { email: user.email },
      item_details: [{ id: 'tape-alerts', price: gross, quantity: 1, name: plan.name.slice(0, 50) }],
      credit_card: { secure: true }
    })
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.token) {
    const why = (json.error_messages && json.error_messages.join('; ')) || json.status_message;
    throw new Error(why || ('Midtrans rejected the request (' + res.status + ')'));
  }

  createOrder({
    orderId,
    userId: user.id,
    method: 'snap',
    amount: gross,
    days: days(),
    status: 'pending',
    raw: { token: json.token }
  });

  return {
    orderId,
    amountIdr: gross,
    days: days(),
    redirectUrl: json.redirect_url,
    token: json.token
  };
}

/* Midtrans signs every notification:
     sha512(order_id + status_code + gross_amount + server_key)
   Reject anything that does not match — otherwise anyone who finds the webhook
   URL could hand themselves a paid subscription. */
export function verifySignature(n) {
  const expected = crypto
    .createHash('sha512')
    .update(String(n.order_id) + String(n.status_code) + String(n.gross_amount) + KEY)
    .digest('hex');
  const got = String(n.signature_key || '');
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function handleNotification(n) {
  if (!verifySignature(n)) return { ok: false, reason: 'bad signature' };

  const order = findOrder(n.order_id);
  if (!order) return { ok: false, reason: 'unknown order' };

  // Amount must match what we charged, so a tampered notification for a
  // smaller sum cannot buy a full subscription.
  if (Math.round(parseFloat(n.gross_amount)) !== order.amount) {
    return { ok: false, reason: 'amount mismatch' };
  }

  const status = n.transaction_status;
  const fraud = n.fraud_status;
  const settled = (status === 'settlement' || status === 'capture') &&
                  (!fraud || fraud === 'accept');

  if (!settled) {
    order.status = status;
    save();
    return { ok: true, granted: false, status };
  }

  if (order.status === 'paid') return { ok: true, granted: false, status: 'already credited' };

  order.status = 'paid';
  order.paidAt = Date.now();
  save();
  grantAccess(order.userId, order.days);
  ledger.record({ orderId: order.orderId, userId: order.userId, email: (findUserById(order.userId) || {}).email, amount: order.amount, days: order.days, method: order.method });
  return { ok: true, granted: true, userId: order.userId };
}

/* Fallback for the impatient: ask Midtrans directly what happened to an order.
   Still server-to-server, so the client cannot fake it. */
export async function syncOrder(orderId) {
  if (!planInfo().configured) throw new Error('Payments are not configured');
  const res = await fetch(BASE + '/v2/' + encodeURIComponent(orderId) + '/status', {
    headers: { Accept: 'application/json', Authorization: authHeader() }
  });
  const n = await res.json().catch(() => ({}));
  if (!n.order_id) throw new Error('Midtrans has no record of that order yet');

  const order = findOrder(orderId);
  if (!order) throw new Error('unknown order');

  const settled = (n.transaction_status === 'settlement' || n.transaction_status === 'capture') &&
                  (!n.fraud_status || n.fraud_status === 'accept');

  if (settled && order.status !== 'paid') {
    order.status = 'paid';
    order.paidAt = Date.now();
    save();
    grantAccess(order.userId, order.days);
    ledger.record({ orderId: order.orderId, userId: order.userId, email: (findUserById(order.userId) || {}).email, amount: order.amount, days: order.days, method: order.method });
    return { granted: true, status: n.transaction_status };
  }
  return { granted: false, status: n.transaction_status };
}

export const ordersFor = (userId) => data().orders.filter((o) => o.userId === userId);
