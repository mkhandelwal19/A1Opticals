/* =============================================================================
   a1opticals/chrome.js — the offer bar, header, nav and footer, in one place
   -----------------------------------------------------------------------------
   Sixteen pages share this. Pasting the same header into sixteen files is how
   a nav link ends up correct on fourteen of them and wrong on two.

   Injecting rather than hard-coding is defensible here specifically because
   the store already requires JavaScript to function at all — there is no bag
   without it.
   ========================================================================== */
(function () {
  'use strict';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  window.escapeHtml = esc;

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  var EMBED = false;
  try { EMBED = new URLSearchParams(location.search).get('embed') === '1'; } catch (e) {}

  /* The dashboard link is only in the customer-facing nav once the owner has
     signed in on this browser; everyone else reaches it from the footer. */
  var ADMIN_ON = false;
  try { ADMIN_ON = !!(sessionStorage.getItem('a1opticals_admin_session_v1') || localStorage.getItem('a1opticals_admin_session_v1')); } catch (e) {}

  /* The wordmark: "A1" heavy, "OPTICALS" light, set solid so the two halves
     lock into one shape. The A1 half detaches for the favicon. */
  function wordmark(cls) {
    return '<a class="wm ' + (cls || '') + '" href="index.html" aria-label="A1 Opticals, home"><b>A1</b><span>OPTICALS</span></a>';
  }
  window.wordmarkHtml = wordmark;

  function navItems() {
    var trade = window.Store && Store.isTrade();
    var items = CATALOG.categories.filter(function (c) { return c.nav; }).map(function (c) {
      return { href: 'shop.html?cat=' + c.id, label: c.label, key: 'cat:' + c.id };
    });
    items.push({ href: 'brands.html', label: 'Brands', key: 'brands.html' });
    items.push({ href: 'offers.html', label: 'Offers', key: 'offers.html', accent: true });
    if (trade) {
      items.push({ href: 'shop.html?cat=lenses', label: 'Ophthalmic lenses', key: 'cat:lenses' });
      items.push({ href: 'shop.html?cat=instruments', label: 'Instruments', key: 'cat:instruments' });
    }
    items.push({ href: 'trade.html', label: trade ? 'Trade desk' : 'For opticians', key: 'trade.html', muted: !trade });
    if (ADMIN_ON) items.push({ href: 'admin.html', label: 'Admin', key: 'admin.html', muted: true });
    return items;
  }

  function currentKey() {
    var page = document.body.getAttribute('data-page') || '';
    if (page === 'shop.html') {
      var cat = '';
      try { cat = new URLSearchParams(location.search).get('cat') || ''; } catch (e) {}
      return cat ? 'cat:' + cat : 'shop.html';
    }
    return page;
  }

  function storesLine() {
    var stores = SITE.stores();
    if (!stores.length) return '';
    var cities = [];
    stores.forEach(function (s) { if (cities.indexOf(s.city) === -1) cities.push(s.city); });
    if (stores.length === 1) return 'Store in ' + esc(stores[0].city) + ' · ' + esc(stores[0].name);
    return 'Stores in ' + cities.map(esc).join(' · ');
  }

  function mount() {
    if (EMBED) document.documentElement.classList.add('is-embedded');
    var trade = window.Store && Store.isTrade();
    var user = window.Store ? Store.getUser() : null;

    var host = document.getElementById('chrome-top');
    if (host) {
      var offer = SITE.get('offerBar');
      var skuCount = CATALOG.products.filter(function (p) { var c = CATALOG.category(p.cat); return !(c && (c.trade || c.hidden)); }).length;
      var key = currentKey();

      var nav = navItems().map(function (n) {
        var here = n.key === key;
        return '<li><a href="' + n.href + '"' + (here ? ' aria-current="page"' : '') +
               (n.accent ? ' class="accent"' : n.muted ? ' class="muted"' : '') + '>' + esc(n.label) + '</a></li>';
      }).join('');

      host.insertAdjacentHTML('beforebegin',
        '<a class="skip" href="#main">Skip to main content</a>' +
        (EMBED ? '' :
        '<div class="preview-bar">' +
          '<span class="pb-badge">Client preview</span>' +
          '<span class="pb-tagline">Prepared for A1 Opticals by <a href="https://netloom.in">Netloom</a></span>' +
          '<span class="pb-spacer"></span>' +
          '<span class="pb-tagline">Prices and stock are placeholders · ' +
            (trade ? 'Trade view' : 'Retail view') + '</span>' +
        '</div>'));

      host.outerHTML =
        (offer.on && offer.items.length && !trade ?
        '<div class="offer-bar" role="region" aria-label="Offers">' +
          '<div class="offer-in">' +
            offer.items.map(function (t, i) { return (i ? '<span class="dot">·</span>' : '') + '<a href="offers.html">' + esc(t) + '</a>'; }).join('') +
          '</div>' +
        '</div>' : '') +
        (trade ?
        '<div class="offer-bar trade" role="region" aria-label="Trade account">' +
          '<div class="offer-in">' +
            '<span>Trade account' + (user && user.shop ? ' · ' + esc(user.shop) : '') + ' · trade prices, volume tiers and GST invoice on every order</span>' +
            '<span class="dot">·</span><a href="#" data-switch="retail">Switch to retail view</a>' +
          '</div>' +
        '</div>' : '') +
        '<header class="head">' +
          '<div class="head-in">' +
            '<button type="button" class="menu-btn" id="menuBtn" aria-label="Menu" aria-expanded="false"><i class="fa-solid fa-bars"></i></button>' +
            wordmark('') +
            '<div class="search">' +
              '<i class="fa-solid fa-magnifying-glass"></i>' +
              '<input id="headSearch" type="search" placeholder="Search ' + skuCount + '+ frames, brands, lenses" ' +
                     'aria-label="Search the catalogue" autocomplete="off">' +
            '</div>' +
            '<div class="head-sp"></div>' +
            '<div class="head-links">' +
              '<a href="track.html">Track order</a>' +
              '<a href="eye-test.html">Book eye test</a>' +
              '<a href="account.html">Account</a>' +
            '</div>' +
            '<a class="bag" href="cart.html" aria-label="Your bag">' +
              '<i class="fa-solid fa-bag-shopping"></i>' +
              '<span class="bag-label">' + (trade ? 'Order' : 'Bag') + ' · <span data-cart-total>₹0</span></span>' +
              '<span class="badge" data-cart-count hidden>0</span></a>' +
          '</div>' +
          '<div class="search search-mobile">' +
            '<i class="fa-solid fa-magnifying-glass"></i>' +
            '<input id="headSearchM" type="search" placeholder="Search frames, brands, lenses" aria-label="Search the catalogue" autocomplete="off">' +
          '</div>' +
          '<nav class="nav" aria-label="Categories">' +
            '<div class="nav-in">' +
              '<ul class="nav-list">' + nav + '</ul>' +
              '<a class="nav-store" href="index.html#visit">' + storesLine() + '</a>' +
            '</div>' +
          '</nav>' +
        '</header>' +
        '<div class="drawer" id="drawer" hidden>' +
          '<div class="drawer-in">' +
            '<div class="drawer-head">' + wordmark('') + '<button type="button" class="icon-x" id="drawerClose" aria-label="Close menu"><i class="fa-solid fa-xmark"></i></button></div>' +
            '<ul class="drawer-nav">' + nav + '</ul>' +
            '<ul class="drawer-links">' +
              '<li><a href="track.html">Track order</a></li>' +
              '<li><a href="eye-test.html">Book eye test</a></li>' +
              '<li><a href="account.html">Account</a></li>' +
              '<li><a href="cart.html">' + (trade ? 'Your order' : 'Your bag') + '</a></li>' +
            '</ul>' +
            '<div class="drawer-store">' + storesLine() + '</div>' +
          '</div>' +
        '</div>';

      /* Search from any page lands on the catalogue with the query applied. */
      ['headSearch', 'headSearchM'].forEach(function (id) {
        var s = document.getElementById(id);
        if (!s) return;
        s.addEventListener('keydown', function (e) {
          if (e.key !== 'Enter') return;
          var q = s.value.trim();
          location.href = 'shop.html' + (q ? '?q=' + encodeURIComponent(q) : '');
        });
      });

      var drawer = document.getElementById('drawer');
      var menuBtn = document.getElementById('menuBtn');
      function openDrawer(open) {
        drawer.hidden = !open;
        menuBtn.setAttribute('aria-expanded', String(open));
        document.body.classList.toggle('drawer-open', open);
      }
      menuBtn.addEventListener('click', function () { openDrawer(drawer.hidden); });

      /* Condense on scroll-down, restore on scroll-up.
         The mobile header is three stacked rows — logo, search, categories —
         and all three are sticky, so 161 px of a 812 px phone screen is spent
         before any product is visible, permanently, while scrolling a
         catalogue. Someone shopping downward does not need the search field
         or the category rail in front of them; someone scrolling back up
         usually does. The two rows collapse together, which returns about a
         fifth of the screen, and the logo, bag and menu never move.

         CSS does the animating; this only sets a class. With JS off the
         header stays exactly as it was. */
      (function condenseHeader(){
        var head = document.querySelector('.head');
        if (!head) return;
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

        var last = window.scrollY, ticking = false;
        var DOWN_AT = 8;   // ignore scroll jitter and rubber-banding
        var CLEAR_AT = 180; // never condense while still near the top

        function update(){
          var y = window.scrollY;
          if (y < CLEAR_AT) {
            head.classList.remove('is-condensed');
          } else if (y - last > DOWN_AT) {
            head.classList.add('is-condensed');
          } else if (last - y > DOWN_AT) {
            head.classList.remove('is-condensed');
          }
          last = y;
          ticking = false;
        }
        window.addEventListener('scroll', function(){
          if (!ticking) { ticking = true; requestAnimationFrame(update); }
        }, { passive: true });
      })();
      document.getElementById('drawerClose').addEventListener('click', function () { openDrawer(false); });
      drawer.addEventListener('click', function (e) { if (e.target === drawer) openDrawer(false); });

      var sw = document.querySelector('[data-switch]');
      if (sw) sw.addEventListener('click', function (e) {
        e.preventDefault();
        Store.setMode(sw.getAttribute('data-switch'));
        location.reload();
      });
    }

    /* ── footer ── */
    var foot = document.getElementById('chrome-foot');
    if (foot) {
      var brand = SITE.get('brand'), contact = SITE.get('contact');
      var cats = CATALOG.categories.filter(function (c) { return c.nav; });
      foot.outerHTML =
        '<footer class="foot"><div class="foot-in">' +
          '<div class="foot-grid">' +
            '<div class="foot-brand-col">' +
              wordmark('wm-foot') +
              '<p class="foot-note">' + esc(brand.tagline) + '</p>' +
              '<p class="foot-note"><a href="' + esc(contact.phoneHref) + '">' + esc(contact.phone) + '</a> · ' +
              '<a href="mailto:' + esc(contact.email) + '">' + esc(contact.email) + '</a></p>' +
            '</div>' +
            '<div><h4>Shop</h4><ul>' +
              cats.map(function (c) { return '<li><a href="shop.html?cat=' + c.id + '">' + esc(c.label) + '</a></li>'; }).join('') +
              '<li><a href="brands.html">Brands</a></li>' +
              '<li><a href="offers.html">Offers</a></li>' +
            '</ul></div>' +
            '<div><h4>Eyecare</h4><ul>' +
              '<li><a href="eye-test.html">Book an eye test</a></li>' +
              '<li><a href="offers.html#lenses">Lens guide</a></li>' +
              '<li><a href="index.html#visit">Repairs &amp; adjustments</a></li>' +
              '<li><a href="index.html#visit">Find the store</a></li>' +
            '</ul></div>' +
            '<div><h4>Help</h4><ul>' +
              '<li><a href="track.html">Track my order</a></li>' +
              '<li><a href="refunds.html">Returns &amp; exchange</a></li>' +
              '<li><a href="shipping.html">Delivery</a></li>' +
              '<li><a href="privacy.html">Privacy</a></li>' +
              '<li><a href="terms.html">Terms</a></li>' +
            '</ul></div>' +
            '<div><h4>For opticians</h4><ul>' +
              '<li><a href="trade.html">Open a trade account</a></li>' +
              '<li><a href="trade.html#quick">Quick order pad</a></li>' +
              '<li><a href="shop.html?cat=lenses">Ophthalmic lenses</a></li>' +
              '<li><a href="shop.html?cat=instruments">Instruments</a></li>' +
              '<li><a href="admin.html">' + (ADMIN_ON ? 'Owner dashboard' : 'Owner login') + '</a></li>' +
            '</ul></div>' +
          '</div>' +
          '<div class="foot-bottom">' +
            '<span>Preview build — no order placed here is real. Prepared by <a href="https://netloom.in">Netloom</a>.</span>' +
            '<span>' + esc(contact.gstin) + ' · ' + esc(SITE.stores()[0] ? SITE.stores()[0].city : '') + '</span>' +
          '</div>' +
        '</div></footer>';
    }

    if (window.Store && Store.mountBadge) Store.mountBadge();
  }

  /* Toast, shared by every page that changes the bag. */
  window.toast = function (msg, icon) {
    var t = document.querySelector('.toast');
    if (!t) { t = el('div', 'toast'); document.body.appendChild(t); }
    t.innerHTML = '<i class="fa-solid ' + (icon || 'fa-circle-check') + '"></i><span></span>';
    t.querySelector('span').textContent = msg;
    requestAnimationFrame(function () { t.classList.add('show'); });
    clearTimeout(t._t);
    t._t = setTimeout(function () { t.classList.remove('show'); }, 2600);
  };

  /* Modal, shared by the prescription entry, the lens guide, the size guide
     and "reserve in store". Returns the dialog element; anything with
     [data-close] inside it closes it, as do Escape and the backdrop. */
  window.modal = function (html, opts) {
    opts = opts || {};
    window.closeModal();
    var bg = el('div', 'modal-bg');
    bg.innerHTML = '<div class="modal' + (opts.wide ? ' wide' : '') + '" role="dialog" aria-modal="true">' +
      '<button type="button" class="icon-x modal-x" data-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button>' +
      html + '</div>';
    document.body.appendChild(bg);
    document.body.classList.add('modal-open');
    function close() { window.closeModal(); }
    bg.addEventListener('click', function (e) { if (e.target === bg || e.target.closest('[data-close]')) close(); });
    bg._esc = function (e) { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', bg._esc);
    var f = bg.querySelector('input, select, textarea, button:not([data-close])');
    if (f) setTimeout(function () { f.focus(); }, 30);
    return bg.querySelector('.modal');
  };
  window.closeModal = function () {
    var bg = document.querySelector('.modal-bg');
    if (!bg) return;
    document.removeEventListener('keydown', bg._esc);
    bg.remove();
    document.body.classList.remove('modal-open');
  };

  /* Star rating, small. */
  window.starsHtml = function (rating, reviews) {
    if (!rating) return '';
    return '<span class="stars" aria-label="Rated ' + rating + ' out of 5"><b>' + rating.toFixed(1) + '</b>' +
      '<i class="fa-solid fa-star"></i>' + (reviews ? '<span>' + reviews + ' reviews</span>' : '') + '</span>';
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
