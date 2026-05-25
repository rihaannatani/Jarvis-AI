'use strict';
// Must be first — loads .env
const config = require('./config');
const logger = require('./logger');

async function main() {
  logger.info('=== Jarvis starting up ===');

  // Initialize database
  require('./state');
  logger.info('[main] Database initialized');

  // Start Telegram bot
  const bot = require('./bot');
  bot.init();

  // Start scheduler (cron jobs)
  const scheduler = require('./scheduler');
  scheduler.init();

  logger.info('[main] Jarvis is online and ready');

  process.on('SIGINT', () => {
    logger.info('[main] Shutting down gracefully...');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.info('[main] SIGTERM received, shutting down...');
    process.exit(0);
  });

  process.on('uncaughtException', (err) => {
    logger.error('[main] Uncaught exception:', err);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('[main] Unhandled rejection:', reason);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
