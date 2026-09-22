/* =============================================================================
   api/test.js — the order lifecycle, end to end, against the real server
   -----------------------------------------------------------------------------
     node --test api/test.js

   In-memory database, stub gateway, log transports. Every test talks HTTP
   to a listening server, the way the browser does, so what is tested is the
   whole thing: routing, cookies, idempotency keys, signatures, webhooks.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./app.js');
const Commerce = require('../commerce.js');

let app, base, cookieJar = {};

async function api(method, p, body, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  const jar = opts.jar || 'anon';
  if (cookieJar[jar]) headers.Cookie = cookieJar[jar];
  const res = await fetch(base + p, { method, headers, body: body == null ? undefined : (opts.raw ? body : JSON.stringify(body)) });
  const setc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (setc.length) {
    const cur = {};
    (cookieJar[jar] || '').split('; ').filter(Boolean).forEach((c) => { const i = c.indexOf('='); cur[c.slice(0, i)] = c.slice(i + 1); });
    setc.forEach((c) => { const kv = c.split(';')[0]; const i = kv.indexOf('='); const v = kv.slice(i + 1); if (v) cur[kv.slice(0, i)] = v; else delete cur[kv.slice(0, i)]; });
    cookieJar[jar] = Object.keys(cur).map((k) => k + '=' + cur[k]).join('; ');
  }
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = () => 'chk_' + Math.random().toString(36).slice(2) + Date.now();

const FRAME = 'A1-FR-2105';
function bag(overrides) {
  return Object.assign({
    items: [{ sku: FRAME, variant: '51', lens: 'sv', qty: 1 }],
    mode: 'retail', method: 'UPI', register: false,
    customer: { name: 'Asha Verma', phone: '98765 43210', email: 'asha@example.com', address: '12, Sector 16-D, near the park', city: 'Chandigarh', pin: '160015', slot: 'Today, by 7 pm' },
    delivery: { method: 'van' },
    rx: { method: 'typed', od: { sph: '-2.25' }, os: { sph: '-1.75' }, pd: { on: false } }
  }, overrides || {});
}
async function owner() {
  const r = await api('POST', '/api/auth/owner', { email: 'owner@a1opticals.in', password: 'a1trade' }, { jar: 'owner' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
}
async function signIn(email, jar) {
  const r = await api('POST', '/api/auth/otp', { email }, { jar });
  assert.equal(r.status, 200); assert.ok(r.json.devCode, 'dev code returned');
  const v = await api('POST', '/api/auth/verify', { email, code: r.json.devCode }, { jar });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  return v.json.customer;
}
/* Walk a gateway checkout through the stub: order → pay → verify. */
async function payOrder(body, opts = {}) {
  const k = opts.key || key();
  const c = await api('POST', '/api/commerce/order', body, { headers: { 'Idempotency-Key': k }, jar: opts.jar });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.ok(c.json.gateway && c.json.gateway.orderId, 'gateway order created');
  const p = await api('POST', '/api/stub/pay', { orderId: c.json.gateway.orderId, outcome: opts.outcome || 'success' });
  assert.equal(p.status, 200);
  const v = await api('POST', '/api/commerce/verify', p.json);
  return { created: c.json, paid: p.json, verify: v, key: k };
}
async function deliver(orderId, jar) {
  let o = (await api('GET', '/api/admin/orders/' + orderId, null, { jar: jar || 'owner' })).json.order;
  for (const s of ['packed', 'shipped', 'delivered']) {
    const r = await api('PATCH', '/api/admin/orders/' + orderId + '/status', { status: s, version: o.version }, { jar: jar || 'owner' });
    assert.equal(r.status, 200, s + ': ' + JSON.stringify(r.json));
    o = r.json.order;
  }
  return o;
}

test.before(async () => {
  app = createApp({ db: ':memory:', quiet: true, outboxIntervalMs: 50, sweepIntervalMs: 60000, pendingTtlMin: 30, gateway: { mode: 'stub', webhookDelayMs: 0 }, ownerNotifyEmail: 'owner-alerts@example.com', siteUrl: 'https://a1opticals.test' });
  const port = await app.listen(0);
  base = 'http://127.0.0.1:' + port;
  await owner();
});
test.after(async () => { await app.close(); });

test('health and static site with the API tag injected', async () => {
  const h = await api('GET', '/api/health');
  assert.equal(h.status, 200); assert.equal(h.json.stub, true);
  const page = await fetch(base + '/checkout.html');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<meta name="a1-api" content="\/api">/);
  assert.equal((await fetch(base + '/api/data/x.sqlite')).status, 404);
  assert.equal((await fetch(base + '/contract/')).status, 404);
});

test('checkout: server prices the bag, reserves stock, creates a gateway order; the browser cannot set the amount', async () => {
  const before = app.orders.stockOf(FRAME);
  const body = bag(); body.total = 1; body.items[0].price = 1;
  const r = await api('POST', '/api/commerce/order', body, { headers: { 'Idempotency-Key': key() } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const o = r.json.order;
  assert.equal(o.status, Commerce.PENDING);
  assert.match(o.ref, /^A1-\d{6}-\d{4}$/);
  assert.ok(o.total > 100000, 'priced by the server: ' + o.total);
  assert.equal(r.json.gateway.amount, o.total);
  assert.equal(app.orders.stockOf(FRAME).reserved, before.reserved + 1);
  assert.equal(o.items[0].cat, 'frames');
});

test('checkout is idempotent: the same key twice is one order; a different bag on the same key is refused', async () => {
  const k = key();
  const a = await api('POST', '/api/commerce/order', bag(), { headers: { 'Idempotency-Key': k } });
  const b = await api('POST', '/api/commerce/order', bag(), { headers: { 'Idempotency-Key': k } });
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(a.json.order.id, b.json.order.id);
  assert.equal(a.json.gateway.orderId, b.json.gateway.orderId);
  const c = await api('POST', '/api/commerce/order', bag({ items: [{ sku: FRAME, variant: '51', lens: 'sv', qty: 2 }] }), { headers: { 'Idempotency-Key': k } });
  assert.equal(c.status, 422); assert.equal(c.json.error, 'idempotency-mismatch');
  const d = await api('POST', '/api/commerce/order', bag());
  assert.equal(d.status, 400);
});

test('concurrent duplicate submits with one key produce one order', async () => {
  const k = key();
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => api('POST', '/api/commerce/order', bag(), { headers: { 'Idempotency-Key': k } })));
  const ok = rs.filter((r) => r.status === 200), busy = rs.filter((r) => r.status === 409);
  assert.equal(ok.length + busy.length, 5);
  const ids = new Set(ok.map((r) => r.json.order.id));
  assert.equal(ids.size, 1, 'exactly one order id across all replies');
  assert.equal(app.db.get(`SELECT COUNT(*) AS n FROM idempotency WHERE key = ?`, k).n, 1);
});

test('stock: the last unit goes to one of two simultaneous checkouts, the other gets 409', async () => {
  const sku = 'A1-FR-2102';
  app.db.run(`UPDATE stock SET on_hand = reserved + 1 WHERE sku = ?`, sku);
  const body = () => bag({ items: [{ sku, variant: '52', lens: 'sv', qty: 1 }] });
  const [a, b] = await Promise.all([api('POST', '/api/commerce/order', body(), { headers: { 'Idempotency-Key': key() } }), api('POST', '/api/commerce/order', body(), { headers: { 'Idempotency-Key': key() } })]);
  const codes = [a.status, b.status].sort();
  assert.deepEqual(codes, [200, 409]);
  const lost = a.status === 409 ? a : b;
  assert.equal(lost.json.error, 'out-of-stock');
  assert.equal(app.orders.stockOf(sku).available, 0);
  /* abandoning the winner gives the unit back */
  const won = a.status === 200 ? a : b;
  const ab = await api('POST', '/api/commerce/abandon', { orderId: won.json.order.id, key: 'wrong' });
  assert.equal(ab.status, 403);
});

test('payment: verify marks paid once; a second verify and the webhook replay change nothing; a forged signature is refused', async () => {
  const before = app.orders.stockOf(FRAME);
  const { created, paid, verify } = await payOrder(bag());
  assert.equal(verify.status, 200, JSON.stringify(verify.json));
  assert.equal(verify.json.verified, true);
  const o = verify.json.order;
  assert.equal(o.status, 'confirmed');
  assert.equal(o.payment.status, 'paid');
  assert.equal(o.payment.paymentId, paid.razorpay_payment_id);
  const after = app.orders.stockOf(FRAME);
  assert.equal(after.on_hand, before.on_hand - 1, 'stock committed once');
  assert.equal(after.reserved, before.reserved, 'reservation released on commit');

  const again = await api('POST', '/api/commerce/verify', paid);
  assert.equal(again.status, 200); assert.equal(again.json.order.version, o.version, 'idempotent verify');
  assert.equal(app.orders.stockOf(FRAME).on_hand, before.on_hand - 1, 'still committed once');

  const forged = await api('POST', '/api/commerce/verify', Object.assign({}, paid, { razorpay_signature: 'deadbeef' }));
  assert.equal(forged.status, 400); assert.equal(forged.json.error, 'bad-signature');

  await sleep(30); // the stub's payment.captured webhook has landed by now
  const evts = app.db.all(`SELECT * FROM webhook_events WHERE type = 'payment.captured'`);
  assert.ok(evts.length >= 1);
  const evt = evts[evts.length - 1];
  const sig = app.gateway.verifyWebhook ? require('./gateway.js').hmac(app.gateway.webhookSecret, evt.payload_json) : '';
  const replay = await api('POST', '/api/webhooks/razorpay', evt.payload_json, { raw: true, headers: { 'X-Razorpay-Signature': sig, 'X-Razorpay-Event-Id': evt.event_id, 'Content-Type': 'application/json' } });
  assert.equal(replay.status, 200); assert.equal(replay.json.duplicate, true);
  const bad = await api('POST', '/api/webhooks/razorpay', evt.payload_json, { raw: true, headers: { 'X-Razorpay-Signature': 'nope', 'X-Razorpay-Event-Id': 'evt_new', 'Content-Type': 'application/json' } });
  assert.equal(bad.status, 400);
  assert.equal(app.db.get(`SELECT COUNT(*) AS n FROM order_events WHERE order_id = ? AND note LIKE '%captured'`, o.id).n, 1, 'one capture event');

  /* the confirmation went to the customer and the owner, once each */
  await sleep(120);
  const n = app.db.all(`SELECT template, channel, recipient, status FROM notifications WHERE order_id = ? ORDER BY template, channel`, o.id);
  assert.deepEqual(n.map((x) => x.template + '/' + x.channel), ['order_confirmed/email', 'order_confirmed/whatsapp', 'owner_new_order/email']);
  assert.ok(n.every((x) => x.status === 'sent'), 'outbox delivered: ' + JSON.stringify(n));
  assert.equal(created.order.id, o.id);
});

test('a failed payment leaves the order pending; the sweeper cancels it and releases stock; a late capture is flagged', async () => {
  const before = app.orders.stockOf(FRAME);
  const c = await api('POST', '/api/commerce/order', bag(), { headers: { 'Idempotency-Key': key() } });
  const p = await api('POST', '/api/stub/pay', { orderId: c.json.gateway.orderId, outcome: 'fail' });
  const v = await api('POST', '/api/commerce/verify', p.json);
  assert.equal(v.status, 400);
  await sleep(20);
  let row = app.db.get(`SELECT * FROM orders WHERE id = ?`, c.json.order.id);
  assert.equal(row.status, Commerce.PENDING); assert.equal(row.pay_status, 'failed');
  app.db.run(`UPDATE orders SET placed_at = ? WHERE id = ?`, new Date(Date.now() - 31 * 60000).toISOString(), row.id);
  assert.equal(app.orders.expirePending(), 1);
  row = app.db.get(`SELECT * FROM orders WHERE id = ?`, row.id);
  assert.equal(row.status, 'cancelled'); assert.equal(row.stock_state, 'released');
  assert.equal(app.orders.stockOf(FRAME).reserved, before.reserved);
  /* the same checkout key after expiry starts a fresh order, not the dead one */
  const k2 = key();
  const first = await api('POST', '/api/commerce/order', bag(), { headers: { 'Idempotency-Key': k2 } });
  app.db.run(`UPDATE orders SET placed_at = ? WHERE id = ?`, new Date(Date.now() - 31 * 60000).toISOString(), first.json.order.id);
  assert.equal(app.orders.expirePending(), 1);
  const second = await api('POST', '/api/commerce/order', bag(), { headers: { 'Idempotency-Key': k2 } });
  assert.equal(second.status, 200);
  assert.notEqual(second.json.order.id, first.json.order.id, 'a replay after expiry is a new order');
  assert.equal(app.orders.stockOf(FRAME).reserved, before.reserved + 1, 'only the new order holds stock');
  await api('POST', '/api/commerce/abandon', { orderId: second.json.order.id, key: k2 });
  assert.equal(app.orders.stockOf(FRAME).reserved, before.reserved, 'abandon released it');
  /* the bank was slow: a capture arrives for the cancelled order */
  const late = await api('POST', '/api/stub/pay', { orderId: c.json.gateway.orderId, outcome: 'success' });
  await api('POST', '/api/commerce/verify', late.json);
  row = app.db.get(`SELECT * FROM orders WHERE id = ?`, row.id);
  assert.equal(row.status, 'cancelled'); assert.equal(row.pay_status, 'paid');
  assert.equal(app.orders.stockOf(FRAME).on_hand, before.on_hand, 'no stock movement for a cancelled order');
  const att = (await api('GET', '/api/admin/attention', null, { jar: 'owner' })).json;
  assert.ok(att.paidButCancelled.some((o) => o.id === row.id), 'shows up for the owner to refund');
});

test('offline methods: bank transfer confirms immediately, stock committed, then marked paid by the owner', async () => {
  const c = await api('POST', '/api/commerce/order', bag({ method: 'Bank transfer' }), { headers: { 'Idempotency-Key': key() } });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.equal(c.json.gateway, null);
  const o = c.json.order;
  assert.equal(o.status, 'confirmed'); assert.equal(o.payment.status, 'awaiting transfer');
  assert.equal(app.db.get(`SELECT stock_state FROM orders WHERE id = ?`, o.id).stock_state, 'committed');
  const paid = await api('POST', '/api/admin/orders/' + o.id + '/paid', { version: o.version, reference: 'NEFT 12345' }, { jar: 'owner' });
  assert.equal(paid.status, 200); assert.equal(paid.json.order.payment.status, 'paid');
  const bad = await api('POST', '/api/commerce/order', bag({ method: 'Cash on delivery', delivery: { method: 'collect' } }), { headers: { 'Idempotency-Key': key() } });
  assert.equal(bad.status, 422);
});

test('status: valid transitions only, stale versions get 409, and shipped/delivered queue the customer notifications', async () => {
  const { verify } = await payOrder(bag());
  let o = verify.json.order;
  const back = await api('PATCH', '/api/admin/orders/' + o.id + '/status', { status: 'delivered', version: o.version + 5 }, { jar: 'owner' });
  assert.equal(back.status, 409); assert.equal(back.json.data.order.version, o.version);
  const noauth = await api('PATCH', '/api/admin/orders/' + o.id + '/status', { status: 'shipped', version: o.version });
  assert.equal(noauth.status, 401);

  const s1 = await api('PATCH', '/api/admin/orders/' + o.id + '/status', { status: 'shipped', version: o.version }, { jar: 'owner' });
  assert.equal(s1.status, 200); o = s1.json.order; assert.equal(o.status, 'shipped');
  /* two staff, same stale version: one wins */
  const [x, y] = await Promise.all([
    api('PATCH', '/api/admin/orders/' + o.id + '/status', { status: 'delivered', version: o.version }, { jar: 'owner' }),
    api('PATCH', '/api/admin/orders/' + o.id + '/status', { status: 'cancelled', version: o.version }, { jar: 'owner' })
  ]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  o = (x.status === 200 ? x : y).json.order;
  const bad = await api('PATCH', '/api/admin/orders/' + o.id + '/status', { status: 'shipped', version: o.version }, { jar: 'owner' });
  assert.equal(bad.status, 422); assert.equal(bad.json.error, 'bad-transition');

  await sleep(150);
  const n = app.db.all(`SELECT template, channel, body FROM notifications WHERE order_id = ? AND template IN ('order_shipped','order_delivered','order_cancelled') ORDER BY created_at`, o.id);
  const templates = n.map((x) => x.template + '/' + x.channel);
  assert.ok(templates.includes('order_shipped/email') && templates.includes('order_shipped/whatsapp'));
  const final = o.status === 'delivered' ? 'order_delivered' : 'order_cancelled';
  assert.ok(templates.includes(final + '/email'), templates.join());
  assert.ok(!templates.includes((o.status === 'delivered' ? 'order_cancelled' : 'order_delivered') + '/email'), 'the loser sent nothing');
  if (final === 'order_delivered') {
    const body = n.find((x) => x.template === 'order_delivered' && x.channel === 'email').body;
    assert.match(body, /refund@a1opticals\.com/, 'guest order points at the refunds mailbox');
    assert.match(body, new RegExp(o.ref.replace(/-/g, '\\-')));
    assert.doesNotMatch(body, /account\.html/);
  }
});

test('guest orders cannot be returned online; the delivered email says to write to refund@', async () => {
  const { verify } = await payOrder(bag({ customer: Object.assign(bag().customer, { email: 'guest@example.com' }) }));
  const o = await deliver(verify.json.order.id);
  assert.equal(o.registered, false);
  assert.equal(o.returnEligibility.ok, false); assert.equal(o.returnEligibility.reason, 'guest');
  const me = await signIn('guest@example.com', 'guest');
  assert.ok(me.id);
  const mine = await api('GET', '/api/me/orders', null, { jar: 'guest' });
  assert.equal(mine.json.orders.length, 0, 'a later account does not adopt guest orders');
  const r = await api('POST', '/api/me/orders/' + o.id + '/returns', { items: [{ idx: 0, qty: 1 }], reason: 'x' }, { jar: 'guest' });
  assert.equal(r.status, 404);
  await sleep(100);
  const mail = app.db.get(`SELECT body FROM notifications WHERE order_id = ? AND template = 'order_delivered' AND channel = 'email'`, o.id);
  assert.match(mail.body, /placed as a guest/); assert.match(mail.body, /refund@a1opticals\.com/);
});

test('registered customer: return → approve → received → refund via the gateway → webhook → refunded; over-refund refused', async () => {
  const email = 'priya@example.com';
  const { verify } = await payOrder(bag({ register: true, items: [{ sku: FRAME, variant: '51', lens: 'sv', qty: 2 }], customer: Object.assign(bag().customer, { email, name: 'Priya Nair' }) }));
  let o = verify.json.order;
  assert.equal(o.registered, true);
  assert.equal(o.discount, o.items[0].unit, 'BOGO applied by the server engine');
  o = await deliver(o.id);
  await sleep(100);
  const mail = app.db.get(`SELECT body FROM notifications WHERE order_id = ? AND template = 'order_delivered' AND channel = 'email'`, o.id);
  assert.match(mail.body, /account\.html/); assert.doesNotMatch(mail.body, /placed as a guest/);

  await signIn(email, 'priya');
  const mine = await api('GET', '/api/me/orders', null, { jar: 'priya' });
  assert.equal(mine.json.orders.length, 1);
  assert.equal(mine.json.orders[0].returnEligibility.ok, true);

  const tooMany = await api('POST', '/api/me/orders/' + o.id + '/returns', { items: [{ idx: 0, qty: 3 }], reason: 'x' }, { jar: 'priya' });
  assert.equal(tooMany.status, 422);
  const r = await api('POST', '/api/me/orders/' + o.id + '/returns', { items: [{ idx: 0, qty: 1 }], reason: 'Frame too wide', method: 'collect' }, { jar: 'priya' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const ret = r.json.return;
  assert.equal(ret.status, 'requested');
  assert.equal(ret.amount, Math.round(o.items[0].net / 2), 'half of a BOGO line: ' + ret.amount);
  const dup = await api('POST', '/api/me/orders/' + o.id + '/returns', { items: [{ idx: 0, qty: 1 }], reason: 'again' }, { jar: 'priya' });
  assert.equal(dup.status, 422); assert.equal(dup.json.data.reason, 'open-return');

  const stockBefore = app.orders.stockOf(FRAME).on_hand;
  const ap = await api('POST', '/api/admin/returns/' + ret.id, { action: 'approve', note: 'Van collects Tuesday' }, { jar: 'owner' });
  assert.equal(ap.status, 200); assert.equal(ap.json.ret.status, 'approved');
  const rc = await api('POST', '/api/admin/returns/' + ret.id, { action: 'received' }, { jar: 'owner' });
  assert.equal(rc.status, 200, JSON.stringify(rc.json));
  assert.equal(app.orders.stockOf(FRAME).on_hand, stockBefore + 1, 'restocked');
  assert.ok(rc.json.refund, 'refund created: ' + JSON.stringify(rc.json));
  assert.equal(rc.json.refund.channel, 'gateway');
  await sleep(50); // the stub's refund.processed webhook
  const orderNow = (await api('GET', '/api/admin/orders/' + o.id, null, { jar: 'owner' })).json.order;
  assert.equal(orderNow.refunds.length, 1);
  assert.equal(orderNow.refunds[0].status, 'processed');
  assert.equal(orderNow.returns[0].status, 'refunded');
  assert.equal(orderNow.payment.status, 'partially refunded');
  assert.equal(orderNow.refundable, o.total - ret.amount);
  const g = app.gateway._refunds.get(orderNow.refunds[0].gatewayRefundId);
  assert.equal(g.notes.refund_id, orderNow.refunds[0].id, 'our id travels in the gateway notes');

  const over = await api('POST', '/api/admin/orders/' + o.id + '/refunds', { amount: orderNow.refundable + 1, reason: 'oops' }, { jar: 'owner' });
  assert.equal(over.status, 422); assert.equal(over.json.error, 'over-refund');
  const rest = await api('POST', '/api/admin/orders/' + o.id + '/refunds', { amount: orderNow.refundable, reason: 'goodwill' }, { jar: 'owner' });
  assert.equal(rest.status, 200, JSON.stringify(rest.json));
  await sleep(50);
  const done = (await api('GET', '/api/admin/orders/' + o.id, null, { jar: 'owner' })).json.order;
  assert.equal(done.payment.status, 'refunded'); assert.equal(done.refundable, 0);
  const none = await api('POST', '/api/admin/orders/' + o.id + '/refunds', { amount: 100, reason: 'more' }, { jar: 'owner' });
  assert.equal(none.status, 422);
  await sleep(120);
  const sent = app.db.all(`SELECT template FROM notifications WHERE order_id = ? AND template LIKE 'return_%' OR (order_id = ? AND template = 'refund_processed') ORDER BY created_at`, o.id, o.id).map((x) => x.template);
  assert.deepEqual(sent.filter((t, i) => sent.indexOf(t) === i), ['return_requested', 'owner_return_requested', 'return_approved', 'return_received', 'refund_processed'].filter((t) => sent.includes(t)));
  assert.ok(sent.includes('refund_processed'));
});

test('two owners refunding at once cannot exceed the balance', async () => {
  const { verify } = await payOrder(bag());
  const o = verify.json.order;
  const half = Math.floor(o.total / 2) + 1;
  const rs = await Promise.all([1, 2, 3].map(() => api('POST', '/api/admin/orders/' + o.id + '/refunds', { amount: half, reason: 'race' }, { jar: 'owner' })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 422, 422]);
  await sleep(50);
  const now = (await api('GET', '/api/admin/orders/' + o.id, null, { jar: 'owner' })).json.order;
  assert.equal(Commerce.refundedSoFar(now), half);
});

test('a refund the gateway refuses is marked failed and frees the balance; an unconfirmed one is reconciled before retry', async () => {
  const { verify } = await payOrder(bag());
  const o = verify.json.order;
  app.gateway.failNext('createRefund');
  const f = await api('POST', '/api/admin/orders/' + o.id + '/refunds', { amount: 10000, reason: 'will fail' }, { jar: 'owner' });
  assert.equal(f.status, 422);
  let cur = (await api('GET', '/api/admin/orders/' + o.id, null, { jar: 'owner' })).json.order;
  assert.equal(cur.refunds[0].status, 'failed'); assert.equal(cur.refundable, o.total); assert.equal(cur.payment.status, 'paid');

  app.gateway.failNext('createRefund:ambiguous');
  const a = await api('POST', '/api/admin/orders/' + o.id + '/refunds', { amount: 10000, reason: 'timeout' }, { jar: 'owner' });
  assert.equal(a.status, 502);
  cur = (await api('GET', '/api/admin/orders/' + o.id, null, { jar: 'owner' })).json.order;
  const pending = cur.refunds.find((r) => r.status === 'pending');
  assert.ok(pending, 'left pending'); assert.equal(cur.refundable, o.total - 10000, 'still counted against the balance');
  const att = (await api('GET', '/api/admin/attention', null, { jar: 'owner' })).json;
  assert.ok(att.unconfirmedRefunds.some((r) => r.id === pending.id));
  const rec = await api('POST', '/api/admin/refunds/' + pending.id + '/reconcile', {}, { jar: 'owner' });
  assert.equal(rec.status, 200); assert.equal(rec.json.refund.status, 'failed', 'gateway never had it → safe to retry');
  cur = (await api('GET', '/api/admin/orders/' + o.id, null, { jar: 'owner' })).json.order;
  assert.equal(cur.refundable, o.total);
});

test('manual refunds for offline payments are recorded with a reference, never sent to the gateway', async () => {
  const c = await api('POST', '/api/commerce/order', bag({ method: 'Bank transfer' }), { headers: { 'Idempotency-Key': key() } });
  const o = c.json.order;
  const notPaid = await api('POST', '/api/admin/orders/' + o.id + '/refunds', { amount: 100, reason: 'x' }, { jar: 'owner' });
  assert.equal(notPaid.status, 422); assert.equal(notPaid.json.error, 'not-paid');
  await api('POST', '/api/admin/orders/' + o.id + '/paid', { version: o.version, reference: 'IMPS 777' }, { jar: 'owner' });
  const needRef = await api('POST', '/api/admin/orders/' + o.id + '/refunds', { amount: 100, reason: 'x' }, { jar: 'owner' });
  assert.equal(needRef.status, 422); assert.equal(needRef.json.error, 'manual-needed');
  const ok = await api('POST', '/api/admin/orders/' + o.id + '/refunds', { amount: 100, reason: 'x', manual: true, reference: 'NEFT back 999' }, { jar: 'owner' });
  assert.equal(ok.status, 200); assert.equal(ok.json.refund.channel, 'manual'); assert.equal(ok.json.refund.status, 'processed');
});

test('return window closes after the policy days', async () => {
  const email = 'late@example.com';
  const { verify } = await payOrder(bag({ register: true, customer: Object.assign(bag().customer, { email }) }));
  const o = await deliver(verify.json.order.id);
  app.db.run(`UPDATE orders SET delivered_at = ? WHERE id = ?`, new Date(Date.now() - 15 * 864e5).toISOString(), o.id);
  await signIn(email, 'late');
  const r = await api('POST', '/api/me/orders/' + o.id + '/returns', { items: [{ idx: 0, qty: 1 }], reason: 'late' }, { jar: 'late' });
  assert.equal(r.status, 422); assert.equal(r.json.data.reason, 'window-closed');
});

test('references are sequential and unique across many orders in a day', async () => {
  const rs = await Promise.all(Array.from({ length: 12 }, () => api('POST', '/api/commerce/order', bag({ method: 'Bank transfer' }), { headers: { 'Idempotency-Key': key() } })));
  const refs = rs.map((r) => r.json.order.ref);
  assert.equal(new Set(refs).size, 12);
  const nums = refs.map((r) => parseInt(r.slice(-4), 10)).sort((a, b) => a - b);
  for (let i = 1; i < nums.length; i++) assert.equal(nums[i], nums[i - 1] + 1);
  const ids = rs.map((r) => r.json.order.id);
  assert.ok(ids.every((id) => /^[0-9a-f-]{36}$/.test(id)));
});

test('tracking: guests need the matching phone; owners and the order\'s customer do not', async () => {
  const { verify } = await payOrder(bag());
  const o = verify.json.order;
  assert.equal((await api('GET', '/api/orders/' + o.ref)).status, 404);
  assert.equal((await api('GET', '/api/orders/' + o.ref + '?phone=9999999999')).status, 404);
  const g = await api('GET', '/api/orders/' + o.ref + '?phone=9876543210');
  assert.equal(g.status, 200); assert.equal(g.json.order.customer.email, undefined, 'guest view hides the email');
  const a = await api('GET', '/api/orders/' + o.ref.toLowerCase(), null, { jar: 'owner' });
  assert.equal(a.status, 200); assert.equal(a.json.order.customer.email, 'asha@example.com');
});

test('trade orders: GSTIN required, minimum enforced, priced at trade tiers', async () => {
  const items = [{ sku: FRAME, variant: '51', qty: 12 }];
  const noGst = await api('POST', '/api/commerce/order', bag({ mode: 'trade', method: 'Bank transfer', items, customer: Object.assign(bag().customer, { shop: 'Nair Opticians' }) }), { headers: { 'Idempotency-Key': key() } });
  assert.equal(noGst.status, 422); assert.equal(noGst.json.error, 'bad-gstin');
  const small = await api('POST', '/api/commerce/order', bag({ mode: 'trade', method: 'Bank transfer', items: [{ sku: FRAME, variant: '51', qty: 1 }], customer: Object.assign(bag().customer, { shop: 'Nair Opticians', gstin: '04AAAAA0000A1Z5' }) }), { headers: { 'Idempotency-Key': key() } });
  assert.equal(small.status, 422, JSON.stringify(small.json));
  const ok = await api('POST', '/api/commerce/order', bag({ mode: 'trade', method: 'Bank transfer', items, customer: Object.assign(bag().customer, { shop: 'Nair Opticians', gstin: '04AAAAA0000A1Z5' }) }), { headers: { 'Idempotency-Key': key() } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.match(ok.json.order.ref, /^A1T-/);
  assert.equal(ok.json.order.items[0].lens, null);
  assert.equal(ok.json.order.mode, 'trade');
});

test('settings saved by the owner change what the server charges', async () => {
  const before = (await api('POST', '/api/commerce/order', bag({ method: 'Bank transfer' }), { headers: { 'Idempotency-Key': key() } })).json.order.total;
  const put = await api('PUT', '/api/admin/settings/overrides', { value: { [FRAME]: { retail: 50000 } } }, { jar: 'owner' });
  assert.equal(put.status, 200);
  const after = (await api('POST', '/api/commerce/order', bag({ method: 'Bank transfer' }), { headers: { 'Idempotency-Key': key() } })).json.order.total;
  assert.ok(after < before, 'price fell: ' + before + ' → ' + after);
  await api('PUT', '/api/admin/settings/overrides', { value: null }, { jar: 'owner' });
});
