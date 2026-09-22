/* =============================================================================
   api/auth.js — who is asking: customers by email code, the owner by password
   -----------------------------------------------------------------------------
   Customers never set a password. They give an email, get a six-digit code,
   type it, and hold a session for thirty days. The code proves they own the
   address the order went to, which is the only thing a return needs proved.

   Sessions are 32 random bytes; the database keeps the SHA-256 of the token,
   so a copy of the database does not log anyone in. The cookie is HttpOnly
   and SameSite=Lax, so page scripts cannot read it and other sites cannot
   send it. The owner has a separate cookie from a separate table row, so an
   owner can also be signed in as a customer on the same laptop to test.

   Rate limits live in memory: one process, one counter. Move them to the
   database if the API ever runs as more than one instance.
   ========================================================================== */
'use strict';

const crypto = require('node:crypto');
const { uuid, now, sha256 } = require('./db.js');
const { safeEqual } = require('./gateway.js');

class HttpError extends Error {
  constructor(status, code, message, data) {
    super(message || code);
    this.status = status; this.code = code; this.data = data;
  }
}

/* A small fixed-window limiter: limit(key, max, windowMs) → true if allowed. */
function limiter() {
  const hits = new Map();
  return function allow(key, max, windowMs) {
    const t = Date.now();
    let h = hits.get(key);
    if (!h || t - h.start > windowMs) { h = { start: t, n: 0 }; hits.set(key, h); }
    h.n++;
    if (hits.size > 10000) for (const [k, v] of hits) if (t - v.start > windowMs) hits.delete(k);
    return h.n <= max;
  };
}

function create({ db, cfg, notify, log }) {
  const allow = limiter();
  const pepper = cfg.secret;

  function newToken() { return crypto.randomBytes(32).toString('hex'); }

  function createSession(tx, kind, customerId) {
    const token = newToken();
    const at = now();
    const exp = new Date(Date.now() + (cfg.sessionDays || 30) * 864e5).toISOString();
    tx.run(`INSERT INTO sessions (token_hash, kind, customer_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`, sha256(token), kind, customerId || null, at, exp);
    return { token, expiresAt: exp };
  }
  function resolve(token, kind) {
    if (!token) return null;
    const row = db.get(`SELECT * FROM sessions WHERE token_hash = ? AND kind = ?`, sha256(token), kind);
    if (!row) return null;
    if (row.expires_at < now()) { db.run(`DELETE FROM sessions WHERE token_hash = ?`, row.token_hash); return null; }
    return row;
  }
  function destroy(token) { if (token) db.run(`DELETE FROM sessions WHERE token_hash = ?`, sha256(token)); }

  function normEmail(e) {
    e = String(e || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) || e.length > 254) throw new HttpError(422, 'bad-email', 'A valid email address is needed');
    return e;
  }
  function customerByEmail(tx, email) { return tx.get(`SELECT * FROM customers WHERE email = ?`, email); }
  /* Create-or-fetch by email. Name and phone are filled in when first seen
     and updated when a later order gives better ones. */
  function upsertCustomer(tx, email, details) {
    let c = customerByEmail(tx, email);
    if (!c) {
      c = { id: uuid(), email, name: (details && details.name) || null, phone: (details && details.phone) || null, created_at: now(), last_login_at: null };
      tx.run(`INSERT INTO customers (id, email, name, phone, created_at) VALUES (?, ?, ?, ?, ?)`, c.id, c.email, c.name, c.phone, c.created_at);
    } else if (details && (details.name || details.phone)) {
      tx.run(`UPDATE customers SET name = COALESCE(?, name), phone = COALESCE(?, phone) WHERE id = ?`, details.name || null, details.phone || null, c.id);
    }
    return c;
  }

  /* ── customer: email code ─────────────────────────────────────────────── */
  function otpHash(email, code) { return sha256(email + ':' + code + ':' + pepper); }

  function requestOtp(emailRaw, ip) {
    const email = normEmail(emailRaw);
    if (!allow('otp:ip:' + ip, 20, 10 * 60 * 1000)) throw new HttpError(429, 'too-many', 'Too many codes requested. Try again in a few minutes.');
    if (!allow('otp:email:' + email, 5, 10 * 60 * 1000)) throw new HttpError(429, 'too-many', 'Too many codes for this email. Try again in a few minutes.');
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const at = now();
    db.tx((tx) => {
      tx.run(`UPDATE otp_codes SET used_at = ? WHERE email = ? AND used_at IS NULL`, at, email); /* one live code per email */
      tx.run(`INSERT INTO otp_codes (id, email, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
        uuid(), email, otpHash(email, code), at, new Date(Date.now() + 10 * 60 * 1000).toISOString());
      notify.enqueue(tx, { template: 'otp', email, ctx: { code, brand: cfg.brand, contact: cfg.contact }, dedupeKey: null });
    });
    /* In development the code is also returned so the flow can be walked
       without a mail provider. Never on in production. */
    return cfg.devOtp && notify.transports.email === 'log' ? { ok: true, devCode: code } : { ok: true };
  }

  function verifyOtp(emailRaw, codeRaw, ip) {
    const email = normEmail(emailRaw);
    const code = String(codeRaw || '').replace(/\D/g, '');
    if (!allow('otpv:ip:' + ip, 30, 10 * 60 * 1000)) throw new HttpError(429, 'too-many', 'Too many attempts. Try again in a few minutes.');
    if (code.length !== 6) throw new HttpError(422, 'bad-code', 'The code is six digits');
    return db.tx((tx) => {
      const row = tx.get(`SELECT * FROM otp_codes WHERE email = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1`, email);
      if (!row || row.expires_at < now()) throw new HttpError(401, 'code-expired', 'That code has expired — ask for a new one');
      if (row.attempts >= 5) throw new HttpError(401, 'code-locked', 'Too many wrong tries — ask for a new code');
      tx.run(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?`, row.id);
      if (!safeEqual(row.code_hash, otpHash(email, code))) throw new HttpError(401, 'wrong-code', 'That code is not right');
      tx.run(`UPDATE otp_codes SET used_at = ? WHERE id = ?`, now(), row.id);
      const c = upsertCustomer(tx, email, null);
      tx.run(`UPDATE customers SET last_login_at = ? WHERE id = ?`, now(), c.id);
      const s = createSession(tx, 'customer', c.id);
      return { customer: { id: c.id, email: c.email, name: c.name, phone: c.phone }, session: s };
    });
  }

  /* ── owner ────────────────────────────────────────────────────────────── */
  function ownerLogin(emailRaw, password, ip) {
    if (!allow('owner:ip:' + ip, 10, 10 * 60 * 1000)) throw new HttpError(429, 'too-many', 'Too many attempts. Try again in ten minutes.');
    const email = String(emailRaw || '').trim().toLowerCase();
    const ok = safeEqual(sha256(email), sha256(cfg.ownerEmail)) && safeEqual(sha256(String(password || '')), sha256(cfg.ownerPassword));
    if (!ok) throw new HttpError(401, 'bad-login', 'That email and password do not match');
    return db.tx((tx) => createSession(tx, 'owner', null));
  }

  return { HttpError, createSession, resolve, destroy, requestOtp, verifyOtp, ownerLogin, upsertCustomer, customerByEmail, normEmail };
}

module.exports = { create, HttpError };
