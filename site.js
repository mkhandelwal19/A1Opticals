/* =============================================================================
   a1opticals/site.js — site content and settings, owner-editable
   -----------------------------------------------------------------------------
   Everything on the storefront that is not a product row lives here: the offer
   bar, the trust strip, lens packages and their prices, the Buy-1-Get-1 rule,
   delivery charges and the delivery-area PIN list, the stores, the eye-test
   slots, the homepage promos and the bestseller picks.

   The shape is the same as the catalogue: DEFAULTS are the seed, the admin
   page writes overrides to localStorage, and every page reads through get().
   On the live build each top-level key is a row in a `site_settings` table
   with a JSON value — the admin form does not change, only where set() goes.

   Money is integer paise, as everywhere else.
   ========================================================================== */
window.SITE = (function () {
  'use strict';

  var KEY = 'a1opticals_site_v1';

  var DEFAULTS = {

    brand: {
      name: 'A1 Opticals',
      tagline: 'One store in Chandigarh and a lens lab of our own. Everyday eyewear at a price we print in full.'
    },

    contact: {
      phone: '+91 87663 08511',
      phoneHref: 'tel:+918766308511',
      whatsapp: 'https://wa.me/918766308511',
      email: 'a1opticals@gmail.com',
      gstin: 'GSTIN to be added'
    },

    /* Stores. The nav line, the eye-test page, "collect from store" at
       checkout and the map on the home page all read this list. */
    stores: [
      {
        id: 'chd16',
        name: 'Sector 16-D',
        city: 'Chandigarh',
        address: 'Shop No. 44, Sector 16-D, Chandigarh 160015',
        phone: '+91 87663 08511',
        hours: '10 am – 8 pm · Monday to Saturday',
        mapQuery: 'A1 Opticals, Shop 44, Sector 16-D, Chandigarh 160015',
        eyeTest: true
      }
    ],

    /* The dark strip above the header. Items rotate on a phone. */
    offerBar: {
      on: true,
      items: [
        'Buy 1 Get 1 free on all A1 Studio frames',
        'Free lenses up to ₹1,200 on every order',
        'Free delivery over ₹999'
      ]
    },

    /* Four promises under the hero. */
    trust: {
      on: true,
      items: [
        { title: 'Lenses in the price',    sub: 'No upsell at checkout' },
        { title: 'Fitted in 48 hours',     sub: 'Our own lab, dispatched pan-India' },
        { title: '14-day returns',         sub: 'Including powered lenses' },
        { title: 'Free eye test in store', sub: 'Sector 16-D, Chandigarh' }
      ]
    },

    hero: {
      kicker: 'Lenses included',
      title: 'Glasses from ₹999.\nThat’s the whole price.',
      text: 'Single-vision lenses, anti-glare coating and a case are already in the number you see. Add your power at checkout — nothing gets added to the bill.',
      cta1: { label: 'Shop eyeglasses', href: 'shop.html?cat=frames' },
      cta2: { label: 'Shop sunglasses', href: 'shop.html?cat=sun' },
      /* A photograph uploaded from the admin page (data URL). Empty means
         the hero shows the featured frame's render with live colourways. */
      photo: '',
      sku: 'A1-FR-2105'
    },

    /* Three panels under the bestsellers. `dark` paints the first one ink. */
    promos: [
      { kicker: 'Contact lenses', title: 'Reorder in two taps',
        text: 'We keep your last box on file. Order again from your account in two taps and save 10% on every repeat.',
        cta: 'Shop contact lenses', href: 'shop.html?cat=contacts', dark: true },
      { kicker: 'Kids', title: 'Unbreakable frames, free replacement',
        text: 'One free frame replacement in the first year on every kids’ pair. No questions asked.',
        cta: 'Shop kids’ eyewear', href: 'shop.html?cat=kids' },
      { kicker: 'Eye test', title: 'Free test at our store',
        text: 'Fifteen minutes with an optometrist. Walk out with your power on your phone, buy online later.',
        cta: 'Book a slot', href: 'eye-test.html' }
    ],

    bestsellers: {
      title: 'Bestsellers this month',
      sub: 'Every price below includes single-vision lenses with anti-glare',
      skus: ['A1-FR-2105', 'VO-5462', 'A1-FR-2103', 'RB-5154', 'A1-FR-2102']
    },

    /* Lens packages. Exactly one is `included` — its price is inside every
       frame price on the site, and the others are shown as +/− against it.
       `plano` marks the no-power option, which needs no prescription. */
    lensPackages: [
      { id: 'sv',   label: 'Single vision + anti-glare', desc: 'Powers up to ±4.00. What most people need.',            price: 50000,  included: true,  sort: 1 },
      { id: 'thin', label: 'Thin 1.61 + anti-glare',     desc: '30% thinner edges. For powers above ±4.00.',            price: 170000, sort: 2 },
      { id: 'blue', label: 'Blue-cut',                   desc: 'For long screen days. Slight warm tint.',               price: 140000, sort: 3 },
      { id: 'prog', label: 'Progressive',                desc: 'Distance and reading in one lens.',                     price: 400000, sort: 4 },
      { id: 'none', label: 'No power — frame only',      desc: 'Plain lenses, or bring your own prescription later.',   price: 0,      sort: 5, plano: true }
    ],

    offers: {
      bogo: {
        on: true,
        badge: 'BUY 1 GET 1',
        label: 'Buy 1 Get 1',
        brands: ['A1 Studio', 'A1 Titanium', 'A1 Sun'],
        cats: ['frames', 'sun', 'kids'],
        note: 'Buy 1 Get 1 free — add a second A1 Studio frame at checkout'
      },
      /* "Under ₹X" shortcut in the Offer filter, in paise. */
      underPrice: 150000
    },

    delivery: {
      retail: {
        flat: 9900,           /* below the free threshold, own van or courier */
        freeOver: 99900,
        courierOutside: true, /* outside the van area, courier rather than refuse */
        courierFlat: 9900,
        courierDays: '4–7 working days',
        vanDays: 'Same day or next working day'
      },
      trade: {
        flat: 25000,
        freeOver: 1000000,
        minOrder: 500000
      },
      /* Own-van delivery area, by PIN prefix. Owner-editable. */
      areas: [
        { prefix: '1600', area: 'Chandigarh' },
        { prefix: '1601', area: 'Chandigarh / Mohali' },
        { prefix: '1341', area: 'Panchkula' },
        { prefix: '1403', area: 'Mohali / Kharar' },
        { prefix: '1406', area: 'Zirakpur' }
      ],
      slots: ['Today, by 7 pm', 'Tomorrow, morning', 'Tomorrow, afternoon']
    },

    eyeTest: {
      on: true,
      slots: ['10:00', '11:00', '12:00', '13:00', '15:00', '16:00', '17:00', '18:00'],
      daysAhead: 14,
      minutes: 15,
      note: 'Free. Fifteen minutes with an optometrist. Your power goes to your phone and is saved to your account, so you can buy online later.'
    },

    display: {
      showBreakdown: true,   /* "frame ₹999 + lens ₹500" under card prices */
      tradeStrip: true       /* the "for opticians" panel on the home page */
    },

    /* Returns and refunds. The windows run from the delivery date; a guest
       order (no account) is pointed at the email instead of the account page.
       Both the storefront and the API read this — see commerce.js. */
    returns: {
      retailDays: 14,
      tradeDays: 7,
      email: 'refund@a1opticals.com',
      excludeCats: []        /* category ids that never come back, e.g. ['contacts'] */
    }
  };

  function read() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null') || {}; } catch (e) { return {}; }
  }
  function writeAll(o) {
    try { localStorage.setItem(KEY, JSON.stringify(o)); return true; } catch (e) { return false; }
  }

  /* A setting is replaced whole at its top-level key — the admin form always
     saves the full object, so partial merges are not needed and would only
     hide stale sub-keys. */
  function get(key) {
    var o = read();
    var v = Object.prototype.hasOwnProperty.call(o, key) ? o[key] : DEFAULTS[key];
    return clone(v);
  }
  function set(key, value) {
    var o = read();
    o[key] = value;
    var ok = writeAll(o);
    changed(key, value);
    return ok;
  }
  function reset(key) {
    var o = read();
    delete o[key];
    var ok = writeAll(o);
    changed(key, null);
    return ok;
  }
  /* Tell anyone listening (store.js, when an API is configured) that a
     setting changed, so the server prices with the same numbers the admin
     just saved. Fire-and-forget; the local write above already happened. */
  function changed(key, value) {
    try { window.dispatchEvent(new CustomEvent('a1:settings', { detail: { store: 'site', key: key, value: value } })); } catch (e) {}
  }
  function resetAll() {
    try { localStorage.removeItem(KEY); } catch (e) {}
  }
  function isEdited(key) {
    return Object.prototype.hasOwnProperty.call(read(), key);
  }
  function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }

  /* ── conveniences ────────────────────────────────────────────────────── */
  function lensPackages() {
    return get('lensPackages').sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); });
  }
  function lens(id) {
    var l = lensPackages();
    for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i];
    return null;
  }
  function includedLens() {
    var l = lensPackages();
    for (var i = 0; i < l.length; i++) if (l[i].included) return l[i];
    return l[0] || null;
  }
  function planoLens() {
    var l = lensPackages();
    for (var i = 0; i < l.length; i++) if (l[i].plano) return l[i];
    return null;
  }
  function stores() { return get('stores'); }
  function store(id) {
    var s = stores();
    for (var i = 0; i < s.length; i++) if (s[i].id === id) return s[i];
    return s[0] || null;
  }
  function areas() { return get('delivery').areas || []; }
  function returnsPolicy() {
    var r = get('returns') || {};
    var d = DEFAULTS.returns;
    return { retailDays: r.retailDays || d.retailDays, tradeDays: r.tradeDays || d.tradeDays, email: r.email || d.email, excludeCats: r.excludeCats || [] };
  }

  return {
    defaults: DEFAULTS,
    get: get, set: set, reset: reset, resetAll: resetAll, isEdited: isEdited,
    lensPackages: lensPackages, lens: lens, includedLens: includedLens, planoLens: planoLens,
    stores: stores, store: store, areas: areas, returnsPolicy: returnsPolicy
  };
})();
