/* =============================================================================
   a1opticals/commerce.js — the order lifecycle, shared by browser and server
   -----------------------------------------------------------------------------
   What happens to an order AFTER it is paid: which status can follow which,
   when a return is allowed and for how long, how much of a payment can still
   be refunded, and the words of every message the customer receives.

   One file, two runtimes. The storefront loads it as window.Commerce; the API
   (api/) requires it as a module. The rules are therefore the same rules
   wherever they are checked — the browser uses them to decide what to show,
   the server uses them to decide what to allow. The server's answer is the
   one that counts.

   Nothing here touches storage, the DOM or the network. Money is integer
   paise, as everywhere else in this codebase.
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Commerce = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── order status ──────────────────────────────────────────────────────────
     PENDING is an order that exists on the server but whose gateway payment
     has not been captured. It never shows the customer as "confirmed", and
     it expires (stock released) if the payment does not arrive. STATUS is
     the list the owner picks from; PENDING is not in it because the owner
     never sets it by hand. */
  var PENDING = 'pending payment';
  var STATUS = ['confirmed', 'awaiting prescription', 'in lab', 'packed', 'shipped', 'ready to collect', 'delivered', 'cancelled'];

  /* Which status may follow which. Delivered and cancelled are terminal —
     what happens after delivery is a return, which is its own record with
     its own states, so an order's history is never rewritten. */
  var TRANSITIONS = {
    'pending payment':       ['confirmed', 'awaiting prescription', 'cancelled'],
    'confirmed':             ['awaiting prescription', 'in lab', 'packed', 'shipped', 'ready to collect', 'delivered', 'cancelled'],
    'awaiting prescription': ['confirmed', 'in lab', 'packed', 'cancelled'],
    'in lab':                ['packed', 'shipped', 'ready to collect', 'cancelled'],
    'packed':                ['shipped', 'ready to collect', 'delivered', 'cancelled'],
    'shipped':               ['delivered', 'cancelled'],
    'ready to collect':      ['delivered', 'cancelled'],
    'delivered':             [],
    'cancelled':             []
  };
  function canTransition(from, to) {
    var next = TRANSITIONS[from];
    return !!next && next.indexOf(to) > -1;
  }
  function nextStatuses(from) { return (TRANSITIONS[from] || []).slice(); }

  /* Which customer message a status change triggers, if any. */
  var STATUS_NOTIFICATION = {
    'shipped': 'order_shipped',
    'ready to collect': 'order_ready',
    'delivered': 'order_delivered',
    'cancelled': 'order_cancelled',
    'awaiting prescription': 'order_awaiting_rx'
  };
  function notificationFor(status) { return STATUS_NOTIFICATION[status] || null; }

  /* ── payment status ─────────────────────────────────────────────────────── */
  var PAY = {
    PENDING: 'pending',                 /* gateway order created, nothing captured */
    PAID: 'paid',
    FAILED: 'failed',
    AWAITING_TRANSFER: 'awaiting transfer',
    PAY_ON_DELIVERY: 'pay on delivery',
    PAY_ON_COLLECTION: 'pay on collection',
    ON_ACCOUNT: 'on account',
    PARTIAL: 'partially refunded',
    REFUNDED: 'refunded'
  };
  /* Money that was actually received and can therefore be sent back. */
  function isPaid(payStatus) {
    return payStatus === PAY.PAID || payStatus === PAY.PARTIAL || payStatus === PAY.REFUNDED;
  }
  /* Methods that never go through the gateway: a refund is a bank transfer
     the owner makes and records, not an API call. */
  function isOffline(method) {
    return /transfer|delivery|store|account|cash/i.test(String(method || ''));
  }

  /* ── returns ────────────────────────────────────────────────────────────── */
  var RETURN_STATUS = ['requested', 'approved', 'rejected', 'received', 'refunded', 'cancelled'];
  var RETURN_TRANSITIONS = {
    requested: ['approved', 'rejected', 'cancelled'],
    approved:  ['received', 'rejected', 'cancelled'],
    received:  ['refunded'],
    rejected:  [], refunded: [], cancelled: []
  };
  function canReturnTransition(from, to) {
    var n = RETURN_TRANSITIONS[from]; return !!n && n.indexOf(to) > -1;
  }
  function returnOpen(r) { return r.status === 'requested' || r.status === 'approved' || r.status === 'received'; }

  var DEFAULT_POLICY = { retailDays: 14, tradeDays: 7, email: 'refund@a1opticals.com', excludeCats: [] };

  /* Quantity of each order line that has not already gone back. Returns
     [{ idx, item, left }] over order.items. */
  function returnableItems(order, policy) {
    policy = policy || DEFAULT_POLICY;
    var taken = {};
    (order.returns || []).forEach(function (r) {
      if (r.status === 'rejected' || r.status === 'cancelled') return;
      (r.items || []).forEach(function (it) { taken[it.idx] = (taken[it.idx] || 0) + it.qty; });
    });
    var out = [];
    (order.items || []).forEach(function (it, idx) {
      var left = it.qty - (taken[idx] || 0);
      if (left <= 0) return;
      /* Trade lenses cut to a per-line prescription are not stock and cannot
         go back on the shelf; the policy page says so. */
      if (order.mode === 'trade' && it.needsRx) return;
      if (it.cat && (policy.excludeCats || []).indexOf(it.cat) > -1) return;
      out.push({ idx: idx, item: it, left: left });
    });
    return out;
  }

  /* Can this customer start a return on this order right now?
       { ok:true, until, days, items }
       { ok:false, reason: 'not-delivered' | 'no-delivery-date' | 'window-closed'
                           | 'guest' | 'refunded' | 'open-return' | 'nothing-left', until? } */
  function returnEligibility(order, policy, now) {
    policy = policy || DEFAULT_POLICY;
    now = now || Date.now();
    if (order.status !== 'delivered') return { ok: false, reason: 'not-delivered' };
    var from = order.deliveredAt ? Date.parse(order.deliveredAt) : NaN;
    if (isNaN(from)) return { ok: false, reason: 'no-delivery-date' };
    var days = order.mode === 'trade' ? policy.tradeDays : policy.retailDays;
    var until = new Date(from + days * 864e5).toISOString();
    if (now > from + days * 864e5) return { ok: false, reason: 'window-closed', until: until, days: days };
    if (!order.registered) return { ok: false, reason: 'guest', until: until, days: days };
    if (order.payment && order.payment.status === PAY.REFUNDED) return { ok: false, reason: 'refunded', until: until, days: days };
    if ((order.returns || []).some(returnOpen)) return { ok: false, reason: 'open-return', until: until, days: days };
    var items = returnableItems(order, policy);
    if (!items.length) return { ok: false, reason: 'nothing-left', until: until, days: days };
    return { ok: true, until: until, days: days, items: items };
  }

  /* Validate a customer's return request against what is returnable.
     items: [{ idx, qty }]. Returns { ok, items } or { ok:false, reason }. */
  function normaliseReturnItems(order, items, policy) {
    var can = returnableItems(order, policy);
    var byIdx = {};
    can.forEach(function (c) { byIdx[c.idx] = c; });
    var out = [];
    if (!items || !items.length) return { ok: false, reason: 'no-items' };
    for (var i = 0; i < items.length; i++) {
      var idx = parseInt(items[i].idx, 10), qty = parseInt(items[i].qty, 10);
      if (isNaN(idx) || !byIdx[idx]) return { ok: false, reason: 'not-returnable', idx: idx };
      if (isNaN(qty) || qty < 1 || qty > byIdx[idx].left) return { ok: false, reason: 'bad-qty', idx: idx, max: byIdx[idx].left };
      out.push({ idx: idx, qty: qty, sku: byIdx[idx].item.sku, name: byIdx[idx].item.name });
    }
    return { ok: true, items: out };
  }

  /* ── refunds ────────────────────────────────────────────────────────────── */
  function refundedSoFar(order) {
    return (order.refunds || []).reduce(function (n, r) {
      return r.status === 'failed' || r.status === 'cancelled' ? n : n + (r.amount || 0);
    }, 0);
  }
  /* How much can still go back: what was paid, less what already has. Only
     money that arrived can leave; an unpaid or pay-on-delivery order has
     nothing to refund through the gateway. */
  function refundable(order) {
    if (!order.payment || !isPaid(order.payment.status)) return 0;
    return Math.max(0, (order.total || 0) - refundedSoFar(order));
  }
  /* The refund a return is worth: each line's net share of the quantity
     coming back, and the delivery charge only when the whole order is going
     back — a customer who keeps one of two pairs still had it delivered. */
  function refundForReturn(order, items) {
    var amount = 0, all = true;
    var returning = {};
    (items || []).forEach(function (it) { returning[it.idx] = (returning[it.idx] || 0) + it.qty; });
    (order.items || []).forEach(function (line, idx) {
      var q = returning[idx] || 0;
      if (q < line.qty) all = false;
      if (q) amount += Math.round((line.net != null ? line.net : line.gross) * q / line.qty);
    });
    /* Anything already returned counts toward "all of it". */
    (order.returns || []).forEach(function (r) {
      if (r.status !== 'refunded' && r.status !== 'received') return;
      (r.items || []).forEach(function (it) { returning[it.idx] = (returning[it.idx] || 0) + it.qty; });
    });
    all = (order.items || []).every(function (line, idx) { return (returning[idx] || 0) >= line.qty; });
    if (all) amount += order.shipping || 0;
    return Math.min(amount, refundable(order));
  }
  function payStatusAfterRefund(order, amount) {
    var done = refundedSoFar(order) + amount;
    return done >= (order.total || 0) ? PAY.REFUNDED : PAY.PARTIAL;
  }

  /* ── ids and references ─────────────────────────────────────────────────── */
  /* "A1-260918-0042": the day, then a counter. Sortable, sayable on the phone,
     and unique by construction because the counter is a database sequence per
     day (server) or a checked counter (preview) — not four random digits. */
  function refFor(date, seq, trade) {
    var d = date instanceof Date ? date : new Date(date);
    var stamp = String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    return (trade ? 'A1T-' : 'A1-') + stamp + '-' + String(seq).padStart(4, '0');
  }

  /* ── money, for the templates ───────────────────────────────────────────── */
  function rupees(paise) {
    var neg = paise < 0;
    var whole = Math.round(Math.abs(paise)) / 100;
    var s;
    try { s = whole.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }
    catch (e) { s = String(whole); }
    return (neg ? '−' : '') + '₹' + s;
  }
  function dateLong(iso) {
    try { return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }); }
    catch (e) { return String(iso).slice(0, 10); }
  }

  /* ── notifications ──────────────────────────────────────────────────────────
     render(template, ctx) → { subject, text, wa }
       ctx.order      the order (with customer, items, delivery, payment)
       ctx.brand      'A1 Opticals'
       ctx.contact    { phone, email, whatsapp }
       ctx.policy     the returns policy (email, days)
       ctx.links      { track, account, order }  absolute URLs
       ctx.ret        the return request (return_* templates)
       ctx.refund     the refund (refund_* templates)
       ctx.code       the OTP (otp template)
       ctx.note       owner's note (return_rejected)
     The text is plain: a receipt should read the same in every mail client
     and in a WhatsApp bubble. */
  function itemsText(order) {
    return (order.items || []).map(function (i) {
      return '  ' + i.qty + ' × ' + i.name + (i.variant ? ' · ' + i.variant : '') + (i.lens ? ' · ' + i.lens : '') +
             (i.free ? ' (' + i.free + ' free)' : '') + ' — ' + rupees(i.net != null ? i.net : i.gross);
    }).join('\n');
  }
  function deliveryText(order) {
    var d = order.delivery || {};
    if (d.method === 'collect') return 'Collect from ' + (d.storeName || 'the store');
    if (d.method === 'courier') return 'By courier, ' + (d.days || '4–7 working days');
    return 'Our van' + (order.customer && order.customer.slot ? ', ' + order.customer.slot.toLowerCase() : '');
  }
  function returnsLine(ctx) {
    var o = ctx.order, p = ctx.policy || DEFAULT_POLICY, links = ctx.links || {};
    var days = o.mode === 'trade' ? p.tradeDays : p.retailDays;
    if (o.registered) {
      return 'Returns: you have ' + days + ' days from delivery. Sign in with this email at ' + (links.account || 'your account') +
             ' and choose “Return or refund” on the order.';
    }
    return 'Returns: this order was placed as a guest, so it is not in an online account. To return anything or ask for a ' +
           'refund within ' + days + ' days of delivery, email ' + p.email + ' quoting order ' + o.ref + '.';
  }
  function sig(ctx) {
    var c = ctx.contact || {};
    return '\n— ' + (ctx.brand || 'A1 Opticals') + (c.phone ? ' · ' + c.phone : '') + (c.email ? ' · ' + c.email : '');
  }

  var TEMPLATES = {
    otp: function (ctx) {
      return {
        subject: 'Your ' + (ctx.brand || 'A1 Opticals') + ' sign-in code: ' + ctx.code,
        text: 'Your sign-in code is ' + ctx.code + '. It works for 10 minutes and once only.\n\nIf you did not ask for it, ignore this email — nothing happens without the code.' + sig(ctx),
        wa: (ctx.brand || 'A1 Opticals') + ': your sign-in code is ' + ctx.code + '. It expires in 10 minutes.'
      };
    },
    order_confirmed: function (ctx) {
      var o = ctx.order, pay = o.payment || {}, links = ctx.links || {};
      var payLine = pay.status === PAY.AWAITING_TRANSFER ? 'Held for your bank transfer — it goes into work the moment the credit shows.'
        : /pay on/.test(pay.status || '') ? 'Pay ' + rupees(o.total) + ' on ' + (pay.status === PAY.PAY_ON_COLLECTION ? 'collection' : 'delivery') + '.'
        : pay.status === PAY.ON_ACCOUNT ? 'On your credit account, invoice due in 30 days.'
        : 'Paid ' + rupees(o.total) + ' by ' + String(pay.method || '').replace(/ \(preview\)/, '') + (pay.paymentId ? ' · ref ' + pay.paymentId : '') + '.';
      var rxLine = '';
      if (o.items.some(function (i) { return i.needsRx; }) && o.mode !== 'trade') {
        var rx = o.rx || {};
        rxLine = !rx.method || rx.method === 'later' ? '\n\nWe still need your prescription — reply to this email with a photo, or add it from your account. Nothing is cut until we have it.'
          : rx.method === 'call' ? '\n\nWe will ring ' + (o.customer.phone || 'you') + ' within the hour for your power.'
          : rx.method === 'photo' ? '\n\nWe read your prescription photo and confirm the power on WhatsApp before cutting.'
          : '\n\nLenses are cut to the power you gave us. Change it free within 24 hours.';
      }
      return {
        subject: 'Order ' + o.ref + ' confirmed · ' + rupees(o.total),
        text: 'Thank you, ' + (o.customer.name || '').split(' ')[0] + '.\n\nOrder ' + o.ref + ' is confirmed.\n\n' + itemsText(o) +
              (o.discount ? '\n  Offer: −' + rupees(o.discount) : '') + '\n  Delivery: ' + (o.shipping ? rupees(o.shipping) : 'free') +
              '\n  Total: ' + rupees(o.total) + '\n\n' + payLine + '\nDelivery: ' + deliveryText(o) + '.' + rxLine +
              (links.track ? '\n\nTrack it: ' + links.track : '') + '\n\n' + returnsLine(ctx) + sig(ctx),
        wa: (ctx.brand || 'A1 Opticals') + ': order ' + o.ref + ' received, ' + o.items.reduce(function (n, i) { return n + i.qty; }, 0) + ' item(s), ' + rupees(o.total) + '. ' +
            (o.items.some(function (i) { return i.needsRx; }) && (!o.rx || o.rx.method === 'later') ? 'Reply with a photo of your prescription to get started.' : 'We will message again when it is ' + ((o.delivery || {}).method === 'collect' ? 'ready to collect' : 'on its way') + '.')
      };
    },
    order_awaiting_rx: function (ctx) {
      var o = ctx.order;
      return {
        subject: 'Order ' + o.ref + ' — we need your prescription',
        text: 'Order ' + o.ref + ' is waiting on your prescription. Reply to this email with a photo of it, add it from your account, or bring it to the store. The lab starts the moment we have it.' + sig(ctx),
        wa: (ctx.brand || 'A1 Opticals') + ': order ' + o.ref + ' is waiting on your prescription — reply with a photo and we start cutting.'
      };
    },
    order_shipped: function (ctx) {
      var o = ctx.order, d = o.delivery || {}, links = ctx.links || {};
      var how = d.method === 'courier' ? 'It is with the courier — allow ' + (d.days || '4–7 working days') + (d.tracking ? '. Tracking: ' + d.tracking : '.')
        : 'It is on our van' + (o.customer && o.customer.slot ? ' for ' + o.customer.slot.toLowerCase() : '') + '. The driver messages you before arriving.';
      return {
        subject: 'Order ' + o.ref + ' is on its way',
        text: 'Order ' + o.ref + ' has been dispatched.\n\n' + how + (links.track ? '\n\nTrack it: ' + links.track : '') + sig(ctx),
        wa: (ctx.brand || 'A1 Opticals') + ': order ' + o.ref + ' is on its way. ' + how
      };
    },
    order_ready: function (ctx) {
      var o = ctx.order, d = o.delivery || {};
      return {
        subject: 'Order ' + o.ref + ' is ready to collect',
        text: 'Order ' + o.ref + ' is ready at ' + (d.storeName || 'the store') + (d.storeAddress ? ', ' + d.storeAddress : '') + (d.storeHours ? ' (' + d.storeHours + ')' : '') + '. Ask for the reference at the counter.' +
              (o.payment && o.payment.status === PAY.PAY_ON_COLLECTION ? ' ' + rupees(o.total) + ' to pay when you collect — cash, card or UPI.' : '') + ' We hold it for 7 days.' + sig(ctx),
        wa: (ctx.brand || 'A1 Opticals') + ': order ' + o.ref + ' is ready to collect at ' + (d.storeName || 'the store') + '. Ask for the reference at the counter.'
      };
    },
    order_delivered: function (ctx) {
      var o = ctx.order, d = o.delivery || {}, p = ctx.policy || DEFAULT_POLICY, links = ctx.links || {};
      var days = o.mode === 'trade' ? p.tradeDays : p.retailDays;
      var until = o.deliveredAt ? dateLong(new Date(Date.parse(o.deliveredAt) + days * 864e5).toISOString()) : days + ' days from today';
      var how = o.registered
        ? 'To return or exchange anything, sign in with this email at ' + (links.account || 'your account') + ' and choose “Return or refund” on order ' + o.ref + '. You have until ' + until + '.'
        : 'This order was placed as a guest, so there is no online account to return it from. To return anything or ask for a refund, email ' + p.email + ' with your order reference ' + o.ref + ' — you have until ' + until + '.';
      return {
        subject: 'Order ' + o.ref + ' ' + (d.method === 'collect' ? 'collected' : 'delivered') + ' — ' + days + '-day returns start today',
        text: 'Order ' + o.ref + ' was ' + (d.method === 'collect' ? 'collected' : 'delivered') + ' today. We hope the fit is right.\n\n' + how +
              '\n\nAnything wrong with the power or the fit is our problem to fix — the same ' + days + ' days apply, including to powered lenses.' + sig(ctx),
        wa: (ctx.brand || 'A1 Opticals') + ': order ' + o.ref + ' delivered. ' + days + '-day returns start today — ' +
            (o.registered ? 'sign in to your account to start one.' : 'email ' + p.email + ' quoting ' + o.ref + '.')
      };
    },
    order_cancelled: function (ctx) {
      var o = ctx.order, paid = o.payment && isPaid(o.payment.status);
      return {
        subject: 'Order ' + o.ref + ' cancelled',
        text: 'Order ' + o.ref + ' has been cancelled.' + (paid ? ' Your payment of ' + rupees(o.total) + ' goes back to the same method; the bank usually shows it within 5–7 working days and we email you when it is sent.' : '') + (ctx.note ? '\n\n' + ctx.note : '') + sig(ctx),
        wa: (ctx.brand || 'A1 Opticals') + ': order ' + o.ref + ' cancelled.' + (paid ? ' Your refund is on its way.' : '')
      };
    },
    return_requested: function (ctx) {
      var o = ctx.order, r = ctx.ret || {};
      return {
        subject: 'Return request received · order ' + o.ref,
        text: 'We have your return request for order ' + o.ref + ':\n\n' + (r.items || []).map(function (i) { return '  ' + i.qty + ' × ' + i.name; }).join('\n') +
              (r.reason ? '\n\nReason: ' + r.reason : '') + '\n\nWe confirm within one working day and tell you how it comes back — store, van or courier label.' + sig(ctx),
        wa: (ctx.brand || 'A1 Opticals') + ': return request for order ' + o.ref + ' received. We confirm within one working day.'
      };
    },
    return_approved: function (ctx) {
      var o = ctx.order, r = ctx.ret || {};
      var how = r.method === 'store' ? 'Bring it to the store with the reference.' : r.method === 'courier' ? 'A courier label follows by email; pack it in the case and box.' : 'Our van collects it — we message you with the time.';
      return {
        subject: 'Return approved · order ' + o.ref,
        text: 'Your return for order ' + o.ref + ' is approved. ' + how + (ctx.note ? '\n\n' + ctx.note : '') + '\n\nThe refund' + (r.amount ? ' of ' + rupees(r.amount) : '') + ' goes back to the original payment method within five working days of receipt.' + sig(ctx),
        wa: (ctx.brand || 'A1 Opticals') + ': return for order ' + o.ref + ' approved. ' + how
      };
    },
    return_rejected: function (ctx) {
      var o = ctx.order;
      return {
        subject: 'About your return request · order ' + o.ref,
        text: 'We looked at your return request for order ' + o.ref + ' and cannot accept it' + (ctx.note ? ':\n\n' + ctx.note : '.') + '\n\nIf you think we have this wrong, reply to this email or call the store.' + sig(ctx),
        wa: (ctx.brand || 'A1 Opticals') + ': we could not accept the return for order ' + o.ref + ' — details by email.'
      };
    },
    return_received: function (ctx) {
      var o = ctx.order, r = ctx.ret || {};
      return {
        subject: 'Return received · order ' + o.ref,
        text: 'We have received your return for order ' + o.ref + '.' + (r.amount ? ' A refund of ' + rupees(r.amount) + ' is being sent to your original payment method — you get another email when it is done.' : '') + sig(ctx),
        wa: (ctx.brand || 'A1 Opticals') + ': return for order ' + o.ref + ' received.' + (r.amount ? ' Refund of ' + rupees(r.amount) + ' on its way.' : '')
      };
    },
    refund_processed: function (ctx) {
      var o = ctx.order, r = ctx.refund || {};
      return {
        subject: 'Refund of ' + rupees(r.amount || 0) + ' sent · order ' + o.ref,
        text: 'A refund of ' + rupees(r.amount || 0) + ' for order ' + o.ref + ' has been ' + (r.channel === 'manual' ? 'transferred' : 'sent to your original payment method') + (r.reference ? ' (ref ' + r.reference + ')' : '') + '. Banks usually show it within 5–7 working days; UPI and wallets often the same day.' + (r.reason ? '\n\nReason: ' + r.reason : '') + sig(ctx),
        wa: (ctx.brand || 'A1 Opticals') + ': refund of ' + rupees(r.amount || 0) + ' for order ' + o.ref + ' sent. Allow 5–7 working days.'
      };
    },
    owner_new_order: function (ctx) {
      var o = ctx.order;
      return {
        subject: 'New order ' + o.ref + ' · ' + rupees(o.total) + (o.mode === 'trade' ? ' · trade' : ''),
        text: o.ref + ' from ' + (o.customer.shop || o.customer.name) + ' · ' + (o.customer.phone || '') + '\n\n' + itemsText(o) + '\n\nTotal ' + rupees(o.total) + ' · ' + (o.payment && o.payment.status ? o.payment.status : 'paid') + '\n' + deliveryText(o) +
              (o.items.some(function (i) { return i.needsRx; }) ? '\nPrescription: ' + (o.rx && o.rx.method !== 'later' ? o.rx.method : 'MISSING') : '') + (o.customer.notes ? '\nNotes: ' + o.customer.notes : ''),
        wa: 'New order ' + o.ref + ' · ' + rupees(o.total) + ' · ' + (o.customer.shop || o.customer.name)
      };
    },
    owner_return_requested: function (ctx) {
      var o = ctx.order, r = ctx.ret || {};
      return {
        subject: 'Return requested · ' + o.ref,
        text: (o.customer.name || '') + ' wants to return from order ' + o.ref + ':\n\n' + (r.items || []).map(function (i) { return '  ' + i.qty + ' × ' + i.name; }).join('\n') + (r.reason ? '\n\nReason: ' + r.reason : '') + '\n\nApprove or reject it from the dashboard.',
        wa: 'Return requested on ' + o.ref
      };
    }
  };

  function render(template, ctx) {
    var fn = TEMPLATES[template];
    if (!fn) throw new Error('unknown template ' + template);
    return fn(ctx || {});
  }

  return {
    PENDING: PENDING, STATUS: STATUS, TRANSITIONS: TRANSITIONS,
    canTransition: canTransition, nextStatuses: nextStatuses, notificationFor: notificationFor,
    PAY: PAY, isPaid: isPaid, isOffline: isOffline,
    RETURN_STATUS: RETURN_STATUS, canReturnTransition: canReturnTransition, returnOpen: returnOpen,
    DEFAULT_POLICY: DEFAULT_POLICY, returnableItems: returnableItems, returnEligibility: returnEligibility, normaliseReturnItems: normaliseReturnItems,
    refundedSoFar: refundedSoFar, refundable: refundable, refundForReturn: refundForReturn, payStatusAfterRefund: payStatusAfterRefund,
    refFor: refFor, rupees: rupees, dateLong: dateLong,
    templates: Object.keys(TEMPLATES), render: render
  };
}));
