'use strict';
const cron = require('node-cron');
const logger = require('./logger');
const config = require('./config');

let bot = null;

function setBotInstance(botInstance) {
  bot = botInstance;
}

function safeSend(chatId, text) {
  if (!bot) return Promise.resolve();
  return sendSplit(chatId, text);
}

async function sendSplit(chatId, text) {
  const MAX = 3000;
  if (text.length <= MAX) {
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    return;
  }
  const chunks = [];
  let current = '';
  for (const para of text.split('\n\n')) {
    if ((current + '\n\n' + para).length > MAX && current) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + '\n\n' + para : para;
    }
  }
  if (current) chunks.push(current.trim());
  for (const chunk of chunks) {
    await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
  }
}

function init() {
  const chatId = config.telegram.myChatId;
  const TZ = 'America/Phoenix';
  let jobCount = 0;

  // Morning brief — 7:00 AM Phoenix time
  cron.schedule('0 7 * * *', async () => {
    logger.info('[scheduler] Firing morning brief');
    try {
      const { assembleMorningBrief } = require('./features/morning-brief');
      const brief = await assembleMorningBrief();
      await safeSend(chatId, brief);
    } catch (err) {
      logger.error('[scheduler] Morning brief failed:', err.message);
    }
  }, { timezone: TZ });
  jobCount++;

  // Night brief — 10:00 PM Phoenix time
  cron.schedule('0 22 * * *', async () => {
    logger.info('[scheduler] Firing night brief');
    try {
      const { assembleNightBrief } = require('./features/night-brief');
      const brief = await assembleNightBrief();
      await safeSend(chatId, brief);
    } catch (err) {
      logger.error('[scheduler] Night brief failed:', err.message);
    }
  }, { timezone: TZ });
  jobCount++;

  // Email watcher — every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    logger.debug('[scheduler] Checking emails');
    try {
      const { checkNewEmails } = require('./features/email-watcher');
      await checkNewEmails((text) => safeSend(chatId, text));
    } catch (err) {
      logger.error('[scheduler] Email watcher failed:', err.message);
    }
  }, { timezone: TZ });
  jobCount++;

  // Canvas watcher — every 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    logger.debug('[scheduler] Running Canvas watcher');
    try {
      const { runCanvasWatcher } = require('./features/canvas-watcher');
      await runCanvasWatcher((text) => safeSend(chatId, text));
    } catch (err) {
      logger.error('[scheduler] Canvas watcher failed:', err.message);
    }
  }, { timezone: TZ });
  jobCount++;

  // Reminders + calendar alerts — every minute
  cron.schedule('* * * * *', async () => {
    try {
      const { checkReminders, checkCalendarReminders } = require('./features/reminders');
      await checkReminders((cid, text) => safeSend(cid, text));
      await checkCalendarReminders((cid, text) => safeSend(cid, text));
    } catch (err) {
      logger.error('[scheduler] Reminder check failed:', err.message);
    }
  }, { timezone: TZ });
  jobCount++;

  // Assignment deadline reminders — every 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    try {
      const { checkAssignmentReminders } = require('./features/reminders');
      await checkAssignmentReminders((cid, text) => safeSend(cid, text));
    } catch (err) {
      logger.error('[scheduler] Assignment reminder check failed:', err.message);
    }
  }, { timezone: TZ });
  jobCount++;

  logger.info(`[scheduler] Initialized — ${jobCount} jobs active (timezone: ${TZ})`);

  // Seed Canvas watcher on startup (populates DB silently, no alerts)
  setImmediate(async () => {
    try {
      const { runCanvasWatcher } = require('./features/canvas-watcher');
      await runCanvasWatcher(null); // null sendFn = silent seed
    } catch (err) {
      logger.warn('[scheduler] Canvas seed run failed:', err.message);
    }
  });
}

module.exports = { init, setBotInstance, sendSplit };
