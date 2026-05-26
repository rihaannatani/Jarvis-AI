'use strict';
const logger = require('../logger');
const { complete, quickComplete } = require('../claude');
const state = require('../state');
const config = require('../config');
const { getRecentEmails } = require('../integrations/gmail');
const { hasToken } = require('../integrations/calendar');
const { draftReplyPrompt } = require('../prompts/email');

const IMPORTANCE_THRESHOLD = 7;

// Domains that are always noise — skip Claude scoring entirely
const NOISE_DOMAINS = [
  'nextdoor.com', 'ubereats.com', 'uber.com', 'devpost.com',
  'rocketmoney.com', 'everydaydose.com', 'openweathermap.org',
];

// Automated sender patterns — skip Claude scoring
const AUTOMATED_PATTERNS = [
  'noreply', 'no-reply', 'donotreply', 'notifications@', 'mailer@', 'bounce',
];

function fromAddress(email) {
  // "Display Name <addr@domain.com>" → "addr@domain.com", or raw string
  const m = (email.from || '').match(/<([^>]+)>/);
  return (m ? m[1] : email.from || '').toLowerCase().trim();
}

function isMySelf(email) {
  const from = fromAddress(email);
  return config.myEmails.some((mine) => from.includes(mine));
}

function isNoiseSender(email) {
  const from = (email.from || '').toLowerCase();
  if (NOISE_DOMAINS.some((d) => from.includes(d))) return true;
  if (AUTOMATED_PATTERNS.some((p) => from.includes(p))) return true;
  if (email.labelIds?.includes('CATEGORY_PROMOTIONS')) return true;
  return false;
}

function isCcOnly(email) {
  if (!email.cc) return false;
  const to = (email.to || '').toLowerCase();
  const cc = (email.cc || '').toLowerCase();
  // If none of my addresses appear in To but at least one appears in Cc
  const inTo = config.myEmails.some((mine) => to.includes(mine));
  const inCc = config.myEmails.some((mine) => cc.includes(mine));
  return !inTo && inCc;
}

async function scoreEmailWithClaude(email) {
  const memories = state.getActiveMemories();
  const ccOnly = isCcOnly(email);

  const prompt =
    `You are scoring an email for importance to Rihaan Natani, a CS student at ASU.\n` +
    (memories ? `Here is what you know about him:${memories}\n\n` : '') +
    `Email details:\n` +
    `From: ${email.from}\n` +
    `To: ${email.to || '(unknown)'}\n` +
    `CC: ${email.cc || '(none)'}\n` +
    `Subject: ${email.subject}\n` +
    `Preview: ${email.snippet || '(none)'}\n\n` +
    `Score this email 1-10 for how important it is for Rihaan to be immediately notified about. Consider:\n` +
    `- Is this directly addressed to him (not just CC'd)? ${ccOnly ? '(Note: Rihaan is only CC\'d on this email)' : ''}\n` +
    `- Is it from someone he knows or an institution he\'s part of (ASU, professors)?\n` +
    `- Does it require action or a response?\n` +
    `- Is it time sensitive?\n` +
    `- Is it a newsletter, automated notification, or marketing? (score low)\n` +
    `- Does it relate to anything in his current context (assignments, jobs, people)?\n\n` +
    `Reply with ONLY a JSON object: {"score": 8, "reason": "Professor emailing directly about assignment"}`;

  try {
    const raw = await quickComplete(prompt, { maxTokens: 150, purpose: 'email-scoring' });
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found in response');
    const parsed = JSON.parse(match[0]);
    const score = Math.min(10, Math.max(1, Number(parsed.score) || 1));
    return { score, reason: parsed.reason || '' };
  } catch (err) {
    logger.warn(`[email-watcher] Claude scoring failed for "${email.subject}":`, err.message);
    return null;
  }
}

async function checkNewEmails(sendAlertFn) {
  if (!sendAlertFn) {
    logger.warn('[email-watcher] No sendAlertFn provided — alerts will be logged only');
    sendAlertFn = (msg) => { logger.info('[email-watcher] ALERT (no send fn):', msg.slice(0, 120)); return Promise.resolve(); };
  }

  // 24-hour fallback so nothing slips through after a restart
  const lastCheck = state.getSetting('last_email_check');
  const sinceTimestamp = lastCheck
    ? parseInt(lastCheck, 10)
    : Date.now() - 24 * 60 * 60 * 1000;
  const now = Date.now();

  logger.info(
    `[email-watcher] Starting check — looking back to ${new Date(sinceTimestamp).toLocaleString('en-US', { timeZone: 'America/Phoenix' })}`
  );

  // Fetch each account separately so we can log clearly
  const accounts = ['personal', 'asu'].filter(hasToken);
  const allEmails = [];

  for (const account of accounts) {
    logger.info(`[email-watcher] Checking ${account} inbox...`);
    try {
      const emails = await getRecentEmails(sinceTimestamp, account);
      logger.info(`[email-watcher] ${account}: fetched ${emails.length} email(s)`);
      allEmails.push(...emails);
    } catch (err) {
      logger.error(`[email-watcher] ${account}: fetch failed — ${err.message}`);
    }
  }

  state.setSetting('last_email_check', String(now));

  if (!allEmails.length) {
    logger.info('[email-watcher] No emails found in any inbox');
    return;
  }

  // Filter already-seen
  const newEmails = allEmails.filter((e) => {
    if (state.isEmailSeen(e.id)) {
      logger.debug(`[email-watcher] Skip (already seen): "${e.subject}" from ${e.from}`);
      return false;
    }
    return true;
  });

  logger.info(`[email-watcher] ${newEmails.length} unseen email(s) to process (${allEmails.length - newEmails.length} already seen)`);

  if (!newEmails.length) return;

  // Pre-filter: skip emails I sent and obvious noise before calling Claude
  const toScore = [];
  for (const email of newEmails) {
    if (isMySelf(email)) {
      logger.info(`[email-watcher] Skip (self): "${email.subject}"`);
      state.markEmailSeen(email.id);
      continue;
    }
    if (isNoiseSender(email)) {
      logger.info(`[email-watcher] Skip (noise): "${email.subject}" from ${email.from}`);
      state.markEmailSeen(email.id);
      continue;
    }
    toScore.push(email);
  }

  logger.info(`[email-watcher] ${toScore.length}/${newEmails.length} email(s) passed pre-filter — sending to Claude`);

  if (!toScore.length) return;

  // Score surviving emails with Claude (sequentially to avoid rate limits)
  const importantEmails = [];
  for (const email of toScore) {
    const result = await scoreEmailWithClaude(email);
    const ccOnly = isCcOnly(email);
    const score = result?.score ?? 0;
    const reason = result?.reason ?? 'scoring unavailable';
    const ccTag = ccOnly ? ' [CC only]' : '';
    const action = score >= IMPORTANCE_THRESHOLD ? 'ALERT' : 'skip';

    logger.info(
      `[email-watcher] [${action}] score=${score}${ccTag} "${email.subject}" from ${email.from} (${email.account}) | ${reason}`
    );

    state.markEmailSeen(email.id);

    if (score >= IMPORTANCE_THRESHOLD) {
      importantEmails.push({ ...email, score, reason, needsDraft: true });
    }
  }

  logger.info(
    `[email-watcher] ${importantEmails.length}/${toScore.length} email(s) exceeded threshold (${IMPORTANCE_THRESHOLD})`
  );

  for (const email of importantEmails) {
    try {
      logger.info(`[email-watcher] Sending alert for: "${email.subject}"`);
      await processImportantEmail(email, sendAlertFn);
    } catch (err) {
      logger.error(`[email-watcher] Failed to process email ${email.id}:`, err.message, err.stack);
    }
  }
}

async function processImportantEmail(email, sendAlertFn) {
  const chatId = config.telegram.myChatId;
  const preview = email.snippet || '(no preview)';
  const accountTag = email.account === 'asu' ? ' (ASU)' : ' (Personal)';
  const ccTag = isCcOnly(email) ? ' · CC' : '';

  const alert =
    `📧 *New email${accountTag}${ccTag}*\n` +
    `*From:* ${email.from}\n` +
    `*Subject:* ${email.subject}\n` +
    `_${email.reason}_\n\n` +
    preview;
  await sendAlertFn(alert);

  if (!email.needsDraft) return;

  // Get full body for drafting
  let fullEmail = email;
  if (!email.body || email.body.length < 100) {
    try {
      const { getEmailContent } = require('../integrations/gmail');
      fullEmail = await getEmailContent(email.id, email.account || 'personal');
    } catch {
      fullEmail = email;
    }
  }

  const draftText = await complete(draftReplyPrompt({ originalEmail: fullEmail }), { maxTokens: 600, purpose: 'email-draft' });

  const draftId = state.saveDraft({
    chatId,
    emailId: email.id,
    threadId: email.threadId,
    toAddress: email.from,
    subject: `Re: ${email.subject}`,
    draftText,
    account: email.account || 'personal',
  });

  const draftMsg =
    `*Draft reply (ID: ${draftId}):*\n\n${draftText}\n\n` +
    `Reply with:\n• *approve* — send this reply\n• *edit: [changes]* — rewrite it\n• *discard* — skip`;
  await sendAlertFn(draftMsg);
  logger.info(`[email-watcher] Draft ${draftId} created for: "${email.subject}"`);
}

module.exports = { checkNewEmails };
