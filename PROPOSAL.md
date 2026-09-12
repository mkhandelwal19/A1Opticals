# A1 Opticals — trade platform: scope, approach and quote

Prepared by Netloom · 11 September 2026 · internal working draft. Numbers are
Netloom's proposed prices for an Indian small business; confirm before they go
to the client.

Preview: `http://localhost:8080/` — run `serve.cmd` in this folder.
This folder is not in any git repository and nothing is hosted.

---

## 1. What the preview now shows (all of this is in the Launch scope)

The preview follows the "One price, lenses included" design (Direction A —
Clear: Schibsted Grotesk, ink and teal, the A1OPTICALS wordmark). One store,
two customers: the retail shopper is the default view; an optician who
registers gets the trade view, which is the earlier trade platform intact.

| Area | Retail view (default) | Trade view (opticians, after registering) |
|---|---|---|
| Home | Offer bar · hero with live colourway swatches · trust strip · shop by category with live from-prices · shop by shape · bestseller tabs · three promo panels · brands · store and map | Trade hero, counter-staples tabs, lenses and instruments in the menu |
| Catalogue | One price per tile with the included lens inside it, MRP struck through, "frame + lens" breakdown · filters for shape, frame width, brand, material, colour, offer · price slider on the all-in price · "change lens package" re-prices every tile · "Know your power?" hides frames too wide for a strong prescription · filters carried in the URL | Trade price per unit, volume tiers, MRP and margin, size select, "Add MOQ" |
| Product page | Gallery, stamped measurements, lens packages chosen inline with the total live, prescription now / photo / later, Add to bag, reserve to try in store | Tier ladder lit by quantity, MOQ, GST and HSN, Rx grid on made-to-order lenses |
| Bag | Lens package switchable per line · "prescription needed" · Buy 1 Get 1 applied automatically (cheaper pair free) · cleaning-kit upsell | GST split, ₹5,000 minimum |
| Checkout | Bag → Prescription (type it in / photo / call me, PD, lens-thickness advice) → Delivery → Payment · own van inside the PIN area, courier beyond it, collect from store · optional GST invoice · UPI, card, pay on delivery, bank transfer | Shop name and validated GSTIN · PIN gating with a hard stop outside the van area · delivery slots · PO and packer notes · UPI, card, bank transfer, credit account (locked until three paid orders) |
| After the order | Receipt or tax invoice · notifications that fire · order tracking by reference · account with orders, reorder, saved prescription, reservations and eye-test bookings | Same, with the GST invoice |
| Eye test | Free 15-minute slots bookable online, saved to the account and the dashboard | |
| Admin | Orders and status (incl. awaiting prescription) · **Products & images** — add or edit, up to five photos resized in the browser, trade and retail prices, sizes, NEW badge · **Price & stock** inline · **Import price list** with header detection, retail column, validation and diff preview · **Lenses & offers** — lens packages and prices, the included package, Buy 1 Get 1 rule, offer bar · **Site content** — hero, trust strip, promos, bestsellers, footer, contact · **Stores & delivery** — stores, charges and free thresholds, van PIN list, slots, eye-test slots · **Bookings** — eye tests and reservations · **Needs attention** | |

Products, prices, stock and every piece of storefront copy above are edited
in the admin; nothing on the storefront is hard-coded except the layout.

---

## 2. Infrastructure — three ways to run it, and which one is "doing it right"

"Set the foundation right" means, concretely: the API in a container, the
database managed with point-in-time recovery, images in object storage
behind a CDN with signed uploads, infrastructure as code, a staging
environment, CI/CD, logs, uptime checks, secrets out of the repo. All of
that is in Option 2 below. **Kubernetes adds orchestration on top of it, and
this platform does not need orchestration** — one API service, one
database, one bucket, a few hundred dealers. A cluster that nobody patches is
less secure than a managed service, and the care plan cannot fund a
Kubernetes operator. Because the API is a container from day one, moving to
GKE later is a deployment change, not a rewrite. The trigger to move: several
services, background workers with persistent connections, or sustained load
where Cloud Run costs more than a node pool would — none of which is on the
horizon.

Monthly figures below assume ₹88 per US dollar. GCP invoices Indian accounts
in INR and adds 18% GST. Region asia-south1 (Mumbai) for everything.

### Option 1 — Cloudflare + Supabase (what the earlier quote assumed)

| Item | Launch | Once busy |
|---|---|---|
| Cloudflare Pages (front end, CDN, HTTPS) | ₹0 | ₹0 |
| Cloudflare Worker (API) | ₹0 | ₹450 |
| Supabase — Postgres, auth, file storage, backups | ₹0 (free tier) | ₹2,200 (Pro) |
| Email | ₹0 | ₹500 |
| **Monthly** | **₹0–500** | **₹3,000–3,500** |

Cheapest and fastest to ship. Two vendors, neither of them GCP. Images live
in Supabase storage (100 GB on Pro, then ₹1.8/GB) behind Cloudflare's CDN.

### Option 2 — GCP-native on Cloud Run (recommended)

| Item | What it does | Launch | Once busy |
|---|---|---|---|
| Cloud Run, asia-south1 | The API in a Docker container; scales to zero, one warm instance kept so nobody waits on a cold start | ₹600 | ₹900–1,500 |
| Cloud SQL for PostgreSQL | Managed Postgres, automated backups, point-in-time recovery. `db-f1-micro` to start, `db-g1-small` once real orders flow | ₹900 | ₹2,300 (₹4,600 with high availability) |
| Cloud Storage bucket | Product images. Admin uploads straight to the bucket by signed URL; a Cloud Run job writes 400 / 900 / 1600 px WebP variants. 20,000 images ≈ 10 GB ≈ ₹20/month — storage is not where the money goes | ₹50 | ₹200 |
| Firebase Hosting | The front end on Google's CDN with HTTPS, plus a rewrite so `/img/*` is served through the same CDN from the bucket — no separate load balancer needed | ₹0 | ₹400 |
| Firebase Authentication | Dealer and owner logins: email + password, email link, phone OTP (10,000 India verifications/month free) | ₹0 | ₹0 |
| Cloud Tasks / Pub/Sub | Order emails, WhatsApp, low-stock alerts, off the request path | ₹0 | ₹0 |
| Secret Manager, Cloud Build, Artifact Registry, Cloud Logging, Error Reporting, uptime checks | Secrets, CI/CD, images, logs, alerts — all inside free tiers at this size | ₹0 | ₹0–200 |
| Email (Resend / ZeptoMail) | Transactional mail | ₹0 | ₹500 |
| **Monthly, before GST** | | **₹1,500–2,000** | **₹4,300–5,500** |

Plus WhatsApp provider (₹999–2,499) and the domain (₹1,000–1,500 a year) in
every option. GCP's $300 / 90-day trial credit covers the build period.

Everything is one Google account in A1's name, one bill, one console. It is
what a larger company would build for the same brief, sized for this one.

### Option 3 — GKE (Kubernetes) — what it costs, so the client can decide with numbers

| Item | Autopilot | Standard (2 × e2-medium) |
|---|---|---|
| Cluster management fee | ₹0 (first cluster free), ₹6,500 for a second | same |
| Compute — API × 2 replicas, 0.5 vCPU / 1 GiB each | ₹3,500 (billed per pod) | ₹4,400 (billed per node, whether used or not) |
| External HTTPS load balancer (required for ingress) | ₹1,600 | ₹1,600 |
| Cloud SQL, bucket, registry, logging | ₹1,200–2,600 | ₹1,200–2,600 |
| **Monthly, before GST** | **₹6,300–7,700** | **₹7,200–8,600** |
| Operations — upgrades, node pools, ingress, network policy, incidents | 4–8 hours a month of someone who knows Kubernetes | same |

Roughly three times Option 2 at launch, for the same traffic, and the
operations line is the real cost: it is why the care plan for a GKE build
would have to be ₹9,999 or more, and why it is not recommended today.

### What changes in the build price for Option 2

Terraform for the project, Cloud SQL with migrations, Firebase Auth wiring,
the signed-upload image pipeline with variants, Cloud Run deploys with a
staging environment, CI/CD, monitoring and alert routing: **+₹40,000** on the
Launch scope against Option 1, and the care plan moves to **₹6,999 / month**
because managed infrastructure needs eyes on it that Supabase's dashboard
does for you. The repository layout from day one:

```
a1opticals/
  apps/web/        the site (this preview, moved to a build step)
  apps/api/        Node + TypeScript API, Dockerfile, OpenAPI spec
  apps/images/     resize job
  infra/           Terraform — project, Cloud SQL, bucket, Cloud Run, IAM, secrets
  .github/         CI: test, build image, deploy to staging, promote to prod
```

## 3. Payments — UPI, cards, net banking, and the Authorize.net question

### Our integration — ₹12,000 one-time, in the Launch scope

One Indian gateway (Razorpay, Cashfree or PayU), opened in A1's name. What
the ₹12,000 covers:

| | |
|---|---|
| Onboarding | KYC in A1's name — PAN, bank account, GSTIN, the four legal pages the gateway reads before activating |
| Checkout | The gateway's hosted checkout (UPI intent, cards, net banking, wallets) opened from our checkout page; card data never touches our servers, so PCI compliance is the gateway's |
| Server side | Order created on the server with the server's price, never the browser's; payment signature verified server-side; webhooks for captured, failed and refunded, idempotent so a webhook delivered twice does not confirm twice |
| Bank transfer | Order held as "awaiting transfer", marked paid from the admin when the credit shows |
| Admin | Payment id and settlement reference on every order; refunds issued from the order screen; a reconciliation view of orders against the gateway's settlement file |
| Go-live | Test mode end to end, then the key switch; failure and retry states on the checkout page |

Add-ons if wanted: **payment links on WhatsApp** for unpaid orders and
counter sales (₹5,000) · **second gateway as fallback** (₹6,000) · **UPI
AutoPay mandates** for credit-account dealers, Phase 2 (₹15,000).

### The gateway's own fees — paid by A1 to the gateway, per transaction

Typical published rates for a standard Indian merchant account; **verify on
the pricing page at sign-up** — they change, and a distributor with ₹20,000+
average tickets should ask for a negotiated rate.

| | Setup / annual fee | Cards & net banking | UPI | Settlement | Notes |
|---|---|---|---|---|---|
| Razorpay | ₹0 / ₹0 | 2% | 2% on the standard plan; lower rates negotiated on volume | T+2, instant settlement for ~0.2% extra | Widest feature set — links, QR, subscriptions, mandates. Easiest to integrate |
| Cashfree | ₹0 / ₹0 | ~1.95% | has offered 0% UPI on some plans | T+1 | Strong on payouts and reconciliation |
| PayU | ₹0 / ₹0 | 2% | ~0.5–2% by plan | T+2 | Long-standing, good bank coverage |
| PhonePe PG | ₹0 / ₹0 | ~1.99% | 0% | T+1 | If UPI will dominate, this is the cheapest UPI |

All fees carry **18% GST** on the fee. International cards run 3% or more
everywhere. Amex and Diners about 3%.

What it means on a real order — the ₹23,710 sample order in the preview:

| Paid by | Gateway fee | GST on fee | Cost to A1 |
|---|---|---|---|
| UPI at 0% | ₹0 | ₹0 | **₹0** |
| UPI at 2% | ₹474 | ₹85 | **₹559** |
| Card / net banking at 2% | ₹474 | ₹85 | **₹559** |
| Bank transfer (NEFT / IMPS) | ₹0 | ₹0 | **₹0**, but manual confirmation |

So for a trade platform the default should be UPI and bank transfer, with
cards as a convenience — 2% on a ₹1,45,000 slit lamp is ₹3,400 of margin.
UPI itself caps a single transaction at ₹1 lakh (₹2 lakh for some
categories), so instrument orders go by net banking or transfer anyway; the
checkout already routes that. Do not surcharge UPI — the UPI rules forbid
it.

### Authorize.net — flag this with the client before quoting

Authorize.net onboards merchants with a business bank account in the US,
Canada, UK, Europe or Australia. An Indian proprietorship in Chandigarh
cannot open an Authorize.net merchant account to take rupees. It only makes
sense if A1 has or is forming an overseas entity, or wants to bill overseas
customers in USD. If that is the case: **₹20,000** to integrate (Accept.js
hosted card form, Worker-side transaction and webhook handling, refund
flow), plus Authorize.net's own fees (about $25/month + 2.9% + $0.30 per
transaction). Ask what they actually meant — nine times out of ten
"Authorize.net" is a name someone heard, and Razorpay is the answer.

---

## 4. Managing price, stock and products

Three ways, all in the admin, all in the preview:

1. **Spreadsheet import** — download the current price list, edit in Excel
   or export from Tally, paste or upload. Every row is validated (unknown
   SKU, price above MRP, negative stock refused with a reason), the diff is
   shown before it is applied, every import is kept and can be rolled back.
2. **Inline edit** — click a price or stock cell, type, save.
3. **Product editor** — add a model, its colourways and sizes, upload a
   photo from the phone (resized in the browser before it is stored).

Optional later: a Google Sheet as the master with a nightly validated sync
and a morning "what changed" email (Phase 2, ₹10,000). Not recommended: a
timer reading an Excel file off a laptop — it needs the laptop on, breaks
when the file is open in Excel, and has no review step.

---

## 5. Product images — read before promising "open source images"

The client will supply brand and model lists (Ray-Ban, Vogue, Essilor and so
on). Product photographs of branded frames are copyrighted by the brand or
its distributor; there is no legitimate "open source" library of Ray-Ban
photos, and copying them from another retailer's site is a copyright
problem in the client's name.

What works: authorised dealers get **image packs from the distributor's
dealer portal** (Luxottica, Safilo, Essilor and the Indian distributors all
provide them) — we list what A1 is licensed to use. Where no pack exists,
the line renders in the preview are free placeholders, or a product shoot
at the counter costs about ₹150–250 per SKU. Data entry of the client's
list (name, model code, colourways, sizes, prices, MOQ) is **₹40 per SKU**
with images and data supplied, minimum ₹5,000.

---

## 6. Scope

### Launch scope — what the preview shows, made real

- Supabase project, schema, row-level security, daily backups, photo storage
- Dealer **registration** with GSTIN, owner approval, **login** by email + OTP; trade prices only for approved dealers
- **Homepage, filterable catalogue, product page with colourways and sizes, cart, checkout, order confirmation** — driven by the database
- Volume price tiers, MOQ, per-product GST and HSN, ₹5,000 minimum
- **Checkout**: GSTIN capture, delivery-area PIN gating with an owner-editable PIN list, delivery slots, PO and notes
- **Payments**: UPI, cards and net banking via one Indian gateway, bank-transfer flow, server-side verification and webhooks
- **Notifications**: email and WhatsApp on order placed and dispatched; email on registration and approval; new-order alert to A1
- Dealer **order history** with reorder and printable GST invoice
- **Admin**: dealers · orders and status · product editor with image upload, colourways and sizes · inline price and stock · spreadsheet import with preview and rollback · delivery PIN list
- **Google Map** and store details; legal pages from the client's real policies
- Domain, DNS, SSL, private preview, two revision rounds, handover with everything in the client's name

### Phase 2 modules — quoted individually, after a month of real orders

| Module | One-time |
|---|---|
| Rx lens ordering — prescription per line, frame trace upload, lab status | ₹20,000 |
| Credit accounts — limits, net-30 ledger, statements, dues, payment recording | ₹25,000 |
| Dealer price groups — negotiated pricing per account | ₹12,000 |
| Reports — sales by SKU / dealer / month, low-stock alerts, reorder suggestions | ₹15,000 |
| Staff logins with roles | ₹10,000 |
| GST invoice PDF and e-invoice IRN (if turnover requires it; needs a GSP) | ₹18,000 |
| Tally export — orders as sales vouchers | ₹15,000 |
| Google Sheet nightly sync | ₹10,000 |
| Authorize.net (only if eligible — see §3) | ₹20,000 |

---

## 7. The quote

### Recurring costs that are the client's regardless of model — infra and domain

Paid by the client in their own accounts. We set them up; we never own them.

| Item | At launch | Once busy |
|---|---|---|
| Domain (.in or .com) | ₹1,000–1,500 / year | same |
| Hosting — Cloudflare Pages | ₹0 | ₹0 |
| Supabase | ₹0 (free tier) | ₹2,200 / month (Pro: daily backups, no pausing) |
| Cloudflare Worker | ₹0 | ₹450 / month |
| Transactional email | ₹0 | ₹500 / month |
| WhatsApp provider | ₹999 / month + ~₹0.15–0.80 per message | ₹1,499–2,499 / month |
| Payment gateway | 2% + GST per card / net banking transaction · UPI 0–2% by plan | same |
| Google Maps | ₹0 | ₹0 |
| **Monthly, typical** | **₹1,000–1,500** | **₹4,500–6,000** |
| **Monthly, typical — GCP-native (Option 2)** | **₹2,500–3,500** | **₹6,000–8,000** |

### Model A — buy outright

| | |
|---|---|
| Launch scope build — Option 1 (Cloudflare + Supabase) | **₹1,45,000** one-time |
| Launch scope build — **Option 2 (GCP-native, recommended)** | **₹1,85,000** one-time |
| Commerce care (recommended, optional) | **₹4,999 / month** on Option 1 · **₹6,999 / month** on Option 2 — monitoring, backups, security updates, import and gateway support, bug fixes, 4 hours of changes a month |
| 36-month total | ₹3,24,964 (Option 1) · ₹4,36,964 (Option 2) |

Milestones: 40% to start, 40% at private preview, 20% at go-live.

### Model B — platform subscription (the recommended pitch)

The build is amortised into the monthly. Client owns domain, accounts and
data from day one; the code licence transfers at the end of the term or on
paying the balance.

| | |
|---|---|
| Setup | **₹60,000** one-time (Option 1) · **₹75,000** (Option 2, GCP-native) |
| Platform fee | **₹5,999 / month** (Option 1) · **₹7,999 / month** (Option 2), 36-month term — hosting management, care, monitoring, backups, updates, 4 hours of changes |
| Add-ons, monthly | WhatsApp notifications ₹999 · card gateway ₹499 · Play Store app ₹1,499 (+₹15,000 setup) · Rx ordering ₹999 · credit ledger ₹1,499 · reports ₹499 · Authorize.net ₹999 (+₹20,000, if eligible) |
| Typical launch (base + WhatsApp + cards) | **₹7,497 / month** (Option 1) · **₹9,497 / month** (Option 2) |
| 36-month total at typical | ₹3,29,892 (Option 1) · ₹4,16,892 (Option 2) |
| After 36 months | ₹4,999 / month care |
| Early exit | Balance of the build (₹85,000 on Option 1, ₹1,10,000 on Option 2 — × months remaining ÷ 36) |

### Model C — subscription, 24-month term

₹60,000 setup + **₹10,999 / month** for 24 months with the typical add-ons
included, then ₹4,999 / month. 24-month total ₹3,23,976.

### What "₹60,000 + ₹5,000 a month" buys

Model B's base without add-ons, on a 36-month term: the whole Launch scope
except WhatsApp (email notifications stay) and card payments (UPI and bank
transfer stay). ₹60,000 + ₹5,999 × 36 = ₹2,75,964. That is a real, sellable
offer — say clearly which two things are add-ons, and the client can switch
them on any month.

### Play Store app

| Option | One-time | Monthly | When |
|---|---|---|---|
| **PWA + Trusted Web Activity** — same site, installable, offline shell, push, Play listing | **₹30,000** (or ₹15,000 + ₹1,499/mo on Model B) + Play Console ₹2,100 once | +₹1,500 care | One week after go-live. Recommended |
| Capacitor hybrid — native push, camera for prescriptions and barcodes, biometric login | ₹75,000 Android; +₹35,000 and Apple Developer ₹8,500/yr for iOS | +₹2,500 | When dealers want scanning |
| Native / Flutter rebuild | ₹3–5 lakh | doubles maintenance | Not recommended for this audience |

---

## 8. Timeline

| | |
|---|---|
| Launch scope | 8–10 weeks from receiving the product list, images and policies |
| Play Store PWA | +1 week after go-live; Google review 3–7 days |
| Phase 2 modules | 1–2 weeks each |

---

## 9. Ask before quoting firm

1. Authorize.net — do they have an overseas entity, or did they mean "a card gateway"?
2. Payment mix — what share of dealers will pay online versus bank transfer or credit?
3. SKU count now and in a year; and do they get image packs from their distributors?
4. Where prices and stock live today — Excel, Tally, something else
5. Delivery — own van only in the Tricity, or courier beyond it later?
6. Who packs and dispatches, and who covers when they are on leave
7. GST turnover — whether e-invoicing (IRN) is a legal requirement
8. WhatsApp — do they already have a WhatsApp Business number to verify with Meta?
9. Infrastructure — do they want everything under one Google account (Option 2), or lowest running cost (Option 1)? Who will hold the GCP billing account and card?
