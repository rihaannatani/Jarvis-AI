'use strict';
const logger = require('../logger');
const state = require('../state');

// One alert per unique problem per 6h, so cron jobs firing every few minutes
// don't spam Telegram with the same "Google auth is broken" message.
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
let alertSendFn = null;

function setAlertSender(sendFn) {
  alertSendFn = sendFn;
}

function isAuthError(err) {
  const status = err?.response?.status || err?.code;
  const reason = err?.response?.data?.error || err?.response?.data?.error_description || '';
  const msg = err?.message || '';
  return (
    status === 401 || status === 403 ||
    /invalid_grant|invalid_token|unauthorized|Invalid Credentials/i.test(String(reason) + msg)
  );
}

function isRetryable(err) {
  const status = err?.response?.status;
  const code = err?.code;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN'].includes(code);
}

function retryDelayMs(err, attempt) {
  const retryAfter = err?.response?.headers?.['retry-after'];
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (!isNaN(secs)) return secs * 1000;
  }
  return Math.min(1000 * 2 ** attempt, 10000);
}

// Wraps an async API call with retry/backoff for transient errors (429/5xx/network),
// and fires a rate-limited Telegram alert the first time an auth error is seen for `key`.
async function withResilience(key, fn, { retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await fn();
      if (attempt > 0) logger.info(`[api-utils] ${key} succeeded after ${attempt} retr${attempt === 1 ? 'y' : 'ies'}`);
      return result;
    } catch (err) {
      lastErr = err;
      if (isAuthError(err)) {
        await maybeAlertAuthFailure(key, err);
        throw err;
      }
      if (attempt < retries && isRetryable(err)) {
        const delay = retryDelayMs(err, attempt);
        logger.warn(`[api-utils] ${key} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms:`, err.message);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function maybeAlertAuthFailure(key, err) {
  const settingKey = `auth_alert_${key}`;
  try {
    const last = Number(state.getSetting(settingKey) || 0);
    if (Date.now() - last < ALERT_COOLDOWN_MS) return;
    state.setSetting(settingKey, String(Date.now()));
  } catch (e) {
    logger.warn('[api-utils] Failed to read/write alert cooldown setting:', e.message);
  }

  logger.error(`[api-utils] Auth failure detected for ${key}:`, err.message);
  if (!alertSendFn) return;
  const detail = /invalid_grant/i.test(err.message || '')
    ? 'The refresh token expired or was revoked — you need to re-run `npm run setup` to re-authorize Google.'
    : 'Credentials look invalid or expired — check the relevant API token/OAuth setup.';
  try {
    await alertSendFn(
      `⚠️ *${key}* has been failing auth checks.\n${detail}`
    );
  } catch (e) {
    logger.warn('[api-utils] Failed to send auth failure alert:', e.message);
  }
}

module.exports = { withResilience, isAuthError, isRetryable, setAlertSender };
