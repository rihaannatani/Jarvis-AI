'use strict';
// Must be first — loads .env
const config = require('./config');
const logger = require('./logger');
const fs = require('fs');
const path = require('path');

const LOCK_PATH = path.resolve(process.cwd(), 'data', 'jarvis.lock');

// Guards against two instances polling Telegram at once (seen historically as
// repeated ETELEGRAM 409 "Conflict: terminated by other getUpdates request" errors,
// which also double-fires every cron job against Google/Canvas).
function acquireSingleInstanceLock() {
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  if (fs.existsSync(LOCK_PATH)) {
    const oldPid = Number(fs.readFileSync(LOCK_PATH, 'utf8').trim());
    const stillRunning = oldPid && isPidAlive(oldPid);
    if (stillRunning) {
      logger.error(`[main] Another Jarvis instance appears to be running (pid ${oldPid}). Exiting to avoid duplicate polling/cron jobs.`);
      process.exit(1);
    }
    logger.warn(`[main] Found stale lock file for pid ${oldPid} (not running) — taking over.`);
  }
  fs.writeFileSync(LOCK_PATH, String(process.pid));
  const releaseLock = () => { try { fs.unlinkSync(LOCK_PATH); } catch { /* already gone */ } };
  process.on('exit', releaseLock);
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  logger.info('=== Jarvis starting up ===');

  acquireSingleInstanceLock();

  // Initialize database
  require('./state');
  logger.info('[main] Database initialized');

  // Warn (non-fatal) about missing/expiring Google + Canvas credentials
  require('./startup-check').run();

  // Start Telegram bot
  const bot = require('./bot');
  bot.init();

  // Start scheduler (cron jobs)
  const scheduler = require('./scheduler');
  scheduler.init();

  // Start webhook server (disabled unless WEBHOOK_ENABLED=true) — receives
  // location/motion events pushed from a phone-side automation.
  const webhookServer = require('./webhook-server');
  webhookServer.setSendFn(scheduler.safeSend);
  webhookServer.init();

  logger.info('[main] Jarvis is online and ready');

  process.on('SIGINT', () => {
    logger.info('[main] Shutting down gracefully...');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.info('[main] SIGTERM received, shutting down...');
    process.exit(0);
  });

  // After an uncaught exception the process is in an unknown state — log it
  // and exit so PM2 restarts clean, rather than limping along and risking
  // silent data corruption or a stuck bot. unhandledRejection is logged only
  // (not fatal), since a single rejected promise from e.g. a stray fetch is
  // usually recoverable and shouldn't take the whole assistant down.
  process.on('uncaughtException', (err) => {
    logger.error('[main] Uncaught exception — exiting for a clean restart:', err);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('[main] Unhandled rejection:', reason);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
