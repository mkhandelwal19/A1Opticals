/* =============================================================================
   api/db.js — SQLite, opened once, with the schema and a transaction helper
   -----------------------------------------------------------------------------
   node:sqlite (Node ≥ 22.5, no native build step). One file on disk, WAL
   mode, one writer at a time — which is exactly the guarantee the order
   logic leans on: every mutation runs inside tx(), which takes the write
   lock up front with BEGIN IMMEDIATE, so two requests can never interleave
   their reads and writes of the same order. Node is single-threaded and
   DatabaseSync is synchronous, so a transaction cannot even be pre-empted by
   another request mid-way.

   The schema is written to port to Postgres unchanged in spirit: text UUIDs,
   ISO timestamps, integer paise, JSON columns for the shapes the storefront
   already uses (customer, delivery, items), plus a version column on orders
   for optimistic locking. See README.md for the concurrency argument.
   ========================================================================== */
'use strict';

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)`,

  `CREATE TABLE IF NOT EXISTS customers (
     id TEXT PRIMARY KEY,
     email TEXT NOT NULL UNIQUE,
     name TEXT, phone TEXT,
     created_at TEXT NOT NULL, last_login_at TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY,
     kind TEXT NOT NULL,                       -- 'customer' | 'owner'
     customer_id TEXT,
     created_at TEXT NOT NULL, expires_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS otp_codes (
     id TEXT PRIMARY KEY,
     email TEXT NOT NULL, code_hash TEXT NOT NULL,
     created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0, used_at TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS otp_email ON otp_codes(email, created_at)`,

  /* Per-day order counters: the human reference is a sequence, not a dice roll. */
  `CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, n INTEGER NOT NULL)`,

  `CREATE TABLE IF NOT EXISTS orders (
     id TEXT PRIMARY KEY,                      -- uuid v4
     ref TEXT NOT NULL UNIQUE,                 -- A1-260918-0042
     version INTEGER NOT NULL DEFAULT 1,       -- optimistic lock for status changes
     status TEXT NOT NULL,
     mode TEXT NOT NULL,                       -- retail | trade
     registered INTEGER NOT NULL DEFAULT 0,    -- 1 = placed by / linked to an account
     customer_id TEXT,
     email TEXT, phone TEXT,
     customer_json TEXT NOT NULL, delivery_json TEXT NOT NULL, rx_json TEXT,
     items_json TEXT NOT NULL, byrate_json TEXT NOT NULL,
     gross INTEGER NOT NULL, discount INTEGER NOT NULL, base INTEGER NOT NULL, tax INTEGER NOT NULL,
     shipping INTEGER NOT NULL, total INTEGER NOT NULL,
     pay_method TEXT NOT NULL, pay_status TEXT NOT NULL,
     gateway TEXT, gateway_order_id TEXT UNIQUE, gateway_payment_id TEXT, paid_at TEXT,
     stock_state TEXT NOT NULL DEFAULT 'reserved',   -- reserved | committed | released | restocked
     placed_at TEXT NOT NULL, updated_at TEXT NOT NULL, delivered_at TEXT, cancelled_at TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS orders_customer ON orders(customer_id, placed_at)`,
  `CREATE INDEX IF NOT EXISTS orders_status ON orders(status, placed_at)`,
  `CREATE INDEX IF NOT EXISTS orders_email ON orders(email)`,

  `CREATE TABLE IF NOT EXISTS order_events (
     id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
     at TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL, actor TEXT NOT NULL, note TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS events_order ON order_events(order_id, at)`,

  /* One row per Idempotency-Key. Inserted BEFORE the work as 'in-progress',
     so a duplicate arriving while the first is still talking to the gateway
     is refused instead of doubled. */
  `CREATE TABLE IF NOT EXISTS idempotency (
     key TEXT PRIMARY KEY, scope TEXT NOT NULL, request_hash TEXT NOT NULL,
     status TEXT NOT NULL, response_json TEXT, created_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS stock (sku TEXT PRIMARY KEY, on_hand INTEGER NOT NULL, reserved INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS stock_moves (
     id TEXT PRIMARY KEY, order_id TEXT, sku TEXT NOT NULL, qty INTEGER NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS refunds (
     id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), return_id TEXT,
     amount INTEGER NOT NULL, reason TEXT,
     channel TEXT NOT NULL,                    -- gateway | manual
     status TEXT NOT NULL,                     -- pending | processing | processed | failed
     gateway_payment_id TEXT, gateway_refund_id TEXT, reference TEXT, error TEXT,
     created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, processed_at TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS refunds_order ON refunds(order_id)`,
  `CREATE INDEX IF NOT EXISTS refunds_gw ON refunds(gateway_refund_id)`,

  `CREATE TABLE IF NOT EXISTS return_requests (
     id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), customer_id TEXT NOT NULL,
     items_json TEXT NOT NULL, reason TEXT, method TEXT NOT NULL,
     status TEXT NOT NULL, amount INTEGER, refund_id TEXT, note TEXT,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL, decided_by TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS returns_order ON return_requests(order_id)`,
  `CREATE INDEX IF NOT EXISTS returns_status ON return_requests(status, created_at)`,

  /* Every webhook delivery, keyed by the provider's event id: a redelivery
     is an INSERT that changes nothing, and is answered 200 without work. */
  `CREATE TABLE IF NOT EXISTS webhook_events (
     event_id TEXT PRIMARY KEY, provider TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL,
     received_at TEXT NOT NULL, processed_at TEXT, result TEXT
   )`,

  /* The outbox. Written in the same transaction as the change it announces. */
  `CREATE TABLE IF NOT EXISTS notifications (
     id TEXT PRIMARY KEY, order_id TEXT,
     channel TEXT NOT NULL,                    -- email | whatsapp
     recipient TEXT NOT NULL, template TEXT NOT NULL, subject TEXT, body TEXT NOT NULL,
     status TEXT NOT NULL,                     -- queued | sent | failed
     attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
     created_at TEXT NOT NULL, sent_at TEXT, error TEXT, dedupe_key TEXT UNIQUE
   )`,
  `CREATE INDEX IF NOT EXISTS notif_queue ON notifications(status, next_attempt_at)`,
  `CREATE INDEX IF NOT EXISTS notif_order ON notifications(order_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL)`,

  `CREATE TABLE IF NOT EXISTS audit_log (
     id TEXT PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail_json TEXT
   )`
];

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA busy_timeout = 5000');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('PRAGMA synchronous = NORMAL');
  SCHEMA.forEach((sql) => raw.exec(sql));
  if (!raw.prepare('SELECT v FROM schema_version').get()) raw.prepare('INSERT INTO schema_version VALUES (1)').run();

  const cache = new Map();
  function stmt(sql) {
    let s = cache.get(sql);
    if (!s) { s = raw.prepare(sql); cache.set(sql, s); }
    return s;
  }

  let depth = 0;
  const api = {
    raw,
    get: (sql, ...p) => stmt(sql).get(...p),
    all: (sql, ...p) => stmt(sql).all(...p),
    run: (sql, ...p) => stmt(sql).run(...p),
    exec: (sql) => raw.exec(sql),
    /* tx(fn): BEGIN IMMEDIATE … COMMIT, or ROLLBACK on throw. Nested calls
       join the outer transaction rather than starting their own. */
    tx(fn) {
      if (depth > 0) return fn(api);
      raw.exec('BEGIN IMMEDIATE');
      depth++;
      try {
        const out = fn(api);
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        try { raw.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
        throw e;
      } finally {
        depth--;
      }
    },
    close() { raw.close(); }
  };
  return api;
}

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

module.exports = { open, now, uuid, sha256 };
