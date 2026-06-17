'use strict';
const logger = require('../logger');
const state = require('../state');

let sendAlertFn = null;

function setSendAlert(fn) {
  sendAlertFn = fn;
}

async function sendAlert(text) {
  if (!sendAlertFn) {
    logger.warn('[expiry-checker] No sendAlert function set — skipping alert');
    return;
  }
  await sendAlertFn(text);
}

function formatDate(isoDate) {
  const d = new Date(isoDate + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

async function checkExpiries() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const items = state.getActivePantryItems();
  if (!items.length) return;

  for (const item of items) {
    if (!item.expiry_date) continue;

    const expiry = new Date(item.expiry_date + 'T00:00:00');
    const daysUntilExpiry = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));

    if (daysUntilExpiry < 0) {
      if (!state.isExpiryAlertSent(item.id, 'expired')) {
        const daysAgo = Math.abs(daysUntilExpiry);
        await sendAlert(
          `⚠️ *${item.name} has expired* (${daysAgo} day${daysAgo !== 1 ? 's' : ''} ago)\n` +
          `It was in your ${item.storage_location || 'storage'}. Time to toss it.`
        );
        state.markExpiryAlertSent(item.id, 'expired');
      }
      continue;
    }

    if (daysUntilExpiry === 7) {
      if (!state.isExpiryAlertSent(item.id, 'week_warning')) {
        await sendAlert(
          `📅 *Use within a week: ${item.name}*\n` +
          `Expires: ${formatDate(item.expiry_date)} (7 days)\n` +
          `Location: ${item.storage_location || 'unknown'}` +
          (item.notes ? `\n${item.notes}` : '')
        );
        state.markExpiryAlertSent(item.id, 'week_warning');
      }
    }

    if (daysUntilExpiry <= 1) {
      if (!state.isExpiryAlertSent(item.id, 'last_day')) {
        await sendAlert(
          `🚨 *Use TODAY: ${item.name}*\n` +
          `Expires ${daysUntilExpiry === 0 ? 'today' : 'tomorrow'}!\n` +
          `Location: ${item.storage_location || 'unknown'}`
        );
        state.markExpiryAlertSent(item.id, 'last_day');
      }
    }
  }
}

module.exports = { checkExpiries, setSendAlert };
