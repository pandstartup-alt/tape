# TAPE — server

Live BTC order flow with a paywall that actually holds, a broadcast news
channel, admin-only signals, and QRIS / BCA payments through Midtrans.

**Two sites, one server**

| URL | Who | What |
|---|---|---|
| `/` | anyone | Free: live flow bar, bullish/bearish, TradingView chart, news channel. Paid: every size alert. |
| `/admin` | you only | Publish signals, broadcast news notes, see members, payments and revenue. |

---

## Why the paywall can't be bypassed

The browser never connects to Binance. **This server** holds the single upstream
connection, and fans out two different things:

- **every visitor** gets aggregate percentages — buy %, sell %, price, trade count
- **paid sessions only** get `alert` events with the individual large trades

A free user has no raw trade data in the page, so there is nothing to unlock in
DevTools. Entitlement is checked per socket, server-side, on every alert.

Access is granted **only** by a signature-verified Midtrans webhook. The browser
saying "I paid" is never trusted.

---

## Setup

You need Node 18 or newer (`node --version`). Nothing here compiles native code.

```bash
cd tape-server
npm install
cp .env.example .env      # Windows: copy .env.example .env
```

Now edit `.env`:

1. **`JWT_SECRET`** — generate a real one:
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```
2. **`ADMIN_EMAIL`** — the address you will sign in with.
3. **`MIDTRANS_SERVER_KEY`** — from dashboard.midtrans.com → Settings → Access
   Keys. Start with the **sandbox** key and leave `MIDTRANS_PRODUCTION=false`.
4. **`PLAN_PRICE_IDR`** — what you charge. Whole rupiah, no decimals.

Start it:

```bash
npm start
```

Then:

1. Open `http://localhost:8080`, go to **ACCOUNT**, register with your
   `ADMIN_EMAIL` address.
2. Restart the server once — it promotes that account to admin on boot.
3. Open `http://localhost:8080/admin` and sign in.

---

## Turning payments on

1. Deploy somewhere with a public HTTPS URL (see below) and set `PUBLIC_URL`.
2. In the Midtrans dashboard → Settings → Configuration, set
   **Payment Notification URL** to:
   ```
   https://your-domain.com/api/payments/webhook
   ```
3. Enable QRIS and BCA Virtual Account as payment methods.
4. Test a sandbox payment end to end. Watch the server log — you want to see
   `[pay] access granted to …`. The user's alerts switch on immediately, with
   no reload, because the server pushes a new entitlement down their socket.
5. Only then swap in the production server key and set
   `MIDTRANS_PRODUCTION=true`.

If a webhook is ever missed, the **I HAVE PAID — CHECK** button asks Midtrans
directly, server to server. The client still cannot grant itself anything.

---

## Deploying

The server must run continuously and hold a WebSocket, so static hosts like
GitHub Pages and Netlify will not work. Any of these will:

- **Railway / Render / Fly.io** — connect the repo, set the env vars, deploy.
  Attach a persistent volume mounted at `/app/data` or the JSON store is wiped
  on redeploy.
- **A small VPS** — `npm install`, then run it under `pm2` or a systemd unit,
  with Caddy or nginx in front for HTTPS.

HTTPS is required in production: browsers block notifications and mixed content
on plain HTTP, and Midtrans will not send webhooks to an insecure URL.

---

## Data

Everything lives in `data/db.json`, written atomically. Back it up — it holds
your members and their paid-until dates.

That file is deliberately the only storage layer. When you outgrow it, replace
`src/store.js` with Postgres queries and nothing else has to change.

---

## What is NOT done

Be aware of these before taking real money:

- **No email.** No verification, no password reset. If a member forgets their
  password you must fix it by hand.
- **No refunds flow.** Refund in the Midtrans dashboard, then adjust the member
  in the admin panel.
- **Chat is unmoderated** beyond a 500-character cap. There is no block or mute.
- **No rate limiting** on login. Worth adding before you get real traffic.
- **The news scoring is keyword rules, not AI.** It matches topic words and
  counts bullish/bearish words. It has no understanding of what it reads.

---

## Layout

```
src/server.js     express + websockets, all routes, entitlement fan-out
src/market.js     the single Binance connection, tiers, rolling flow
src/payments.js   Midtrans charge, signature verification, webhook
src/auth.js       register/login, JWT, role guards
src/store.js      JSON persistence — swap this one file for a real database
public/index.html public site
public/admin.html admin console
```
