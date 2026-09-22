#!/usr/bin/env node
/* =============================================================================
   api/server.js — run the A1 Opticals API (and serve the site with it)
   -----------------------------------------------------------------------------
     node api/server.js            → http://localhost:8787  (site + /api)
     PORT=9000 node api/server.js

   Environment (see README.md): A1_DB, A1_SITE_URL, A1_ORIGINS, A1_OWNER_EMAIL,
   A1_OWNER_PASSWORD, A1_SECRET, GATEWAY=stub|razorpay, RAZORPAY_KEY_ID,
   RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET, EMAIL_TRANSPORT=log|resend,
   RESEND_API_KEY, MAIL_FROM, WHATSAPP_WEBHOOK_URL, WHATSAPP_TOKEN.
   ========================================================================== */
'use strict';

const { createApp } = require('./app.js');

const app = createApp();
app.listen().then((port) => {
  const c = app.cfg;
  console.log('A1 Opticals API listening on http://localhost:' + port + (c.serveStatic ? '  (serving the site too)' : ''));
  console.log('  database  ' + c.db);
  console.log('  gateway   ' + app.gateway.name + (app.gateway.stub ? '  — STUB: no real money moves; set GATEWAY=razorpay with keys to go live' : ''));
  console.log('  email     ' + app.notify.transports.email + '   whatsapp ' + app.notify.transports.whatsapp + (app.notify.transports.email === 'log' ? '  — messages are printed here and shown in the dashboard outbox' : ''));
  if (c.ownerPassword === 'a1trade') console.log('  owner     ' + c.ownerEmail + ' / a1trade  — DEFAULT PASSWORD: set A1_OWNER_PASSWORD before this faces the internet');
  if (!process.env.A1_SECRET) console.log('  secret    random for this run (set A1_SECRET so sessions survive a restart)');
});

function shutdown() { app.close().then(() => process.exit(0)); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
