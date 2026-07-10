'use strict';
// Receives location/motion events pushed from a phone-side automation
// (Tasker on Android, Shortcuts on iPhone) — Jarvis has no way to poll a
// phone's GPS itself, so the phone does the geofencing/motion detection and
// tells us when something relevant happens. See README for Tasker setup.
const http = require('http');
const crypto = require('crypto');
const logger = require('./logger');
const config = require('./config');
const state = require('./state');

const VALID_EVENTS = ['arrived', 'left', 'driving_start', 'driving_stop'];
const MAX_BODY_BYTES = 10_000;

let sendFn = null;

function setSendFn(fn) {
  sendFn = fn;
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

async function handleLocationEvent(event, place) {
  if (!sendFn) {
    logger.warn('[webhook] Location event received but no sendFn configured — dropping');
    return { matched: 0 };
  }
  const chatId = config.telegram.myChatId;
  const matches = state.getPendingLocationReminders(event, place);
  for (const r of matches) {
    await sendFn(chatId, `📍 ${r.message}`);
    state.markLocationReminderFired(r.id);
    logger.info(`[webhook] Fired location reminder #${r.id}: "${r.message}" (${event}${place ? ` @ ${place}` : ''})`);
  }
  return { matched: matches.length };
}

function init() {
  if (!config.webhook.enabled) {
    logger.info('[webhook] Disabled (WEBHOOK_ENABLED not set) — not starting HTTP server');
    return null;
  }
  if (!config.webhook.secret) {
    logger.error('[webhook] WEBHOOK_ENABLED is true but WEBHOOK_SECRET is not set — refusing to start (would accept unauthenticated requests)');
    return null;
  }

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/webhook/location') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    let body = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        tooLarge = true;
        req.destroy();
      }
    });

    req.on('end', async () => {
      if (tooLarge) return; // connection already destroyed
      try {
        const data = JSON.parse(body || '{}');

        if (!timingSafeEqual(data.secret, config.webhook.secret)) {
          logger.warn('[webhook] Rejected request with invalid secret');
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }

        const event = String(data.event || '').toLowerCase().trim();
        const place = data.place ? String(data.place).toLowerCase().trim() : null;

        if (!VALID_EVENTS.includes(event)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `event must be one of: ${VALID_EVENTS.join(', ')}` }));
          return;
        }

        logger.info(`[webhook] Location event: ${event}${place ? ` @ ${place}` : ''}`);
        const result = await handleLocationEvent(event, place);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (err) {
        logger.error('[webhook] Error handling request:', err.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad request' }));
      }
    });
  });

  server.on('error', (err) => {
    logger.error('[webhook] Server error:', err.message);
  });

  server.listen(config.app.port, () => {
    logger.info(`[webhook] Listening on port ${config.app.port} (POST /webhook/location)`);
  });

  return server;
}

module.exports = { init, setSendFn, handleLocationEvent };
