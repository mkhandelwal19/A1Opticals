/* =============================================================================
   api/app.js — the HTTP surface: routes, sessions, static files, workers
   -----------------------------------------------------------------------------
   createApp(overrides) wires config → db → engine → gateway → outbox → auth
   → order services, and returns { handle, listen, close, … }. server.js
   listens; test.js drives it in-process on an in-memory database.

   Routes (all JSON, all under /api):

     GET  /health

     POST /auth/otp                 { email }            → { ok, devCode? }
     POST /auth/verify              { email, code }      → { customer }   sets a1_session
     POST /auth/logout
     GET  /auth/me                  → { customer | null, owner: bool }
     POST /auth/owner               { email, password }  → { owner }      sets a1_owner
     POST /auth/owner/logout

     POST /commerce/order           Idempotency-Key      → { order, gateway? }
     POST /commerce/verify          { razorpay_* }       → { verified, order }
     POST /commerce/abandon         { orderId, key }
     POST /stub/pay                 { orderId, outcome } (stub gateway only)
     POST /webhooks/razorpay        raw body, X-Razorpay-Signature

     GET  /orders/:ref?phone=       guest tracking, or the owner/customer's own
     GET  /me/orders
     GET  /me/orders/:id
     POST /me/orders/:id/returns    { items:[{idx,qty}], reason, method }

     GET  /admin/orders?status=&q=&pending=1
     GET  /admin/orders/:id
     PATCH /admin/orders/:id/status  { status, version, note }   409 on a stale version
     POST /admin/orders/:id/paid     { version, reference }
     POST /admin/orders/:id/refunds  { amount, reason, manual?, reference? }
     POST /admin/refunds/:id/reconcile
     GET  /admin/returns?status=
     POST /admin/returns/:id         { action: approve|reject|received|cancel, note, refund? }
     GET  /admin/notifications?orderId=&status=
     POST /admin/notifications/:id/retry
     GET  /admin/attention
     GET  /admin/settings · PUT /admin/settings/:key { value }
     GET  /admin/stock/:sku
   ========================================================================== */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DB = require('./db.js');
const Engine = require('./engine.js');
const Gateway = require('./gateway.js');
const Notify = require('./notify.js');
const Auth = require('./auth.js');
const Orders = require('./orders.js');
const Commerce = require('../commerce.js');
const { HttpError } = Auth;

const ROOT = path.join(__dirname, '..');

function config(over = {}) {
  const env = process.env;
  const port = parseInt(over.port || env.PORT || '8787', 10);
  const c = {
    port,
    db: over.db || env.A1_DB || path.join(__dirname, 'data', 'a1opticals.sqlite'),
    siteUrl: over.siteUrl || env.A1_SITE_URL || ('http://localhost:' + port),
    serveStatic: over.serveStatic != null ? over.serveStatic : env.A1_STATIC !== '0',
    origins: (over.origins || env.A1_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    brand: 'A1 Opticals',
    ownerEmail: (over.ownerEmail || env.A1_OWNER_EMAIL || 'owner@a1opticals.in').toLowerCase(),
    ownerPassword: over.ownerPassword || env.A1_OWNER_PASSWORD || 'a1trade',
    ownerNotifyEmail: over.ownerNotifyEmail != null ? over.ownerNotifyEmail : (env.A1_OWNER_NOTIFY_EMAIL || 'a1opticals@gmail.com'),
    secret: over.secret || env.A1_SECRET || crypto.randomBytes(32).toString('hex'),
    sessionDays: parseInt(over.sessionDays || env.A1_SESSION_DAYS || '30', 10),
    pendingTtlMin: parseInt(over.pendingTtlMin || env.A1_PENDING_TTL_MIN || '30', 10),
    secureCookies: over.secureCookies != null ? over.secureCookies : env.A1_SECURE_COOKIES === '1',
    devOtp: over.devOtp != null ? over.devOtp : env.A1_DEV_OTP !== '0',
    maxBody: 6 * 1024 * 1024,
    gateway: over.gateway || {
      mode: env.GATEWAY === 'razorpay' ? 'razorpay' : 'stub',
      keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET, webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
      webhookDelayMs: env.STUB_WEBHOOK_DELAY_MS != null ? parseInt(env.STUB_WEBHOOK_DELAY_MS, 10) : undefined
    },
    emailTransport: over.emailTransport || env.EMAIL_TRANSPORT || 'log',
    resendKey: env.RESEND_API_KEY, mailFrom: env.MAIL_FROM || 'A1 Opticals <orders@a1opticals.com>',
    whatsappWebhook: env.WHATSAPP_WEBHOOK_URL, whatsappToken: env.WHATSAPP_TOKEN,
    outboxIntervalMs: over.outboxIntervalMs || 3000,
    sweepIntervalMs: over.sweepIntervalMs || 60000,
    quiet: !!over.quiet
  };
  c.contact = null; // filled from the engine's site settings at boot
  return c;
}

/* ── tiny helpers ─────────────────────────────────────────────────────── */
function parseCookies(h) {
  const out = {};
  String(h || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function cookie(name, value, opts) {
  const parts = [name + '=' + encodeURIComponent(value), 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (opts.maxAge != null) parts.push('Max-Age=' + opts.maxAge);
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > max) { reject(new HttpError(413, 'too-large', 'Request body too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json' };
const STATIC_DENY = /^\/(api|contract|node_modules|\.git)(\/|$)|\/\.|\.cmd$|package(-lock)?\.json$/i;

function createApp(overrides) {
  const cfg = config(overrides);
  const log = {
    info: (m) => { if (!cfg.quiet) console.log(m); },
    warn: (m) => { if (!cfg.quiet) console.warn(m); },
    error: (m) => console.error(m)
  };

  const db = DB.open(cfg.db);
  const engine = Engine.create({});
  const settings = {};
  db.all(`SELECT key, value_json FROM settings`).forEach((r) => { try { settings[r.key] = JSON.parse(r.value_json); } catch (_) {} });
  engine.reload(settings);
  cfg.contact = engine.site.get('contact');

  const gateway = Gateway.create(cfg.gateway);
  const notify = Notify.create({ db, cfg, log });
  const auth = Auth.create({ db, cfg, notify, log });
  const orders = Orders.create({ db, engine, gateway, notify, auth, cfg, log });

  /* The stub delivers its webhooks straight into the handler, signed, the
     way Razorpay's would arrive over HTTP. */
  if (gateway.stub) gateway.setWebhookDelivery(async (raw, sig, id) => { try { orders.handleWebhook({ rawBody: raw, signature: sig, eventId: id }); } catch (e) { log.warn('stub webhook: ' + e.message); } });

  /* ── router ───────────────────────────────────────────────────────────── */
  const routes = [];
  function route(method, pattern, fn, opts = {}) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, fn, opts });
  }
  const requireOwner = (ctx) => { if (!ctx.owner) throw new HttpError(401, 'owner-login', 'Owner sign-in required'); return 'owner:' + cfg.ownerEmail; };
  const requireCustomer = (ctx) => { if (!ctx.customer) throw new HttpError(401, 'sign-in', 'Sign in to continue'); return ctx.customer; };
  const cookieOpts = (ctx, days) => ({ maxAge: days * 86400, secure: cfg.secureCookies || ctx.https });

  route('GET', '/api/health', () => ({ ok: true, gateway: gateway.name, stub: !!gateway.stub, transports: notify.transports, queued: db.get(`SELECT COUNT(*) AS n FROM notifications WHERE status = 'queued'`).n, time: DB.now() }));

  /* auth */
  route('POST', '/api/auth/otp', (ctx) => auth.requestOtp(ctx.body.email, ctx.ip));
  route('POST', '/api/auth/verify', (ctx) => {
    const r = auth.verifyOtp(ctx.body.email, ctx.body.code, ctx.ip);
    ctx.setCookie(cookie('a1_session', r.session.token, cookieOpts(ctx, cfg.sessionDays)));
    return { customer: r.customer };
  });
  route('POST', '/api/auth/logout', (ctx) => { auth.destroy(ctx.cookies.a1_session); ctx.setCookie(cookie('a1_session', '', { maxAge: 0 })); return { ok: true }; });
  route('GET', '/api/auth/me', (ctx) => ({ customer: ctx.customer ? { id: ctx.customer.id, email: ctx.customer.email, name: ctx.customer.name, phone: ctx.customer.phone } : null, owner: !!ctx.owner }));
  route('POST', '/api/auth/owner', (ctx) => {
    const s = auth.ownerLogin(ctx.body.email, ctx.body.password, ctx.ip);
    ctx.setCookie(cookie('a1_owner', s.token, cookieOpts(ctx, 1)));
    return { owner: true, email: cfg.ownerEmail };
  });
  route('POST', '/api/auth/owner/logout', (ctx) => { auth.destroy(ctx.cookies.a1_owner); ctx.setCookie(cookie('a1_owner', '', { maxAge: 0 })); return { ok: true }; });

  /* commerce */
  route('POST', '/api/commerce/order', (ctx) => orders.createOrder({ body: ctx.body, idemKey: ctx.req.headers['idempotency-key'], customer: ctx.customer, ip: ctx.ip }));
  route('POST', '/api/commerce/verify', (ctx) => orders.verifyCheckout(ctx.body || {}));
  route('POST', '/api/commerce/abandon', (ctx) => orders.abandon({ orderId: String(ctx.body.orderId || ''), idemKey: String(ctx.body.key || '') }));
  route('POST', '/api/stub/pay', (ctx) => {
    if (!gateway.stub) throw new HttpError(404, 'not-found');
    return gateway.pay(String(ctx.body.orderId || ''), ctx.body.outcome === 'fail' ? 'fail' : 'success', ctx.body.method);
  });
  route('POST', '/api/webhooks/razorpay', (ctx) => orders.handleWebhook({ rawBody: ctx.rawBody, signature: ctx.req.headers['x-razorpay-signature'], eventId: ctx.req.headers['x-razorpay-event-id'] }), { raw: true });

  /* orders, for whoever can see them */
  route('GET', '/api/orders/:ref', (ctx) => {
    const ref = decodeURIComponent(ctx.params.ref);
    let o = null;
    if (ctx.owner) o = orders.findByRef(ref, null, 'admin');
    if (!o && ctx.customer) { const row = db.get(`SELECT * FROM orders WHERE ref = ? AND customer_id = ?`, ref.trim().toUpperCase(), ctx.customer.id); if (row) o = orders.view(row, 'customer'); }
    if (!o) o = orders.findByRef(ref, ctx.query.phone, 'guest');
    if (!o) throw new HttpError(404, 'no-order', 'No order with that reference and phone number');
    return { order: o };
  });
  route('GET', '/api/me/orders', (ctx) => ({ orders: orders.listOrders({ scope: 'customer', customerId: requireCustomer(ctx).id, includePending: true }) }));
  route('GET', '/api/me/orders/:id', (ctx) => { const o = orders.getForCustomer(ctx.params.id, requireCustomer(ctx).id); if (!o) throw new HttpError(404, 'no-order'); return { order: o }; });
  route('POST', '/api/me/orders/:id/returns', (ctx) => ({ return: orders.requestReturn({ orderId: ctx.params.id, customer: requireCustomer(ctx), items: ctx.body.items, reason: ctx.body.reason, method: ctx.body.method }) }));

  /* owner */
  route('GET', '/api/admin/orders', (ctx) => { requireOwner(ctx); return { orders: orders.listOrders({ scope: 'admin', status: ctx.query.status, q: ctx.query.q, includePending: ctx.query.pending === '1' }) }; });
  route('GET', '/api/admin/orders/:id', (ctx) => { requireOwner(ctx); const row = orders.rowById(null, ctx.params.id); if (!row) throw new HttpError(404, 'no-order'); return { order: orders.view(row, 'admin') }; });
  route('PATCH', '/api/admin/orders/:id/status', (ctx) => ({ order: orders.changeStatus({ orderId: ctx.params.id, status: String(ctx.body.status || ''), version: ctx.body.version, note: ctx.body.note, actor: requireOwner(ctx) }) }));
  route('POST', '/api/admin/orders/:id/paid', (ctx) => ({ order: orders.markOfflinePaid({ orderId: ctx.params.id, version: ctx.body.version, reference: ctx.body.reference, actor: requireOwner(ctx) }) }));
  route('POST', '/api/admin/orders/:id/refunds', async (ctx) => ({ refund: await orders.createRefund({ orderId: ctx.params.id, amount: ctx.body.amount, reason: ctx.body.reason, returnId: ctx.body.returnId, manual: !!ctx.body.manual, reference: ctx.body.reference, actor: requireOwner(ctx) }) }));
  route('POST', '/api/admin/refunds/:id/reconcile', async (ctx) => ({ refund: await orders.reconcileRefund({ refundId: ctx.params.id, actor: requireOwner(ctx) }) }));
  route('GET', '/api/admin/returns', (ctx) => { requireOwner(ctx); return { returns: orders.listReturns({ status: ctx.query.status }) }; });
  route('POST', '/api/admin/returns/:id', (ctx) => orders.decideReturn({ returnId: ctx.params.id, action: String(ctx.body.action || ''), note: ctx.body.note, refund: ctx.body.refund, actor: requireOwner(ctx) }));
  route('GET', '/api/admin/notifications', (ctx) => { requireOwner(ctx); return { notifications: orders.listNotifications({ orderId: ctx.query.orderId, status: ctx.query.status }) }; });
  route('POST', '/api/admin/notifications/:id/retry', (ctx) => { requireOwner(ctx); return { ok: notify.retry(ctx.params.id) > 0 }; });
  route('GET', '/api/admin/attention', (ctx) => { requireOwner(ctx); return orders.attention(); });
  route('GET', '/api/admin/settings', (ctx) => { requireOwner(ctx); return orders.settings(); });
  route('PUT', '/api/admin/settings/:key', (ctx) => { const actor = requireOwner(ctx); orders.putSetting(ctx.params.key, ctx.body.value, actor); return { ok: true }; });
  route('GET', '/api/admin/stock/:sku', (ctx) => { requireOwner(ctx); return { stock: orders.stockOf(decodeURIComponent(ctx.params.sku)) || null }; });

  /* ── request handling ─────────────────────────────────────────────────── */
  function cors(req, res) {
    const origin = req.headers.origin;
    if (!origin || !cfg.origins.length || cfg.origins.indexOf(origin) < 0) return;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  }
  function send(res, status, obj, extra) {
    const body = JSON.stringify(obj);
    res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) }, extra || {}));
    res.end(body);
  }

  async function handleApi(req, res, url) {
    cors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const match = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!match) {
      if (routes.some((r) => r.re.test(url.pathname))) throw new HttpError(405, 'method-not-allowed');
      throw new HttpError(404, 'not-found', 'No such endpoint');
    }
    const m = url.pathname.match(match.re);
    const params = {}; match.keys.forEach((k, i) => { params[k] = m[i + 1]; });
    const rawBody = req.method === 'GET' || req.method === 'HEAD' ? '' : await readBody(req, cfg.maxBody);
    let body = {};
    if (rawBody && !match.opts.raw) {
      if (!/application\/json/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'json-only', 'Send application/json');
      try { body = JSON.parse(rawBody); } catch (_) { throw new HttpError(400, 'bad-json', 'The request body is not valid JSON'); }
      if (!body || typeof body !== 'object') throw new HttpError(400, 'bad-json');
    }
    /* Cross-site request forgery: a browser cannot send JSON cross-origin
       without a preflight, and our preflight only answers allowed origins.
       For mutating requests we therefore insist on the JSON content type. */
    if (req.method !== 'GET' && !match.opts.raw && !/application\/json/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'json-only', 'Send application/json');

    const cookies = parseCookies(req.headers.cookie);
    const cs = auth.resolve(cookies.a1_session, 'customer');
    const customer = cs ? db.get(`SELECT id, email, name, phone FROM customers WHERE id = ?`, cs.customer_id) : null;
    const owner = !!auth.resolve(cookies.a1_owner, 'owner');
    const setCookies = [];
    const ctx = {
      req, res, url, params, query: Object.fromEntries(url.searchParams), body, rawBody, cookies, customer, owner,
      ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?',
      https: req.headers['x-forwarded-proto'] === 'https' || !!(req.socket && req.socket.encrypted),
      setCookie: (c) => setCookies.push(c)
    };
    const out = await match.fn(ctx);
    const extra = setCookies.length ? { 'Set-Cookie': setCookies } : null;
    send(res, out && out.__status || 200, out == null ? { ok: true } : out, extra);
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    if (STATIC_DENY.test(p) || p.indexOf('..') > -1) { res.writeHead(404); res.end('Not found'); return; }
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT)) { res.writeHead(404); res.end(); return; }
    let st;
    try { st = fs.statSync(file); } catch (_) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    if (st.isDirectory()) { res.writeHead(302, { Location: p.replace(/\/?$/, '/') + 'index.html' }); res.end(); return; }
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext];
    if (!type) { res.writeHead(404); res.end('Not found'); return; }
    if (ext === '.html') {
      /* The one line that switches a page from preview to live: store.js
         reads this tag and talks to /api instead of localStorage. */
      let html = fs.readFileSync(file, 'utf8');
      html = html.replace(/<meta charset="UTF-8">/i, '<meta charset="UTF-8">\n<meta name="a1-api" content="/api">');
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(html) });
      res.end(req.method === 'HEAD' ? undefined : html);
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': ext === '.js' || ext === '.css' ? 'no-cache' : 'public, max-age=3600', 'Content-Length': st.size });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    const reqId = crypto.randomBytes(4).toString('hex');
    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else if (cfg.serveStatic) serveStatic(req, res, url);
      else { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); }
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof HttpError) { send(res, e.status, Object.assign({ error: e.code, message: e.message }, e.data ? { data: e.data } : {})); return; }
      if (e instanceof Gateway.GatewayError) { send(res, e.status || 502, { error: e.code, message: e.message }); return; }
      log.error('[' + reqId + '] ' + req.method + ' ' + url.pathname + ' → ' + (e.stack || e));
      send(res, 500, { error: 'internal', message: 'Something went wrong on our side (ref ' + reqId + ')' });
    }
  }

  /* ── workers ──────────────────────────────────────────────────────────── */
  let sweeper = null, server = null;
  function start() {
    notify.start();
    sweeper = setInterval(() => { try { const n = orders.expirePending(); if (n) log.info('expired ' + n + ' unpaid order(s)'); } catch (e) { log.error('sweeper: ' + e.message); } }, cfg.sweepIntervalMs);
    if (sweeper.unref) sweeper.unref();
  }
  function listen(port) {
    return new Promise((resolve) => {
      server = http.createServer(handle);
      server.listen(port == null ? cfg.port : port, '127.0.0.1', () => { start(); resolve(server.address().port); });
    });
  }
  function close() {
    notify.stop();
    if (sweeper) clearInterval(sweeper);
    return new Promise((resolve) => { if (server) server.close(() => { db.close(); resolve(); }); else { db.close(); resolve(); } });
  }

  return { cfg, db, engine, gateway, notify, auth, orders, handle, listen, close, start, log };
}

module.exports = { createApp, config };
