'use strict';
const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const logger = require('./logger');
const claude = require('./claude');
const { handleDraftAction } = require('./features/draft-flow');
const scheduler = require('./scheduler');
const state = require('./state');
const { handleApply, runWorkdayWatcher } = require('./features/workday-watcher');

const MY_CHAT_ID = config.telegram.myChatId;

function splitMessage(text, maxLen = 3000) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let current = '';
  for (const para of text.split('\n\n')) {
    if ((current + '\n\n' + para).length > maxLen && current) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + '\n\n' + para : para;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks;
}

async function sendSafe(bot, chatId, text) {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    try {
      await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
    } catch (err) {
      // Markdown parse failed — retry as plain text
      try {
        await bot.sendMessage(chatId, chunk);
      } catch (err2) {
        // Retry once after 5s on network failure
        await new Promise((r) => setTimeout(r, 5000));
        await bot.sendMessage(chatId, chunk).catch(() => {});
      }
    }
  }
}

function isAuthorized(chatId) {
  return String(chatId) === String(MY_CHAT_ID);
}

function init() {
  const bot = new TelegramBot(config.telegram.botToken, { polling: true });

  scheduler.setBotInstance(bot);

  // ── Inline button callback handler ────────────────────────────────────────
  bot.on('callback_query', async (query) => {
    const chatId = String(query.message.chat.id);
    if (!isAuthorized(chatId)) return;

    const data = query.data;
    await bot.answerCallbackQuery(query.id);

    const removeKeyboard = () =>
      bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
        chat_id: chatId,
        message_id: query.message.message_id,
      }).catch(() => {});

    if (data === 'workday_apply_all') {
      await removeKeyboard();
      await handleApply('all', (t) => sendSafe(bot, chatId, t));

    } else if (data === 'workday_pick') {
      await removeKeyboard();
      await sendSafe(bot, chatId,
        'Reply with the job numbers you want, e.g.:\n`apply 1,3`\n\nor `apply all` for everything.'
      );

    } else if (data === 'workday_skip_all') {
      await removeKeyboard();
      await sendSafe(bot, chatId, "👍 Skipped. I'll check again in 2 hours.");
      state.setSetting('workday_pending_jobs', '');
    }
  });

  bot.on('message', async (msg) => {
    const chatId = String(msg.chat.id);
    const text = msg.text?.trim();

    if (!isAuthorized(chatId)) {
      logger.warn(`[bot] Unauthorized message from chat ${chatId}`);
      await bot.sendMessage(chatId, "Sorry, I'm a private assistant.").catch(() => {});
      return;
    }

    if (!text) return;

    logger.info(`[bot] Message from ${chatId}: ${text.slice(0, 80)}`);

    // Show typing indicator
    bot.sendChatAction(chatId, 'typing').catch(() => {});

    try {
      // Check if this is a draft approval action first
      const handled = await handleDraftAction(chatId, text, (t) => sendSafe(bot, chatId, t));
      if (handled) return;

      // ── Workday: apply command ────────────────────────────────────────────
      if (/^apply\s+(all|\d[\d,\s]*)$/i.test(text)) {
        const arg = text.replace(/^apply\s+/i, '').trim();
        const indices = arg.toLowerCase() === 'all'
          ? 'all'
          : arg.split(',').map((n) => parseInt(n.trim()) - 1).filter((n) => !isNaN(n));
        await handleApply(indices, (t) => sendSafe(bot, chatId, t));
        return;
      }

      // ── Workday: manual scan trigger ──────────────────────────────────────
      if (/^(scan jobs|check jobs|workday)$/i.test(text)) {
        await sendSafe(bot, chatId, '🔍 Scanning ASU Workday for new jobs...');
        await runWorkdayWatcher(
          (t) => sendSafe(bot, chatId, t),
          (t, buttons) => bot.sendMessage(chatId, t, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons },
          })
        );
        return;
      }

      // Otherwise route to Claude
      const response = await claude.chat(chatId, text);
      await sendSafe(bot, chatId, response);
    } catch (err) {
      logger.error('[bot] Message handling error:', err);
      await sendSafe(bot, chatId, "I hit a snag. Give it another shot.");
    }
  });

  bot.on('polling_error', (err) => {
    const body = err.response?.body;
    const detail = body ? JSON.stringify(body) : err.message;
    logger.error(`[bot] Polling error (${err.code || 'unknown'}): ${detail}`);
  });

  bot.on('error', (err) => {
    logger.error('[bot] Bot error:', err.message);
  });

  // Validate token on startup
  bot.getMe().then((me) => {
    logger.info(`[bot] Connected as @${me.username} (${me.first_name})`);
  }).catch((err) => {
    logger.error('[bot] Token validation failed — check TELEGRAM_BOT_TOKEN in .env:', err.message);
  });

  logger.info('[bot] Telegram bot started (polling)');
  return bot;
}

module.exports = { init };
