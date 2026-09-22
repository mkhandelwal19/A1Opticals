/* =============================================================================
   api/orders.js — everything that happens to an order, and the rules for it
   -----------------------------------------------------------------------------
   The invariants this file exists to keep, and how each one is kept:

   1. ONE ORDER PER CHECKOUT. The browser sends an Idempotency-Key. The key
      row is inserted as 'in-progress' in the same transaction that creates
      the order, before the gateway is called. A duplicate submit (double
      click, retry after a dropped response, two tabs) either gets the same
      response back or a 409 "still in progress" — never a second order.

   2. STOCK IS NEVER SOLD TWICE. A reservation is one UPDATE with the check
      in its WHERE clause: `reserved = reserved + n WHERE on_hand - reserved
      >= n`. Zero rows changed means someone else got there first, and the
      whole transaction rolls back. Reservations are committed when the
      payment is captured, released when it fails or expires.

   3. A PAYMENT IS RECORDED ONCE. Both the browser's /verify and Razorpay's
      webhook call markPaid(); the update is `… WHERE pay_status IN
      ('pending','failed')`, so whichever arrives second changes nothing and
      says so. Webhook deliveries are deduplicated by event id before that.

   4. A STATUS CHANGE NEEDS THE VERSION IT WAS BASED ON. Two staff on the
      dashboard, one stale: the second update fails with 409 and the current
      row, instead of silently overwriting the first.

   5. A REFUND IS WRITTEN DOWN BEFORE IT IS ASKED FOR. The refund row exists,
      counted against the refundable balance, before the gateway is called.
      If the answer is lost, the row says 'pending' with the error, and
      reconcile() asks the gateway what it has — matched by our refund id in
      the notes — before anyone can try again. Two people refunding the same
      order at once are serialised by the write lock, and the second sees the
      first's row in the balance.

   6. A MESSAGE GOES OUT IF AND ONLY IF THE CHANGE COMMITTED. Notifications
      are queued inside the change's transaction (see notify.js).
   ========================================================================== */
'use strict';

const Commerce = require('../commerce.js');
const { uuid, now, sha256 } = require('./db.js');
const { HttpError } = require('./auth.js');
const { GatewayError } = require('./gateway.js');

const GATEWAY_METHODS = ['UPI', 'Card'];
const OFFLINE_METHODS = { 'Bank transfer': Commerce.PAY.AWAITING_TRANSFER, 'Cash on delivery': Commerce.PAY.PAY_ON_DELIVERY, 'Pay in store': Commerce.PAY.PAY_ON_COLLECTION, 'Credit account': Commerce.PAY.ON_ACCOUNT };
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

function stable(o) {
  if (Array.isArray(o)) return '[' + o.map(stable).join(',') + ']';
  if (o && typeof o === 'object') return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stable(o[k])).join(',') + '}';
  return JSON.stringify(o);
}
const J = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch (_) { return d; } };
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 200);

function create({ db, engine, gateway, notify, auth, cfg, log }) {

  /* ── settings & stock seed ────────────────────────────────────────────── */
  function settings() {
    const out = {};
    db.all(`SELECT key, value_json FROM settings`).forEach((r) => { out[r.key] = J(r.value_json, null); });
    return out;
  }
  function putSetting(key, value, actor) {
    if (['site', 'overrides', 'products'].indexOf(key) < 0) throw new HttpError(404, 'no-such-setting');
    db.tx((tx) => {
      if (value == null) tx.run(`DELETE FROM settings WHERE key = ?`, key);
      else tx.run(`INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`, key, JSON.stringify(value), now());
      audit(tx, actor, 'settings.put', key, null);
    });
    engine.reload(settings());
    seedStock();
    if (key === 'overrides' && value) {
      /* An absolute stock figure from the admin replaces on-hand; open
         reservations stay open — they are real bags at the checkout. */
      db.tx((tx) => {
        Object.keys(value).forEach((sku) => {
          if (typeof value[sku].stock === 'number') tx.run(`UPDATE stock SET on_hand = ? WHERE sku = ?`, value[sku].stock, sku);
        });
      });
    }
  }
  function seedStock() {
    db.tx((tx) => {
      engine.catalog.products.forEach((p) => {
        tx.run(`INSERT OR IGNORE INTO stock (sku, on_hand, reserved) VALUES (?, ?, 0)`, p.sku, Math.max(0, p.stock | 0));
      });
    });
  }
  function stockOf(sku) { return db.get(`SELECT sku, on_hand, reserved, on_hand - reserved AS available FROM stock WHERE sku = ?`, sku); }

  function audit(tx, actor, action, target, detail) {
    tx.run(`INSERT INTO audit_log (id, at, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?, ?)`, uuid(), now(), actor || 'system', action, target || null, detail ? JSON.stringify(detail) : null);
  }
  function event(tx, orderId, from, to, actor, note) {
    tx.run(`INSERT INTO order_events (id, order_id, at, from_status, to_status, actor, note) VALUES (?, ?, ?, ?, ?, ?, ?)`, uuid(), orderId, now(), from || null, to, actor || 'system', note || null);
  }

  /* ── stock moves ──────────────────────────────────────────────────────── */
  function reserveStock(tx, orderId, items) {
    for (const it of items) {
      const r = tx.run(`UPDATE stock SET reserved = reserved + ? WHERE sku = ? AND on_hand - reserved >= ?`, it.qty, it.sku, it.qty);
      if (!r.changes) {
        const s = tx.get(`SELECT on_hand - reserved AS available FROM stock WHERE sku = ?`, it.sku);
        throw new HttpError(409, 'out-of-stock', (s && s.available > 0 ? 'Only ' + s.available + ' left of ' : 'Sold out: ') + it.name, { sku: it.sku, available: s ? Math.max(0, s.available) : 0 });
      }
      tx.run(`INSERT INTO stock_moves (id, order_id, sku, qty, kind, at) VALUES (?, ?, ?, ?, 'reserve', ?)`, uuid(), orderId, it.sku, it.qty, now());
    }
  }
  function moveStock(tx, order, kind) {
    /* reserved → committed (sold), reserved → released, committed → restocked */
    const items = J(order.items_json, []);
    const cur = order.stock_state;
    if (kind === 'commit' && cur !== 'reserved') return;
    if (kind === 'release' && cur !== 'reserved') return;
    if (kind === 'restock' && cur !== 'committed') return;
    for (const it of items) {
      if (kind === 'commit') tx.run(`UPDATE stock SET on_hand = on_hand - ?, reserved = reserved - ? WHERE sku = ?`, it.qty, it.qty, it.sku);
      if (kind === 'release') tx.run(`UPDATE stock SET reserved = MAX(0, reserved - ?) WHERE sku = ?`, it.qty, it.sku);
      if (kind === 'restock') tx.run(`UPDATE stock SET on_hand = on_hand + ? WHERE sku = ?`, it.qty, it.sku);
      tx.run(`INSERT INTO stock_moves (id, order_id, sku, qty, kind, at) VALUES (?, ?, ?, ?, ?, ?)`, uuid(), order.id, it.sku, it.qty, kind, now());
    }
    const next = kind === 'commit' ? 'committed' : kind === 'release' ? 'released' : 'restocked';
    tx.run(`UPDATE orders SET stock_state = ? WHERE id = ?`, next, order.id);
    order.stock_state = next;
  }
  function restockItems(tx, orderId, items) {
    for (const it of items) {
      tx.run(`UPDATE stock SET on_hand = on_hand + ? WHERE sku = ?`, it.qty, it.sku);
      tx.run(`INSERT INTO stock_moves (id, order_id, sku, qty, kind, at) VALUES (?, ?, ?, ?, 'return', ?)`, uuid(), orderId, it.sku, it.qty, now());
    }
  }

  /* ── reading orders ───────────────────────────────────────────────────── */
  function policy() { return engine.site.returnsPolicy(); }
  function links(ref) {
    const base = cfg.siteUrl.replace(/\/$/, '');
    return { track: base + '/track.html?ref=' + encodeURIComponent(ref), account: base + '/account.html', order: base + '/order.html?ref=' + encodeURIComponent(ref) };
  }
  function ctxFor(order, extra) {
    const contact = engine.site.get('contact') || {};
    return Object.assign({ order, brand: cfg.brand, contact, policy: policy(), links: links(order.ref) }, extra || {});
  }

  function rowById(tx, id) { return (tx || db).get(`SELECT * FROM orders WHERE id = ?`, id); }

  /* The order as the pages see it — the same shape the preview's
     placeOrder() writes, plus what only the server knows. scope:
     'admin' | 'customer' | 'guest' (the track page: no email, no photo). */
  function view(row, scope, tx) {
    const q = tx || db;
    if (!row) return null;
    const customer = J(row.customer_json, {});
    const rx = J(row.rx_json, null);
    const refunds = q.all(`SELECT * FROM refunds WHERE order_id = ? ORDER BY created_at`, row.id).map(viewRefund);
    const returns = q.all(`SELECT * FROM return_requests WHERE order_id = ? ORDER BY created_at`, row.id).map(viewReturn);
    const events = q.all(`SELECT at, from_status AS "from", to_status AS "to", actor, note FROM order_events WHERE order_id = ? ORDER BY at`, row.id);
    const notifications = q.all(`SELECT id, channel, recipient, template, subject, status, attempts, created_at, sent_at, error${scope === 'admin' ? ', body' : ''} FROM notifications WHERE order_id = ? ORDER BY created_at`, row.id)
      .map((n) => ({ id: n.id, channel: n.channel, to: n.recipient, template: n.template, subject: n.subject, status: n.status, attempts: n.attempts, at: n.created_at, sentAt: n.sent_at, error: scope === 'admin' ? n.error : undefined, body: n.body }));
    const o = {
      id: row.id, ref: row.ref, version: row.version, status: row.status, mode: row.mode,
      registered: !!row.registered, customerId: scope === 'admin' ? row.customer_id : undefined,
      placedAt: row.placed_at, updatedAt: row.updated_at, deliveredAt: row.delivered_at, cancelledAt: row.cancelled_at,
      customer: scope === 'guest' ? Object.assign({}, customer, { email: undefined }) : customer,
      delivery: J(row.delivery_json, { method: 'van' }),
      rx: scope === 'guest' && rx ? Object.assign({}, rx, { photo: rx.photo ? '(photo on file)' : undefined }) : rx,
      items: J(row.items_json, []),
      gross: row.gross, discount: row.discount, base: row.base, tax: row.tax, byRate: J(row.byrate_json, {}), shipping: row.shipping, total: row.total,
      payment: { method: row.pay_method, status: row.pay_status, paymentId: row.gateway_payment_id, gateway: row.gateway, gatewayOrderId: row.gateway_order_id, paidAt: row.paid_at },
      stockState: scope === 'admin' ? row.stock_state : undefined,
      events, refunds, returns, notifications
    };
    o.refundable = Commerce.refundable(o);
    o.returnEligibility = Commerce.returnEligibility(o, policy());
    return o;
  }
  function viewRefund(r) {
    return { id: r.id, orderId: r.order_id, returnId: r.return_id, amount: r.amount, reason: r.reason, channel: r.channel, status: r.status,
      paymentId: r.gateway_payment_id, gatewayRefundId: r.gateway_refund_id, reference: r.reference, error: r.error,
      createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at, processedAt: r.processed_at };
  }
  function viewReturn(r) {
    return { id: r.id, orderId: r.order_id, customerId: r.customer_id, items: J(r.items_json, []), reason: r.reason, method: r.method, status: r.status,
      amount: r.amount, refundId: r.refund_id, note: r.note, createdAt: r.created_at, updatedAt: r.updated_at, decidedBy: r.decided_by };
  }

  function listOrders({ scope, customerId, status, q, includePending, limit }) {
    const where = [], p = [];
    if (scope === 'customer') { where.push('customer_id = ?'); p.push(customerId); }
    if (!includePending) where.push(`status != '${Commerce.PENDING}'`);
    if (status) { where.push('status = ?'); p.push(status); }
    if (q) { where.push('(ref LIKE ? OR email LIKE ? OR phone LIKE ? OR customer_json LIKE ?)'); const like = '%' + q + '%'; p.push(like, like, like, like); }
    const rows = db.all(`SELECT * FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY placed_at DESC LIMIT ?`, ...p, Math.min(limit || 500, 2000));
    return rows.map((r) => view(r, scope === 'customer' ? 'customer' : 'admin'));
  }
  function getForCustomer(id, customerId) {
    const row = db.get(`SELECT * FROM orders WHERE id = ? AND customer_id = ?`, id, customerId);
    return row ? view(row, 'customer') : null;
  }
  function findByRef(ref, phone, scope) {
    const row = db.get(`SELECT * FROM orders WHERE ref = ?`, String(ref || '').trim().toUpperCase());
    if (!row) return null;
    if (scope !== 'admin') {
      const want = String(phone || '').replace(/\D/g, '').slice(-10);
      const have = String(row.phone || '').replace(/\D/g, '').slice(-10);
      if (!want || want.length < 10 || want !== have) return null;
    }
    return view(row, scope || 'guest');
  }

  /* ── creating an order ────────────────────────────────────────────────── */
  function nextRef(tx, trade) {
    const d = new Date();
    const key = 'order:' + d.toISOString().slice(0, 10);
    tx.run(`INSERT INTO counters (key, n) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET n = n + 1`, key);
    const n = tx.get(`SELECT n FROM counters WHERE key = ?`, key).n;
    return Commerce.refFor(d, n, trade);
  }

  function validateCheckout(body, customer) {
    if (!body || typeof body !== 'object') throw new HttpError(400, 'bad-body');
    const mode = body.mode === 'trade' ? 'trade' : 'retail';
    const c = body.customer || {};
    const details = {
      shop: str(c.shop, 120), gstin: str(c.gstin, 15).toUpperCase(), name: str(c.name, 120), phone: str(c.phone, 20), email: auth.normEmail(c.email),
      address: str(c.address, 400), city: str(c.city, 80), pin: str(c.pin, 6), slot: str(c.slot, 60), po: str(c.po, 200), notes: str(c.notes, 400), labNotes: str(c.labNotes, 400)
    };
    if (details.name.length < 2) throw new HttpError(422, 'bad-name', 'Who is this for?');
    if (!/^[+ 0-9-]{10,20}$/.test(details.phone) || details.phone.replace(/\D/g, '').length < 10) throw new HttpError(422, 'bad-phone', 'A ten-digit mobile number is needed');
    if (mode === 'trade') {
      if (details.shop.length < 2) throw new HttpError(422, 'bad-shop', 'The name on the invoice');
      if (!GSTIN.test(details.gstin)) throw new HttpError(422, 'bad-gstin', 'A valid 15-character GSTIN');
    } else if (details.gstin && !GSTIN.test(details.gstin)) throw new HttpError(422, 'bad-gstin', 'A valid 15-character GSTIN');

    const dIn = body.delivery || {};
    const site = engine.site, Store = engine.store;
    const del = engine.site.get('delivery');
    let method;
    const collect = dIn.method === 'collect';
    if (collect) {
      method = 'collect';
      details.address = ''; details.city = ''; details.pin = '';
    } else {
      if (details.address.length < 10) throw new HttpError(422, 'bad-address', 'A full address, please');
      if (details.city.length < 2) throw new HttpError(422, 'bad-city', 'Which city?');
      const area = Store.serviceArea(details.pin);
      if (!area) throw new HttpError(422, 'bad-pin', 'A six-digit PIN code');
      if (area.van) method = 'van';
      else if (mode === 'retail' && del.retail.courierOutside) method = 'courier';
      else throw new HttpError(422, 'outside-area', 'That PIN is outside our delivery area');
    }
    const store = collect ? (site.store(str(dIn.store, 40)) || site.stores()[0]) : null;
    const delivery = {
      method, area: !collect ? (Store.serviceArea(details.pin) || {}).area || null : null,
      slot: collect ? 'Collect from store' : method === 'courier' ? 'Courier' : (details.slot || (del.slots || [])[0] || ''),
      store: store ? store.id : null, storeName: store ? store.name + ', ' + store.city : null, storeAddress: store ? store.address : null, storeHours: store ? store.hours : null,
      days: method === 'courier' ? del.retail.courierDays : del.retail.vanDays
    };
    details.slot = delivery.slot;

    const payMethod = str(body.method, 30);
    if (GATEWAY_METHODS.indexOf(payMethod) < 0 && !OFFLINE_METHODS[payMethod]) throw new HttpError(422, 'bad-method', 'Choose a payment method');
    if (payMethod === 'Cash on delivery' && (mode !== 'retail' || method !== 'van')) throw new HttpError(422, 'bad-method', 'Pay on delivery is for van deliveries only');
    if (payMethod === 'Pay in store' && (mode !== 'retail' || method !== 'collect')) throw new HttpError(422, 'bad-method', 'Pay in store is for collection orders');
    if (payMethod === 'Credit account') {
      if (mode !== 'trade' || !customer) throw new HttpError(422, 'bad-method', 'A credit account needs a signed-in trade account');
      const paid = db.get(`SELECT COUNT(*) AS n FROM orders WHERE customer_id = ? AND mode = 'trade' AND pay_status IN ('paid','partially refunded','refunded','on account')`, customer.id).n;
      if (paid < 3) throw new HttpError(422, 'credit-locked', 'Credit unlocks after your third paid order');
    }

    let rx = null;
    if (body.rx && typeof body.rx === 'object') {
      const r = body.rx;
      const m = ['typed', 'photo', 'call', 'later'].indexOf(r.method) > -1 ? r.method : 'later';
      const eye = (e) => ({ sph: str(e && e.sph, 8), cyl: str(e && e.cyl, 8), axis: str(e && e.axis, 4), add: str(e && e.add, 8) });
      rx = { method: m, od: eye(r.od), os: eye(r.os), pd: { on: !!(r.pd && r.pd.on), r: str(r.pd && r.pd.r, 6), l: str(r.pd && r.pd.l, 6) }, notes: str(r.notes, 400), savedAt: str(r.savedAt, 40) || now() };
      if (m === 'photo') {
        const photo = String(r.photo || '');
        if (!/^data:image\/(jpeg|png|webp);base64,/.test(photo) || photo.length > 3 * 1024 * 1024) throw new HttpError(422, 'bad-rx-photo', 'The prescription photo could not be read');
        rx.photo = photo;
      }
      if (m === 'typed' && (isNaN(parseFloat(rx.od.sph)) || isNaN(parseFloat(rx.os.sph)))) throw new HttpError(422, 'bad-rx', 'SPH for both eyes, please');
    }
    return { mode, details, delivery, payMethod, rx, register: !!body.register, items: Array.isArray(body.items) ? body.items : [] };
  }

  async function createOrder({ body, idemKey, customer, ip }) {
    if (!idemKey || idemKey.length < 8 || idemKey.length > 128) throw new HttpError(400, 'idempotency-key', 'Idempotency-Key header is required');
    const hash = sha256(stable(body));
    const scope = 'order:' + (customer ? customer.id : ip);

    /* Phase 1 — everything except the gateway, in one transaction. */
    const first = db.tx((tx) => {
      const seen = tx.get(`SELECT * FROM idempotency WHERE key = ?`, idemKey);
      if (seen) {
        if (seen.request_hash !== hash) throw new HttpError(422, 'idempotency-mismatch', 'This checkout key was already used for a different bag');
        if (seen.status !== 'done') throw new HttpError(409, 'in-progress', 'That order is still being created — wait a moment');
        const resp = J(seen.response_json, {});
        const row = rowById(tx, resp.orderId);
        /* The earlier attempt died unpaid (checkout closed, or the 30-minute
           sweep). Handing back a cancelled order helps nobody: forget the key
           and start again with fresh stock. */
        if (row && row.status === 'cancelled' && !Commerce.isPaid(row.pay_status)) tx.run(`DELETE FROM idempotency WHERE key = ?`, idemKey);
        else return { replay: true, order: view(row, 'customer', tx), gateway: resp.gateway || null };
      }
      const v = validateCheckout(body, customer);
      let t;
      try { t = engine.price(v.items, v.mode, v.delivery.method); }
      catch (e) { if (e.code) throw new HttpError(422, e.code, e.message, { sku: e.sku }); throw e; }
      if (v.mode === 'trade' && t.belowMin) throw new HttpError(422, 'below-minimum', 'Trade orders start at ' + Commerce.rupees(t.minOrder));
      if (t.rxNeeded && v.mode === 'retail' && !v.rx) v.rx = { method: 'later', od: {}, os: {}, pd: {}, savedAt: now() };

      const id = uuid();
      const ref = nextRef(tx, v.mode === 'trade');
      const gatewayPay = GATEWAY_METHODS.indexOf(v.payMethod) > -1;
      const rxLater = t.rxNeeded && v.rx && (v.rx.method === 'later' || v.rx.method === 'call');
      const readyStatus = rxLater ? 'awaiting prescription' : 'confirmed';
      const status = gatewayPay ? Commerce.PENDING : readyStatus;
      const payStatus = gatewayPay ? Commerce.PAY.PENDING : OFFLINE_METHODS[v.payMethod];

      let customerId = customer ? customer.id : null;
      if (!customerId && v.register) customerId = auth.upsertCustomer(tx, v.details.email, { name: v.details.name, phone: v.details.phone }).id;
      const registered = customerId ? 1 : 0;

      reserveStock(tx, id, t.orderItems);
      const at = now();
      tx.run(`INSERT INTO orders (id, ref, version, status, mode, registered, customer_id, email, phone, customer_json, delivery_json, rx_json, items_json, byrate_json,
                gross, discount, base, tax, shipping, total, pay_method, pay_status, gateway, stock_state, placed_at, updated_at)
              VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
        id, ref, status, v.mode, registered, customerId, v.details.email, v.details.phone, JSON.stringify(v.details), JSON.stringify(v.delivery), v.rx ? JSON.stringify(v.rx) : null,
        JSON.stringify(t.orderItems), JSON.stringify(t.byRate), t.gross, t.discount, t.base, t.tax, t.shipping, t.total, v.payMethod, payStatus, gatewayPay ? gateway.name : null, at, at);
      event(tx, id, null, status, customer ? 'customer:' + customer.email : 'customer', gatewayPay ? 'awaiting gateway payment' : 'placed · ' + v.payMethod);
      tx.run(`INSERT INTO idempotency (key, scope, request_hash, status, response_json, created_at) VALUES (?, ?, ?, ?, NULL, ?)`, idemKey, scope, hash, gatewayPay ? 'in-progress' : 'done', at);

      const row = rowById(tx, id);
      if (!gatewayPay) {
        /* Nothing to wait for: the goods go out before the money arrives. */
        moveStock(tx, row, 'commit');
        const o = view(row, 'customer', tx);
        queueConfirmation(tx, o);
        tx.run(`UPDATE idempotency SET response_json = ? WHERE key = ?`, JSON.stringify({ orderId: id }), idemKey);
        return { order: o, gateway: null };
      }
      return { order: view(row, 'customer', tx), gateway: 'create' };
    });
    if (first.replay || !first.gateway) return { order: first.order, gateway: first.gateway || null };

    /* Phase 2 — the gateway, outside the write lock. */
    const o = first.order;
    let g;
    try {
      g = await gateway.createOrder({ amount: o.total, receipt: o.ref, notes: { order_id: o.id, ref: o.ref } });
    } catch (e) {
      db.tx((tx) => {
        const row = rowById(tx, o.id);
        moveStock(tx, row, 'release');
        tx.run(`UPDATE orders SET status = 'cancelled', pay_status = 'failed', cancelled_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`, now(), now(), o.id);
        event(tx, o.id, row.status, 'cancelled', 'system', 'gateway order could not be created: ' + (e.message || e));
        tx.run(`DELETE FROM idempotency WHERE key = ?`, idemKey);
      });
      throw e instanceof GatewayError ? new HttpError(502, 'gateway-down', 'The payment gateway did not respond. Nothing was charged — please try again.') : e;
    }
    const gw = { name: gateway.name, stub: !!gateway.stub, key: gateway.keyId, orderId: g.id, amount: g.amount, currency: g.currency || 'INR' };
    const order = db.tx((tx) => {
      tx.run(`UPDATE orders SET gateway_order_id = ?, updated_at = ? WHERE id = ?`, g.id, now(), o.id);
      tx.run(`UPDATE idempotency SET status = 'done', response_json = ? WHERE key = ?`, JSON.stringify({ orderId: o.id, gateway: gw }), idemKey);
      return view(rowById(tx, o.id), 'customer', tx);
    });
    return { order, gateway: gw };
  }

  function queueConfirmation(tx, o) {
    notify.enqueue(tx, { orderId: o.id, template: 'order_confirmed', email: o.customer.email, phone: o.customer.phone, ctx: ctxFor(o), dedupeKey: o.id + ':order_confirmed' });
    if (o.status === 'awaiting prescription') notify.enqueue(tx, { orderId: o.id, template: 'order_awaiting_rx', email: o.customer.email, phone: o.customer.phone, ctx: ctxFor(o), dedupeKey: o.id + ':order_awaiting_rx:v' + o.version });
    if (cfg.ownerNotifyEmail) notify.enqueue(tx, { orderId: o.id, template: 'owner_new_order', email: cfg.ownerNotifyEmail, ctx: ctxFor(o), dedupeKey: o.id + ':owner_new_order' });
  }

  /* ── payment ──────────────────────────────────────────────────────────── */
  function markPaid({ orderId, gatewayOrderId, paymentId, via }) {
    return db.tx((tx) => {
      const row = orderId ? rowById(tx, orderId) : tx.get(`SELECT * FROM orders WHERE gateway_order_id = ?`, gatewayOrderId);
      if (!row) return { found: false };
      if (Commerce.isPaid(row.pay_status)) {
        if (row.gateway_payment_id && paymentId && row.gateway_payment_id !== paymentId) {
          /* Two captures for one order — a retried checkout that both went
             through. Money the customer did not mean to send: flag it. */
          audit(tx, 'system:' + via, 'payment.double-capture', row.id, { first: row.gateway_payment_id, second: paymentId });
          event(tx, row.id, row.status, row.status, 'system:' + via, 'SECOND payment captured ' + paymentId + ' — refund it from the gateway dashboard');
        }
        return { found: true, changed: false, order: view(row, 'customer', tx) };
      }
      const r = tx.run(`UPDATE orders SET pay_status = 'paid', gateway_payment_id = ?, paid_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND pay_status IN ('pending','failed')`, paymentId, now(), now(), row.id);
      if (!r.changes) return { found: true, changed: false, order: view(rowById(tx, row.id), 'customer', tx) };

      if (row.status === 'cancelled') {
        /* Captured after we gave up on it (customer closed the checkout, or
           the 30-minute expiry ran first, and the bank was slow). The order
           stays cancelled; the money must go back. */
        event(tx, row.id, 'cancelled', 'cancelled', 'system:' + via, 'payment ' + paymentId + ' captured AFTER cancellation — refund needed');
        audit(tx, 'system:' + via, 'payment.captured-after-cancel', row.id, { paymentId });
        return { found: true, changed: true, order: view(rowById(tx, row.id), 'customer', tx), lateCapture: true };
      }
      const items = J(row.items_json, []);
      const rx = J(row.rx_json, null);
      const rxNeeded = items.some((i) => i.needsRx);
      const next = row.status === Commerce.PENDING ? (rxNeeded && rx && (rx.method === 'later' || rx.method === 'call') ? 'awaiting prescription' : 'confirmed') : row.status;
      tx.run(`UPDATE orders SET status = ? WHERE id = ?`, next, row.id);
      moveStock(tx, row, 'commit');
      event(tx, row.id, row.status, next, 'system:' + via, 'payment ' + paymentId + ' captured');
      const o = view(rowById(tx, row.id), 'customer', tx);
      queueConfirmation(tx, o);
      return { found: true, changed: true, order: o };
    });
  }

  function verifyCheckout({ razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) throw new HttpError(400, 'bad-body', 'order id, payment id and signature are required');
    const row = db.get(`SELECT id FROM orders WHERE gateway_order_id = ?`, razorpay_order_id);
    if (!row) throw new HttpError(404, 'no-order', 'No order for that payment');
    if (!gateway.verifyCheckout({ orderId: razorpay_order_id, paymentId: razorpay_payment_id, signature: razorpay_signature })) {
      db.tx((tx) => audit(tx, 'system:verify', 'payment.bad-signature', row.id, { paymentId: razorpay_payment_id }));
      throw new HttpError(400, 'bad-signature', 'The payment could not be verified');
    }
    const r = markPaid({ orderId: row.id, paymentId: razorpay_payment_id, via: 'verify' });
    return { verified: true, order: r.order, method: r.order.payment.method };
  }

  /* The customer closed the checkout: give the stock back now rather than
     in thirty minutes. Only a pending, unpaid order can be abandoned, and
     only by the browser that owns the idempotency key for it — the key is
     the proof. */
  function abandon({ orderId, idemKey }) {
    return db.tx((tx) => {
      const row = rowById(tx, orderId);
      if (!row) throw new HttpError(404, 'no-order');
      const key = tx.get(`SELECT key FROM idempotency WHERE key = ? AND response_json LIKE ?`, idemKey || '', '%' + orderId + '%');
      if (!key) throw new HttpError(403, 'not-yours');
      if (row.status !== Commerce.PENDING || Commerce.isPaid(row.pay_status)) return { order: view(row, 'customer', tx), changed: false };
      cancelPending(tx, row, 'customer', 'checkout closed');
      return { order: view(rowById(tx, row.id), 'customer', tx), changed: true };
    });
  }
  function cancelPending(tx, row, actor, note) {
    moveStock(tx, row, 'release');
    tx.run(`UPDATE orders SET status = 'cancelled', cancelled_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status = ?`, now(), now(), row.id, Commerce.PENDING);
    event(tx, row.id, Commerce.PENDING, 'cancelled', actor, note);
  }
  /* Sweeper: pending orders older than the TTL are cancelled and their
     stock released. A capture that lands later is handled by markPaid(). */
  function expirePending() {
    const cutoff = new Date(Date.now() - (cfg.pendingTtlMin || 30) * 60 * 1000).toISOString();
    const rows = db.all(`SELECT * FROM orders WHERE status = ? AND placed_at < ?`, Commerce.PENDING, cutoff);
    let n = 0;
    for (const row of rows) {
      db.tx((tx) => { const fresh = rowById(tx, row.id); if (fresh && fresh.status === Commerce.PENDING && !Commerce.isPaid(fresh.pay_status)) { cancelPending(tx, fresh, 'system:expiry', 'no payment within ' + (cfg.pendingTtlMin || 30) + ' minutes'); n++; } });
    }
    return n;
  }

  /* ── status changes (owner) ───────────────────────────────────────────── */
  function changeStatus({ orderId, status, version, note, actor }) {
    if (Commerce.STATUS.indexOf(status) < 0) throw new HttpError(422, 'bad-status', 'Unknown status');
    return db.tx((tx) => {
      const row = rowById(tx, orderId);
      if (!row) throw new HttpError(404, 'no-order');
      if (typeof version !== 'number' || row.version !== version) throw new HttpError(409, 'conflict', 'This order changed since you loaded it', { order: view(row, 'admin', tx) });
      if (row.status === status) return view(row, 'admin', tx);
      if (!Commerce.canTransition(row.status, status)) throw new HttpError(422, 'bad-transition', 'An order cannot go from "' + row.status + '" to "' + status + '"', { from: row.status, allowed: Commerce.nextStatuses(row.status) });
      const at = now();
      const r = tx.run(`UPDATE orders SET status = ?, version = version + 1, updated_at = ?, delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END, cancelled_at = CASE WHEN ? = 'cancelled' THEN ? ELSE cancelled_at END WHERE id = ? AND version = ?`,
        status, at, status, at, status, at, orderId, version);
      if (!r.changes) throw new HttpError(409, 'conflict', 'This order changed since you loaded it', { order: view(rowById(tx, orderId), 'admin', tx) });
      event(tx, orderId, row.status, status, actor, note || null);
      if (status === 'cancelled') {
        if (row.stock_state === 'reserved') moveStock(tx, row, 'release');
        else if (row.stock_state === 'committed') moveStock(tx, row, 'restock');
      }
      const o = view(rowById(tx, orderId), 'admin', tx);
      const template = Commerce.notificationFor(status);
      if (template && o.customer.email) {
        notify.enqueue(tx, { orderId, template, email: o.customer.email, phone: o.customer.phone, ctx: ctxFor(o, { note }), dedupeKey: orderId + ':' + template + ':v' + o.version });
      }
      audit(tx, actor, 'order.status', orderId, { from: row.status, to: status, note });
      return o;
    });
  }

  /* A bank transfer or on-account payment has arrived. */
  function markOfflinePaid({ orderId, version, reference, actor }) {
    return db.tx((tx) => {
      const row = rowById(tx, orderId);
      if (!row) throw new HttpError(404, 'no-order');
      if (row.version !== version) throw new HttpError(409, 'conflict', 'This order changed since you loaded it', { order: view(row, 'admin', tx) });
      if (Commerce.isPaid(row.pay_status)) return view(row, 'admin', tx);
      if (GATEWAY_METHODS.indexOf(row.pay_method) > -1) throw new HttpError(422, 'gateway-order', 'Gateway payments are confirmed by the gateway, not by hand');
      tx.run(`UPDATE orders SET pay_status = 'paid', paid_at = ?, gateway_payment_id = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?`, now(), reference ? 'manual:' + str(reference, 60) : null, now(), orderId, version);
      event(tx, orderId, row.status, row.status, actor, 'payment received' + (reference ? ' · ' + str(reference, 60) : ''));
      audit(tx, actor, 'order.paid-offline', orderId, { reference });
      return view(rowById(tx, orderId), 'admin', tx);
    });
  }

  /* ── returns ──────────────────────────────────────────────────────────── */
  function requestReturn({ orderId, customer, items, reason, method }) {
    return db.tx((tx) => {
      const row = tx.get(`SELECT * FROM orders WHERE id = ? AND customer_id = ?`, orderId, customer.id);
      if (!row) throw new HttpError(404, 'no-order');
      const o = view(row, 'customer', tx);
      const elig = Commerce.returnEligibility(o, policy());
      if (!elig.ok) throw new HttpError(422, 'not-eligible', elig.reason === 'window-closed' ? 'The return window closed on ' + Commerce.dateLong(elig.until) : 'This order cannot be returned right now (' + elig.reason + ')', elig);
      const norm = Commerce.normaliseReturnItems(o, items, policy());
      if (!norm.ok) throw new HttpError(422, 'bad-items', 'Those items cannot be returned (' + norm.reason + ')', norm);
      const m = ['collect', 'store', 'courier'].indexOf(method) > -1 ? method : 'collect';
      const amount = Commerce.refundForReturn(o, norm.items);
      const id = uuid(), at = now();
      tx.run(`INSERT INTO return_requests (id, order_id, customer_id, items_json, reason, method, status, amount, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?)`,
        id, orderId, customer.id, JSON.stringify(norm.items), str(reason, 500), m, amount, at, at);
      event(tx, orderId, row.status, row.status, 'customer:' + customer.email, 'return requested · ' + norm.items.map((i) => i.qty + ' × ' + i.name).join(', '));
      const ret = viewReturn(tx.get(`SELECT * FROM return_requests WHERE id = ?`, id));
      notify.enqueue(tx, { orderId, template: 'return_requested', email: o.customer.email, phone: o.customer.phone, ctx: ctxFor(o, { ret }), dedupeKey: 'ret:' + id + ':requested' });
      if (cfg.ownerNotifyEmail) notify.enqueue(tx, { orderId, template: 'owner_return_requested', email: cfg.ownerNotifyEmail, ctx: ctxFor(o, { ret }), dedupeKey: 'ret:' + id + ':owner' });
      return ret;
    });
  }

  function listReturns({ status }) {
    const rows = status ? db.all(`SELECT * FROM return_requests WHERE status = ? ORDER BY created_at DESC LIMIT 500`, status) : db.all(`SELECT * FROM return_requests ORDER BY created_at DESC LIMIT 500`);
    return rows.map((r) => { const v = viewReturn(r); const o = db.get(`SELECT ref, customer_json, mode, total, pay_status, pay_method FROM orders WHERE id = ?`, r.order_id); v.order = o ? { ref: o.ref, customer: J(o.customer_json, {}), mode: o.mode, total: o.total, payStatus: o.pay_status, payMethod: o.pay_method } : null; return v; });
  }

  async function decideReturn({ returnId, action, note, actor, refund }) {
    const map = { approve: 'approved', reject: 'rejected', received: 'received', cancel: 'cancelled' };
    const to = map[action];
    if (!to) throw new HttpError(422, 'bad-action');
    const done = db.tx((tx) => {
      const r = tx.get(`SELECT * FROM return_requests WHERE id = ?`, returnId);
      if (!r) throw new HttpError(404, 'no-return');
      if (!Commerce.canReturnTransition(r.status, to)) throw new HttpError(422, 'bad-transition', 'A return cannot go from "' + r.status + '" to "' + to + '"');
      tx.run(`UPDATE return_requests SET status = ?, note = COALESCE(?, note), decided_by = ?, updated_at = ? WHERE id = ? AND status = ?`, to, note ? str(note, 500) : null, actor, now(), returnId, r.status);
      const row = rowById(tx, r.order_id);
      const o = view(row, 'admin', tx);
      const ret = viewReturn(tx.get(`SELECT * FROM return_requests WHERE id = ?`, returnId));
      event(tx, r.order_id, row.status, row.status, actor, 'return ' + to + (note ? ' · ' + str(note, 120) : ''));
      if (to === 'received') restockItems(tx, r.order_id, ret.items);
      const template = { approved: 'return_approved', rejected: 'return_rejected', received: 'return_received' }[to];
      if (template) notify.enqueue(tx, { orderId: r.order_id, template, email: o.customer.email, phone: o.customer.phone, ctx: ctxFor(o, { ret, note }), dedupeKey: 'ret:' + returnId + ':' + to });
      audit(tx, actor, 'return.' + to, returnId, { note });
      return { ret, order: o };
    });
    /* Received and paid online → send the money back, unless told not to. */
    if (to === 'received' && refund !== false && done.ret.amount > 0 && Commerce.isPaid(done.order.payment.status)) {
      try {
        done.refund = await createRefund({ orderId: done.ret.orderId, amount: done.ret.amount, reason: 'Return ' + done.ret.id.slice(0, 8), returnId, actor });
      } catch (e) {
        done.refundError = e.message || String(e);
        log.warn('return ' + returnId + ' received but refund failed: ' + done.refundError);
      }
    }
    return done;
  }

  /* ── refunds ──────────────────────────────────────────────────────────── */
  function recomputePayStatus(tx, orderId) {
    const row = rowById(tx, orderId);
    if (!row || !Commerce.isPaid(row.pay_status)) return;
    const sum = tx.get(`SELECT COALESCE(SUM(amount), 0) AS s FROM refunds WHERE order_id = ? AND status != 'failed'`, orderId).s;
    const ps = sum >= row.total ? Commerce.PAY.REFUNDED : sum > 0 ? Commerce.PAY.PARTIAL : Commerce.PAY.PAID;
    if (ps !== row.pay_status) tx.run(`UPDATE orders SET pay_status = ?, updated_at = ? WHERE id = ?`, ps, now(), orderId);
  }
  function settleRefund(tx, refundRow, result, actor) {
    /* result: 'processed' | 'failed' | 'processing' */
    const r = tx.run(`UPDATE refunds SET status = ?, updated_at = ?, processed_at = CASE WHEN ? = 'processed' THEN ? ELSE processed_at END WHERE id = ? AND status IN ('pending','processing')`, result, now(), result, now(), refundRow.id);
    if (!r.changes) return false;
    recomputePayStatus(tx, refundRow.order_id);
    const o = view(rowById(tx, refundRow.order_id), 'admin', tx);
    const refund = viewRefund(tx.get(`SELECT * FROM refunds WHERE id = ?`, refundRow.id));
    event(tx, o.id, o.status, o.status, actor, 'refund ' + Commerce.rupees(refund.amount) + ' ' + result + (refund.gatewayRefundId ? ' · ' + refund.gatewayRefundId : ''));
    if (result === 'processed') {
      if (refundRow.return_id) tx.run(`UPDATE return_requests SET status = 'refunded', refund_id = ?, updated_at = ? WHERE id = ? AND status = 'received'`, refundRow.id, now(), refundRow.return_id);
      notify.enqueue(tx, { orderId: o.id, template: 'refund_processed', email: o.customer.email, phone: o.customer.phone, ctx: ctxFor(o, { refund }), dedupeKey: 'refund:' + refund.id + ':processed' });
    }
    if (result === 'failed') audit(tx, actor, 'refund.failed', refundRow.id, { error: refundRow.error });
    return true;
  }

  async function createRefund({ orderId, amount, reason, returnId, actor, manual, reference }) {
    amount = parseInt(amount, 10);
    if (!(amount > 0)) throw new HttpError(422, 'bad-amount', 'The refund amount must be more than zero');
    /* Phase 1: write it down. */
    const created = db.tx((tx) => {
      const row = rowById(tx, orderId);
      if (!row) throw new HttpError(404, 'no-order');
      if (!Commerce.isPaid(row.pay_status)) throw new HttpError(422, 'not-paid', 'Nothing has been paid on this order yet');
      const o = view(row, 'admin', tx);
      if (amount > o.refundable) throw new HttpError(422, 'over-refund', 'Only ' + Commerce.rupees(o.refundable) + ' can still be refunded on this order', { refundable: o.refundable });
      if (returnId) {
        const r = tx.get(`SELECT * FROM return_requests WHERE id = ? AND order_id = ?`, returnId, orderId);
        if (!r) throw new HttpError(404, 'no-return');
        if (r.refund_id) throw new HttpError(422, 'already-refunded', 'That return already has a refund');
        const open = tx.get(`SELECT id FROM refunds WHERE return_id = ? AND status != 'failed'`, returnId);
        if (open) throw new HttpError(422, 'already-refunded', 'That return already has a refund in progress');
      }
      const channel = manual || Commerce.isOffline(row.pay_method) || !row.gateway_payment_id || String(row.gateway_payment_id).startsWith('manual:') ? 'manual' : 'gateway';
      if (channel === 'manual' && !manual && !reference) throw new HttpError(422, 'manual-needed', 'This order was not paid through the gateway — record the bank transfer you made, with its reference', { channel: 'manual' });
      const id = uuid(), at = now();
      tx.run(`INSERT INTO refunds (id, order_id, return_id, amount, reason, channel, status, gateway_payment_id, reference, created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
        id, orderId, returnId || null, amount, str(reason, 300), channel, channel === 'gateway' ? row.gateway_payment_id : null, reference ? str(reference, 80) : null, actor, at, at);
      recomputePayStatus(tx, orderId);
      const refundRow = tx.get(`SELECT * FROM refunds WHERE id = ?`, id);
      audit(tx, actor, 'refund.create', id, { orderId, amount, channel, returnId });
      if (channel === 'manual') settleRefund(tx, refundRow, 'processed', actor);
      return refundRow;
    });
    if (created.channel === 'manual') return viewRefund(db.get(`SELECT * FROM refunds WHERE id = ?`, created.id));

    /* Phase 2: ask the gateway, outside the write lock. */
    let g;
    try {
      g = await gateway.createRefund({ paymentId: created.gateway_payment_id, amount, receipt: created.id, notes: { refund_id: created.id, order_id: orderId, reason: str(reason, 100) } });
    } catch (e) {
      db.tx((tx) => {
        const fresh = tx.get(`SELECT * FROM refunds WHERE id = ?`, created.id);
        if (e instanceof GatewayError && e.ambiguous) {
          /* Maybe it went through. Leave it pending — it still counts against
             the balance — and let reconcile() find out. */
          tx.run(`UPDATE refunds SET error = ?, updated_at = ? WHERE id = ?`, 'unconfirmed: ' + e.message, now(), created.id);
          const ord = rowById(tx, orderId);
          event(tx, orderId, ord.status, ord.status, actor, 'refund ' + Commerce.rupees(amount) + ' UNCONFIRMED — reconcile before retrying');
        } else {
          tx.run(`UPDATE refunds SET error = ?, updated_at = ? WHERE id = ?`, String(e.message || e).slice(0, 300), now(), created.id);
          settleRefund(tx, Object.assign(fresh, { error: e.message }), 'failed', actor);
        }
      });
      throw e instanceof GatewayError ? new HttpError(e.ambiguous ? 502 : 422, e.code, e.ambiguous ? 'The gateway did not answer. The refund is recorded as unconfirmed — use Reconcile before trying again.' : 'The gateway refused the refund: ' + e.message) : e;
    }
    return db.tx((tx) => {
      const fresh = tx.get(`SELECT * FROM refunds WHERE id = ?`, created.id);
      tx.run(`UPDATE refunds SET gateway_refund_id = ?, updated_at = ? WHERE id = ?`, g.id, now(), created.id);
      /* Razorpay answers 'processed' for instant refunds and 'pending' for
         the rest; the webhook finishes the rest. */
      if (g.status === 'processed') settleRefund(tx, Object.assign(fresh, { gateway_refund_id: g.id }), 'processed', actor);
      else tx.run(`UPDATE refunds SET status = 'processing' WHERE id = ? AND status = 'pending'`, created.id);
      return viewRefund(tx.get(`SELECT * FROM refunds WHERE id = ?`, created.id));
    });
  }

  /* Ask the gateway what it has for this refund and settle accordingly.
     Safe to call any number of times. */
  async function reconcileRefund({ refundId, actor }) {
    const r = db.get(`SELECT * FROM refunds WHERE id = ?`, refundId);
    if (!r) throw new HttpError(404, 'no-refund');
    if (r.channel !== 'gateway') return viewRefund(r);
    const list = await gateway.fetchRefunds(r.gateway_payment_id);
    const match = list.find((x) => x.id === r.gateway_refund_id || (x.notes && x.notes.refund_id === r.id) || x.receipt === r.id);
    return db.tx((tx) => {
      const fresh = tx.get(`SELECT * FROM refunds WHERE id = ?`, refundId);
      if (match) {
        if (!fresh.gateway_refund_id) tx.run(`UPDATE refunds SET gateway_refund_id = ?, error = NULL, updated_at = ? WHERE id = ?`, match.id, now(), refundId);
        if (match.status === 'processed') settleRefund(tx, Object.assign(fresh, { gateway_refund_id: match.id }), 'processed', actor);
        else if (match.status === 'failed') settleRefund(tx, fresh, 'failed', actor);
        else tx.run(`UPDATE refunds SET status = 'processing', error = NULL, updated_at = ? WHERE id = ? AND status = 'pending'`, now(), refundId);
      } else if (fresh.status === 'pending') {
        /* The gateway never got it: it is safe to try again. */
        tx.run(`UPDATE refunds SET error = ? WHERE id = ?`, 'not found at gateway — nothing was refunded', refundId);
        settleRefund(tx, fresh, 'failed', actor);
      }
      audit(tx, actor, 'refund.reconcile', refundId, { found: !!match, status: match && match.status });
      return viewRefund(tx.get(`SELECT * FROM refunds WHERE id = ?`, refundId));
    });
  }

  /* ── webhooks ─────────────────────────────────────────────────────────── */
  function handleWebhook({ rawBody, signature, eventId }) {
    if (!gateway.verifyWebhook(rawBody, signature)) throw new HttpError(400, 'bad-signature', 'Webhook signature does not verify');
    let evt;
    try { evt = JSON.parse(rawBody); } catch (_) { throw new HttpError(400, 'bad-json'); }
    const id = eventId || evt.id || sha256(rawBody);
    const type = String(evt.event || '');
    const ins = db.run(`INSERT OR IGNORE INTO webhook_events (event_id, provider, type, payload_json, received_at) VALUES (?, ?, ?, ?, ?)`, id, gateway.name, type, rawBody, now());
    if (!ins.changes) return { duplicate: true };
    let result = 'ignored';
    try {
      const pl = evt.payload || {};
      if (type === 'payment.captured' || type === 'order.paid') {
        const p = pl.payment && pl.payment.entity;
        if (p && p.order_id) { const r = markPaid({ gatewayOrderId: p.order_id, paymentId: p.id, via: 'webhook' }); result = !r.found ? 'no-order' : r.changed ? 'paid' : 'already-paid'; }
      } else if (type === 'payment.failed') {
        const p = pl.payment && pl.payment.entity;
        if (p && p.order_id) db.tx((tx) => {
          const row = tx.get(`SELECT * FROM orders WHERE gateway_order_id = ?`, p.order_id);
          if (row && row.pay_status === 'pending') { tx.run(`UPDATE orders SET pay_status = 'failed', updated_at = ? WHERE id = ? AND pay_status = 'pending'`, now(), row.id); event(tx, row.id, row.status, row.status, 'system:webhook', 'payment attempt failed: ' + ((p.error_description || p.error_code) || 'declined')); result = 'failed-recorded'; }
        });
      } else if (type === 'refund.processed' || type === 'refund.failed' || type === 'refund.created') {
        const rf = pl.refund && pl.refund.entity;
        if (rf) db.tx((tx) => {
          const row = tx.get(`SELECT * FROM refunds WHERE gateway_refund_id = ? OR id = ?`, rf.id, (rf.notes && rf.notes.refund_id) || rf.receipt || '');
          if (!row) { result = 'no-refund'; return; }
          if (!row.gateway_refund_id) tx.run(`UPDATE refunds SET gateway_refund_id = ? WHERE id = ?`, rf.id, row.id);
          if (type === 'refund.processed') result = settleRefund(tx, Object.assign(row, { gateway_refund_id: rf.id }), 'processed', 'system:webhook') ? 'refund-processed' : 'already-settled';
          else if (type === 'refund.failed') { tx.run(`UPDATE refunds SET error = ? WHERE id = ?`, 'gateway reported failure', row.id); result = settleRefund(tx, row, 'failed', 'system:webhook') ? 'refund-failed' : 'already-settled'; }
          else result = 'noted';
        });
      }
      db.run(`UPDATE webhook_events SET processed_at = ?, result = ? WHERE event_id = ?`, now(), result, id);
    } catch (e) {
      db.run(`UPDATE webhook_events SET processed_at = ?, result = ? WHERE event_id = ?`, now(), 'error: ' + (e.message || e), id);
      throw e;
    }
    return { duplicate: false, result };
  }

  /* ── dashboard helpers ────────────────────────────────────────────────── */
  function attention() {
    const late = db.all(`SELECT * FROM orders WHERE status = 'cancelled' AND pay_status IN ('paid','partially refunded')`).map((r) => view(r, 'admin'));
    const unconfirmed = db.all(`SELECT * FROM refunds WHERE status = 'pending' AND channel = 'gateway' AND error IS NOT NULL`).map(viewRefund);
    const doubles = db.all(`SELECT * FROM audit_log WHERE action = 'payment.double-capture' ORDER BY at DESC LIMIT 50`);
    const failedNotifs = db.all(`SELECT id, order_id, channel, recipient, template, error, attempts FROM notifications WHERE status = 'failed' ORDER BY created_at DESC LIMIT 50`);
    return { paidButCancelled: late.filter((o) => o.refundable > 0), unconfirmedRefunds: unconfirmed, doubleCaptures: doubles.map((d) => ({ at: d.at, orderId: d.target, detail: J(d.detail_json, {}) })), failedNotifications: failedNotifs };
  }
  function listNotifications({ orderId, status, limit }) {
    const where = [], p = [];
    if (orderId) { where.push('order_id = ?'); p.push(orderId); }
    if (status) { where.push('status = ?'); p.push(status); }
    return db.all(`SELECT n.*, o.ref AS order_ref FROM notifications n LEFT JOIN orders o ON o.id = n.order_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY n.created_at DESC LIMIT ?`, ...p, Math.min(limit || 200, 1000))
      .map((n) => ({ id: n.id, orderId: n.order_id, orderRef: n.order_ref, channel: n.channel, to: n.recipient, template: n.template, subject: n.subject, body: n.body, status: n.status, attempts: n.attempts, at: n.created_at, sentAt: n.sent_at, error: n.error }));
  }

  seedStock();

  return {
    settings, putSetting, seedStock, stockOf, policy,
    view, listOrders, getForCustomer, findByRef, rowById,
    createOrder, verifyCheckout, markPaid, abandon, expirePending,
    changeStatus, markOfflinePaid,
    requestReturn, listReturns, decideReturn,
    createRefund, reconcileRefund,
    handleWebhook, attention, listNotifications
  };
}

module.exports = { create };
