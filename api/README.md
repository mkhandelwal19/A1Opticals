# A1 Opticals — commerce API

The server side of the store: orders, payments, refunds, returns, customer
sign-in and notifications. Node ≥ 22.5, **no npm dependencies** (`node:sqlite`,
`fetch`, `crypto`). One process, one SQLite file, and it serves the storefront
too, so `node api/server.js` is the whole platform on a laptop.

```
node api/server.js          # http://localhost:8787 — site + /api, stub gateway, log transports
node --test api/test.js     # 19 end-to-end tests against a live server on an in-memory DB
```

Or double-click `api.cmd`. `serve.cmd` still serves the pure static preview
(no API: orders simulated in the browser, as before).

## How a page knows which mode it is in

`store.js` looks for `<meta name="a1-api" content="/api">`. The API server
injects that tag into every HTML page it serves; GitHub Pages and `serve.cmd`
do not, so the same files run as the preview there. `window.A1_API` overrides
it (set it in a page, or `localStorage a1opticals_api_v1`, to point a static
deployment at an API on another origin — then also set `A1_ORIGINS`).

Every page uses the same calls (`Store.checkout`, `Store.fetchOrders`,
`Store.changeStatus`, `Store.requestReturn`, `Store.refund`, …). With an API
they are HTTP; without, they resolve from localStorage and run the same
lifecycle rules, because the rules live in one file — `commerce.js` — that the
browser and the server both load.

## Files

| | |
|---|---|
| `commerce.js` (repo root) | Status state machine, return windows and eligibility, refund maths, every customer message. Shared with the browser. |
| `api/server.js` | Entry point. |
| `api/app.js` | Config from env, routes, cookies/sessions, CORS, body limits, static files with the meta tag, background workers. |
| `api/orders.js` | Checkout, payment capture, status changes, returns, refunds, webhooks, the sweeper. The invariants are listed at the top of the file. |
| `api/engine.js` | Loads `catalog.js` + `site.js` + `store.js` in a sandbox so the **server prices every order with the storefront's own code**, with the admin's saved settings applied. |
| `api/gateway.js` | Razorpay (orders, checkout signature, refunds, webhook signature) and a stub with the same interface. |
| `api/notify.js` | Transactional outbox: email (log / Resend), WhatsApp (log / provider webhook), retries with backoff. |
| `api/auth.js` | Email-code sign-in for customers, password sign-in for the owner, hashed session tokens, rate limits. |
| `api/db.js` | Schema and the `BEGIN IMMEDIATE` transaction helper. |
| `api/test.js` | The lifecycle, end to end, over HTTP. |

## Environment

| Variable | Default | |
|---|---|---|
| `PORT` | `8787` | |
| `A1_DB` | `api/data/a1opticals.sqlite` | Ignored by git. Back it up (it is one file; `sqlite3 .backup` or copy while the app is idle). |
| `A1_SITE_URL` | `http://localhost:PORT` | Base for the links in emails (track, account). |
| `A1_STATIC` | `1` | `0` to serve only `/api` (site hosted elsewhere). |
| `A1_ORIGINS` | — | Comma list of origins allowed to call the API with cookies (only needed when the site is on another origin). |
| `A1_OWNER_EMAIL` / `A1_OWNER_PASSWORD` | `owner@a1opticals.in` / `a1trade` | **Change the password before this faces the internet.** |
| `A1_OWNER_NOTIFY_EMAIL` | `a1opticals@gmail.com` | New-order and return alerts. |
| `A1_SECRET` | random per run | Peppers OTP hashes. Set it so codes survive a restart. |
| `A1_SESSION_DAYS` | `30` | |
| `A1_PENDING_TTL_MIN` | `30` | Unpaid gateway orders are cancelled and their stock released after this. |
| `A1_SECURE_COOKIES` | `0` | `1` behind HTTPS (also auto when `X-Forwarded-Proto: https`). |
| `A1_DEV_OTP` | `1` | Return the sign-in code in the API response when email is on the `log` transport. **Set `0` in production.** |
| `GATEWAY` | `stub` | `razorpay` with `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`. |
| `EMAIL_TRANSPORT` | `log` | `resend` with `RESEND_API_KEY` and `MAIL_FROM`. |
| `WHATSAPP_WEBHOOK_URL` / `WHATSAPP_TOKEN` | — | POSTs `{ to, text, template }`; adapt to the chosen provider (Interakt, Gupshup, AiSensy) in `notify.js`. |

## Endpoints

All JSON under `/api`. Mutating requests must send `Content-Type: application/json`
(that, plus `SameSite=Lax` cookies, is the CSRF defence).

```
GET  /health
POST /auth/otp {email} · POST /auth/verify {email,code} · POST /auth/logout · GET /auth/me
POST /auth/owner {email,password} · POST /auth/owner/logout

POST /commerce/order        Idempotency-Key header   → { order, gateway? }
POST /commerce/verify       { razorpay_order_id, razorpay_payment_id, razorpay_signature }
POST /commerce/abandon      { orderId, key }
POST /stub/pay              { orderId, outcome:'success'|'fail' }   stub gateway only
POST /webhooks/razorpay     raw body · X-Razorpay-Signature · X-Razorpay-Event-Id

GET  /orders/:ref?phone=    guest tracking (phone must match); owner and the order's customer need no phone
GET  /me/orders · GET /me/orders/:id · POST /me/orders/:id/returns { items:[{idx,qty}], reason, method }

GET  /admin/orders?status=&q=&pending=1 · GET /admin/orders/:id
PATCH /admin/orders/:id/status   { status, version, note }        409 with the current order on a stale version
POST /admin/orders/:id/paid      { version, reference }           bank transfer arrived
POST /admin/orders/:id/refunds   { amount, reason, manual?, reference?, returnId? }
POST /admin/refunds/:id/reconcile
GET  /admin/returns?status= · POST /admin/returns/:id { action: approve|reject|received|cancel, note, refund? }
GET  /admin/notifications?orderId=&status= · POST /admin/notifications/:id/retry
GET  /admin/attention · GET /admin/settings · PUT /admin/settings/:key { value } · GET /admin/stock/:sku
```

## The order lifecycle

```
pending payment ──(capture)──► confirmed ─► in lab ─► packed ─► shipped ──────► delivered
      │                            │                     │      └► ready to collect ─┘
      └─(fail/expire/abandon)──► cancelled ◄─────────────┴──────────────────────────────
                                                     awaiting prescription ─► confirmed / in lab / packed
```

* Offline methods (bank transfer, pay on delivery, pay in store, credit account)
  skip `pending payment`: the order is confirmed at once and stock is committed,
  because the goods go out before the money arrives. The owner marks the
  transfer received from the dashboard.
* `delivered` and `cancelled` are terminal. What happens after delivery is a
  **return request** with its own states (`requested → approved → received →
  refunded`, or `rejected`), never a rewrite of the order.
* A status change queues the customer's message in the same transaction:
  `shipped`, `ready to collect`, `delivered`, `cancelled`, `awaiting prescription`.
* **Registered vs guest.** An order placed while signed in, or with "keep an
  account" ticked, is linked to a customer (`registered = 1`). Its delivered
  email says *sign in and choose Return or refund*; the account page shows the
  button while the window is open. A guest order's delivered email says *email
  refund@a1opticals.com quoting the reference*, and nothing online can return
  it — the owner records that refund from the order's Refund button. An account
  created later with the same email does **not** adopt earlier guest orders
  (`orders.js` → `listOrders`; flip that if the client prefers).
* Windows come from the admin (Stores & delivery → Returns & refunds): 14 days
  retail, 7 trade, from `delivered_at`.

## Refunds

* **Gateway payments** (UPI, card): `POST /admin/orders/:id/refunds` or a return
  reaching `received`. The refund row is written (`pending`) and counted against
  the balance **before** Razorpay is called; the call carries our refund id in
  `receipt` and `notes.refund_id`. Razorpay answers `pending`/`processed`; the
  `refund.processed` webhook (or `reconcile`) settles it, the order's
  `pay_status` becomes `partially refunded`/`refunded`, the customer gets
  *Refund of ₹… sent*.
* **Offline payments**: a bank transfer the owner makes; the dashboard records it
  with its UTR (`manual: true`). Never sent to the gateway.
* **Ambiguity is never retried blind.** If the gateway times out, the row stays
  `pending` with `error = unconfirmed…`, still counted against the balance, and
  appears under *Needs attention → Money to sort out*. *Reconcile* fetches the
  payment's refunds from Razorpay and matches by our id: found → settle; not
  found → mark `failed`, balance freed, safe to try again.
* Cap: `total − Σ non-failed refunds`. Enforced inside the write lock, so two
  owners clicking at once cannot exceed it (tested).

## Architecture review — what was fragile, what holds now

The preview kept everything in localStorage and simulated the gateway. Moving
to a real server surfaced these; each is now handled and covered by
`api/test.js`.

| Concern | Before | Now |
|---|---|---|
| **Order ids** | `A1-YYMMDD-` + 4 random digits: two orders in a day collide with probability ≈ n²/18,000 — a coin flip by the 100th order. | Every order has a UUID v4 primary key. The human reference is `A1-YYMMDD-NNNN` from a per-day counter row incremented inside the order's transaction, with a UNIQUE index as the backstop. The preview uses a checked counter too. |
| **Double checkout** | A double click or a retried request placed two orders. | `Idempotency-Key` per checkout (UUID, kept in `sessionStorage`, rotated when the bag or details change). The key row is inserted as `in-progress` in the same transaction that creates the order, before the gateway call; a concurrent duplicate gets 409, a later one gets the same response. Different body on the same key → 422. |
| **Amount** | The browser computed the total. | The server prices from its own catalogue and settings (the same code, in a sandbox). The Razorpay order is created with the server's amount; the browser only shows it. |
| **Stock** | Checked in the browser only. | Reserved at order creation with `UPDATE … WHERE on_hand − reserved ≥ qty` (0 rows → 409, transaction rolled back), committed on capture, released on failure/abandon/expiry, restocked on cancellation after commit and on return receipt. Simultaneous checkouts for the last unit: one wins (tested). |
| **Payment success** | Asserted by the page. | `/verify` checks the HMAC with the key secret (`timingSafeEqual`); Razorpay's webhook is verified with the webhook secret and deduplicated by event id (`INSERT OR IGNORE` on the primary key). Both paths call `markPaid`, whose update is `WHERE pay_status IN ('pending','failed')` — the second arrival changes nothing. A second *distinct* capture for one order is recorded as a double capture and surfaced for refund. |
| **Abandoned checkouts** | Nothing. | Closing the checkout releases the stock; the sweeper cancels anything still pending after 30 min. A capture that lands after cancellation is kept `paid` on a `cancelled` order and listed under *Money to sort out* — money is never silently dropped. |
| **Concurrent status edits** | Last write wins. | Optimistic lock: `version` must match; `UPDATE … WHERE version = ?`; 409 returns the current row and the dashboard refreshes. Transitions are validated against the state machine (422 otherwise), and the dashboard only offers legal next states. |
| **Notifications** | Hard-coded "sent" labels. | Transactional outbox: the row is inserted inside the change's transaction with a dedupe key (`order:template:version`), delivered by a worker with backoff, visible with status on the order page and in the dashboard, re-sendable. |
| **Refund races** | — | Write-ahead refund row inside the write lock; balance check in the same transaction; gateway call outside the lock; ambiguous outcomes reconciled, never retried blind. |
| **Sessions** | None. | Random 32-byte tokens stored as SHA-256, HttpOnly + SameSite=Lax cookies, separate owner cookie, OTP hashed with a pepper, 10-minute expiry, 5 attempts, per-email and per-IP rate limits. |

**Why SQLite is safe here, and when it stops being.** `node:sqlite` is
synchronous and Node is single-threaded, so a transaction cannot be interleaved
with another request — and `BEGIN IMMEDIATE` takes the write lock up front so
there is no upgrade deadlock. That gives serialisable writes for free, which is
the property everything above relies on. The cost is **one process**: run one
instance (Cloud Run `--max-instances=1`, or a VM). At A1's volume (hundreds of
orders a month) that is far more than enough. When the day comes for two
instances, the schema and SQL move to Postgres with `SELECT … FOR UPDATE` in
`reserveStock`/`changeStatus`/`createRefund` and the in-memory rate limiter
moves to a table — the logic does not change.

**What lives only in the browser, still.** Product, price and site edits are
saved in the admin's browser and mirrored to the server (`PUT /admin/settings`),
so the server prices with them; but another browser viewing the storefront
still sees the static seed until the catalogue becomes API-served (Launch
scope). Reservations and eye-test bookings are also still browser-local.

## Before it takes real money

1. `GATEWAY=razorpay` with test keys; in the Razorpay dashboard add the webhook
   `https://<host>/api/webhooks/razorpay` for `payment.captured`,
   `payment.failed`, `order.paid`, `refund.processed`, `refund.failed`, with a
   secret in `RAZORPAY_WEBHOOK_SECRET`. Walk a test card through; check
   `webhook_events`.
2. `EMAIL_TRANSPORT=resend`, a verified sending domain, `MAIL_FROM`. The
   `refund@a1opticals.com` mailbox in the policy must exist and be read.
3. `A1_DEV_OTP=0`, a real `A1_OWNER_PASSWORD`, an `A1_SECRET`, HTTPS in front
   (`A1_SECURE_COOKIES=1`), `A1_SITE_URL` set to the public origin.
4. Back up `api/data/` daily. It is the ledger.
5. WhatsApp: pick the provider and adapt `notify.js`'s webhook transport to its
   template API; until then WhatsApp rows are logged, not sent (the dashboard
   shows them as sent by the log transport — switch it on knowingly).
