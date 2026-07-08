'use strict';
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const config = require('./config');

const ACCOUNT_TOKEN_PATHS = {
  personal: './data/google-token-personal.json',
  asu: './data/google-token-asu.json',
};

function checkGoogleToken(account, tokenPath) {
  const resolved = path.resolve(process.cwd(), tokenPath);
  if (!fs.existsSync(resolved)) {
    if (account === 'personal') {
      const legacy = path.resolve(process.cwd(), config.google.tokenPath);
      if (fs.existsSync(legacy)) return checkGoogleTokenFile(account, legacy);
    }
    logger.warn(`[startup-check] No Google token found for '${account}' account — run \`npm run setup\` to authorize it.`);
    return;
  }
  checkGoogleTokenFile(account, resolved);
}

function checkGoogleTokenFile(account, resolved) {
  try {
    const token = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    if (!token.refresh_token) {
      logger.warn(`[startup-check] Google token for '${account}' has no refresh_token — re-run \`npm run setup\`.`);
      return;
    }
    // Testing-mode OAuth apps report refresh_token_expires_in (~7 days).
    // Best-effort staleness check since we don't track the token's issue date directly.
    if (token.refresh_token_expires_in && token.expiry_date) {
      const accessTokenIssuedAt = token.expiry_date - 3600 * 1000; // access tokens last ~1h
      const refreshExpiresAt = accessTokenIssuedAt + token.refresh_token_expires_in * 1000;
      const daysLeft = (refreshExpiresAt - Date.now()) / (24 * 60 * 60 * 1000);
      if (daysLeft <= 0) {
        logger.error(
          `[startup-check] Google refresh token for '${account}' has expired (Testing-mode apps expire refresh tokens after ~7 days). ` +
          'Run `npm run setup` to re-authorize. Consider publishing the OAuth consent screen to Production to avoid this recurring.'
        );
      } else if (daysLeft <= 2) {
        logger.warn(`[startup-check] Google refresh token for '${account}' expires in ~${daysLeft.toFixed(1)} days — re-run \`npm run setup\` soon.`);
      }
    }
  } catch (err) {
    logger.warn(`[startup-check] Could not parse Google token for '${account}': ${err.message}`);
  }
}

function checkCanvasToken() {
  if (!config.canvas.apiToken || !config.canvas.baseUrl) {
    logger.warn('[startup-check] CANVAS_API_TOKEN or CANVAS_BASE_URL is not set — Canvas features will be disabled.');
  }
}

function run() {
  checkGoogleToken('personal', ACCOUNT_TOKEN_PATHS.personal);
  checkGoogleToken('asu', ACCOUNT_TOKEN_PATHS.asu);
  checkCanvasToken();
}

module.exports = { run };
