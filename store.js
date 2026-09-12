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

  /* Where the API lives. In the preview there is no deployed API, so checkout
     runs in simulated mode and says so on screen — see pay(). */
  var API = '';

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

  /* ── orders ────────────────────────────────────────────────────────────── */
  function orders() { return read(ORDER_KEY, []); }
  function orderByRef(ref) {
    var all = orders();
    for (var i = 0; i < all.length; i++) if (all[i].ref === ref) return all[i];
    return null;
  }

  function orderRef() {
    var d = new Date();
    var stamp = String(d.getFullYear()).slice(2) +
                String(d.getMonth() + 1).padStart(2, '0') +
                String(d.getDate()).padStart(2, '0');
    return (isTrade() ? 'A1T-' : 'A1-') + stamp + '-' + String(Math.floor(Math.random() * 9000) + 1000);
  }

  /* details: the checkout form. payment: from pay(). extra: { delivery, rx }. */
  function placeOrder(details, payment, extra) {
    extra = extra || {};
    var t = totals(extra.delivery ? { method: extra.delivery.method } : {});
    if (!t.lines.length) return null;
    var order = {
      ref: orderRef(),
      placedAt: new Date().toISOString(),
      status: t.rxNeeded && extra.rx && (extra.rx.method === 'later' || extra.rx.method === 'call') ? 'awaiting prescription' : 'confirmed',
      mode: mode(),
      customer: details,
      payment: payment,
      delivery: extra.delivery || { method: 'van' },
      rx: extra.rx || null,
      items: t.lines.map(function (l) {
        return {
          sku: l.sku, name: l.product.name + (l.product.colour ? ' · ' + l.product.colour.label : ''),
          variant: l.variant.label, lens: l.lens ? l.lens.label : null, lensId: l.lensId,
          qty: l.qty, unit: l.unit, gross: l.gross, discount: l.discount, free: l.free, net: l.net, gstRate: l.gstRate,
          hsn: l.product.hsn, photo: l.product.photo, needsRx: l.needsRx
        };
      }),
      gross: t.gross, discount: t.discount, base: t.base, tax: t.tax, byRate: t.byRate,
      shipping: t.shipping, total: t.total
    };
    var all = orders();
    all.unshift(order);
    write(ORDER_KEY, all);
    clear();
    return order;
  }

  /* Order status, kept separately so the owner's updates never rewrite the
     order record itself. */
  var STATUS = ['confirmed', 'awaiting prescription', 'in lab', 'packed', 'shipped', 'ready to collect', 'delivered', 'cancelled'];
  function statusMap() { return read(STATUS_KEY, {}); }
  function setStatus(ref, s) { var m = statusMap(); m[ref] = s; write(STATUS_KEY, m); }
  function statusOf(o) { return statusMap()[o.ref] || o.status; }

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

  /* ── payment ───────────────────────────────────────────────────────────────
     The real flow is:

       browser  -> POST /commerce/order   { items }        (server prices it)
       server   -> Razorpay Orders API                     (server-side key)
       server   -> browser  { order_id, amount, key_id }
       browser  -> Razorpay Checkout
       Razorpay -> browser  { payment_id, order_id, signature }
       browser  -> POST /commerce/verify  { those three }
       server   -> HMAC-SHA256 check with the key SECRET, then mark paid

     At no point does the browser tell the server that a payment succeeded.
     API is empty in the preview because no API is deployed and no Razorpay
     account exists yet, so this returns a clearly-labelled simulated result. */
  function pay(details) {
    if (!API) {
      return Promise.resolve({
        simulated: true,
        method: 'Simulated (test mode)',
        paymentId: 'pay_demo_' + Math.random().toString(36).slice(2, 12)
      });
    }
    return fetch(API + '/commerce/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: getCart(),
        customer: { name: details.name, email: details.email, phone: details.phone }
      })
    })
      .then(function (r) { return r.json(); })
      .then(function (created) {
        if (!created || !created.order_id) throw new Error('order not created');
        return new Promise(function (resolve, reject) {
          var rzp = new window.Razorpay({
            key: created.key_id,
            order_id: created.order_id,
            amount: created.amount,
            currency: 'INR',
            name: 'A1 Opticals',
            prefill: { name: details.name, email: details.email, contact: details.phone },
            handler: function (resp) {
              fetch(API + '/commerce/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(resp)
              })
                .then(function (r) { return r.json(); })
                .then(function (v) {
                  if (v && v.verified) resolve({ simulated: false, method: v.method, paymentId: resp.razorpay_payment_id });
                  else reject(new Error('payment could not be verified'));
                })
                .catch(reject);
            },
            modal: { ondismiss: function () { reject(new Error('cancelled')); } }
          });
          rzp.open();
        });
      });
  }

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
    orders: orders, orderByRef: orderByRef, placeOrder: placeOrder, pay: pay,
    STATUS: STATUS, statusOf: statusOf, setStatus: setStatus,
    reservations: reservations, reserve: reserve, bookings: bookings, book: book,
    setReservationStatus: function (ref, s) { setRowStatus(RESV_KEY, ref, s); },
    setBookingStatus: function (ref, s) { setRowStatus(BOOK_KEY, ref, s); },
    mountBadge: mountBadge,
    _keys: { cart: CART_KEY, orders: ORDER_KEY, user: USER_KEY, rx: RX_KEY, mode: MODE_KEY }
  };
})();
