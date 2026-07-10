'use strict';
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const config = require('./config');
const logger = require('./logger');
const claude = require('./claude');
const { handleDraftAction } = require('./features/draft-flow');
const scheduler = require('./scheduler');
const state = require('./state');
const { handleApply, handleConfirmApply, handleCancelApply, runWorkdayWatcher } = require('./features/workday-watcher');
const { processReceiptImage } = require('./features/receipt-scanner');
const { phoenixToday } = require('./date-utils');

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
  // Single save-point for every message this bot ever sends directly (draft
  // actions, receipt summaries, workday alerts, chat replies, task
  // confirmations) — without this, a follow-up question about anything the
  // bot "just said" outside a plain chat reply hits blank context, the same
  // bug the receipt-scanning thread showed.
  state.saveMessage(chatId, 'assistant', text);
}

function isAuthorized(chatId) {
  return String(chatId) === String(MY_CHAT_ID);
}

function formatTaskDue(dueDate) {
  if (!dueDate) return '';
  const d = new Date(dueDate.length <= 10 ? `${dueDate}T00:00:00` : dueDate);
  if (isNaN(d)) return '';
  const today = phoenixToday();
  const days = Math.round((d - today) / (1000 * 60 * 60 * 24));
  const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (days < 0) return ` — ⚠️ overdue (${dateStr})`;
  if (days === 0) return ` — due today`;
  if (days === 1) return ` — due tomorrow`;
  return ` — due ${dateStr}`;
}

function buildTasksView() {
  const tasks = state.listOpenTasks();
  if (!tasks.length) {
    return { text: "✅ No open tasks — you're all caught up.", keyboard: [] };
  }
  const lines = tasks.map((t, i) => `${i + 1}. ${t.content}${formatTaskDue(t.due_date)}`);
  const text = `*Open tasks:*\n${lines.join('\n')}\n\nTap ✅ to mark one done.`;
  const keyboard = tasks.map((t, i) => ([
    { text: `✅ ${i + 1}`, callback_data: `task_done_${t.id}` },
  ]));
  return { text, keyboard };
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

    } else if (data.startsWith('task_done_')) {
      const taskId = Number(data.slice('task_done_'.length));
      const task = state.getTask(taskId);
      await removeKeyboard();
      if (!task || task.done) {
        await sendSafe(bot, chatId, 'That task is already gone.');
        return;
      }
      state.completeTask(taskId);
      await sendSafe(bot, chatId, `✅ Done: ${task.content}`);
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

    if (!text) {
      // node-telegram-bot-api fires 'message' for every update type; photos
      // are handled by the dedicated 'photo' listener below, so anything
      // else with no text (documents, voice notes, videos, stickers) would
      // otherwise get silently dropped with zero feedback to the user.
      if (!msg.photo) {
        const kind = msg.document ? 'a file' : msg.voice ? 'a voice note' : msg.video ? 'a video'
          : msg.sticker ? 'a sticker' : msg.video_note ? 'a video note' : msg.audio ? 'audio' : 'that';
        await sendSafe(bot, chatId, `I can't do anything with ${kind} yet — text or a photo of a receipt works though.`).catch(() => {});
      }
      return;
    }

    logger.info(`[bot] Message from ${chatId}: ${text.slice(0, 80)}`);

    // Show typing indicator
    bot.sendChatAction(chatId, 'typing').catch(() => {});

    try {
      // ── Tasks: /tasks command ─────────────────────────────────────────────
      if (/^\/tasks\b/i.test(text)) {
        const { text: viewText, keyboard } = buildTasksView();
        if (keyboard.length) {
          await bot.sendMessage(chatId, viewText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
        } else {
          await sendSafe(bot, chatId, viewText);
        }
        return;
      }

      // Check if this is a draft approval action first
      const handled = await handleDraftAction(chatId, text, (t) => sendSafe(bot, chatId, t));
      if (handled) return;

      // ── Workday: job scan/apply commands (disabled — see config.workday.enabled) ──
      if (config.workday.enabled) {
        // Apply command (generates cover letters for review only)
        if (/^apply\s+(all|\d[\d,\s]*)$/i.test(text)) {
          const arg = text.replace(/^apply\s+/i, '').trim();
          const indices = arg.toLowerCase() === 'all'
            ? 'all'
            : arg.split(',').map((n) => parseInt(n.trim()) - 1).filter((n) => !isNaN(n));
          await handleApply(indices, (t) => sendSafe(bot, chatId, t));
          return;
        }

        // Confirm/cancel the actual submission
        if (/^confirm\s+apply$/i.test(text)) {
          await handleConfirmApply((t) => sendSafe(bot, chatId, t));
          return;
        }
        if (/^cancel\s+apply$/i.test(text)) {
          await handleCancelApply((t) => sendSafe(bot, chatId, t));
          return;
        }

        // Manual scan trigger
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
      }

      // Otherwise route to Claude
      const response = await claude.chat(chatId, text);
      await sendSafe(bot, chatId, response);
    } catch (err) {
      logger.error('[bot] Message handling error:', err);
      await sendSafe(bot, chatId, "I hit a snag. Give it another shot.");
    }
  });

  // ── Photo handler — receipt scanning ──────────────────────────────────────
  bot.on('photo', async (msg) => {
    const chatId = String(msg.chat.id);
    if (!isAuthorized(chatId)) return;

    bot.sendChatAction(chatId, 'typing').catch(() => {});

    try {
      const photo = msg.photo[msg.photo.length - 1];
      const file = await bot.getFile(photo.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
      const dlResponse = await axios.get(fileUrl, { responseType: 'arraybuffer' });
      const base64Image = Buffer.from(dlResponse.data).toString('base64');
      const caption = msg.caption || '';

      // Record the user's turn now — Telegram photos never pass through the
      // text handler, so this is the only place it'd otherwise be captured.
      // The assistant's summary is saved automatically inside sendSafe().
      state.saveMessage(chatId, 'user', caption ? `[sent a photo of a receipt] ${caption}` : '[sent a photo of a receipt]');

      await sendSafe(bot, chatId, '🔍 Scanning receipt...');
      const { summary } = await processReceiptImage(base64Image, caption);
      await sendSafe(bot, chatId, summary);
    } catch (err) {
      logger.error('[bot] Photo handler error:', err.message);
      await sendSafe(bot, chatId, "Couldn't scan that image. Make sure it's a clear photo of a receipt and try again.");
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
