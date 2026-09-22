/* =============================================================================
   api/gateway.js — the payment gateway behind one small interface
   -----------------------------------------------------------------------------
   Razorpay, with the key secret on the server and nowhere else. The browser
   gets a key_id and an order_id, opens the hosted checkout, and hands back
   a payment_id and a signature; only this file can check the signature and
   only this file can move money back.

     createOrder({ amount, receipt, notes })      → { id, amount, currency }
     verifyCheckout({ orderId, paymentId, signature }) → boolean
     verifyWebhook(rawBody, signature)             → boolean
     createRefund({ paymentId, amount, receipt, notes }) → { id, status, amount }
     fetchRefunds(paymentId)                       → [{ id, status, amount, notes, receipt }]
     fetchPayment(paymentId)                       → { id, status, amount, method }

   A GatewayError carries `ambiguous: true` when we do not know whether the
   request reached Razorpay (timeout, connection reset). Callers treat that
   differently from a definite refusal: a refund that may have gone through
   is never retried blind — it is reconciled first (fetchRefunds, matched by
   our own refund id in the notes).

   The STUB implements the same interface in memory so the whole platform —
   checkout, verify, webhooks, refunds, refund webhooks — runs end to end on
   a laptop with no account. It signs with a made-up secret, delivers its
   webhooks back to the app the same way Razorpay would, and can be told to
   fail the next call so the failure paths are tested too.
   ========================================================================== */
'use strict';

const crypto = require('node:crypto');

class GatewayError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'GatewayError';
    this.status = opts.status || 502;
    this.code = opts.code || 'gateway-error';
    this.ambiguous = !!opts.ambiguous;
    this.detail = opts.detail;
  }
}

function hmac(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* ── Razorpay ──────────────────────────────────────────────────────────── */
function razorpay(cfg) {
  const base = cfg.baseUrl || 'https://api.razorpay.com/v1';
  const auth = 'Basic ' + Buffer.from(cfg.keyId + ':' + cfg.keySecret).toString('base64');
  const timeoutMs = cfg.timeoutMs || 15000;

  async function call(method, p, body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(base + p, {
        method,
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal
      });
    } catch (e) {
      /* We do not know whether Razorpay processed it. */
      throw new GatewayError('gateway unreachable: ' + e.message, { ambiguous: true, code: 'gateway-unreachable' });
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (!res.ok) {
      const err = (data && data.error) || {};
      throw new GatewayError(err.description || ('gateway refused (' + res.status + ')'), {
        status: res.status >= 500 ? 502 : 422, code: err.code || 'gateway-refused', detail: err, ambiguous: res.status >= 500
      });
    }
    return data;
  }

  return {
    name: 'razorpay',
    keyId: cfg.keyId,
    stub: false,
    createOrder: ({ amount, receipt, notes }) => call('POST', '/orders', { amount, currency: 'INR', receipt, notes: notes || {} }),
    verifyCheckout: ({ orderId, paymentId, signature }) => safeEqual(hmac(cfg.keySecret, orderId + '|' + paymentId), signature),
    verifyWebhook: (rawBody, signature) => !!cfg.webhookSecret && safeEqual(hmac(cfg.webhookSecret, rawBody), signature),
    createRefund: ({ paymentId, amount, receipt, notes }) =>
      call('POST', '/payments/' + encodeURIComponent(paymentId) + '/refund', { amount, receipt, notes: notes || {}, speed: 'normal' }),
    fetchRefunds: async (paymentId) => (await call('GET', '/payments/' + encodeURIComponent(paymentId) + '/refunds?count=100')).items || [],
    fetchPayment: (paymentId) => call('GET', '/payments/' + encodeURIComponent(paymentId))
  };
}

/* ── Stub ──────────────────────────────────────────────────────────────── */
function stub(cfg = {}) {
  const secret = cfg.keySecret || 'stub_secret_' + crypto.randomBytes(8).toString('hex');
  const webhookSecret = cfg.webhookSecret || 'stub_webhook_' + crypto.randomBytes(8).toString('hex');
  const delay = cfg.webhookDelayMs == null ? 800 : cfg.webhookDelayMs;
  const orders = new Map(), payments = new Map(), refunds = new Map();
  let deliver = cfg.deliverWebhook || null;   // (rawBody, signature) => Promise
  const failNext = new Set();
  let n = 0;
  const id = (p) => p + '_stub' + String(++n).padStart(6, '0') + crypto.randomBytes(3).toString('hex');

  function emit(type, payload) {
    if (!deliver) return;
    const evt = { entity: 'event', event: type, created_at: Math.floor(Date.now() / 1000), payload, id: 'evt_' + crypto.randomUUID() };
    const raw = JSON.stringify(evt);
    const sig = hmac(webhookSecret, raw);
    const send = () => deliver(raw, sig, evt.id).catch(() => {});
    if (delay > 0) setTimeout(send, delay); else queueMicrotask(send);
    return evt;
  }
  function maybeFail(op) {
    if (failNext.has(op)) { failNext.delete(op); throw new GatewayError('stub: simulated ' + op + ' failure', { status: 422, code: 'stub-failure' }); }
    if (failNext.has(op + ':ambiguous')) { failNext.delete(op + ':ambiguous'); throw new GatewayError('stub: simulated timeout', { ambiguous: true, code: 'gateway-unreachable' }); }
  }

  const g = {
    name: 'stub',
    keyId: 'rzp_test_stub',
    stub: true,
    secret, webhookSecret,
    setWebhookDelivery(fn) { deliver = fn; },
    failNext(op) { failNext.add(op); },
    async createOrder({ amount, receipt, notes }) {
      maybeFail('createOrder');
      const o = { id: id('order'), amount, currency: 'INR', receipt, notes: notes || {}, status: 'created', amount_paid: 0 };
      orders.set(o.id, o);
      return { id: o.id, amount: o.amount, currency: 'INR' };
    },
    /* What the customer does in the hosted checkout: pay, or fail. Returns
       what Razorpay's handler would hand the browser. */
    pay(orderId, outcome, method) {
      const o = orders.get(orderId);
      if (!o) throw new GatewayError('stub: no such order', { status: 404, code: 'no-order' });
      const p = { id: id('pay'), order_id: orderId, amount: o.amount, currency: 'INR', method: method || 'upi',
        status: outcome === 'fail' ? 'failed' : 'captured', notes: o.notes, created_at: Math.floor(Date.now() / 1000) };
      payments.set(p.id, p);
      if (p.status === 'failed') {
        emit('payment.failed', { payment: { entity: p } });
        return { razorpay_order_id: orderId, razorpay_payment_id: p.id, razorpay_signature: 'invalid', failed: true };
      }
      o.status = 'paid'; o.amount_paid = o.amount;
      emit('payment.captured', { payment: { entity: p } });
      return { razorpay_order_id: orderId, razorpay_payment_id: p.id, razorpay_signature: hmac(secret, orderId + '|' + p.id) };
    },
    verifyCheckout: ({ orderId, paymentId, signature }) => safeEqual(hmac(secret, orderId + '|' + paymentId), signature),
    verifyWebhook: (rawBody, signature) => safeEqual(hmac(webhookSecret, rawBody), signature),
    async createRefund({ paymentId, amount, receipt, notes }) {
      maybeFail('createRefund');
      const p = payments.get(paymentId);
      if (!p || p.status !== 'captured') throw new GatewayError('stub: payment not refundable', { status: 422, code: 'not-refundable' });
      const done = [...refunds.values()].filter((r) => r.payment_id === paymentId && r.status !== 'failed').reduce((s, r) => s + r.amount, 0);
      if (done + amount > p.amount) throw new GatewayError('The refund amount exceeds the refundable amount', { status: 422, code: 'BAD_REQUEST_ERROR' });
      const r = { id: id('rfnd'), payment_id: paymentId, amount, currency: 'INR', receipt: receipt || null, notes: notes || {}, status: 'processed',
        created_at: Math.floor(Date.now() / 1000), speed_processed: 'normal' };
      refunds.set(r.id, r);
      emit('refund.processed', { refund: { entity: r }, payment: { entity: p } });
      /* Razorpay answers 'pending'/'processed' at creation; we answer as it
         does for instant-ish refunds so the app exercises the webhook path. */
      return { id: r.id, status: 'pending', amount: r.amount };
    },
    async fetchRefunds(paymentId) {
      maybeFail('fetchRefunds');
      return [...refunds.values()].filter((r) => r.payment_id === paymentId);
    },
    async fetchPayment(paymentId) {
      const p = payments.get(paymentId);
      if (!p) throw new GatewayError('stub: no such payment', { status: 404, code: 'no-payment' });
      return p;
    },
    _orders: orders, _payments: payments, _refunds: refunds
  };
  return g;
}

function create(cfg) {
  if (cfg.mode === 'razorpay') {
    if (!cfg.keyId || !cfg.keySecret) throw new Error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required when GATEWAY=razorpay');
    return razorpay(cfg);
  }
  return stub(cfg);
}

module.exports = { create, razorpay, stub, GatewayError, hmac, safeEqual };
