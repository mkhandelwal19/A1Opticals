/* =============================================================================
   api/notify.js — the notification outbox
   -----------------------------------------------------------------------------
   A status change and the message about it are one transaction: enqueue()
   is called inside the same tx() that updates the order, so a message is
   never sent for a change that rolled back, and never lost for one that
   committed. A worker then drains the queue and talks to the mail and
   WhatsApp providers, with retries and backoff, off the request path.

   Transports:
     email     log       print to the console (default; the dashboard shows
                         the outbox, so nothing is invisible)
               resend    Resend's HTTP API (RESEND_API_KEY, MAIL_FROM)
     whatsapp  log       as above
               webhook   POST { to, text } to WHATSAPP_WEBHOOK_URL with a
                         bearer token — the shape every Indian WhatsApp
                         Business provider (Interakt, Gupshup, AiSensy) can
                         be adapted to in a few lines

   The templates live in commerce.js so the storefront preview shows the
   same words the server sends.
   ========================================================================== */
'use strict';

const Commerce = require('../commerce.js');
const { uuid, now } = require('./db.js');

const MAX_ATTEMPTS = 6;
const backoffMs = (attempt) => Math.min(60 * 60 * 1000, 30 * 1000 * Math.pow(2, attempt - 1));

function transports(cfg, log) {
  const email = cfg.emailTransport === 'resend' && cfg.resendKey
    ? {
        name: 'resend',
        async send(n) {
          const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + cfg.resendKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: cfg.mailFrom, to: [n.recipient], subject: n.subject, text: n.body })
          });
          if (!res.ok) throw new Error('resend ' + res.status + ': ' + (await res.text()).slice(0, 300));
        }
      }
    : {
        name: 'log',
        async send(n) { log.info('[email → ' + n.recipient + '] ' + n.subject + '\n' + n.body.replace(/^/gm, '    ')); }
      };

  const whatsapp = cfg.whatsappWebhook
    ? {
        name: 'webhook',
        async send(n) {
          const res = await fetch(cfg.whatsappWebhook, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + (cfg.whatsappToken || ''), 'Content-Type': 'application/json' },
            body: JSON.stringify({ to: n.recipient, text: n.body, template: n.template })
          });
          if (!res.ok) throw new Error('whatsapp ' + res.status + ': ' + (await res.text()).slice(0, 300));
        }
      }
    : {
        name: 'log',
        async send(n) { log.info('[whatsapp → ' + n.recipient + '] ' + n.body); }
      };

  return { email, whatsapp };
}

function create({ db, cfg, log }) {
  const tr = transports(cfg, log);

  /* enqueue(tx, { orderId, template, ctx, email, phone, dedupeKey })
     Renders once and queues an email and, when there is a phone number, a
     WhatsApp. Returns the ids. Dedupe: the same key twice is a no-op — a
     "shipped" message cannot be queued twice for the same order version. */
  function enqueue(tx, spec) {
    const rendered = Commerce.render(spec.template, spec.ctx);
    const at = now();
    const out = [];
    const rows = [];
    if (spec.email) rows.push({ channel: 'email', recipient: String(spec.email).trim().toLowerCase(), body: rendered.text, subject: rendered.subject });
    if (spec.phone && rendered.wa) rows.push({ channel: 'whatsapp', recipient: String(spec.phone).replace(/[^\d+]/g, ''), body: rendered.wa, subject: null });
    for (const r of rows) {
      const id = uuid();
      const key = spec.dedupeKey ? spec.dedupeKey + ':' + r.channel : null;
      const res = tx.run(
        `INSERT OR IGNORE INTO notifications (id, order_id, channel, recipient, template, subject, body, status, attempts, next_attempt_at, created_at, dedupe_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
        id, spec.orderId || null, r.channel, r.recipient, spec.template, r.subject, r.body, at, at, key
      );
      if (res.changes) out.push(id);
    }
    return out;
  }

  let timer = null, running = false;

  async function deliver(n) {
    const t = tr[n.channel];
    try {
      await t.send(n);
      db.run(`UPDATE notifications SET status='sent', sent_at=?, attempts=attempts+1, error=NULL WHERE id=?`, now(), n.id);
    } catch (e) {
      const attempts = n.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      db.run(`UPDATE notifications SET status=?, attempts=?, next_attempt_at=?, error=? WHERE id=?`,
        dead ? 'failed' : 'queued', attempts, new Date(Date.now() + backoffMs(attempts)).toISOString(), String(e.message || e).slice(0, 500), n.id);
      log.warn('notification ' + n.id + ' (' + n.channel + ' ' + n.template + ') attempt ' + attempts + ' failed: ' + (e.message || e));
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const due = db.all(`SELECT * FROM notifications WHERE status='queued' AND next_attempt_at <= ? ORDER BY created_at LIMIT 25`, now());
      for (const n of due) await deliver(n);
    } finally { running = false; }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { tick().catch((e) => log.error('outbox: ' + e.message)); }, cfg.outboxIntervalMs || 3000);
    if (timer.unref) timer.unref();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  /* Owner's "send again" — resets the row so the next tick picks it up. */
  function retry(id) {
    return db.run(`UPDATE notifications SET status='queued', next_attempt_at=?, error=NULL WHERE id=? AND status IN ('failed','queued','sent')`, now(), id).changes;
  }

  return { enqueue, start, stop, tick, retry, transports: { email: tr.email.name, whatsapp: tr.whatsapp.name } };
}

module.exports = { create };
