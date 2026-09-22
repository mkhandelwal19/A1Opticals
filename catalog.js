/* =============================================================================
   a1opticals/catalog.js — the catalogue, retail and trade
   -----------------------------------------------------------------------------
   Static for the preview, and deliberately shaped like database rows rather
   than display copy, so moving it to Supabase later is a change of source and
   not a rewrite of every page.

   Money is in PAISE, always, as integers. Never floats.

   The product model, the way an eyewear catalogue actually works:
     - A MODEL is a design: "Meridian", model code A1-FR-2105.
     - Each COLOURWAY of a model is its own SKU with its own stock and its own
       image: A1-FR-2105 (tortoise), A1-FR-2105-BK (black). Real brands do the
       same — RB2140 901 and RB2140 902 are one model, two SKUs.
     - SIZES are variants on a SKU: 51□19-142, 53□19-145.
   So the catalogue grid shows one tile per model with colour swatches, the
   bag holds SKUs, and stock is counted where it is actually counted.

   Three prices on every row:
     - `retail` is what a walk-in customer pays for the FRAME. The storefront
       adds the included lens package (site.js) on top and shows one number —
       "₹1,499, lenses included" — because a price that grows at checkout is
       the thing this store exists to not do.
     - `mrp` is the printed MRP, shown struck through.
     - `price` is the TRADE price per unit at quantity one; `tiers` steps it
       down at volume. Opticians with a trade account see this instead.

   Trade specifics kept from the trade build:
     - `moq` is the minimum order quantity; `unit` is what one line means.
     - `rx` flags lenses made to a prescription supplied per line.
     - `gst` and `hsn` go on the invoice.
     - `attrs` carries the filterable attributes: material, shape, gender.

   Product imagery is generated: a `photo` key such as
   "frame:round:acetate:tortoise" becomes an SVG line render on a white
   studio, so a few thousand SKUs can be previewed before one is photographed.
   A photo uploaded from the admin page is a data URL and is used as-is. Real
   photography drops in by pointing `photo` (or `photos[]`) at a file.
   ========================================================================== */
window.CATALOG = (function () {
  'use strict';

  var SWATCH = {
    tortoise: '#7A5334', black: '#14181A', crystal: '#DCE3EA', navy: '#243B55',
    gold: '#C79A3E', silver: '#B9C0C7', gunmetal: '#5E6B73', rosegold: '#D2957A',
    grey: '#93968F', smoke: '#9AA0A3', slate: '#3E5468', red: '#A8503F',
    green: '#2E5B3E', brown: '#8A6B4F', blue: '#2F6FB5', pink: '#D98BA6', clear: '#B6BABC'
  };

  var FAMILY = {
    tortoise: 'Tortoise', black: 'Black', crystal: 'Crystal', navy: 'Navy', gold: 'Gold', silver: 'Silver',
    gunmetal: 'Gunmetal', rosegold: 'Rose gold', grey: 'Grey', smoke: 'Smoke', slate: 'Slate blue', red: 'Red',
    green: 'Green', brown: 'Brown', blue: 'Blue', pink: 'Pink', clear: 'Clear'
  };
  function colour(id, label) { return { id: id, label: label, hex: SWATCH[id] || '#999' }; }

  /* A frame model with its colourways. The first colourway keeps the bare
     model code as its SKU; the rest take a suffix. Everything else is shared. */
  function frameModel(base, ways) {
    return ways.map(function (w, i) {
      var p = {};
      for (var k in base) p[k] = base[k];
      p.model = base.sku;
      p.sku = i === 0 ? base.sku : base.sku + '-' + w.suffix;
      p.colour = colour(w.colour, w.label);
      p.photo = w.photo;
      p.stock = w.stock;
      p.attrs = { material: base.material, shape: base.shape, gender: base.gender || 'Unisex' };
      delete p.material; delete p.shape; delete p.gender;
      return p;
    });
  }

  function sizes(list) {
    return list.map(function (s) { return { id: String(s[0]), label: s[0] + ' □ ' + s[1] + ' – ' + s[2], delta: 0 }; });
  }
  var POWERS = ['+1.00', '+1.50', '+2.00', '+2.50', '+3.00'].map(function (p) {
    return { id: p.replace(/[+.]/g, ''), label: p, delta: 0 };
  });

  var PRODUCTS = [].concat(
    /* ── Eyeglasses — A1 Studio (acetate & TR90) ───────────────────────── */
    frameModel({
      sku: 'A1-FR-2105', name: 'Meridian', style: 'Rectangle acetate', cat: 'frames',
      brand: 'A1 Studio', pack: 'Per piece · MOQ 6', unit: 'pc', moq: 6,
      price: 72000, retail: 99900, mrp: 260000, gst: 12, hsn: '9003',
      tiers: [{ min: 12, price: 64000 }, { min: 48, price: 56000 }],
      material: 'Acetate', shape: 'Rectangle', weight: 24, rating: 4.6, reviews: 218,
      blurb: 'Hand-polished acetate in a medium rectangle — the shape that suits the widest range of faces and the one we sell most of. Spring hinges, adjustable nose pads, and a five-barrel hinge that survives being folded a few thousand times.',
      variants: sizes([[51, 19, 142], [53, 19, 145]])
    }, [
      { suffix: '', colour: 'tortoise', label: 'Tortoise', photo: 'frame:rectangle:acetate:tortoise', stock: 96 },
      { suffix: 'BK', colour: 'black', label: 'Black', photo: 'frame:rectangle:acetate:black', stock: 110 },
      { suffix: 'GY', colour: 'grey', label: 'Grey', photo: 'frame:rectangle:acetate:grey', stock: 34 }
    ]),
    frameModel({
      sku: 'A1-FR-2102', name: 'Rille', style: 'Wayfarer acetate', cat: 'frames',
      brand: 'A1 Studio', pack: 'Per piece · MOQ 6', unit: 'pc', moq: 6,
      price: 74000, retail: 79900, mrp: 240000, gst: 12, hsn: '9003',
      tiers: [{ min: 12, price: 64000 }, { min: 48, price: 55000 }],
      material: 'Acetate', shape: 'Wayfarer', weight: 26, rating: 4.6, reviews: 418,
      blurb: 'The frame every counter needs a dozen of. Spring hinges, fits most Indian faces at 53 eye. The reorder SKU in most of our accounts, and the one we put on the window.',
      variants: sizes([[53, 18, 145], [55, 18, 148]])
    }, [
      { suffix: '', colour: 'black', label: 'Matte black', photo: 'frame:wayfarer:acetate:black', stock: 120 },
      { suffix: 'TO', colour: 'tortoise', label: 'Tortoise', photo: 'frame:wayfarer:acetate:tortoise', stock: 66 },
      { suffix: 'NV', colour: 'navy', label: 'Navy', photo: 'frame:wayfarer:acetate:navy', stock: 30 }
    ]),
    frameModel({
      sku: 'A1-FR-2103', name: 'Ellis', style: 'Square acetate', cat: 'frames',
      brand: 'A1 Studio', pack: 'Per piece · MOQ 6', unit: 'pc', moq: 6,
      price: 82000, retail: 139900, mrp: 290000, gst: 12, hsn: '9003',
      tiers: [{ min: 12, price: 72000 }, { min: 48, price: 62000 }],
      material: 'Acetate', shape: 'Square', weight: 24, rating: 4.4, reviews: 61, isNew: true,
      blurb: 'Slightly thicker rim, which carries a high-minus lens edge without showing it. The smoke crystal has a faint grey cast so it does not yellow in a sunlit window.',
      variants: sizes([[52, 17, 145], [54, 17, 145]])
    }, [
      { suffix: '', colour: 'smoke', label: 'Smoke crystal', photo: 'frame:square:acetate:smoke', stock: 36 },
      { suffix: 'BK', colour: 'black', label: 'Black', photo: 'frame:square:acetate:black', stock: 74 },
      { suffix: 'SL', colour: 'slate', label: 'Slate blue', photo: 'frame:square:acetate:slate', stock: 41 }
    ]),
    frameModel({
      sku: 'A1-FR-2101', name: 'Orbit', style: 'Round acetate', cat: 'frames',
      brand: 'A1 Studio', pack: 'Per piece · MOQ 6', unit: 'pc', moq: 6,
      price: 79000, retail: 119900, mrp: 219000, gst: 12, hsn: '9003',
      tiers: [{ min: 12, price: 69000 }, { min: 48, price: 59000 }],
      material: 'Acetate', shape: 'Round', weight: 22, rating: 4.5, reviews: 132,
      blurb: 'Hand-polished Italian-grade acetate, five-barrel hinges, 47 and 49 eye. Sells through at the counter without help.',
      variants: sizes([[47, 21, 145], [49, 21, 145]])
    }, [
      { suffix: '', colour: 'tortoise', label: 'Tortoise', photo: 'frame:round:acetate:tortoise', stock: 84 },
      { suffix: 'BK', colour: 'black', label: 'Black', photo: 'frame:round:acetate:black', stock: 52 },
      { suffix: 'CR', colour: 'crystal', label: 'Crystal', photo: 'frame:round:acetate:crystal', stock: 18 }
    ]),
    frameModel({
      sku: 'A1-FR-2104', name: 'Harlow', style: 'Browline', cat: 'frames',
      brand: 'A1 Studio', pack: 'Per piece · MOQ 6', unit: 'pc', moq: 6,
      price: 98000, retail: 169900, mrp: 269000, gst: 12, hsn: '9003',
      tiers: [{ min: 12, price: 88000 }, { min: 48, price: 76000 }],
      material: 'Acetate', shape: 'Browline', gender: 'Men', weight: 27, rating: 4.7, reviews: 88,
      blurb: 'Acetate brow over a gold-tone metal rim. Reads formal, sits at a price point where the retail margin is comfortable.',
      variants: sizes([[50, 21, 145]])
    }, [
      { suffix: '', colour: 'navy', label: 'Navy / gold', photo: 'frame:browline:metal:gold:navy', stock: 28 },
      { suffix: 'BK', colour: 'black', label: 'Black / gold', photo: 'frame:browline:metal:gold:black', stock: 33 },
      { suffix: 'TO', colour: 'tortoise', label: 'Tortoise / gold', photo: 'frame:browline:metal:gold:tortoise', stock: 12 }
    ]),
    frameModel({
      sku: 'A1-FR-2106', name: 'Kade', style: 'Rectangle TR90', cat: 'frames',
      brand: 'A1 Studio', pack: 'Per piece · MOQ 6', unit: 'pc', moq: 6,
      price: 52000, retail: 69900, mrp: 220000, gst: 12, hsn: '9003',
      tiers: [{ min: 12, price: 46000 }, { min: 48, price: 40000 }],
      material: 'TR90', shape: 'Rectangle', weight: 15, rating: 4.3, reviews: 74,
      blurb: 'Featherweight TR90 that bends and comes back. The frame we suggest to anyone who has broken a pair sitting on it.',
      variants: sizes([[50, 20, 140], [52, 20, 142]])
    }, [
      { suffix: '', colour: 'navy', label: 'Navy', photo: 'frame:rectangle:tr90:navy', stock: 58 },
      { suffix: 'BK', colour: 'black', label: 'Black', photo: 'frame:rectangle:tr90:black', stock: 72 }
    ]),
    frameModel({
      sku: 'A1-FR-2107', name: 'Arno', style: 'Round-square acetate', cat: 'frames',
      brand: 'A1 Studio', pack: 'Per piece · MOQ 6', unit: 'pc', moq: 6,
      price: 39000, retail: 49900, mrp: 190000, gst: 12, hsn: '9003',
      tiers: [{ min: 12, price: 34000 }, { min: 48, price: 29000 }],
      material: 'Acetate', shape: 'Square', weight: 23, rating: 4.2, reviews: 156,
      blurb: 'Our entry frame, and the one that makes "glasses from ₹999" true. Soft square, keyhole bridge, a clear grey that disappears on the face.',
      variants: sizes([[52, 19, 142]])
    }, [
      { suffix: '', colour: 'clear', label: 'Clear grey', photo: 'frame:square:acetate:clear', stock: 140 },
      { suffix: 'TO', colour: 'tortoise', label: 'Tortoise', photo: 'frame:square:acetate:tortoise', stock: 88 }
    ]),

    /* ── Eyeglasses — A1 Titanium (metal) ─────────────────────────────── */
    frameModel({
      sku: 'A1-FR-3201', name: 'Halden', style: 'Aviator titanium', cat: 'frames',
      brand: 'A1 Titanium', pack: 'Per piece · MOQ 3', unit: 'pc', moq: 3,
      price: 168000, retail: 299900, mrp: 449000, gst: 12, hsn: '9003',
      tiers: [{ min: 12, price: 152000 }, { min: 36, price: 138000 }],
      material: 'Titanium', shape: 'Aviator', weight: 14, rating: 4.8, reviews: 97,
      blurb: 'Beta-titanium, 14 g on the scale, IP-plated so the finish does not wear at the temples in a year. Adjustable silicone pads. Sold with a hard case and cloth.',
      variants: sizes([[56, 15, 140], [58, 15, 145]])
    }, [
      { suffix: '', colour: 'gold', label: 'Gold', photo: 'frame:aviator:metal:gold', stock: 22 },
      { suffix: 'SL', colour: 'silver', label: 'Silver', photo: 'frame:aviator:metal:silver', stock: 19 },
      { suffix: 'GM', colour: 'gunmetal', label: 'Gunmetal', photo: 'frame:aviator:metal:gunmetal', stock: 14 }
    ]),
    frameModel({
      sku: 'A1-FR-3202', name: 'Lumen', style: 'Round metal', cat: 'frames',
      brand: 'A1 Titanium', pack: 'Per piece · MOQ 3', unit: 'pc', moq: 3,
      price: 112000, retail: 199900, mrp: 299000, gst: 12, hsn: '9003',
      tiers: [{ min: 12, price: 99000 }, { min: 36, price: 89000 }],
      material: 'Metal', shape: 'Round', weight: 18, rating: 4.6, reviews: 143,
      blurb: 'Stainless with a brushed finish. Thin rim, so it takes a 1.67 or 1.74 lens cleanly. The frame most of our clinic accounts stock for professionals.',
      variants: sizes([[47, 22, 145], [49, 22, 145]])
    }, [
      { suffix: '', colour: 'gunmetal', label: 'Gunmetal', photo: 'frame:round:metal:gunmetal', stock: 40 },
      { suffix: 'GD', colour: 'gold', label: 'Gold', photo: 'frame:round:metal:gold', stock: 26 },
      { suffix: 'RG', colour: 'rosegold', label: 'Rose gold', photo: 'frame:round:metal:rosegold', stock: 17 }
    ]),
    frameModel({
      sku: 'A1-FR-3203', name: 'Vesper', style: 'Cat-eye metal', cat: 'frames',
      brand: 'A1 Titanium', pack: 'Per piece · MOQ 3', unit: 'pc', moq: 3,
      price: 124000, retail: 219900, mrp: 329000, gst: 12, hsn: '9003',
      tiers: [{ min: 12, price: 110000 }, { min: 36, price: 98000 }],
      material: 'Metal', shape: 'Cat-eye', gender: 'Women', weight: 17, rating: 4.5, reviews: 52,
      blurb: 'A soft upsweep rather than a sharp one, so it works on more faces. IP plating over stainless. Ships with matching cloth.',
      variants: sizes([[52, 17, 140]])
    }, [
      { suffix: '', colour: 'rosegold', label: 'Rose gold', photo: 'frame:cateye:metal:rosegold', stock: 18 },
      { suffix: 'GD', colour: 'gold', label: 'Gold', photo: 'frame:cateye:metal:gold', stock: 15 },
      { suffix: 'BK', colour: 'black', label: 'Matte black', photo: 'frame:cateye:metal:black', stock: 9 }
    ]),
    frameModel({
      sku: 'A1-FR-3301', name: 'Aero', style: 'Rimless titanium', cat: 'frames',
      brand: 'A1 Titanium', pack: 'Per piece · MOQ 3', unit: 'pc', moq: 3,
      price: 189000, retail: 349900, mrp: 499000, gst: 12, hsn: '9003',
      tiers: [{ min: 12, price: 172000 }, { min: 36, price: 158000 }],
      material: 'Titanium', shape: 'Rimless', weight: 9, rating: 4.7, reviews: 39,
      blurb: 'Three-piece rimless, pure titanium, 9 g. Supplied with a demo lens cut to the shape shown; glazing to any shape on the chart on request.',
      variants: sizes([[54, 18, 145]])
    }, [
      { suffix: '', colour: 'silver', label: 'Silver', photo: 'frame:square:rimless:silver', stock: 9 },
      { suffix: 'GM', colour: 'gunmetal', label: 'Gunmetal', photo: 'frame:square:rimless:gunmetal', stock: 6 }
    ]),

    /* ── Eyeglasses — designer brands, stocked as an authorised dealer ─── */
    frameModel({
      sku: 'VO-5462', name: 'VO5462', style: 'Square acetate', cat: 'frames',
      brand: 'Vogue', pack: 'Per piece', unit: 'pc', moq: 1,
      price: 320000, retail: 379000, mrp: 529000, gst: 12, hsn: '9003',
      tiers: [{ min: 6, price: 298000 }],
      material: 'Acetate', shape: 'Square', gender: 'Women', weight: 25, rating: 4.5, reviews: 64,
      blurb: 'Vogue’s bestselling square, glossy acetate with the metal V at the temple. Fitted with A1 lenses, so the price here is the price of a finished pair.',
      variants: sizes([[54, 17, 145]])
    }, [
      { suffix: '', colour: 'black', label: 'Black', photo: 'frame:square:acetate:black', stock: 14 },
      { suffix: 'BR', colour: 'brown', label: 'Havana brown', photo: 'frame:square:acetate:brown', stock: 8 }
    ]),
    frameModel({
      sku: 'RB-5154', name: 'RB5154 Clubmaster', style: 'Browline', cat: 'frames',
      brand: 'Ray-Ban', pack: 'Per piece', unit: 'pc', moq: 1,
      price: 790000, retail: 919000, mrp: 1099000, gst: 12, hsn: '9003',
      tiers: [{ min: 6, price: 749000 }],
      material: 'Acetate', shape: 'Browline', weight: 28, rating: 4.8, reviews: 310,
      blurb: 'The optical Clubmaster. Genuine Luxottica stock with the serial etched on the temple, fitted with A1 lenses in our own lab.',
      variants: sizes([[51, 21, 145], [53, 21, 145]])
    }, [
      { suffix: '', colour: 'tortoise', label: 'Tortoise', photo: 'frame:browline:metal:gold:tortoise', stock: 11 },
      { suffix: 'BK', colour: 'black', label: 'Black', photo: 'frame:browline:metal:black:black', stock: 9 }
    ]),
    frameModel({
      sku: 'PO-VPLN47', name: 'VPLN47', style: 'Rectangle metal', cat: 'frames',
      brand: 'Police', pack: 'Per piece', unit: 'pc', moq: 1,
      price: 125000, retail: 149000, mrp: 249000, gst: 12, hsn: '9003',
      tiers: [{ min: 6, price: 116000 }],
      material: 'Metal', shape: 'Rectangle', gender: 'Men', weight: 19, rating: 4.3, reviews: 28,
      blurb: 'Slim stainless rectangle with a brushed gunmetal finish and the Police wing on the temple tip.',
      variants: sizes([[54, 17, 145]])
    }, [
      { suffix: '', colour: 'gunmetal', label: 'Gunmetal', photo: 'frame:rectangle:metal:gunmetal', stock: 16 }
    ]),
    frameModel({
      sku: 'LC-L2913', name: 'L2913', style: 'Rectangle TR90', cat: 'frames',
      brand: 'Lacoste', pack: 'Per piece', unit: 'pc', moq: 1,
      price: 125000, retail: 149000, mrp: 279000, gst: 12, hsn: '9003',
      tiers: [{ min: 6, price: 116000 }],
      material: 'TR90', shape: 'Rectangle', weight: 16, rating: 4.4, reviews: 45,
      blurb: 'Matte TR90 in Lacoste green with the crocodile at the hinge. Light enough to forget on a long day.',
      variants: sizes([[53, 18, 145]])
    }, [
      { suffix: '', colour: 'green', label: 'Green', photo: 'frame:rectangle:tr90:green', stock: 12 },
      { suffix: 'BK', colour: 'black', label: 'Black', photo: 'frame:rectangle:tr90:black', stock: 10 }
    ]),

    /* ── Sunglasses ─────────────────────────────────────────────────────── */
    frameModel({
      sku: 'A1-SG-4101', name: 'Solstice', style: 'Aviator sun', cat: 'sun',
      brand: 'A1 Sun', pack: 'Per piece · MOQ 6', unit: 'pc', moq: 6,
      price: 142000, retail: 179900, mrp: 379000, gst: 18, hsn: '9004',
      tiers: [{ min: 12, price: 128000 }, { min: 48, price: 114000 }],
      material: 'Metal', shape: 'Aviator', weight: 24, rating: 4.6, reviews: 121,
      blurb: 'Classic 58 aviator, mineral lens, UV400. Metal, double bridge. Case and cloth included. Add your power and we fit tinted prescription lenses instead.',
      variants: sizes([[58, 14, 135]])
    }, [
      { suffix: '', colour: 'gold', label: 'Gold / green', photo: 'sun:aviator:metal:gold:green', stock: 30 },
      { suffix: 'SL', colour: 'silver', label: 'Silver / grey', photo: 'sun:aviator:metal:silver:grey', stock: 24 },
      { suffix: 'GM', colour: 'gunmetal', label: 'Gunmetal / grey', photo: 'sun:aviator:metal:gunmetal:grey', stock: 12 }
    ]),
    frameModel({
      sku: 'A1-SG-4102', name: 'Coast', style: 'Wayfarer sun', cat: 'sun',
      brand: 'A1 Sun', pack: 'Per piece · MOQ 6', unit: 'pc', moq: 6,
      price: 96000, retail: 129900, mrp: 259000, gst: 18, hsn: '9004',
      tiers: [{ min: 12, price: 86000 }, { min: 48, price: 76000 }],
      material: 'Acetate', shape: 'Wayfarer', weight: 30, rating: 4.5, reviews: 204,
      blurb: 'Polarised lens, UV400. The highest-turning sun SKU we carry — one for the window, eleven for the drawer.',
      variants: [{ id: 'pol', label: 'Polarised', delta: 0 }, { id: 'nonpol', label: 'Non-polarised', delta: -14000 }]
    }, [
      { suffix: '', colour: 'black', label: 'Black / grey', photo: 'sun:wayfarer:acetate:black:grey', stock: 64 },
      { suffix: 'TO', colour: 'tortoise', label: 'Tortoise / brown', photo: 'sun:wayfarer:acetate:tortoise:brown', stock: 38 }
    ]),
    frameModel({
      sku: 'A1-SG-4103', name: 'Riviera', style: 'Cat-eye sun', cat: 'sun',
      brand: 'A1 Sun', pack: 'Per piece · MOQ 6', unit: 'pc', moq: 6,
      price: 104000, retail: 149900, mrp: 279000, gst: 18, hsn: '9004',
      tiers: [{ min: 12, price: 94000 }, { min: 48, price: 82000 }],
      material: 'Acetate', shape: 'Cat-eye', gender: 'Women', weight: 28, rating: 4.4, reviews: 77,
      blurb: 'Gradient lens, UV400. Sells on the shelf next to the round tortoise optical as a pair.',
      variants: sizes([[53, 18, 140]])
    }, [
      { suffix: '', colour: 'tortoise', label: 'Tortoise / brown', photo: 'sun:cateye:acetate:tortoise:brown', stock: 26 },
      { suffix: 'BK', colour: 'black', label: 'Black / grey', photo: 'sun:cateye:acetate:black:grey', stock: 21 }
    ]),
    frameModel({
      sku: 'RB-3025', name: 'RB3025 Aviator', style: 'Aviator sun', cat: 'sun',
      brand: 'Ray-Ban', pack: 'Per piece', unit: 'pc', moq: 1,
      price: 690000, retail: 799000, mrp: 949000, gst: 18, hsn: '9004',
      tiers: [{ min: 6, price: 649000 }],
      material: 'Metal', shape: 'Aviator', weight: 31, rating: 4.9, reviews: 512,
      blurb: 'The original aviator, G-15 mineral lens. Genuine Luxottica stock. Powered versions fitted in our lab with the same tint.',
      variants: sizes([[58, 14, 135]])
    }, [
      { suffix: '', colour: 'gold', label: 'Gold / G-15', photo: 'sun:aviator:metal:gold:green', stock: 7 },
      { suffix: 'SL', colour: 'silver', label: 'Silver / grey', photo: 'sun:aviator:metal:silver:grey', stock: 5 }
    ]),

    /* ── Reading glasses — power built in, no prescription needed ───────── */
    frameModel({
      sku: 'A1-RG-8101', name: 'Page', style: 'Full-rim readers', cat: 'readers',
      brand: 'A1 Studio', pack: 'Per piece · MOQ 6', unit: 'pc', moq: 6,
      price: 32000, retail: 59900, mrp: 99000, gst: 12, hsn: '9004',
      tiers: [{ min: 12, price: 28000 }, { min: 48, price: 24000 }],
      material: 'TR90', shape: 'Rectangle', weight: 14, rating: 4.4, reviews: 203,
      blurb: 'Ready readers in +1.00 to +3.00, anti-glare coated, with a slim case. Same power both eyes. If your eyes differ, order a Meridian with your prescription instead.',
      variants: POWERS
    }, [
      { suffix: '', colour: 'black', label: 'Black', photo: 'frame:rectangle:tr90:black', stock: 210 },
      { suffix: 'TO', colour: 'tortoise', label: 'Tortoise', photo: 'frame:rectangle:tr90:tortoise', stock: 140 }
    ]),
    frameModel({
      sku: 'A1-RG-8102', name: 'Folio', style: 'Half-rim readers', cat: 'readers',
      brand: 'A1 Titanium', pack: 'Per piece · MOQ 6', unit: 'pc', moq: 6,
      price: 48000, retail: 89900, mrp: 149000, gst: 12, hsn: '9004',
      tiers: [{ min: 12, price: 42000 }, { min: 48, price: 36000 }],
      material: 'Metal', shape: 'Rectangle', weight: 16, rating: 4.5, reviews: 96,
      blurb: 'Half-rim metal readers you can look over. +1.00 to +3.00, anti-glare, spring hinges.',
      variants: POWERS
    }, [
      { suffix: '', colour: 'gunmetal', label: 'Gunmetal', photo: 'frame:rectangle:metal:gunmetal', stock: 80 },
      { suffix: 'GD', colour: 'gold', label: 'Gold', photo: 'frame:rectangle:metal:gold', stock: 44 }
    ]),

    /* ── Kids ───────────────────────────────────────────────────────────── */
    frameModel({
      sku: 'A1-KD-9101', name: 'Pip', style: 'Kids flexible TR90', cat: 'kids',
      brand: 'A1 Studio', pack: 'Per piece · MOQ 6', unit: 'pc', moq: 6,
      price: 26000, retail: 39900, mrp: 129000, gst: 12, hsn: '9003',
      tiers: [{ min: 12, price: 23000 }, { min: 48, price: 20000 }],
      material: 'TR90', shape: 'Round', gender: 'Kids', weight: 12, rating: 4.7, reviews: 86,
      blurb: 'Bendable TR90 with a one-piece hinge — no screws to lose — and a soft silicone nose. Ages 4 to 9. One free replacement in the first year.',
      variants: sizes([[44, 16, 125]])
    }, [
      { suffix: '', colour: 'blue', label: 'Blue', photo: 'frame:round:tr90:blue', stock: 48 },
      { suffix: 'PK', colour: 'pink', label: 'Pink', photo: 'frame:round:tr90:pink', stock: 40 },
      { suffix: 'BK', colour: 'black', label: 'Black', photo: 'frame:round:tr90:black', stock: 36 }
    ]),
    frameModel({
      sku: 'A1-KD-9102', name: 'Scout', style: 'Kids round acetate', cat: 'kids',
      brand: 'A1 Studio', pack: 'Per piece · MOQ 6', unit: 'pc', moq: 6,
      price: 42000, retail: 59900, mrp: 159000, gst: 12, hsn: '9003',
      tiers: [{ min: 12, price: 37000 }, { min: 48, price: 32000 }],
      material: 'Acetate', shape: 'Round', gender: 'Kids', weight: 16, rating: 4.6, reviews: 41,
      blurb: 'A proper acetate round scaled for ages 8 to 13, with spring hinges and a hard case that fits a school bag pocket.',
      variants: sizes([[45, 17, 130]])
    }, [
      { suffix: '', colour: 'tortoise', label: 'Tortoise', photo: 'frame:round:acetate:tortoise', stock: 22 },
      { suffix: 'NV', colour: 'navy', label: 'Navy', photo: 'frame:round:acetate:navy', stock: 19 }
    ]),

    /* ── Contact lenses — per box ───────────────────────────────────────── */
    [{
      sku: 'A1-CL-6103', model: 'A1-CL-6103', name: 'Monthly disposable, 3 lenses', cat: 'contacts',
      brand: 'A1 Vision', pack: 'Per box · MOQ 5', unit: 'box', moq: 5,
      price: 29000, retail: 45000, mrp: 65000, gst: 12, hsn: '9001',
      tiers: [{ min: 20, price: 26000 }, { min: 60, price: 23000 }],
      photo: 'cl:monthly3', stock: 160, attrs: { type: 'Monthly' }, rating: 4.4, reviews: 58,
      blurb: 'Three silicone hydrogel monthlies — a quarter’s supply for one eye, or a trial box. 8.6 base curve, 14.2 diameter, −0.50 to −10.00.',
      variants: [{ id: 'lo', label: '−0.50 to −6.00', delta: 0 }, { id: 'hi', label: '−6.50 to −10.00', delta: 0 }]
    }, {
      sku: 'A1-CL-6101', model: 'A1-CL-6101', name: 'Monthly disposable, 6 lenses', cat: 'contacts',
      brand: 'A1 Vision', pack: 'Per box · MOQ 5', unit: 'box', moq: 5,
      price: 58000, retail: 89900, mrp: 125000, gst: 12, hsn: '9001',
      tiers: [{ min: 20, price: 52000 }, { min: 60, price: 46000 }],
      photo: 'cl:monthly', stock: 210, attrs: { type: 'Monthly' }, rating: 4.6, reviews: 240,
      blurb: 'Silicone hydrogel monthly, 8.6 base curve, 14.2 diameter. −0.50 to −10.00 in 0.25 steps from stock. Six lenses per box — half a year for both eyes.',
      variants: [{ id: 'lo', label: '−0.50 to −6.00', delta: 0 }, { id: 'hi', label: '−6.50 to −10.00', delta: 0 }]
    }, {
      sku: 'A1-CL-6102', model: 'A1-CL-6102', name: 'Daily disposable, 30 lenses', cat: 'contacts',
      brand: 'A1 Vision', pack: 'Per box · MOQ 5', unit: 'box', moq: 5,
      price: 89000, retail: 129900, mrp: 189000, gst: 12, hsn: '9001',
      tiers: [{ min: 20, price: 81000 }, { min: 60, price: 72000 }],
      photo: 'cl:daily', stock: 140, attrs: { type: 'Daily' }, rating: 4.7, reviews: 188,
      blurb: 'Hydrogel daily, 8.5 base curve, 14.2 diameter, thirty lenses per box. The box a first-time wearer leaves with.',
      variants: [{ id: 'lo', label: '−0.50 to −6.00', delta: 0 }, { id: 'hi', label: '−6.50 to −10.00', delta: 0 }]
    }, {
      sku: 'A1-CL-6201', model: 'A1-CL-6201', name: 'Toric monthly, 3 lenses', cat: 'contacts',
      brand: 'A1 Vision', pack: 'Per box · MOQ 3', unit: 'box', moq: 3,
      price: 96000, retail: 149900, mrp: 210000, gst: 12, hsn: '9001',
      tiers: [{ min: 12, price: 88000 }, { min: 36, price: 79000 }],
      photo: 'cl:toric', stock: 48, attrs: { type: 'Toric' }, rating: 4.5, reviews: 36,
      blurb: 'Silicone hydrogel toric for astigmatism, cylinder −0.75 to −2.25, axis 10° to 180° in 10° steps. Three per box; we take the axis from your prescription.',
      variants: [{ id: 'std', label: 'Cylinder & axis from prescription', delta: 0 }]
    },

    /* ── Ophthalmic lenses — trade only, per pair ───────────────────────── */
    {
      sku: 'A1-LN-5101', model: 'A1-LN-5101', name: 'Single vision stock, hard coat', cat: 'lenses',
      brand: 'Stock lens', pack: 'Per pair · MOQ 10', unit: 'pair', moq: 10,
      price: 18000, retail: 65000, mrp: 65000, gst: 12, hsn: '9001',
      tiers: [{ min: 50, price: 15500 }, { min: 200, price: 12500 }],
      photo: 'lens:sv', stock: 2400, attrs: { type: 'Single vision' },
      blurb: 'Uncut 65 mm stock lens, hard-coated, sphere −6.00 to +4.00 and cylinder to −2.00 from stock. Same-day dispatch on stock powers.',
      variants: [
        { id: '156', label: 'Index 1.56', delta: 0 },
        { id: '160', label: 'Index 1.60', delta: 14000 },
        { id: '167', label: 'Index 1.67', delta: 38000 }
      ]
    }, {
      sku: 'A1-LN-5102', model: 'A1-LN-5102', name: 'Single vision, blue-cut', cat: 'lenses',
      brand: 'Stock lens', pack: 'Per pair · MOQ 10', unit: 'pair', moq: 10,
      price: 34000, retail: 120000, mrp: 120000, gst: 12, hsn: '9001',
      tiers: [{ min: 50, price: 30000 }, { min: 200, price: 26000 }],
      photo: 'lens:blue', stock: 1600, attrs: { type: 'Single vision' },
      blurb: 'Blue-light filtering substrate rather than a coating, so the tint does not wear off. Anti-reflective, hydrophobic top coat. The lens most counters now sell by default.',
      variants: [
        { id: '156', label: 'Index 1.56', delta: 0 },
        { id: '160', label: 'Index 1.60', delta: 16000 },
        { id: '167', label: 'Index 1.67', delta: 42000 }
      ]
    }, {
      sku: 'A1-LN-5201', model: 'A1-LN-5201', name: 'Progressive, freeform Rx', cat: 'lenses',
      brand: 'Rx lab', pack: 'Per pair · made to order', unit: 'pair', moq: 1, rx: true,
      price: 240000, retail: 650000, mrp: 650000, gst: 12, hsn: '9001',
      tiers: [{ min: 10, price: 215000 }, { min: 30, price: 195000 }],
      photo: 'lens:prog', stock: 999, attrs: { type: 'Progressive' },
      blurb: 'Digitally surfaced freeform progressive, 14 mm corridor as standard, 11 mm on request. Prescription and fitting data go in per line at checkout. 3–4 working days from the lab.',
      variants: [
        { id: '156', label: 'Index 1.56', delta: 0 },
        { id: '160', label: 'Index 1.60', delta: 45000 },
        { id: '167', label: 'Index 1.67', delta: 98000 }
      ]
    }, {
      sku: 'A1-LN-5301', model: 'A1-LN-5301', name: 'Photochromic SV', cat: 'lenses',
      brand: 'Stock lens', pack: 'Per pair · MOQ 5', unit: 'pair', moq: 5,
      price: 78000, retail: 220000, mrp: 220000, gst: 12, hsn: '9001',
      tiers: [{ min: 25, price: 70000 }, { min: 100, price: 62000 }],
      photo: 'lens:photo', stock: 480, attrs: { type: 'Photochromic' },
      blurb: 'Photochromic on a 1.56 base, hard-coated, clear indoors to full tint in under a minute in Chandigarh sun.',
      variants: [{ id: 'grey', label: 'Grey', delta: 0 }, { id: 'brown', label: 'Brown', delta: 0 }]
    },

    /* ── Instruments — trade only ───────────────────────────────────────── */
    {
      sku: 'A1-IN-7101', model: 'A1-IN-7101', name: 'Lensmeter, manual, LED', cat: 'instruments',
      brand: 'Instruments', pack: 'Per unit · 12-month warranty', unit: 'unit', moq: 1,
      price: 2450000, retail: 3200000, mrp: 3200000, gst: 12, hsn: '9018',
      tiers: [{ min: 3, price: 2250000 }],
      photo: 'inst:lensmeter', stock: 4, attrs: { type: 'Lensmeter' },
      blurb: 'Internal-reading lensmeter, ±25 D, prism to 5 Δ, LED illumination. Installed and calibrated on delivery within the Tricity; couriered elsewhere with a video walkthrough.',
      variants: [{ id: 'std', label: 'Standard, with dust cover', delta: 0 }]
    }, {
      sku: 'A1-IN-7102', model: 'A1-IN-7102', name: 'Keratometer, two-position', cat: 'instruments',
      brand: 'Instruments', pack: 'Per unit · 12-month warranty', unit: 'unit', moq: 1,
      price: 5800000, retail: 7400000, mrp: 7400000, gst: 12, hsn: '9018',
      tiers: [],
      photo: 'inst:keratometer', stock: 2, attrs: { type: 'Keratometer' },
      blurb: 'Bausch and Lomb type, 36–52 D range, chin rest and head band. Demonstration on site before you sign for it.',
      variants: [{ id: 'std', label: 'Standard', delta: 0 }]
    }, {
      sku: 'A1-IN-7103', model: 'A1-IN-7103', name: 'Slit lamp, 3-step magnification', cat: 'instruments',
      brand: 'Instruments', pack: 'Per unit · 12-month warranty', unit: 'unit', moq: 1,
      price: 14500000, retail: 18500000, mrp: 18500000, gst: 12, hsn: '9018',
      tiers: [],
      photo: 'inst:slitlamp', stock: 2, attrs: { type: 'Slit lamp' },
      blurb: 'Tower illumination, 10×, 16× and 25× magnification, LED. Table, chin rest and dust cover included. Engineer installation in the Tricity.',
      variants: [{ id: 'std', label: 'Instrument only', delta: 0 }, { id: 'table', label: 'With motorised table', delta: 2800000 }]
    }, {
      sku: 'A1-IN-7104', model: 'A1-IN-7104', name: 'Trial lens set, 232 pieces', cat: 'instruments',
      brand: 'Instruments', pack: 'Per set', unit: 'set', moq: 1,
      price: 1850000, retail: 2600000, mrp: 2600000, gst: 12, hsn: '9018',
      tiers: [{ min: 3, price: 1700000 }],
      photo: 'inst:trialset', stock: 5, attrs: { type: 'Trial set' },
      blurb: 'Metal-rim trial set, 232 lenses in a wooden case, ±20.00 sphere and −6.00 cylinder, with prisms and accessories. Trial frame sold separately.',
      variants: [{ id: 'std', label: 'Set only', delta: 0 }, { id: 'frame', label: 'With adjustable trial frame', delta: 320000 }]
    },

    /* ── Accessories — the bag upsell ───────────────────────────────────── */
    {
      sku: 'A1-AC-8101', model: 'A1-AC-8101', name: 'Cleaning kit', cat: 'accessories',
      brand: 'A1 Studio', pack: 'Per kit · MOQ 12', unit: 'kit', moq: 12,
      price: 12000, retail: 19900, mrp: 24900, gst: 18, hsn: '3402',
      tiers: [{ min: 48, price: 10000 }],
      photo: 'acc:kit', stock: 300, attrs: { type: 'Care' }, rating: 4.5, reviews: 412,
      blurb: 'Spray, microfibre cloth and a screwdriver for the hinge screws. Safe on every coating we sell.',
      variants: [{ id: 'std', label: 'Standard', delta: 0 }]
    }, {
      sku: 'A1-AC-8102', model: 'A1-AC-8102', name: 'Hard case', cat: 'accessories',
      brand: 'A1 Studio', pack: 'Per piece · MOQ 12', unit: 'pc', moq: 12,
      price: 9000, retail: 14900, mrp: 19900, gst: 18, hsn: '4202',
      tiers: [{ min: 48, price: 7500 }],
      photo: 'acc:case', stock: 220, attrs: { type: 'Care' }, rating: 4.3, reviews: 130,
      blurb: 'Clamshell hard case, felt-lined, fits everything on the site up to the 58 aviators.',
      variants: [{ id: 'std', label: 'Standard', delta: 0 }]
    }]
  );

  /* Categories. `lens` says whether a lens package is fitted:
       true       — frames: the included package is inside the price
       'optional' — sunglasses: plain lenses are in the price, power is extra
       false      — nothing to fit (contacts, readers, accessories)
     `trade` marks what only opticians buy. `nav` puts it in the main menu. */
  var CATEGORIES = [
    { id: 'all',         label: 'Everything',        photo: 'frame:rectangle:acetate:tortoise' },
    { id: 'frames',      label: 'Eyeglasses',        nav: true, lens: true,       photo: 'frame:rectangle:acetate:tortoise', short: 'Eyeglasses' },
    { id: 'sun',         label: 'Sunglasses',        nav: true, lens: 'optional', photo: 'sun:wayfarer:acetate:black:grey',   short: 'Sunglasses' },
    { id: 'contacts',    label: 'Contact lenses',    nav: true, lens: false,      photo: 'cl:monthly',                       short: 'Contacts', rx: true },
    { id: 'readers',     label: 'Reading glasses',   nav: true, lens: false,      photo: 'frame:rectangle:tr90:tortoise',    short: 'Readers' },
    { id: 'kids',        label: 'Kids',              nav: true, lens: true,       photo: 'frame:round:tr90:blue',            short: 'Kids' },
    { id: 'lenses',      label: 'Ophthalmic lenses', trade: true, lens: false,    photo: 'lens:blue' },
    { id: 'instruments', label: 'Instruments',       trade: true, lens: false,    photo: 'inst:slitlamp' },
    { id: 'accessories', label: 'Accessories',       lens: false, hidden: true,   photo: 'acc:kit' }
  ];

  /* Shapes, for the "shop by shape" tiles and the filter. */
  var SHAPES_LIST = [
    { id: 'Rectangle', photo: 'frame:rectangle:acetate:black' },
    { id: 'Round',     photo: 'frame:round:metal:gold' },
    { id: 'Square',    photo: 'frame:square:acetate:tortoise' },
    { id: 'Wayfarer',  photo: 'frame:wayfarer:acetate:black' },
    { id: 'Aviator',   photo: 'frame:aviator:metal:silver' },
    { id: 'Cat-eye',   photo: 'frame:cateye:metal:rosegold' },
    { id: 'Browline',  photo: 'frame:browline:metal:gold:navy' },
    { id: 'Rimless',   photo: 'frame:square:rimless:silver' }
  ];

  /* ── Product renders ───────────────────────────────────────────────────────
     A `photo` key such as "frame:round:acetate:tortoise" becomes an SVG. All
     renders share one studio: a white ground, a soft contact shadow and a
     consistent object size, so a grid of tiles reads as one catalogue. */

  var COLOURS = {
    tortoise: null, // pattern, see defs
    black:    '#1C1B1A',
    crystal:  'rgba(215,222,230,.55)',
    smoke:    'rgba(140,146,150,.55)',
    clear:    'rgba(182,186,188,.45)',
    navy:     '#1F2E4A',
    slate:    '#3E5468',
    grey:     '#8E9295',
    red:      '#A8503F',
    green:    '#2E5B3E',
    brown:    '#7A5A44',
    blue:     '#2F6FB5',
    pink:     '#D98BA6',
    gold:     'url(#m-gold)',
    silver:   'url(#m-silver)',
    gunmetal: 'url(#m-gun)',
    rosegold: 'url(#m-rose)'
  };

  /* Lens outlines, drawn for one eye with the temple side at +x. The other
     eye is the same path mirrored, which is also how a frame is made. */
  var SHAPES = {
    round:     'M -66 0 A 66 66 0 1 0 66 0 A 66 66 0 1 0 -66 0 Z',
    oval:      'M -74 0 A 74 52 0 1 0 74 0 A 74 52 0 1 0 -74 0 Z',
    square:    'M -60 -50 H 62 Q 80 -50 80 -32 V 34 Q 80 50 62 50 H -60 Q -78 50 -78 34 V -32 Q -78 -50 -60 -50 Z',
    rectangle: 'M -66 -42 H 70 Q 84 -42 84 -28 V 30 Q 84 44 70 44 H -66 Q -82 44 -82 30 V -28 Q -82 -42 -66 -42 Z',
    wayfarer:  'M -76 -52 L 82 -46 Q 92 -45 90 -34 L 76 40 Q 72 52 58 52 L -52 52 Q -68 52 -72 40 L -84 -40 Q -86 -52 -76 -52 Z',
    aviator:   'M -70 -42 Q -36 -64 22 -60 Q 86 -56 88 -18 Q 90 30 60 56 Q 28 74 -10 62 Q -60 48 -74 0 Q -78 -26 -70 -42 Z',
    cateye:    'M -74 -30 Q -70 -50 -40 -48 L 58 -40 Q 92 -62 97 -50 Q 99 -42 84 -18 L 74 30 Q 70 50 50 52 L -45 52 Q -72 52 -76 30 Z',
    browline:  'M -64 -44 H 66 Q 80 -44 80 -30 V 34 Q 80 50 64 50 H -60 Q -78 50 -78 34 V -30 Q -78 -44 -64 -44 Z'
  };

  var DEFS =
    '<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#F2F4F3"/></linearGradient>' +
    '<radialGradient id="shadow" cx=".5" cy=".5" r=".5">' +
      '<stop offset="0" stop-color="#14181A" stop-opacity=".14"/><stop offset="1" stop-color="#14181A" stop-opacity="0"/></radialGradient>' +
    '<linearGradient id="m-gold" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#E8C878"/><stop offset=".5" stop-color="#C79A3E"/><stop offset="1" stop-color="#9A6F22"/></linearGradient>' +
    '<linearGradient id="m-silver" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#F2F4F6"/><stop offset=".5" stop-color="#BFC6CD"/><stop offset="1" stop-color="#8A929B"/></linearGradient>' +
    '<linearGradient id="m-gun" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#7C838B"/><stop offset=".5" stop-color="#4A5058"/><stop offset="1" stop-color="#25292E"/></linearGradient>' +
    '<linearGradient id="m-rose" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#F0C9B4"/><stop offset=".5" stop-color="#D2957A"/><stop offset="1" stop-color="#A9694F"/></linearGradient>' +
    '<pattern id="tort" patternUnits="userSpaceOnUse" width="46" height="46">' +
      '<rect width="46" height="46" fill="#B8712C"/>' +
      '<ellipse cx="10" cy="12" rx="11" ry="8" fill="#3A1E0D" opacity=".85" transform="rotate(-20 10 12)"/>' +
      '<ellipse cx="34" cy="30" rx="12" ry="7" fill="#3A1E0D" opacity=".8" transform="rotate(25 34 30)"/>' +
      '<ellipse cx="30" cy="6" rx="6" ry="4" fill="#5A2E12" opacity=".7"/>' +
      '<ellipse cx="8" cy="38" rx="7" ry="5" fill="#5A2E12" opacity=".75" transform="rotate(15 8 38)"/></pattern>' +
    '<linearGradient id="l-clear" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#FFFFFF" stop-opacity=".70"/><stop offset="1" stop-color="#C8D6E2" stop-opacity=".45"/></linearGradient>' +
    '<linearGradient id="l-green" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#2E4A3A"/><stop offset="1" stop-color="#6E8A78"/></linearGradient>' +
    '<linearGradient id="l-grey" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#26282B"/><stop offset="1" stop-color="#5E6369"/></linearGradient>' +
    '<linearGradient id="l-brown" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#4A2E1A"/><stop offset="1" stop-color="#B98F6E"/></linearGradient>' +
    '<linearGradient id="sheen" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#FFFFFF" stop-opacity=".55"/><stop offset=".5" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>' +
    '<radialGradient id="blank" cx=".38" cy=".32" r=".75">' +
      '<stop offset="0" stop-color="#FFFFFF" stop-opacity=".95"/><stop offset=".55" stop-color="#DCE6EE" stop-opacity=".8"/><stop offset="1" stop-color="#9FB2C2" stop-opacity=".9"/></radialGradient>' +
    '<radialGradient id="blank-blue" cx=".38" cy=".32" r=".75">' +
      '<stop offset="0" stop-color="#FFFFFF" stop-opacity=".95"/><stop offset=".55" stop-color="#D6DEF5" stop-opacity=".85"/><stop offset="1" stop-color="#6F7FD4" stop-opacity=".9"/></radialGradient>' +
    '<linearGradient id="blank-photo" x1="0" y1="0" x2="1" y2="0">' +
      '<stop offset="0" stop-color="#F3F6F8"/><stop offset=".5" stop-color="#C9D0D6"/><stop offset="1" stop-color="#4A4F55"/></linearGradient>' +
    '<linearGradient id="steel" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#F4F5F6"/><stop offset="1" stop-color="#C5CAD0"/></linearGradient>' +
    '<linearGradient id="dark" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#3B3F45"/><stop offset="1" stop-color="#1E2124"/></linearGradient>';

  function studio(inner) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 450">' +
      '<defs>' + DEFS + '</defs>' +
      '<rect width="600" height="450" fill="url(#bg)"/>' +
      '<ellipse cx="300" cy="332" rx="230" ry="34" fill="url(#shadow)"/>' +
      inner + '</svg>';
  }

  function frameSvg(k) {
    // frame:<shape>:<material>:<colour>  |  sun:<shape>:<material>:<colour>:<tint>
    var sun = k[0] === 'sun';
    var shape = k[1], material = k[2], colour = k[3], tint = k[4];
    var d = SHAPES[shape] || SHAPES.square;
    var rim = material === 'acetate' ? 13 : material === 'tr90' ? 9 : material === 'metal' ? 4.5 : 0;
    var stroke = colour === 'tortoise' ? 'url(#tort)' : (COLOURS[colour] || '#222');
    var lensFill = sun ? 'url(#l-' + (tint || 'grey') + ')' : 'url(#l-clear)';
    var lensOp = sun ? '.92' : '1';

    function eye(mirror) {
      var t = mirror ? 'translate(203 218) scale(-1 1)' : 'translate(397 218)';
      var edge = rim ? '' : '<path d="' + d + '" fill="none" stroke="rgba(60,70,80,.55)" stroke-width="1.6"/>';
      return '<g transform="' + t + '">' +
        '<path d="' + d + '" fill="' + lensFill + '" opacity="' + lensOp + '"/>' +
        '<clipPath id="c' + (mirror ? 'l' : 'r') + '"><path d="' + d + '"/></clipPath>' +
        '<g clip-path="url(#c' + (mirror ? 'l' : 'r') + ')">' +
          '<path d="M -120 -80 L 40 -80 L -40 90 L -140 90 Z" fill="url(#sheen)"/>' +
        '</g>' +
        edge +
        (rim ? '<path d="' + d + '" fill="none" stroke="' + stroke + '" stroke-width="' + rim + '" stroke-linejoin="round"/>' : '') +
        // end-piece and temple stub
        (rim
          ? '<path d="M 78 -30 L 112 -38" stroke="' + stroke + '" stroke-width="' + (rim * 0.9) + '" stroke-linecap="round"/>'
          : '<path d="M 76 -28 L 110 -36" stroke="' + (COLOURS[colour] || 'url(#m-silver)') + '" stroke-width="3.5" stroke-linecap="round"/>' +
            '<circle cx="76" cy="-28" r="3" fill="' + (COLOURS[colour] || '#8A929B') + '"/><circle cx="-76" cy="-4" r="3" fill="' + (COLOURS[colour] || '#8A929B') + '"/>') +
      '</g>';
    }

    var bridge;
    if (material === 'acetate' || material === 'tr90') {
      bridge = '<path d="M 280 190 Q 300 170 320 190" fill="none" stroke="' + stroke + '" stroke-width="' + (rim * 0.9) + '" stroke-linecap="round"/>';
    } else {
      bridge = '<path d="M 282 192 Q 300 176 318 192" fill="none" stroke="' + (rim ? stroke : (COLOURS[colour] || 'url(#m-silver)')) + '" stroke-width="4" stroke-linecap="round"/>' +
        (sun && shape === 'aviator' ? '<path d="M 268 176 Q 300 152 332 176" fill="none" stroke="' + stroke + '" stroke-width="4" stroke-linecap="round"/>' : '') +
        // nose pads
        '<ellipse cx="288" cy="232" rx="5" ry="9" fill="rgba(255,255,255,.7)" stroke="#B9C0C7" stroke-width="1.2" transform="rotate(18 288 232)"/>' +
        '<ellipse cx="312" cy="232" rx="5" ry="9" fill="rgba(255,255,255,.7)" stroke="#B9C0C7" stroke-width="1.2" transform="rotate(-18 312 232)"/>';
    }

    var brow = '';
    if (shape === 'browline') {
      var browCol = tint === 'tortoise' ? 'url(#tort)' : (COLOURS[tint] || COLOURS[colour] || '#222');
      brow = '<path d="M 124 170 Q 203 150 280 170" fill="none" stroke="' + browCol + '" stroke-width="18" stroke-linecap="round"/>' +
             '<path d="M 320 170 Q 397 150 476 170" fill="none" stroke="' + browCol + '" stroke-width="18" stroke-linecap="round"/>' +
             '<path d="M 280 172 Q 300 158 320 172" fill="none" stroke="' + browCol + '" stroke-width="14" stroke-linecap="round"/>';
    }

    return studio(eye(true) + eye(false) + bridge + brow);
  }

  function lensSvg(k) {
    var kind = k[1];
    var fill = kind === 'blue' ? 'url(#blank-blue)' : kind === 'photo' ? 'url(#blank-photo)' : 'url(#blank)';
    var marks = '';
    if (kind === 'prog') {
      marks =
        '<circle cx="300" cy="205" r="6" fill="none" stroke="#4A5560" stroke-width="1.5"/>' +
        '<path d="M 300 195 V 215 M 290 205 H 310" stroke="#4A5560" stroke-width="1.5"/>' +
        '<path d="M 300 214 Q 302 250 306 282" fill="none" stroke="#4A5560" stroke-width="1.2" stroke-dasharray="3 4"/>' +
        '<circle cx="306" cy="284" r="14" fill="none" stroke="#4A5560" stroke-width="1.2" stroke-dasharray="3 4"/>' +
        '<circle cx="222" cy="210" r="3" fill="#4A5560"/><circle cx="378" cy="210" r="3" fill="#4A5560"/>';
    }
    return studio(
      '<circle cx="300" cy="222" r="122" fill="' + fill + '" stroke="rgba(90,110,130,.55)" stroke-width="3"/>' +
      '<circle cx="300" cy="222" r="112" fill="none" stroke="rgba(255,255,255,.75)" stroke-width="1.2"/>' +
      '<circle cx="300" cy="222" r="96" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="1"/>' +
      '<path d="M 200 140 Q 260 100 340 118" fill="none" stroke="#FFFFFF" stroke-opacity=".85" stroke-width="10" stroke-linecap="round"/>' +
      marks
    );
  }

  function contactSvg(k) {
    var kind = k[1];
    var band = kind === 'daily' ? '#2E7D5B' : kind === 'toric' ? '#6C4AA6' : '#0E7C74';
    var n = kind === 'daily' ? '30' : kind === 'toric' || kind === 'monthly3' ? '3' : '6';
    return studio(
      '<g transform="translate(300 232)">' +
        '<rect x="-140" y="-88" width="280" height="176" rx="16" fill="#FFFFFF" stroke="rgba(20,24,26,.14)" stroke-width="1.5"/>' +
        '<rect x="-140" y="-88" width="280" height="46" rx="16" fill="' + band + '"/>' +
        '<rect x="-140" y="-60" width="280" height="18" fill="' + band + '"/>' +
        '<ellipse cx="-58" cy="26" rx="52" ry="30" fill="none" stroke="' + band + '" stroke-opacity=".35" stroke-width="2"/>' +
        '<path d="M -110 26 Q -58 -20 -6 26" fill="rgba(220,235,250,.75)" stroke="' + band + '" stroke-width="2"/>' +
        '<path d="M -96 22 Q -60 -8 -30 18" fill="none" stroke="#FFFFFF" stroke-width="4" stroke-linecap="round"/>' +
        '<text x="22" y="18" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="38" font-weight="700" fill="#14181A">' + n + '</text>' +
        '<text x="22" y="46" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="12" letter-spacing="2" fill="#6A706E">LENSES</text>' +
        '<rect x="22" y="58" width="96" height="6" rx="3" fill="rgba(20,24,26,.12)"/>' +
        '<rect x="22" y="70" width="64" height="6" rx="3" fill="rgba(20,24,26,.12)"/>' +
      '</g>'
    );
  }

  function accessorySvg(k) {
    var kind = k[1];
    if (kind === 'case') {
      return studio(
        '<g transform="translate(300 228)">' +
          '<path d="M -150 20 Q -150 -50 -80 -56 L 80 -56 Q 150 -50 150 20 L 150 40 Q 150 62 128 62 L -128 62 Q -150 62 -150 40 Z" fill="#1C1B1A"/>' +
          '<path d="M -150 20 Q -150 -50 -80 -56 L 80 -56 Q 150 -50 150 20 Z" fill="#2B2C2E"/>' +
          '<path d="M -140 18 L 140 18" stroke="#3E4043" stroke-width="2"/>' +
          '<text x="0" y="44" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="14" font-weight="700" letter-spacing="3" fill="#8F9396">A1</text>' +
        '</g>'
      );
    }
    // cleaning kit: spray bottle, folded cloth, small screwdriver
    return studio(
      '<g transform="translate(300 232)">' +
        '<rect x="-150" y="-30" width="120" height="96" rx="6" fill="#0E7C74"/>' +
        '<rect x="-150" y="-30" width="120" height="96" rx="6" fill="url(#sheen)"/>' +
        '<path d="M -120 -30 L -120 -58 L -60 -58 L -60 -30 Z" fill="#F2F4F3"/>' +
        '<rect x="-96" y="-46" width="8" height="18" fill="#B9C0C7"/>' +
        '<rect x="-112" y="-76" width="42" height="14" rx="4" fill="#B9C0C7"/>' +
        '<rect x="-86" y="-70" width="36" height="8" rx="3" fill="#FFFFFF"/>' +
        '<rect x="-136" y="-8" width="92" height="52" rx="3" fill="#FFFFFF" opacity=".92"/>' +
        '<text x="-90" y="14" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="11" font-weight="700" letter-spacing="1" fill="#14181A">LENS SPRAY</text>' +
        '<text x="-90" y="30" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="8" fill="#6A706E">60 ml · anti-static</text>' +
        '<rect x="-10" y="-50" width="140" height="116" rx="8" fill="#1F2E4A" stroke="rgba(20,24,26,.14)" stroke-width="1.5"/>' +
        '<rect x="0" y="-40" width="120" height="96" rx="6" fill="#243B55"/>' +
        '<rect x="-30" y="-20" width="12" height="80" rx="3" fill="#B9C0C7" transform="rotate(-12 -24 20)"/>' +
        '<rect x="-30" y="52" width="12" height="20" rx="3" fill="#1C1B1A" transform="rotate(-12 -24 20)"/>' +
      '</g>'
    );
  }

  function instrumentSvg(k) {
    var kind = k[1], body = '';
    if (kind === 'lensmeter') {
      body =
        '<ellipse cx="300" cy="322" rx="92" ry="16" fill="url(#dark)"/>' +
        '<rect x="284" y="200" width="32" height="124" rx="6" fill="url(#steel)" stroke="#9AA1A8" stroke-width="1.5"/>' +
        '<g transform="rotate(-22 300 190)">' +
          '<rect x="200" y="164" width="230" height="52" rx="22" fill="url(#steel)" stroke="#9AA1A8" stroke-width="1.5"/>' +
          '<rect x="176" y="176" width="40" height="28" rx="8" fill="url(#dark)"/>' +
          '<circle cx="318" cy="190" r="22" fill="#FFFFFF" stroke="#9AA1A8" stroke-width="1.5"/>' +
          '<circle cx="318" cy="190" r="14" fill="none" stroke="#0E7C74" stroke-width="1.2"/>' +
        '</g>' +
        '<circle cx="360" cy="252" r="22" fill="url(#dark)"/><circle cx="360" cy="252" r="9" fill="#5B6169"/>';
    } else if (kind === 'keratometer') {
      body =
        '<ellipse cx="300" cy="322" rx="120" ry="16" fill="url(#dark)"/>' +
        '<rect x="288" y="210" width="24" height="112" rx="5" fill="url(#steel)" stroke="#9AA1A8" stroke-width="1.5"/>' +
        '<rect x="214" y="168" width="200" height="60" rx="18" fill="url(#steel)" stroke="#9AA1A8" stroke-width="1.5"/>' +
        '<circle cx="410" cy="198" r="26" fill="url(#dark)"/><circle cx="410" cy="198" r="12" fill="#FFFFFF" opacity=".85"/>' +
        '<rect x="196" y="184" width="26" height="28" rx="6" fill="url(#dark)"/>' +
        '<rect x="452" y="150" width="8" height="172" rx="3" fill="url(#steel)" stroke="#9AA1A8"/>' +
        '<rect x="480" y="150" width="8" height="172" rx="3" fill="url(#steel)" stroke="#9AA1A8"/>' +
        '<rect x="444" y="146" width="52" height="8" rx="3" fill="url(#dark)"/>' +
        '<rect x="444" y="250" width="52" height="8" rx="3" fill="url(#dark)"/>';
    } else if (kind === 'slitlamp') {
      body =
        '<rect x="150" y="318" width="300" height="12" rx="4" fill="url(#dark)"/>' +
        '<rect x="200" y="306" width="200" height="14" rx="4" fill="url(#steel)" stroke="#9AA1A8"/>' +
        '<rect x="292" y="130" width="16" height="180" rx="4" fill="url(#steel)" stroke="#9AA1A8" stroke-width="1.5"/>' +
        '<rect x="232" y="176" width="134" height="40" rx="12" fill="url(#steel)" stroke="#9AA1A8" stroke-width="1.5"/>' +
        '<circle cx="238" cy="196" r="14" fill="url(#dark)"/><circle cx="238" cy="196" r="6" fill="#FFFFFF" opacity=".8"/>' +
        '<g transform="rotate(28 300 300)"><rect x="286" y="200" width="28" height="108" rx="8" fill="url(#dark)"/>' +
          '<rect x="278" y="126" width="44" height="82" rx="10" fill="url(#steel)" stroke="#9AA1A8" stroke-width="1.5"/></g>' +
        '<rect x="404" y="134" width="8" height="176" rx="3" fill="url(#steel)" stroke="#9AA1A8"/>' +
        '<rect x="436" y="134" width="8" height="176" rx="3" fill="url(#steel)" stroke="#9AA1A8"/>' +
        '<rect x="398" y="128" width="52" height="8" rx="3" fill="url(#dark)"/>' +
        '<rect x="398" y="236" width="52" height="8" rx="3" fill="url(#dark)"/>';
    } else { // trialset
      var cells = '';
      for (var r = 0; r < 4; r++) for (var c = 0; c < 8; c++) {
        var x = 152 + c * 37, y = 152 + r * 42;
        cells += '<circle cx="' + x + '" cy="' + y + '" r="13" fill="url(#blank)" stroke="' + (c % 2 ? '#B8471C' : '#14181A') + '" stroke-width="3"/>';
      }
      body =
        '<rect x="118" y="120" width="364" height="200" rx="14" fill="#4A3324" stroke="#2C1D14" stroke-width="2"/>' +
        '<rect x="128" y="130" width="344" height="180" rx="10" fill="#2E2A26"/>' +
        cells +
        '<rect x="118" y="112" width="364" height="14" rx="6" fill="#5A4030"/>';
    }
    return studio(body);
  }

  var CACHE = {};
  function render(key) {
    if (CACHE[key]) return CACHE[key];
    var k = key.split(':');
    var svg = k[0] === 'lens' ? lensSvg(k)
            : k[0] === 'cl'   ? contactSvg(k)
            : k[0] === 'inst' ? instrumentSvg(k)
            : k[0] === 'acc'  ? accessorySvg(k)
            : frameSvg(k);
    CACHE[key] = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    return CACHE[key];
  }

  /* A photo that is already a URL — uploaded from the admin page, or a real
     photograph — is returned untouched; a render key is rendered. */
  function img(photo) {
    if (!photo) return render('frame:square:acetate:crystal');
    if (/^(data:|https?:|\.{0,2}\/)/.test(photo)) return photo;
    return render(photo);
  }

  /* Every image of a product: uploaded photos first, then the render. The
     product page shows these as the gallery. */
  function photos(p) {
    var list = [];
    if (p.photos && p.photos.length) p.photos.forEach(function (u) { if (u) list.push(u); });
    if (!list.length) list.push(p.photo);
    return list;
  }

  function bySku(sku) {
    for (var i = 0; i < PRODUCTS.length; i++) if (PRODUCTS[i].sku === sku) return PRODUCTS[i];
    return null;
  }
  function category(id) {
    for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].id === id) return CATEGORIES[i];
    return null;
  }

  /* Every colourway of the same model, in catalogue order. */
  function siblings(p) {
    return PRODUCTS.filter(function (o) { return o.model === p.model; });
  }

  /* One representative per model — the catalogue grid shows models, not
     every colourway. `prefer` picks which colourway fronts the tile. */
  function models(list, prefer) {
    var seen = {}, out = [];
    (list || PRODUCTS).forEach(function (p) {
      if (seen[p.model]) return;
      seen[p.model] = true;
      out.push(prefer ? (prefer(siblings(p)) || p) : p);
    });
    return out;
  }

  /* Distinct values of an attribute across a list, for building filters. */
  function facet(list, key) {
    var seen = {}, out = [];
    list.forEach(function (p) {
      var v = key === 'brand' ? p.brand : key === 'colour' ? (p.colour && p.colour.id) : key === 'width' ? widthBand(p) : (p.attrs || {})[key];
      if (!v || seen[v]) return;
      seen[v] = true; out.push(v);
    });
    return out;
  }

  /* ── Sizes ─────────────────────────────────────────────────────────────
     A variant label is stored the way it is stamped inside the temple arm,
     "51 □ 19 – 142": lens width, bridge, temple length in millimetres. The
     stamped □ looks like a missing glyph on screen, so anything shown to a
     customer goes through sizeLabel(), which renders "51 · 19 · 142". */
  function dims(variant) {
    var m = variant && /(\d{2})\s*□\s*(\d{2})\s*[–-]\s*(\d{3})/.exec(variant.label);
    return m ? { lens: +m[1], bridge: +m[2], temple: +m[3] } : null;
  }
  function sizeLabel(p, variantId) {
    var v = variantId ? variant(p, variantId) : p.variants[0];
    var d = dims(v);
    return d ? d.lens + ' · ' + d.bridge + ' · ' + d.temple : '';
  }
  /* Overall frame width, estimated from the stamped numbers: two lenses, the
     bridge and about 14 mm of end-pieces. Good to a few millimetres, which is
     all a narrow / medium / wide filter needs. */
  function frameWidth(p) {
    var d = dims(p.variants[0]);
    return d ? d.lens * 2 + d.bridge + 14 : null;
  }
  function widthBand(p) {
    var w = frameWidth(p);
    if (w == null) return null;
    return w < 130 ? 'Narrow' : w < 140 ? 'Medium' : 'Wide';
  }
  var WIDTHS = [
    { id: 'Narrow', label: 'Narrow · under 130mm' },
    { id: 'Medium', label: 'Medium · 130–139mm' },
    { id: 'Wide',   label: 'Wide · 140mm+' }
  ];

  function variant(p, id) {
    for (var i = 0; i < p.variants.length; i++) if (p.variants[i].id === id) return p.variants[i];
    return p.variants[0];
  }

  /* Trade price for a quantity: the base price stepped down by whichever
     tier the quantity reaches. Tiers are sorted ascending in the data. */
  function unitFor(product, qty) {
    var price = product.price, t = product.tiers || [];
    for (var i = 0; i < t.length; i++) if (qty >= t[i].min) price = t[i].price;
    return price;
  }

  /* Trade price for a specific variant at a quantity, in paise. */
  function priceOf(product, variantId, qty) {
    var v = variant(product, variantId);
    return unitFor(product, qty || 1) + (v ? v.delta : 0);
  }

  /* Retail price of the frame alone, before any lens. Rows that never got a
     retail price (older imports) fall back to the MRP, never to the trade
     price — a trade price on a consumer page would be a leak. */
  function retailOf(product, variantId) {
    var v = variant(product, variantId);
    var base = typeof product.retail === 'number' ? product.retail : product.mrp;
    return base + (v ? v.delta : 0);
  }

  /* ── Owner edits ──────────────────────────────────────────────────────────
     The admin page edits prices, stock, photos and copy, and adds products.
     On the live build those are rows in Supabase; in the preview they are two
     maps in localStorage applied on top of the static catalogue, so every
     page sees the change immediately. */
  var OVR_KEY = 'a1opticals_overrides_v1';
  var NEW_KEY = 'a1opticals_products_v1';
  var EDITABLE = ['price', 'retail', 'mrp', 'stock', 'photo', 'photos', 'name', 'blurb', 'isNew', 'weight', 'style'];

  function readJson(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || 'null') || fallback; } catch (e) { return fallback; }
  }
  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }

  function overrides() { return readJson(OVR_KEY, {}); }
  function applyOverrides() {
    var m = overrides();
    PRODUCTS.forEach(function (p) {
      var o = m[p.sku];
      if (!o) return;
      EDITABLE.forEach(function (k) { if (o[k] !== undefined) p[k] = o[k]; });
    });
  }
  function setOverride(sku, patch) {
    var m = overrides();
    m[sku] = m[sku] || {};
    EDITABLE.forEach(function (k) { if (patch[k] !== undefined) m[sku][k] = patch[k]; });
    var ok = writeJson(OVR_KEY, m);
    applyOverrides();
    changed('overrides', m);
    return ok;
  }
  /* Mirror an edit to the API when one is configured (store.js listens).
     The server prices every order itself, so it has to hear about a price
     or stock change the moment the admin saves it. */
  function changed(key, value) {
    try { window.dispatchEvent(new CustomEvent('a1:settings', { detail: { store: 'catalog', key: key, value: value } })); } catch (e) {}
  }

  /* Products added from the admin page. Stored whole; they look exactly like
     the static rows above once loaded. */
  function customProducts() { return readJson(NEW_KEY, []); }
  function upsertCustom(p) {
    var list = customProducts().filter(function (o) { return o.sku !== p.sku; });
    p.custom = true;
    list.push(p);
    var ok = writeJson(NEW_KEY, list);
    if (!ok) return false;
    for (var i = PRODUCTS.length - 1; i >= 0; i--) if (PRODUCTS[i].sku === p.sku) PRODUCTS.splice(i, 1);
    PRODUCTS.push(p);
    changed('products', list);
    return true;
  }
  function removeCustom(sku) {
    var list = customProducts().filter(function (o) { return o.sku !== sku; });
    writeJson(NEW_KEY, list);
    for (var i = PRODUCTS.length - 1; i >= 0; i--) if (PRODUCTS[i].sku === sku && PRODUCTS[i].custom) PRODUCTS.splice(i, 1);
    changed('products', list);
  }
  function clearEdits() {
    try { localStorage.removeItem(OVR_KEY); localStorage.removeItem(NEW_KEY); } catch (e) {}
    location.reload();
  }

  customProducts().forEach(function (p) { PRODUCTS.push(p); });
  applyOverrides();

  return {
    products: PRODUCTS,
    categories: CATEGORIES,
    category: category,
    shapes: SHAPES_LIST,
    widths: WIDTHS,
    swatches: SWATCH,
    families: FAMILY,
    bySku: bySku,
    siblings: siblings,
    models: models,
    facet: facet,
    variant: variant,
    dims: dims,
    sizeLabel: sizeLabel,
    frameWidth: frameWidth,
    widthBand: widthBand,
    priceOf: priceOf,
    unitFor: unitFor,
    retailOf: retailOf,
    img: img,
    photos: photos,
    overrides: overrides,
    setOverride: setOverride,
    customProducts: customProducts,
    upsertCustom: upsertCustom,
    removeCustom: removeCustom,
    clearEdits: clearEdits
  };
})();
