/* =============================================================================
   api/engine.js — the storefront's pricing code, run on the server
   -----------------------------------------------------------------------------
   The browser never decides what an order costs. But the rules that decide
   it — retail all-in prices with the included lens, trade tiers and MOQ,
   Buy-1-Get-1, GST backed out per line, delivery thresholds — already exist,
   in catalog.js, site.js and store.js. Rewriting them for the server would
   give two engines that drift apart. So the server loads the same three
   files into a vm sandbox with a fake window and an in-memory localStorage,
   and asks Store.totals() the same question the bag page asks.

   The admin's edits (prices, stock, lens packages, delivery charges) reach
   the sandbox through the settings table: reload() rebuilds it whenever a
   setting is saved, so the server prices with what the owner last saved,
   not with the static seed.
   ========================================================================== */
'use strict';

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FILES = ['commerce.js', 'catalog.js', 'site.js', 'store.js'];

/* The localStorage keys the three files read. Settings from the admin are
   written under exactly these keys, so the files need no change to see them. */
const KEYS = {
  cart: 'a1opticals_cart_v2',
  mode: 'a1opticals_mode_v1',
  site: 'a1opticals_site_v1',
  overrides: 'a1opticals_overrides_v1',
  products: 'a1opticals_products_v1'
};

function build(settings) {
  const mem = new Map();
  if (settings.site) mem.set(KEYS.site, JSON.stringify(settings.site));
  if (settings.overrides) mem.set(KEYS.overrides, JSON.stringify(settings.overrides));
  if (settings.products) mem.set(KEYS.products, JSON.stringify(settings.products));

  const sandbox = {
    localStorage: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => { mem.set(k, String(v)); },
      removeItem: (k) => { mem.delete(k); }
    },
    document: { addEventListener() {}, querySelectorAll() { return []; }, readyState: 'complete' },
    location: { search: '', href: '', origin: '' },
    navigator: { userAgent: 'a1opticals-api' },
    CustomEvent: function () {},
    fetch: () => Promise.reject(new Error('the pricing engine does not talk to the network')),
    console, Intl, Math, Date, JSON, String, Number, Array, Object, RegExp, Error, Promise,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, Infinity, NaN,
    setTimeout: () => 0, clearTimeout() {}
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.dispatchEvent = () => true;
  vm.createContext(sandbox);
  for (const f of FILES) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
  }
  return { sandbox, mem };
}

function create(initialSettings) {
  let ctx = build(initialSettings || {});

  function reload(settings) { ctx = build(settings || {}); }

  /* price(items, mode, method) → the totals object Store.totals() returns,
     plus `orderItems`, the rows an order record stores. Throws on anything
     the catalogue does not know, so a tampered bag is refused, not priced. */
  function price(items, mode, method) {
    const { sandbox, mem } = ctx;
    const { Store, CATALOG } = sandbox;
    if (!Array.isArray(items) || !items.length) throw Object.assign(new Error('empty bag'), { code: 'empty' });
    if (items.length > 50) throw Object.assign(new Error('too many lines'), { code: 'too-many-lines' });

    const cart = items.map((it) => {
      const p = CATALOG.bySku(String(it.sku || ''));
      if (!p) throw Object.assign(new Error('unknown sku ' + it.sku), { code: 'unknown-sku', sku: it.sku });
      const variant = CATALOG.variant(p, String(it.variant || '')) || (it.variant == null ? p.variants[0] : null);
      if (!variant) throw Object.assign(new Error('unknown variant ' + it.variant + ' for ' + it.sku), { code: 'unknown-variant', sku: it.sku });
      const qty = parseInt(it.qty, 10);
      if (!(qty >= 1) || qty > 999) throw Object.assign(new Error('bad quantity for ' + it.sku), { code: 'bad-qty', sku: it.sku });
      const trade = mode === 'trade' || Store.isTradeItem(p);
      let lensId = null;
      if (!trade) {
        const lf = Store.lensFor(p);
        if (lf.applies) {
          lensId = it.lens || lf.defaultId;
          if (!sandbox.SITE.lens(lensId)) throw Object.assign(new Error('unknown lens package ' + lensId), { code: 'unknown-lens', sku: it.sku });
        }
      } else if (p.moq && qty < p.moq) {
        throw Object.assign(new Error('below MOQ for ' + it.sku), { code: 'below-moq', sku: it.sku, moq: p.moq });
      }
      if (trade && mode !== 'trade') {
        throw Object.assign(new Error(it.sku + ' is a trade item'), { code: 'trade-only', sku: it.sku });
      }
      return { id: p.sku + '::' + variant.id + '::' + (lensId || '-'), sku: p.sku, variant: variant.id, lens: lensId, qty };
    });

    /* Merge duplicate lines the way the bag would. */
    const merged = [];
    cart.forEach((l) => {
      const dup = merged.find((m) => m.id === l.id);
      if (dup) dup.qty += l.qty; else merged.push(l);
    });

    mem.set(KEYS.cart, JSON.stringify(merged));
    mem.set(KEYS.mode, JSON.stringify(mode === 'trade' ? 'trade' : 'retail'));
    try {
      const t = Store.totals({ method: method || 'van' });
      if (t.lines.length !== merged.length) throw Object.assign(new Error('bag could not be priced'), { code: 'unpriceable' });
      t.orderItems = t.lines.map((l) => ({
        sku: l.sku,
        name: l.product.name + (l.product.colour ? ' · ' + l.product.colour.label : ''),
        cat: l.product.cat,
        variant: l.variant.label, variantId: l.variant.id,
        lens: l.lens ? l.lens.label : null, lensId: l.lensId,
        qty: l.qty, unit: l.unit, gross: l.gross, discount: l.discount, free: l.free, net: l.net, gstRate: l.gstRate,
        hsn: l.product.hsn, photo: l.product.photo, needsRx: l.needsRx
      }));
      /* lines carry live product objects from the sandbox; not for the API's callers */
      delete t.lines;
      return t;
    } finally {
      mem.delete(KEYS.cart);
      mem.delete(KEYS.mode);
    }
  }

  return {
    reload,
    price,
    get catalog() { return ctx.sandbox.CATALOG; },
    get site() { return ctx.sandbox.SITE; },
    get store() { return ctx.sandbox.Store; },
    KEYS
  };
}

module.exports = { create, KEYS };
