/* =============================================================================
   a1opticals/card.js — one product tile, rendered the same way everywhere
   -----------------------------------------------------------------------------
   The home page, the catalogue, the brand and offer pages all show tiles.
   Two copies of this markup would drift the first time a price format or a
   badge changed.

   Two tiles, chosen by what is being sold and to whom:

   RETAIL — "Meridian · Tortoise, ₹1,499, was ₹2,600, frame ₹999 + lens ₹500".
   One number, lenses included, because the whole store is built on that
   number not growing at checkout. No add button: a pair of glasses needs a
   lens choice, so the tile goes to the product page.

   TRADE — what an optician sees for every item once signed in, and what
   everyone sees for stock lenses and instruments: trade price per unit, the
   volume steps, MRP and margin, and an "Add MOQ" button.

   A tile shows a MODEL. The swatches under the image are its colourways;
   clicking one re-renders the tile as that SKU in place, so the image, the
   size and the price all switch together without leaving the grid.
   ========================================================================== */
(function () {
  'use strict';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* One badge at most, in order of what the shopper needs to know. */
  function badge(p) {
    var rule = Store.bogoRule();
    if (p.stock === 0) return '<span class="tag out">Out of stock</span>';
    if (Store.bogoEligible(p)) return '<span class="tag teal">' + esc(rule.badge) + '</span>';
    if (Store.isNew(p)) return '<span class="tag ink">NEW</span>';
    if (p.rx) return '<span class="tag ink">Made to Rx</span>';
    if (p.stock <= 3) return '<span class="tag amber">Only ' + p.stock + ' left</span>';
    return '';
  }

  function swatchesHtml(p) {
    var sibs = CATALOG.siblings(p);
    if (sibs.length < 2) return '';
    return '<div class="card-swatches" role="group" aria-label="Colours">' +
      sibs.map(function (s) {
        var on = s.sku === p.sku;
        return '<button type="button" class="sw' + (on ? ' on' : '') + (s.stock === 0 ? ' out' : '') + '" data-swatch="' + esc(s.sku) + '" ' +
               'style="--sw:' + esc(s.colour.hex) + '" title="' + esc(s.colour.label) + '" aria-label="' + esc(s.colour.label) + '" aria-pressed="' + on + '"></button>';
      }).join('') +
    '</div>';
  }

  function retailCard(p, lensId) {
    var href = 'product.html?sku=' + encodeURIComponent(p.sku) + (lensId ? '&lens=' + encodeURIComponent(lensId) : '');
    var now = Store.displayPrice(p, lensId);
    var was = Store.wasPrice(p, lensId);
    var bd = Store.breakdown(p, p.variants[0].id, lensId);
    var showBd = SITE.get('display').showBreakdown && bd.lensPkg && bd.lens > 0;
    var size = CATALOG.sizeLabel(p);
    var title = esc(p.name) + (p.colour ? ' · ' + esc(p.colour.label) : '');
    var sub = p.cat === 'contacts' ? esc((p.attrs && p.attrs.type ? p.attrs.type + ' · ' : '') + 'per box')
            : p.cat === 'readers' ? 'Powers +1.00 to +3.00'
            : size ? '<span class="tnum">' + esc(size) + '</span>' : esc(p.style || '');

    return '' +
      '<div class="card" data-sku="' + esc(p.sku) + '" data-lens="' + esc(lensId || '') + '">' +
        '<a class="card-media" href="' + href + '">' +
          '<img src="' + CATALOG.img(p.photo) + '" alt="' + title + '" loading="lazy" decoding="async">' +
          badge(p) +
        '</a>' +
        '<div class="card-body">' +
          '<span class="card-brand">' + esc(p.brand) + '</span>' +
          '<a class="card-name" href="' + href + '">' + title + '</a>' +
          '<span class="card-size">' + sub + '</span>' +
          swatchesHtml(p) +
          '<div class="card-price-row">' +
            '<span class="card-price">' + Store.rupees(now) + '</span>' +
            (was ? '<span class="card-was">' + Store.rupees(was) + '</span>' : '') +
          '</div>' +
          (showBd ? '<span class="card-bd">frame ' + Store.rupees(bd.frame) + ' + lens ' + Store.rupees(bd.lens) + '</span>' : '') +
        '</div>' +
      '</div>';
  }

  function tiersHtml(p) {
    if (!p.tiers || !p.tiers.length) return '';
    return '<div class="card-tiers">' + p.tiers.map(function (t) {
      return '<span><b>' + t.min + '+</b> ' + Store.rupees(t.price) + '</span>';
    }).join('') + '</div>';
  }

  function tradeCard(p) {
    var margin = Math.round((1 - p.price / p.mrp) * 100);
    var many = p.variants.length > 1;
    var soldOut = p.stock === 0;
    var locked = !Store.isTrade();   // a trade item seen by a retail visitor
    var href = 'product.html?sku=' + encodeURIComponent(p.sku);

    var chooser = many && !locked
      ? '<select class="card-var" data-variant aria-label="Choose an option for ' + esc(p.name) + '">' +
          p.variants.map(function (v) {
            return '<option value="' + esc(v.id) + '">' + esc(v.label) +
                   (v.delta ? ' · ' + (v.delta > 0 ? '+' : '−') + Store.rupees(Math.abs(v.delta)) : '') + '</option>';
          }).join('') +
        '</select>'
      : '';

    return '' +
      '<div class="card card-trade" data-sku="' + esc(p.sku) + '">' +
        '<a class="card-media" href="' + href + '">' +
          '<img src="' + CATALOG.img(p.photo) + '" alt="' + esc(p.name) + (p.colour ? ', ' + esc(p.colour.label) : '') + '" loading="lazy" decoding="async">' +
          badge(p) +
        '</a>' +
        '<div class="card-body">' +
          '<span class="card-brand">' + esc(p.brand) + ' · <span class="tnum">' + esc(p.sku) + '</span></span>' +
          '<a class="card-name" href="' + href + '">' + esc(p.name) + (p.colour ? ' · ' + esc(p.colour.label) : '') + '</a>' +
          '<span class="card-size">' + esc(p.style || p.pack) + '</span>' +
          swatchesHtml(p) +
          '<div class="card-price-row">' +
            '<span class="card-price">' + Store.rupees(p.price) + '<small>/' + esc(p.unit) + '</small></span>' +
            '<span class="card-mrp">MRP ' + Store.rupees(p.mrp) + '</span>' +
            (margin > 0 ? '<span class="card-off">' + margin + '% margin</span>' : '') +
          '</div>' +
          tiersHtml(p) +
        '</div>' +
        '<div class="card-add">' +
          chooser +
          (locked
            ? '<a class="btn btn-ghost btn-sm card-buy" href="trade.html">Trade price · open an account</a>'
            : '<button type="button" class="btn btn-primary btn-sm card-buy" data-add' + (soldOut ? ' disabled' : '') + '>' +
                (soldOut ? 'Out of stock' : '<i class="fa-solid fa-plus"></i> Add ' + p.moq) + '</button>') +
        '</div>' +
      '</div>';
  }

  /* opts.lens — price every retail tile with this package instead of the
     included one (the "change lens package" control on the catalogue). */
  window.cardHtml = function (p, opts) {
    opts = opts || {};
    if (Store.tradePricing(p)) return tradeCard(p);
    return retailCard(p, opts.lens || null);
  };

  /* One delegated listener for every grid on the page. */
  document.addEventListener('click', function (e) {
    /* colourway swap — re-render the tile as the sibling SKU */
    var sw = e.target.closest && e.target.closest('[data-swatch]');
    if (sw) {
      var card0 = sw.closest('.card');
      var next = CATALOG.bySku(sw.getAttribute('data-swatch'));
      if (card0 && next) {
        var tmp = document.createElement('div');
        tmp.innerHTML = window.cardHtml(next, { lens: card0.getAttribute('data-lens') || null });
        card0.parentNode.replaceChild(tmp.firstChild, card0);
      }
      return;
    }

    var btn = e.target.closest && e.target.closest('[data-add]');
    if (!btn) return;

    var card = btn.closest('.card');
    if (!card) return;
    var sku = card.getAttribute('data-sku');
    var p = CATALOG.bySku(sku);
    if (!p) return;

    var sel = card.querySelector('[data-variant]');
    var variantId = sel ? sel.value : p.variants[0].id;
    var variant = CATALOG.variant(p, variantId);

    var r = Store.add(sku, variantId, p.moq || 1);

    if (r.ok && r.capped) {
      window.toast('Added — that is all ' + r.max + ' in stock', 'fa-triangle-exclamation');
    } else if (r.ok) {
      window.toast(p.moq + ' × ' + p.name + (p.colour ? ' · ' + p.colour.label : '') + (p.variants.length > 1 ? ' · ' + variant.label : '') + ' added to order');
      flash(btn);
    } else if (r.reason === 'out-of-stock') {
      window.toast('Out of stock', 'fa-circle-xmark');
    } else if (r.reason === 'stock-capped') {
      window.toast('Your order already has all ' + r.max, 'fa-triangle-exclamation');
    }
  });

  function flash(btn) {
    if (btn.dataset.busy) return;
    btn.dataset.busy = '1';
    var original = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-check"></i> Added';
    btn.classList.add('is-added');
    setTimeout(function () {
      btn.innerHTML = original;
      btn.classList.remove('is-added');
      delete btn.dataset.busy;
    }, 1400);
  }
})();
