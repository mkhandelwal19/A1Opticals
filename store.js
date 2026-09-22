/* =============================================================================
   a1opticals/store.js — bag, money, tax, prescriptions and the checkout handshake
   -----------------------------------------------------------------------------
   Every page loads this, and nothing here touches the DOM of a specific page
   — pages ask it questions and render the answers.

   Two customers use one store:

     RETAIL — the default. Walks in from Google, buys one pair. Sees one
              all-in price with the included lens package inside it, chooses
              a lens upgrade, gives a prescription, may get Buy-1-Get-1.
     TRADE  — an optician with a trade account. Sees trade prices with volume
              tiers, buys by MOQ, needs a GSTIN on the invoice, has a ₹5,000
              minimum and own-van delivery only.

   mode() decides which; everything that prices, ships or validates asks it.

   Three rules that the rest of the file exists to keep:

   1. MONEY IS INTEGER PAISE. Never a float, never a string, never rupees.

   2. GST IS BACKED OUT, NOT ADDED ON. Indian retail prices are quoted
      inclusive of tax. The customer pays the shelf price; the invoice has to
      show what part of it was tax.

   3. THE BROWSER NEVER DECIDES THAT A PAYMENT SUCCEEDED. It cannot: anything
      the client asserts, a client can forge. The server verifies the gateway
      signature and the server alone.
   ========================================================================== */
window.Store = (function () {
  'use strict';

  var CART_KEY   = 'a1opticals_cart_v2';
  var ORDER_KEY  = 'a1opticals_orders_v1';
  var USER_KEY   = 'a1opticals_user_v1';
  var MODE_KEY   = 'a1opticals_mode_v1';
  var RX_KEY     = 'a1opticals_rx_v1';
  var STATUS_KEY = 'a1opticals_order_status_v1';
  var RESV_KEY   = 'a1opticals_reservations_v1';
  var BOOK_KEY   = 'a1opticals_bookings_v1';

  /* Where the API lives. Empty means the static preview: orders and payments
     are simulated in this browser and every page says so. Set by (in order)
     window.A1_API, a <meta name="a1-api"> tag — which api/server.js injects
     into every page it serves — or a value saved from the dashboard. */
  var API = (function () {
    try {
      if (typeof window.A1_API === 'string') return window.A1_API.replace(/\/$/, '');
      var m = document.querySelector('meta[name="a1-api"]');
      if (m && m.getAttribute('content')) return m.getAttribute('content').replace(/\/$/, '');
      var saved = localStorage.getItem('a1opticals_api_v1');
      if (saved) return JSON.parse(saved).replace(/\/$/, '');
    } catch (e) {}
    return '';
  })();

  /* ── storage, defensively ──────────────────────────────────────────────────
     localStorage throws in private windows and when a browser is set to block
     site data. A store that white-screens because storage is unavailable is
     worse than a store that forgets the bag. */
  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { return false; }
  }

  /* The trade build stored orders, the saved shop and the owner's status map
     under older keys. Carry them across once so nothing the client has
     already placed in the preview disappears. */
  (function migrate() {
    var old = [
      ['a1opticals_trade_orders_v1', ORDER_KEY],
      ['a1opticals_trade_user_v1', USER_KEY],
      ['netloom_commerce_status_v1', STATUS_KEY]
    ];
    old.forEach(function (pair) {
      try {
        var v = localStorage.getItem(pair[0]);
        if (v && !localStorage.getItem(pair[1])) localStorage.setItem(pair[1], v);
      } catch (e) {}
    });
  })();

  /* ── money ─────────────────────────────────────────────────────────────── */
  function rupees(paise) {
    var neg = paise < 0;
    var whole = Math.round(Math.abs(paise)) / 100;
    var s = whole.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    return (neg ? '−' : '') + '₹' + s;
  }

  /* ── tax ───────────────────────────────────────────────────────────────────
     price is GST-inclusive, so base = price * 100 / (100 + rate) and the tax
     is the remainder. Rounded once per line, then summed — rounding the total
     instead would drift away from the sum of the printed lines, which is the
     kind of thing that fails a GST audit. */
  function taxSplit(inclusivePaise, ratePercent) {
    var base = Math.round(inclusivePaise * 100 / (100 + ratePercent));
    return { base: base, tax: inclusivePaise - base };
  }

  /* ── customer mode ─────────────────────────────────────────────────────── */
  function getUser() { return read(USER_KEY, null); }
  function setUser(u) { write(USER_KEY, u); notify(); return u; }
  function signOut() { try { localStorage.removeItem(USER_KEY); localStorage.removeItem(MODE_KEY); } catch (e) {} notify(); }

  function mode() {
    var m = read(MODE_KEY, '');
    if (m === 'trade' || m === 'retail') return m;
    var u = getUser();
    return u && u.trade ? 'trade' : 'retail';
  }
  function setMode(m) { write(MODE_KEY, m === 'trade' ? 'trade' : 'retail'); notify(); }
  function isTrade() { return mode() === 'trade'; }
  function isTradeUser() { var u = getUser(); return !!(u && u.trade && u.gstin); }

  /* Ophthalmic lenses and instruments are trade items whoever is looking:
     they are priced and sold the trade way, and a retail visitor is pointed
     at the trade page rather than sold a slit lamp. */
  function isTradeItem(p) {
    var c = window.CATALOG.category(p.cat);
    return !!(c && c.trade);
  }
  function tradePricing(p) { return isTrade() || isTradeItem(p); }

  /* ── lens packages ─────────────────────────────────────────────────────────
     Whether a product takes a lens package, and which one it comes with.
       frames, kids  → the included package (single vision + anti-glare)
       sunglasses    → plain tinted lenses; power is an upgrade
       everything else → none */
  function lensFor(p) {
    var c = window.CATALOG.category(p.cat);
    if (!c || !c.lens) return { applies: false, defaultId: null, optional: false };
    if (c.lens === 'optional') {
      var plano = window.SITE.planoLens();
      return { applies: true, optional: true, defaultId: plano ? plano.id : null };
    }
    var inc = window.SITE.includedLens();
    return { applies: true, optional: false, defaultId: inc ? inc.id : null };
  }
  function lensOf(p, lensId) {
    var lf = lensFor(p);
    if (!lf.applies) return null;
    return window.SITE.lens(lensId || lf.defaultId) || window.SITE.lens(lf.defaultId);
  }
  /* The price difference a lens package shows against what is included. */
  function lensDelta(p, lensId) {
    var chosen = lensOf(p, lensId);
    var base = lensOf(p, null);
    if (!chosen) return 0;
    return chosen.price - (base ? base.price : 0);
  }

  /* ── pricing ───────────────────────────────────────────────────────────────
     One function, two answers. Retail: frame + lens package, all in. Trade:
     the volume-tier price for the quantity. Pages never add these up
     themselves. */
  function unitPrice(p, variantId, qty, lensId) {
    if (tradePricing(p)) return window.CATALOG.priceOf(p, variantId, qty || 1);
    var base = window.CATALOG.retailOf(p, variantId);
    var lens = lensOf(p, lensId);
    return base + (lens ? lens.price : 0);
  }
  /* The number on a card: default variant, default lens, quantity one. */
  function displayPrice(p, lensId) {
    return unitPrice(p, p.variants[0].id, 1, lensId);
  }
  /* What is struck through next to it, or 0 when there is nothing to strike. */
  function wasPrice(p, lensId) {
    if (tradePricing(p)) return 0;
    var now = displayPrice(p, lensId);
    return p.mrp > now ? p.mrp : 0;
  }
  /* "frame ₹999 + lens ₹500" — the parts of a retail price. */
  function breakdown(p, variantId, lensId) {
    var lens = lensOf(p, lensId);
    return { frame: window.CATALOG.retailOf(p, variantId), lens: lens ? lens.price : 0, lensPkg: lens };
  }
  /* The cheapest all-in price in a category, for "Eyeglasses from ₹999". */
  function fromPrice(catId) {
    var min = 0;
    window.CATALOG.products.forEach(function (p) {
      if (p.cat !== catId || p.stock === 0) return;
      var v = displayPrice(p);
      if (!min || v < min) min = v;
    });
    return min;
  }

  /* ── offers ────────────────────────────────────────────────────────────── */
  function bogoRule() { var o = window.SITE.get('offers'); return o && o.bogo && o.bogo.on ? o.bogo : null; }
  function bogoEligible(p) {
    var r = bogoRule();
    if (!r || isTrade() || isTradeItem(p)) return false;
    return r.brands.indexOf(p.brand) > -1 && r.cats.indexOf(p.cat) > -1;
  }
  /* Newness: flagged in the data, or added from the admin page. */
  function isNew(p) { return !!(p.isNew || p.custom); }

  /* ── bag ───────────────────────────────────────────────────────────────── */
  var listeners = [];
  function notify() { listeners.forEach(function (fn) { try { fn(getCart()); } catch (e) {} }); }
  function onChange(fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; }

  function getCart() { return read(CART_KEY, []); }
  function setCart(items) { write(CART_KEY, items); notify(); return items; }

  function lineId(sku, variantId, lensId) { return sku + '::' + variantId + '::' + (lensId || '-'); }

  function add(sku, variantId, qty, lensId) {
    var product = window.CATALOG.bySku(sku);
    if (!product) return { ok: false, reason: 'unknown-sku' };
    qty = Math.max(1, parseInt(qty, 10) || 1);
    var lf = lensFor(product);
    lensId = lf.applies ? (lensId || lf.defaultId) : null;
    if (tradePricing(product)) lensId = null;

    var items = getCart();
    var id = lineId(sku, variantId, lensId);
    var existing = null;
    for (var i = 0; i < items.length; i++) if (items[i].id === id) existing = items[i];

    var wanted = (existing ? existing.qty : 0) + qty;
    /* Stock is checked here AND again on the server before payment. The client
       check is a courtesy so nobody reaches checkout with an impossible bag;
       it is not the authority, because a client cannot be one. */
    if (wanted > product.stock) {
      if (product.stock === 0) return { ok: false, reason: 'out-of-stock' };
      wanted = product.stock;
      if (existing && existing.qty === wanted) return { ok: false, reason: 'stock-capped', max: product.stock };
    }

    if (existing) existing.qty = wanted;
    else items.push({ id: id, sku: sku, variant: variantId, lens: lensId, qty: wanted });

    setCart(items);
    return { ok: true, capped: wanted !== (existing ? existing.qty : qty) && wanted === product.stock, max: product.stock };
  }

  function setQty(id, qty) {
    var items = getCart();
    qty = parseInt(qty, 10) || 0;
    if (qty <= 0) return remove(id);
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === id) {
        var p = window.CATALOG.bySku(items[i].sku);
        var floor = p && tradePricing(p) ? (p.moq || 1) : 1;
        items[i].qty = p ? Math.min(Math.max(qty, floor), p.stock) : qty;
      }
    }
    return setCart(items);
  }

  /* Change the lens package on a line in place — the bag lets you switch
     without going back to the product page. */
  function setLens(id, lensId) {
    var items = getCart();
    for (var i = 0; i < items.length; i++) {
      if (items[i].id !== id) continue;
      var next = lineId(items[i].sku, items[i].variant, lensId);
      var dup = null;
      for (var j = 0; j < items.length; j++) if (items[j].id === next) dup = items[j];
      if (dup) { dup.qty += items[i].qty; items.splice(i, 1); }
      else { items[i].lens = lensId; items[i].id = next; }
      break;
    }
    return setCart(items);
  }

  function remove(id) {
    return setCart(getCart().filter(function (l) { return l.id !== id; }));
  }

  function clear() { return setCart([]); }

  function count() {
    return getCart().reduce(function (n, l) { return n + l.qty; }, 0);
  }

  /* Expand bag lines into everything a page or an invoice needs. Anything
     whose SKU has vanished from the catalogue is dropped rather than rendered
     as a broken row. */
  function lines() {
    var ls = getCart().map(function (l) {
      var p = window.CATALOG.bySku(l.sku);
      if (!p) return null;
      var lens = tradePricing(p) ? null : lensOf(p, l.lens);
      var unit = unitPrice(p, l.variant, l.qty, l.lens);
      var variant = window.CATALOG.variant(p, l.variant);
      var gross = unit * l.qty;
      var c = window.CATALOG.category(p.cat) || {};
      /* A prescription is needed for any powered lens, and for contact lenses,
         and for lenses an optician orders made to Rx. Readers carry their
         power in the variant, so they do not need one. */
      var needsRx = !isTrade() && ((lens && !lens.plano) || !!c.rx) || (isTrade() && !!p.rx);
      return {
        id: l.id, sku: l.sku, qty: l.qty, product: p,
        variant: variant || p.variants[0],
        lens: lens, lensId: l.lens || null, needsRx: needsRx,
        unit: unit, gross: gross, discount: 0, free: 0, gstRate: p.gst,
        bogo: bogoEligible(p)
      };
    }).filter(Boolean);

    /* Buy 1 Get 1: every eligible unit in the bag is laid out dearest first,
       and every second one is free. The cheapest of a pair is the free one,
       which is how the offer is worded on the shelf. */
    if (bogoRule() && !isTrade()) {
      var units = [];
      ls.forEach(function (l) { if (l.bogo) for (var i = 0; i < l.qty; i++) units.push(l); });
      units.sort(function (a, b) { return b.unit - a.unit; });
      for (var u = 1; u < units.length; u += 2) { units[u].free += 1; units[u].discount += units[u].unit; }
    }

    ls.forEach(function (l) {
      l.net = l.gross - l.discount;
      var split = taxSplit(l.net, l.gstRate);
      l.base = split.base; l.tax = split.tax;
    });
    return ls;
  }

  /* ── delivery ──────────────────────────────────────────────────────────────
     A1 delivers with its own van inside the Tricity. A PIN inside the area
     gets the van and a slot; outside it, a retail order goes by courier and a
     trade order stops with a phone number — the trade van route is the
     business, and taking a slit lamp's worth of money for a delivery that
     will not happen is worse than a lost sale.
       serviceArea(pin) → { van:true, area } | { van:false } | null (not a PIN yet) */
  function serviceArea(pin) {
    pin = String(pin || '').trim();
    if (!/^[1-9][0-9]{5}$/.test(pin)) return null;
    var areas = window.SITE.areas();
    for (var i = 0; i < areas.length; i++) if (pin.indexOf(areas[i].prefix) === 0) return { van: true, area: areas[i].area };
    return { van: false, area: null };
  }
  function areaNames() {
    var seen = {}, out = [];
    window.SITE.areas().forEach(function (a) {
      a.area.split('/').forEach(function (n) { n = n.trim(); if (n && !seen[n]) { seen[n] = 1; out.push(n); } });
    });
    return out;
  }

  /* opts.method: 'van' | 'courier' | 'collect' — decided by the PIN and the
     slot at checkout. Without it, the bag page assumes the van. */
  function shippingFor(subtotal, opts) {
    opts = opts || {};
    if (subtotal === 0 || opts.method === 'collect') return 0;
    var d = window.SITE.get('delivery');
    var rule = isTrade() ? d.trade : d.retail;
    if (subtotal >= rule.freeOver) return 0;
    if (opts.method === 'courier') return rule.courierFlat != null ? rule.courierFlat : rule.flat;
    return rule.flat;
  }

  function totals(opts) {
    opts = opts || {};
    var ls = lines();
    var gross = ls.reduce(function (n, l) { return n + l.gross; }, 0);
    var discount = ls.reduce(function (n, l) { return n + l.discount; }, 0);
    var net = gross - discount;
    var taxTotal = ls.reduce(function (n, l) { return n + l.tax; }, 0);
    var base = net - taxTotal;
    var shipping = shippingFor(net, opts);
    var d = window.SITE.get('delivery');
    var rule = isTrade() ? d.trade : d.retail;

    // GST grouped by rate, which is how it has to appear on the invoice.
    var byRate = {};
    ls.forEach(function (l) { byRate[l.gstRate] = (byRate[l.gstRate] || 0) + l.tax; });

    return {
      lines: ls,
      itemCount: ls.reduce(function (n, l) { return n + l.qty; }, 0),
      gross: gross, discount: discount, net: net,
      base: base, tax: taxTotal, byRate: byRate,
      shipping: shipping,
      total: net + shipping,
      freeShippingGap: Math.max(0, rule.freeOver - net),
      freeOver: rule.freeOver,
      minOrder: isTrade() ? rule.minOrder : 0,
      belowMin: isTrade() ? net < rule.minOrder : false,
      rxNeeded: ls.some(function (l) { return l.needsRx; }),
      mode: mode()
    };
  }

  /* ── prescription ──────────────────────────────────────────────────────────
     One prescription is kept on this browser and applied to every powered
     line, which is what almost everyone wants. A line can carry its own
     (rx on the bag line) for the household that orders three pairs at once.
       { method: 'typed'|'photo'|'call'|'later', od:{sph,cyl,axis,add}, os:{…},
         pd:{on, r, l}, photo:dataURL, savedAt } */
  function getRx() { return read(RX_KEY, null); }
  function setRx(rx) { rx.savedAt = new Date().toISOString(); write(RX_KEY, rx); notify(); return rx; }
  function clearRx() { try { localStorage.removeItem(RX_KEY); } catch (e) {} notify(); }
  function rxComplete(rx) {
    if (!rx) return false;
    if (rx.method === 'photo') return !!rx.photo;
    if (rx.method === 'call' || rx.method === 'later') return true;
    return !!(rx.od && rx.os && rx.od.sph !== '' && rx.os.sph !== '' && rx.od.sph != null && rx.os.sph != null);
  }
  function rxStrength(rx) {
    if (!rx || rx.method !== 'typed') return 0;
    var a = Math.abs(parseFloat(rx.od && rx.od.sph) || 0), b = Math.abs(parseFloat(rx.os && rx.os.sph) || 0);
    return Math.max(a, b);
  }
  function rxSummary(rx) {
    if (!rx) return '';
    if (rx.method === 'photo') return 'Photo of prescription uploaded';
    if (rx.method === 'call') return 'We will call you for it';
    if (rx.method === 'later') return 'To be added after payment';
    function eye(e) {
      if (!e) return '—';
      var s = fmtPow(e.sph);
      if (e.cyl) s += ' / ' + fmtPow(e.cyl) + ' × ' + (e.axis || '0');
      if (e.add) s += ' add ' + fmtPow(e.add);
      return s;
    }
    return 'R ' + eye(rx.od) + ' · L ' + eye(rx.os) + (rx.pd && rx.pd.on && rx.pd.r ? ' · PD ' + rx.pd.r + (rx.pd.l ? '/' + rx.pd.l : '') : '');
  }
  function fmtPow(v) {
    var n = parseFloat(v);
    if (isNaN(n)) return String(v || '0.00');
    return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(2);
  }
  /* Lens advice from the power: the banner on the prescription step. */
  function lensAdvice(rx, lensId) {
    var s = rxStrength(rx);
    var thin = window.SITE.lens('thin');
    if (!s) return null;
    if (s > 4 && lensId !== 'thin' && lensId !== 'prog' && thin) {
      return { level: 'warn', text: 'At ' + fmtPow(-s) + ' a standard 1.56 lens will show a thick edge. We recommend the ' + thin.label + ' — you can switch it in the bag.' };
    }
    return { level: 'ok', text: 'At ' + fmtPow(-s) + ' the standard 1.56 lens is fine in this frame. No upgrade needed — we will say so if that ever changes.' };
  }

  /* ── catalogue queries ─────────────────────────────────────────────────────
     Real search, filter and sort, over the data. */
  function search(opts) {
    opts = opts || {};
    var q = (opts.q || '').trim().toLowerCase();
    var cat = opts.cat || 'all';
    var sort = opts.sort || 'featured';
    var minPrice = opts.minPrice || 0;
    var maxPrice = opts.maxPrice || Infinity;
    var lensId = opts.lens || null;

    /* Attribute filters are comma-separated lists in the URL, so several
       shapes or colours can be ticked at once. A blank list means "any". */
    function list(v) { return v ? String(v).split(',').filter(Boolean) : []; }
    var want = {
      brand:    list(opts.brand),
      material: list(opts.material),
      shape:    list(opts.shape),
      colour:   list(opts.colour),
      gender:   list(opts.gender),
      type:     list(opts.type),
      width:    list(opts.width),
      offer:    list(opts.offer)
    };
    function attr(p, k) {
      if (k === 'brand') return p.brand;
      if (k === 'colour') return p.colour && p.colour.id;
      if (k === 'width') return window.CATALOG.widthBand(p);
      return (p.attrs || {})[k];
    }
    var underPrice = (window.SITE.get('offers') || {}).underPrice || 150000;
    function offerMatch(p, o) {
      if (o === 'bogo') return bogoEligible(p);
      if (o === 'under') return displayPrice(p, lensId) <= underPrice;
      if (o === 'new') return isNew(p);
      return true;
    }

    /* A strong prescription in a very wide lens is thick and heavy at the
       edge. When the visitor has saved a power above ±4.00 and asked us to,
       frames with a lens width over 54 mm step aside. */
    var strong = opts.power ? rxStrength(getRx()) > 4 : false;
    var hiddenForPower = 0;

    var priceOf = function (p) { return tradePricing(p) ? p.price : displayPrice(p, lensId); };

    var out = window.CATALOG.products.filter(function (p) {
      var c = window.CATALOG.category(p.cat) || {};
      if (cat === 'all' && c.hidden) return false;
      if (cat !== 'all' && p.cat !== cat) return false;
      var price = priceOf(p);
      if (price > maxPrice || price < minPrice) return false;
      if (opts.inStock && p.stock === 0) return false;
      for (var k in want) {
        if (!want[k].length) continue;
        if (k === 'offer') { if (!want.offer.every(function (o) { return offerMatch(p, o); })) return false; continue; }
        if (want[k].indexOf(attr(p, k)) === -1) return false;
      }
      if (strong) {
        var d = window.CATALOG.dims(p.variants[0]);
        if (d && d.lens > 54) { hiddenForPower++; return false; }
      }
      if (!q) return true;
      var hay = (p.name + ' ' + (p.style || '') + ' ' + p.sku + ' ' + p.model + ' ' + p.brand + ' ' + p.pack + ' ' + p.cat + ' ' + (c.label || '') + ' ' +
                 (p.colour ? p.colour.label : '') + ' ' + Object.keys(p.attrs || {}).map(function (k) { return p.attrs[k]; }).join(' ') + ' ' +
                 (p.blurb || '')).toLowerCase();
      // every word must appear somewhere, so "round gold" narrows instead of
      // widening the way an OR match would
      return q.split(/\s+/).every(function (w) { return hay.indexOf(w) > -1; });
    });

    out.sort(function (a, b) {
      if (sort === 'price-asc')  return priceOf(a) - priceOf(b);
      if (sort === 'price-desc') return priceOf(b) - priceOf(a);
      if (sort === 'name')       return a.name.localeCompare(b.name);
      if (sort === 'newest')     return (isNew(b) ? 1 : 0) - (isNew(a) ? 1 : 0) || b.sku.localeCompare(a.sku);
      if (sort === 'rating')     return (b.rating || 0) - (a.rating || 0);
      return 0;
    });

    /* One tile per model. Because the list is already filtered, the first
       colourway left standing is the one that matched — tick "black" and the
       tile fronts the black colourway. */
    if (opts.group) out = window.CATALOG.models(out);
    out.hiddenForPower = hiddenForPower;
    return out;
  }

  /* ── orders ────────────────────────────────────────────────────────────────
     Two homes for an order. With an API configured (see `API` above) the
     server holds them and every function below that returns a Promise talks
     to it. Without one — the static preview — they live in this browser, and
     the same Promises resolve from localStorage, running the same lifecycle
     rules (commerce.js) so the preview shows what the live store does.

     Owner edits never rewrite the order record itself: status, version,
     the event trail, returns and refunds sit in a meta map beside it. */
  var META_KEY   = 'a1opticals_order_meta_v1';
  var OUTBOX_KEY = 'a1opticals_outbox_v1';
  var SEQ_KEY    = 'a1opticals_order_seq_v1';
  var CHK_KEY    = 'a1opticals_checkout_key_v1';
  var LAST_KEY   = 'a1opticals_last_order_v1';

  var Commerce = window.Commerce;
  var ordersCache = null;   /* API mode: the last list fetched, for the sync readers */

  function uuid() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    var b = new Uint8Array(16);
    try { crypto.getRandomValues(b); } catch (e) { for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256); }
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  function orders() { return API ? (ordersCache || []) : read(ORDER_KEY, []); }
  function orderByRef(ref) {
    var all = orders();
    for (var i = 0; i < all.length; i++) if (all[i].ref === ref) return all[i];
    return null;
  }

  /* A1-260918-0007: the day, then a counter kept in this browser and checked
     against the orders already here — never four random digits. */
  function orderRef() {
    var d = new Date();
    var day = d.toISOString().slice(0, 10);
    var seq = read(SEQ_KEY, {});
    var n = (seq[day] || 0);
    var ref;
    do { n++; ref = Commerce.refFor(d, n, isTrade()); } while (read(ORDER_KEY, []).some(function (o) { return o.ref === ref; }));
    var next = {}; next[day] = n;
    write(SEQ_KEY, next);
    return ref;
  }

  /* details: the checkout form. payment: from the gateway. extra: { delivery, rx, register }. */
  function placeOrder(details, payment, extra) {
    extra = extra || {};
    var t = totals(extra.delivery ? { method: extra.delivery.method } : {});
    if (!t.lines.length) return null;
    var order = {
      id: uuid(),
      ref: orderRef(),
      placedAt: new Date().toISOString(),
      status: t.rxNeeded && extra.rx && (extra.rx.method === 'later' || extra.rx.method === 'call') ? 'awaiting prescription' : 'confirmed',
      mode: mode(),
      registered: !!extra.register,
      customer: details,
      payment: payment,
      delivery: extra.delivery || { method: 'van' },
      rx: extra.rx || null,
      items: t.lines.map(function (l) {
        return {
          sku: l.sku, name: l.product.name + (l.product.colour ? ' · ' + l.product.colour.label : ''), cat: l.product.cat,
          variant: l.variant.label, variantId: l.variant.id, lens: l.lens ? l.lens.label : null, lensId: l.lensId,
          qty: l.qty, unit: l.unit, gross: l.gross, discount: l.discount, free: l.free, net: l.net, gstRate: l.gstRate,
          hsn: l.product.hsn, photo: l.product.photo, needsRx: l.needsRx
        };
      }),
      gross: t.gross, discount: t.discount, base: t.base, tax: t.tax, byRate: t.byRate,
      shipping: t.shipping, total: t.total
    };
    var all = read(ORDER_KEY, []);
    all.unshift(order);
    write(ORDER_KEY, all);
    var m = metaOf(order.ref);
    m.status = order.status; m.version = 1;
    m.events = [{ at: order.placedAt, from: null, to: order.status, actor: 'customer', note: 'placed · ' + (payment.method || '') }];
    saveMeta(order.ref, m);
    clear();
    var h = hydrate(order);
    queueLocal(h, 'order_confirmed', {}, { email: h.customer.email, phone: h.customer.phone });
    if (h.status === 'awaiting prescription') queueLocal(h, 'order_awaiting_rx', {}, { email: h.customer.email, phone: h.customer.phone });
    queueLocal(h, 'owner_new_order', {}, { email: (window.SITE.get('contact') || {}).email });
    return hydrate(orderByRef(order.ref));
  }

  /* ── local lifecycle: meta, outbox ── */
  var STATUS = Commerce.STATUS;
  function metas() { return read(META_KEY, {}); }
  function metaOf(ref) {
    var m = metas()[ref];
    if (!m) {
      /* the trade build kept a plain status map; carry it over */
      var old = read(STATUS_KEY, {})[ref];
      m = { status: old || null, version: 1, events: [], refunds: [], returns: [] };
    }
    m.events = m.events || []; m.refunds = m.refunds || []; m.returns = m.returns || [];
    return m;
  }
  function saveMeta(ref, m) { var all = metas(); all[ref] = m; write(META_KEY, all); }
  function outbox() { return read(OUTBOX_KEY, []); }

  /* An order with its meta merged in — what the pages render. */
  function hydrate(o) {
    if (!o) return null;
    var m = metaOf(o.ref);
    var h = JSON.parse(JSON.stringify(o));
    h.id = h.id || ('local-' + h.ref);
    h.status = m.status || o.status;
    h.version = m.version || 1;
    h.events = m.events; h.refunds = m.refunds; h.returns = m.returns;
    h.deliveredAt = m.deliveredAt || null; h.cancelledAt = m.cancelledAt || null;
    h.registered = !!o.registered;
    h.payment = h.payment || {};
    if (m.payStatus) h.payment.status = m.payStatus;
    if (!h.payment.status) h.payment.status = Commerce.PAY.PAID;   /* a simulated gateway payment counts as paid */
    h.notifications = outbox().filter(function (n) { return n.orderRef === o.ref; }).sort(function (a, b) { return a.at < b.at ? -1 : 1; });
    h.refundable = Commerce.refundable(h);
    h.returnEligibility = Commerce.returnEligibility(h, window.SITE.returnsPolicy());
    return h;
  }
  function siteBase() {
    try { return location.href.replace(/[^/]*$/, ''); } catch (e) { return ''; }
  }
  function ctxFor(order, extra) {
    var base = siteBase();
    return Object.assign({
      order: order, brand: 'A1 Opticals', contact: window.SITE.get('contact') || {}, policy: window.SITE.returnsPolicy(),
      links: { track: base + 'track.html?ref=' + encodeURIComponent(order.ref), account: base + 'account.html', order: base + 'order.html?ref=' + encodeURIComponent(order.ref) }
    }, extra || {});
  }
  /* The preview's outbox: rendered with the real templates, marked as
     simulated. The order page and the dashboard show these rows. */
  function queueLocal(order, template, extra, to) {
    var r = Commerce.render(template, ctxFor(order, extra));
    var box = outbox();
    var at = new Date().toISOString();
    if (to.email) box.unshift({ id: uuid(), orderRef: order.ref, orderId: order.id, channel: 'email', to: to.email, template: template, subject: r.subject, body: r.text, status: 'sent', simulated: true, at: at, sentAt: at });
    if (to.phone && r.wa) box.unshift({ id: uuid(), orderRef: order.ref, orderId: order.id, channel: 'whatsapp', to: to.phone, template: template, subject: null, body: r.wa, status: 'sent', simulated: true, at: at, sentAt: at });
    write(OUTBOX_KEY, box.slice(0, 500));
  }
  function localChangeStatus(ref, status, note, actor) {
    var o = hydrate(orderByRef(ref));
    if (!o) throw new Error('no-order');
    if (o.status === status) return o;
    if (!Commerce.canTransition(o.status, status)) { var e = new Error('An order cannot go from "' + o.status + '" to "' + status + '"'); e.code = 'bad-transition'; throw e; }
    var m = metaOf(ref), at = new Date().toISOString();
    m.status = status; m.version = (m.version || 1) + 1;
    m.events.push({ at: at, from: o.status, to: status, actor: actor || 'owner', note: note || null });
    if (status === 'delivered') m.deliveredAt = at;
    if (status === 'cancelled') m.cancelledAt = at;
    saveMeta(ref, m);
    var h = hydrate(orderByRef(ref));
    var template = Commerce.notificationFor(status);
    if (template) queueLocal(h, template, { note: note }, { email: h.customer.email, phone: h.customer.phone });
    return h;
  }
  function localRequestReturn(ref, items, reason, method) {
    var o = hydrate(orderByRef(ref));
    if (!o) throw new Error('no-order');
    var elig = Commerce.returnEligibility(o, window.SITE.returnsPolicy());
    if (!elig.ok) { var e = new Error('not-eligible'); e.code = 'not-eligible'; e.data = elig; throw e; }
    var norm = Commerce.normaliseReturnItems(o, items, window.SITE.returnsPolicy());
    if (!norm.ok) { var e2 = new Error('bad-items'); e2.code = 'bad-items'; e2.data = norm; throw e2; }
    var at = new Date().toISOString();
    var ret = { id: uuid(), orderId: o.id, orderRef: ref, items: norm.items, reason: String(reason || '').slice(0, 500), method: method || 'collect', status: 'requested', amount: Commerce.refundForReturn(o, norm.items), createdAt: at, updatedAt: at };
    var m = metaOf(ref); m.returns.push(ret);
    m.events.push({ at: at, from: o.status, to: o.status, actor: 'customer', note: 'return requested · ' + norm.items.map(function (i) { return i.qty + ' × ' + i.name; }).join(', ') });
    saveMeta(ref, m);
    var h = hydrate(orderByRef(ref));
    queueLocal(h, 'return_requested', { ret: ret }, { email: h.customer.email, phone: h.customer.phone });
    queueLocal(h, 'owner_return_requested', { ret: ret }, { email: (window.SITE.get('contact') || {}).email });
    return ret;
  }
  function localRefund(ref, amount, reason, opts) {
    opts = opts || {};
    var o = hydrate(orderByRef(ref));
    if (!o) throw new Error('no-order');
    amount = parseInt(amount, 10);
    if (!(amount > 0)) { var e0 = new Error('The refund amount must be more than zero'); e0.code = 'bad-amount'; throw e0; }
    if (!Commerce.isPaid(o.payment.status)) { var e1 = new Error('Nothing has been paid on this order yet'); e1.code = 'not-paid'; throw e1; }
    if (amount > o.refundable) { var e2 = new Error('Only ' + rupees(o.refundable) + ' can still be refunded on this order'); e2.code = 'over-refund'; throw e2; }
    var manual = opts.manual || Commerce.isOffline(o.payment.method);
    if (manual && !opts.reference && !opts.manual) { var e3 = new Error('This order was not paid through the gateway — record the transfer you made, with its reference'); e3.code = 'manual-needed'; throw e3; }
    var at = new Date().toISOString();
    var refund = { id: uuid(), orderId: o.id, returnId: opts.returnId || null, amount: amount, reason: String(reason || '').slice(0, 300), channel: manual ? 'manual' : 'gateway', status: 'processed', paymentId: o.payment.paymentId || null, gatewayRefundId: manual ? null : 'rfnd_demo_' + Math.random().toString(36).slice(2, 10), reference: opts.reference || null, createdBy: 'owner', createdAt: at, updatedAt: at, processedAt: at };
    var m = metaOf(ref);
    m.refunds.push(refund);
    m.payStatus = Commerce.payStatusAfterRefund(o, amount);
    m.events.push({ at: at, from: o.status, to: o.status, actor: 'owner', note: 'refund ' + rupees(amount) + ' processed' + (refund.gatewayRefundId ? ' · ' + refund.gatewayRefundId : '') });
    if (opts.returnId) m.returns.forEach(function (r) { if (r.id === opts.returnId) { r.status = 'refunded'; r.refundId = refund.id; r.updatedAt = at; } });
    saveMeta(ref, m);
    var h = hydrate(orderByRef(ref));
    queueLocal(h, 'refund_processed', { refund: refund }, { email: h.customer.email, phone: h.customer.phone });
    return refund;
  }
  function localDecideReturn(id, action, note, refund) {
    var map = { approve: 'approved', reject: 'rejected', received: 'received', cancel: 'cancelled' };
    var to = map[action];
    var all = metas(), ref = null, ret = null;
    Object.keys(all).forEach(function (r) { (all[r].returns || []).forEach(function (x) { if (x.id === id) { ref = r; ret = x; } }); });
    if (!ret) throw new Error('no-return');
    if (!Commerce.canReturnTransition(ret.status, to)) { var e = new Error('A return cannot go from "' + ret.status + '" to "' + to + '"'); e.code = 'bad-transition'; throw e; }
    var at = new Date().toISOString();
    ret.status = to; ret.updatedAt = at; if (note) ret.note = note;
    var m = all[ref];
    var o = hydrate(orderByRef(ref));
    m.events.push({ at: at, from: o.status, to: o.status, actor: 'owner', note: 'return ' + to + (note ? ' · ' + note : '') });
    saveMeta(ref, m);
    var h = hydrate(orderByRef(ref));
    var template = { approved: 'return_approved', rejected: 'return_rejected', received: 'return_received' }[to];
    if (template) queueLocal(h, template, { ret: ret, note: note }, { email: h.customer.email, phone: h.customer.phone });
    var out = { ret: ret, order: h };
    if (to === 'received' && refund !== false && ret.amount > 0 && Commerce.isPaid(h.payment.status)) {
      try { out.refund = localRefund(ref, ret.amount, 'Return ' + ret.id.slice(0, 8), { returnId: ret.id, manual: Commerce.isOffline(h.payment.method), reference: Commerce.isOffline(h.payment.method) ? 'preview' : null }); }
      catch (e2) { out.refundError = e2.message; }
      out.order = hydrate(orderByRef(ref));
      out.ret = out.order.returns.filter(function (r) { return r.id === id; })[0] || ret;
    }
    return out;
  }
  function localReturns() {
    var list = [];
    var all = metas();
    Object.keys(all).forEach(function (ref) {
      var o = orderByRef(ref);
      (all[ref].returns || []).forEach(function (r) {
        var v = JSON.parse(JSON.stringify(r));
        v.order = o ? { ref: o.ref, customer: o.customer, mode: o.mode, total: o.total, payStatus: hydrate(o).payment.status, payMethod: o.payment && o.payment.method } : null;
        list.push(v);
      });
    });
    return list.sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
  }

  /* Kept for pages that still read synchronously in the preview. */
  function statusMap() { return read(STATUS_KEY, {}); }
  function setStatus(ref, s) { return localChangeStatus(ref, s); }
  function statusOf(o) { return metaOf(o.ref).status || o.status; }

  /* ── the API client ── */
  function ApiError(status, body) {
    this.status = status; this.code = body && body.error || 'error';
    this.message = body && body.message || ('Request failed (' + status + ')');
    this.data = body && body.data || null;
  }
  ApiError.prototype = Object.create(Error.prototype);
  function request(method, path, body, headers) {
    var opts = { method: method, credentials: 'include', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) };
    if (body !== undefined) opts.body = JSON.stringify(body);
    return fetch(API + path, opts).then(function (r) {
      return r.text().then(function (t) {
        var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) {}
        if (!r.ok) throw new ApiError(r.status, j);
        return j;
      });
    });
  }
  function resolved(fn) { return new Promise(function (res, rej) { try { res(fn()); } catch (e) { rej(e); } }); }

  /* ── the async facade — the same calls in both modes ── */
  function fetchOrders(opts) {
    opts = opts || {};
    if (!API) return resolved(function () { return read(ORDER_KEY, []).map(hydrate); });
    var p = opts.scope === 'admin' ? '/admin/orders' + (opts.pending ? '?pending=1' : '') : '/me/orders';
    return request('GET', p).then(function (j) { ordersCache = j.orders; return j.orders; });
  }
  function fetchOrder(ref, phone) {
    if (!API) return resolved(function () {
      var o = orderByRef(ref);
      if (!o) return null;
      if (phone) { var a = String(phone).replace(/\D/g, '').slice(-10), b = String(o.customer.phone || '').replace(/\D/g, '').slice(-10); if (a !== b) return null; }
      return hydrate(o);
    });
    var last = read(LAST_KEY, null);
    if (!phone && last && last.ref === ref) phone = last.phone;
    return request('GET', '/orders/' + encodeURIComponent(ref) + (phone ? '?phone=' + encodeURIComponent(phone) : '')).then(function (j) { return j.order; })
      .catch(function (e) { if (e.status === 404) return null; throw e; });
  }
  function changeStatus(order, status, note) {
    if (!API) return resolved(function () { return localChangeStatus(order.ref, status, note); });
    return request('PATCH', '/admin/orders/' + order.id + '/status', { status: status, version: order.version, note: note || null }).then(function (j) { return j.order; });
  }
  function markPaid(order, reference) {
    if (!API) return resolved(function () { var m = metaOf(order.ref); m.payStatus = Commerce.PAY.PAID; m.version = (m.version || 1) + 1; m.events.push({ at: new Date().toISOString(), from: order.status, to: order.status, actor: 'owner', note: 'payment received' + (reference ? ' · ' + reference : '') }); saveMeta(order.ref, m); return hydrate(orderByRef(order.ref)); });
    return request('POST', '/admin/orders/' + order.id + '/paid', { version: order.version, reference: reference || null }).then(function (j) { return j.order; });
  }
  function requestReturn(order, items, reason, method) {
    if (!API) return resolved(function () { return localRequestReturn(order.ref, items, reason, method); });
    return request('POST', '/me/orders/' + order.id + '/returns', { items: items, reason: reason, method: method }).then(function (j) { return j['return']; });
  }
  function fetchReturns(status) {
    if (!API) return resolved(function () { return localReturns().filter(function (r) { return !status || r.status === status; }); });
    return request('GET', '/admin/returns' + (status ? '?status=' + encodeURIComponent(status) : '')).then(function (j) { return j.returns; });
  }
  function decideReturn(id, action, note, refund) {
    if (!API) return resolved(function () { return localDecideReturn(id, action, note, refund); });
    return request('POST', '/admin/returns/' + id, { action: action, note: note || null, refund: refund });
  }
  function refund(order, amount, reason, opts) {
    opts = opts || {};
    if (!API) return resolved(function () { return localRefund(order.ref, amount, reason, opts); });
    return request('POST', '/admin/orders/' + order.id + '/refunds', { amount: amount, reason: reason, manual: !!opts.manual, reference: opts.reference || null, returnId: opts.returnId || null }).then(function (j) { return j.refund; });
  }
  function reconcileRefund(id) {
    if (!API) return resolved(function () { return null; });
    return request('POST', '/admin/refunds/' + id + '/reconcile', {}).then(function (j) { return j.refund; });
  }
  function fetchOutbox(opts) {
    opts = opts || {};
    if (!API) return resolved(function () { return outbox().filter(function (n) { return !opts.orderRef || n.orderRef === opts.orderRef; }); });
    var q = [];
    if (opts.orderId) q.push('orderId=' + encodeURIComponent(opts.orderId));
    if (opts.status) q.push('status=' + encodeURIComponent(opts.status));
    return request('GET', '/admin/notifications' + (q.length ? '?' + q.join('&') : '')).then(function (j) { return j.notifications; });
  }
  function retryNotification(id) {
    if (!API) return resolved(function () { return true; });
    return request('POST', '/admin/notifications/' + id + '/retry', {}).then(function (j) { return j.ok; });
  }
  function fetchAttention() {
    if (!API) return resolved(function () {
      var late = read(ORDER_KEY, []).map(hydrate).filter(function (o) { return o.status === 'cancelled' && o.refundable > 0; });
      return { paidButCancelled: late, unconfirmedRefunds: [], doubleCaptures: [], failedNotifications: [] };
    });
    return request('GET', '/admin/attention');
  }

  /* ── who is signed in ── */
  var auth = {
    me: function () {
      if (!API) return resolved(function () { var u = getUser(); return { customer: u && u.registered ? u : null, owner: !!adminMarker() }; });
      return request('GET', '/auth/me');
    },
    requestOtp: function (email) { return API ? request('POST', '/auth/otp', { email: email }) : resolved(function () { return { ok: true, devCode: '000000' }; }); },
    verifyOtp: function (email, code) {
      if (!API) return resolved(function () { var u = getUser() || {}; u.email = email; u.registered = true; setUser(u); return { customer: u }; });
      return request('POST', '/auth/verify', { email: email, code: code }).then(function (j) { ordersCache = null; return j; });
    },
    logout: function () {
      ordersCache = null;
      if (!API) return resolved(function () { var u = getUser(); if (u) { u.registered = false; setUser(u); } return { ok: true }; });
      return request('POST', '/auth/logout', {});
    }
  };
  var ADMIN_SESSION = 'a1opticals_admin_session_v1';
  function adminMarker() { try { return sessionStorage.getItem(ADMIN_SESSION) || localStorage.getItem(ADMIN_SESSION); } catch (e) { return null; } }
  var owner = {
    login: function (email, password, remember) {
      var done = function (r) {
        var s = { email: email, name: 'A1 Opticals · owner', at: Date.now() };
        try { (remember ? localStorage : sessionStorage).setItem(ADMIN_SESSION, JSON.stringify(s)); } catch (e) {}
        return s;
      };
      if (!API) return resolved(function () { return done(); });
      return request('POST', '/auth/owner', { email: email, password: password }).then(done);
    },
    logout: function () {
      try { sessionStorage.removeItem(ADMIN_SESSION); localStorage.removeItem(ADMIN_SESSION); } catch (e) {}
      return API ? request('POST', '/auth/owner/logout', {}).catch(function () {}) : resolved(function () { return true; });
    },
    check: function () {
      if (!API) return resolved(function () { try { return JSON.parse(adminMarker() || 'null'); } catch (e) { return null; } });
      return request('GET', '/auth/me').then(function (j) { if (!j.owner) return null; try { return JSON.parse(adminMarker() || 'null') || { email: '', name: 'A1 Opticals · owner' }; } catch (e) { return { name: 'A1 Opticals · owner' }; } });
    }
  };

  /* Admin edits reach the server so it prices with the same numbers. */
  var syncTimers = {};
  window.addEventListener('a1:settings', function (e) {
    if (!API || !adminMarker()) return;
    var d = e.detail || {};
    var key = d.store === 'site' ? 'site' : d.key === 'products' ? 'products' : 'overrides';
    clearTimeout(syncTimers[key]);
    syncTimers[key] = setTimeout(function () {
      var lsKey = key === 'site' ? 'a1opticals_site_v1' : key === 'products' ? 'a1opticals_products_v1' : 'a1opticals_overrides_v1';
      var value = read(lsKey, null);
      request('PUT', '/admin/settings/' + key, { value: value }).catch(function (err) { if (window.toast) window.toast('Not saved to the server: ' + err.message, 'fa-triangle-exclamation'); });
    }, 300);
  });

  /* ── reservations & bookings ──────────────────────────────────────────────
     "Reserve to try in store" on a product, and eye-test bookings. Both are
     rows for the owner's dashboard; on the live build they also send a
     WhatsApp to the counter. */
  function reservations() { return read(RESV_KEY, []); }
  function reserve(r) {
    r.ref = 'R-' + Math.random().toString(36).slice(2, 7).toUpperCase();
    r.at = new Date().toISOString();
    r.status = 'requested';
    var all = reservations(); all.unshift(r); write(RESV_KEY, all);
    return r;
  }
  function bookings() { return read(BOOK_KEY, []); }
  function book(b) {
    b.ref = 'ET-' + Math.random().toString(36).slice(2, 7).toUpperCase();
    b.at = new Date().toISOString();
    b.status = 'booked';
    var all = bookings(); all.unshift(b); write(BOOK_KEY, all);
    return b;
  }
  function setRowStatus(key, ref, status) {
    var all = read(key, []);
    all.forEach(function (r) { if (r.ref === ref) r.status = status; });
    write(key, all);
  }

  /* ── checkout & payment ────────────────────────────────────────────────────
     The real flow:

       browser  -> POST /api/commerce/order  Idempotency-Key  (server prices it,
                   reserves stock, creates the gateway order)
       browser  -> Razorpay Checkout (hosted; card data never touches us)
       Razorpay -> browser  { payment_id, order_id, signature }
       browser  -> POST /api/commerce/verify { those three }
       server   -> HMAC-SHA256 check with the key SECRET, then marks paid —
                   and Razorpay's webhook does the same, whichever is first.

     At no point does the browser tell the server that a payment succeeded.
     The Idempotency-Key is made once per bag-and-details and reused on a
     retry, so a double click or a dropped response cannot make two orders.
     Without an API the same call resolves from the preview's simulation. */
  function checkoutKey(payload) {
    var hash = JSON.stringify(payload);
    var cur = null;
    try { cur = JSON.parse(sessionStorage.getItem(CHK_KEY) || 'null'); } catch (e) {}
    if (cur && cur.hash === hash) return cur.key;
    var key = uuid();
    try { sessionStorage.setItem(CHK_KEY, JSON.stringify({ key: key, hash: hash })); } catch (e) {}
    return key;
  }
  function rotateKey() { try { sessionStorage.removeItem(CHK_KEY); } catch (e) {} }

  function checkout(o) {
    if (!API) {
      return resolved(function () {
        var payment = { simulated: true, method: o.method + ' (preview)', paymentId: 'pay_demo_' + Math.random().toString(36).slice(2, 12) };
        if (o.method === 'Bank transfer') payment.status = Commerce.PAY.AWAITING_TRANSFER;
        if (o.method === 'Cash on delivery') payment.status = Commerce.PAY.PAY_ON_DELIVERY;
        if (o.method === 'Pay in store') payment.status = Commerce.PAY.PAY_ON_COLLECTION;
        if (o.method === 'Credit account') payment.status = Commerce.PAY.ON_ACCOUNT;
        if (o.register) { var u = getUser() || {}; u.registered = true; u.email = o.details.email; setUser(u); }
        var order = placeOrder(o.details, payment, { delivery: o.delivery, rx: o.rx, register: o.register });
        if (!order) throw new Error('order could not be created');
        return order;
      });
    }
    var payload = { items: getCart(), mode: mode(), method: o.method, customer: o.details, delivery: o.delivery, rx: o.rx, register: !!o.register };
    var key = checkoutKey(payload);
    function done(order) { clear(); rotateKey(); write(LAST_KEY, { ref: order.ref, phone: o.details.phone }); return order; }
    return request('POST', '/commerce/order', payload, { 'Idempotency-Key': key }).then(function (res) {
      var order = res.order;
      if (!res.gateway) return done(order);
      if (order.status !== Commerce.PENDING && Commerce.isPaid(order.payment.status)) return done(order); /* replayed after payment */
      return openGateway(res.gateway, o.details).then(function (resp) {
        return request('POST', '/commerce/verify', resp);
      }).then(function (v) {
        if (!v || !v.verified) throw new Error('payment could not be verified');
        return done(v.order);
      }).catch(function (err) {
        if (err && err.message === 'cancelled') {
          request('POST', '/commerce/abandon', { orderId: order.id, key: key }).catch(function () {});
          rotateKey();
        }
        throw err;
      });
    });
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[src="' + src + '"]')) return resolve();
      var s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = function () { reject(new Error('could not load the payment gateway')); };
      document.head.appendChild(s);
    });
  }
  function openGateway(g, details) {
    if (g.stub) return stubGateway(g, details);
    return loadScript('https://checkout.razorpay.com/v1/checkout.js').then(function () {
      return new Promise(function (resolve, reject) {
        var rzp = new window.Razorpay({
          key: g.key, order_id: g.orderId, amount: g.amount, currency: g.currency || 'INR',
          name: 'A1 Opticals', description: 'Order payment', theme: { color: '#0E7C74' },
          prefill: { name: details.name, email: details.email, contact: details.phone },
          handler: resolve,
          modal: { ondismiss: function () { reject(new Error('cancelled')); } }
        });
        rzp.open();
      });
    });
  }
  /* The stub gateway's "hosted checkout": a dialog that pays or fails,
     signed by the server's stub the way Razorpay would sign. */
  function stubGateway(g, details) {
    return new Promise(function (resolve, reject) {
      var esc = window.escapeHtml || function (s) { return String(s); };
      if (!window.modal) {
        if (confirm('Test gateway: pay ' + rupees(g.amount) + '?')) request('POST', '/stub/pay', { orderId: g.orderId, outcome: 'success' }).then(resolve, reject);
        else reject(new Error('cancelled'));
        return;
      }
      var m = window.modal(
        '<div class="mono">Test payment gateway</div>' +
        '<h2 style="margin-top:8px">' + rupees(g.amount) + '</h2>' +
        '<p>This stands in for the Razorpay checkout. Nothing is charged. The server signs the result exactly as the gateway would, and verifies it the same way.</p>' +
        '<p style="font-size:13px;color:var(--muted)">Order ' + esc(g.orderId) + ' · ' + esc(details.email) + '</p>' +
        '<div class="actions" style="flex-wrap:wrap"><button type="button" class="btn btn-primary" id="stubPay"><i class="fa-solid fa-qrcode"></i> Pay by UPI (test)</button>' +
        '<button type="button" class="btn btn-soft" id="stubCard"><i class="fa-regular fa-credit-card"></i> Pay by card (test)</button>' +
        '<button type="button" class="btn btn-soft" id="stubFail">Simulate a failed payment</button></div>'
      );
      var settled = false;
      function go(outcome, method) {
        settled = true;
        request('POST', '/stub/pay', { orderId: g.orderId, outcome: outcome, method: method }).then(function (resp) {
          window.closeModal();
          if (resp.failed) reject(new Error('failed')); else resolve(resp);
        }, function (e) { window.closeModal(); reject(e); });
      }
      m.querySelector('#stubPay').addEventListener('click', function () { go('success', 'upi'); });
      m.querySelector('#stubCard').addEventListener('click', function () { go('success', 'card'); });
      m.querySelector('#stubFail').addEventListener('click', function () { go('fail'); });
      var bg = m.parentNode;
      var obs = new MutationObserver(function () { if (!document.body.contains(bg)) { obs.disconnect(); if (!settled) reject(new Error('cancelled')); } });
      obs.observe(document.body, { childList: true });
    });
  }
  /* Kept for callers of the old name. */
  function pay(details) { return checkout({ details: details, method: 'UPI' }); }

  /* ── shared chrome ─────────────────────────────────────────────────────────
     Every page has "Bag · ₹1,499" in the header; wire it once here rather
     than in fifteen separate files. */
  function mountBadge() {
    function paint() {
      var n = count();
      var t = n ? totals().total : 0;
      document.querySelectorAll('[data-cart-count]').forEach(function (b) { b.textContent = n; b.hidden = n === 0; });
      document.querySelectorAll('[data-cart-total]').forEach(function (b) { b.textContent = rupees(t); });
    }
    paint();
    onChange(paint);
    // A second tab is a different page with the same bag. Keep them in step.
    window.addEventListener('storage', function (e) { if (e.key === CART_KEY || e.key === MODE_KEY) paint(); });
  }

  document.addEventListener('DOMContentLoaded', mountBadge);

  return {
    rupees: rupees, taxSplit: taxSplit, fmtPow: fmtPow,
    mode: mode, setMode: setMode, isTrade: isTrade, isTradeUser: isTradeUser, isTradeItem: isTradeItem, tradePricing: tradePricing,
    lensFor: lensFor, lensOf: lensOf, lensDelta: lensDelta,
    unitPrice: unitPrice, displayPrice: displayPrice, wasPrice: wasPrice, breakdown: breakdown, fromPrice: fromPrice,
    bogoRule: bogoRule, bogoEligible: bogoEligible, isNew: isNew,
    add: add, setQty: setQty, setLens: setLens, remove: remove, clear: clear,
    count: count, lines: lines, totals: totals, onChange: onChange,
    serviceArea: serviceArea, areaNames: areaNames, shippingFor: shippingFor,
    getRx: getRx, setRx: setRx, clearRx: clearRx, rxComplete: rxComplete, rxStrength: rxStrength, rxSummary: rxSummary, lensAdvice: lensAdvice,
    search: search,
    getUser: getUser, setUser: setUser, signOut: signOut,
    /* orders — sync readers (preview, or the last fetched list) */
    orders: orders, orderByRef: orderByRef, placeOrder: placeOrder, pay: pay, hydrate: hydrate,
    STATUS: STATUS, statusOf: statusOf, setStatus: setStatus,
    /* orders — the async facade, same calls with or without an API */
    api: API, remote: !!API, uuid: uuid, ApiError: ApiError, request: request,
    checkout: checkout, fetchOrders: fetchOrders, fetchOrder: fetchOrder, changeStatus: changeStatus, markPaid: markPaid,
    requestReturn: requestReturn, fetchReturns: fetchReturns, decideReturn: decideReturn,
    refund: refund, reconcileRefund: reconcileRefund, fetchOutbox: fetchOutbox, retryNotification: retryNotification, fetchAttention: fetchAttention,
    auth: auth, owner: owner,
    reservations: reservations, reserve: reserve, bookings: bookings, book: book,
    setReservationStatus: function (ref, s) { setRowStatus(RESV_KEY, ref, s); },
    setBookingStatus: function (ref, s) { setRowStatus(BOOK_KEY, ref, s); },
    mountBadge: mountBadge,
    _keys: { cart: CART_KEY, orders: ORDER_KEY, user: USER_KEY, rx: RX_KEY, mode: MODE_KEY, meta: META_KEY, outbox: OUTBOX_KEY }
  };
})();
