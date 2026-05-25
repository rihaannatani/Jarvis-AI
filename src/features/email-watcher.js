'use strict';
const logger = require('../logger');
const claude = require('../claude');
const state = require('../state');
const config = require('../config');
const { getRecentEmails } = require('../integrations/gmail');
const { hasToken } = require('../integrations/calendar');
const { draftReplyPrompt } = require('../prompts/email');

// Lowered from 6 — a plain direct email from a real person scores 6 now
const IMPORTANCE_THRESHOLD = 5;

function scoreEmail(email) {
  let score = 3; // base
  const subject = (email.subject || '').toLowerCase();
  const from = (email.from || '').toLowerCase();
  const reasons = [];

  // Automated/bulk sender signals (lower score)
  const isAutomated =
    from.includes('noreply') ||
    from.includes('no-reply') ||
    from.includes('donotreply') ||
    from.includes('notifications@') ||
    from.includes('mailer@') ||
    from.includes('bounce');
  if (isAutomated) {
    score -= 2;
    reasons.push('-2 automated sender');
  }
  if (email.labelIds?.includes('CATEGORY_PROMOTIONS')) { score -= 3; reasons.push('-3 promotions'); }
  if (email.labelIds?.includes('CATEGORY_SOCIAL'))     { score -= 2; reasons.push('-2 social'); }
  if (email.labelIds?.includes('CATEGORY_UPDATES'))    { score -= 1; reasons.push('-1 updates'); }

  // Real person signal
  if (!isAutomated) { score += 1; reasons.push('+1 real person'); }

  // Landed in INBOX proper (not a bulk category)
  if (email.labelIds?.includes('INBOX') && !email.labelIds?.includes('CATEGORY_PROMOTIONS')) {
    score += 2;
    reasons.push('+2 in inbox');
  }

  // Thread participation
  if (subject.startsWith('re:') || subject.startsWith('fwd:')) { score += 1; reasons.push('+1 thread reply'); }

  // Urgency keywords in subject
  const urgentWords = [
    'urgent', 'asap', 'deadline', 'important', 'action required',
    'time-sensitive', 'overdue', 'final notice', 'critical',
    'respond', 'response needed', 'please reply', 'follow up',
    'follow-up', 'reminder', 'expir',
  ];
  const matched = urgentWords.filter((w) => subject.includes(w));
  if (matched.length) { score += 3; reasons.push(`+3 urgent keyword (${matched[0]})`); }

  // Educational/institutional senders
  if (from.includes('.edu') || from.includes('asu.edu')) { score += 2; reasons.push('+2 .edu sender'); }
  if (from.includes('canvas')) { score += 1; reasons.push('+1 canvas'); }

  const final = Math.min(10, Math.max(1, score));
  return { score: final, reasons };
}

async function checkNewEmails(sendAlertFn) {
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

  // Always update last-check timestamp regardless of results
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

  logger.info(`[email-watcher] ${newEmails.length} unseen email(s) to score (${allEmails.length - newEmails.length} already seen)`);

  if (!newEmails.length) return;

  // Score and log every email
  const scoredEmails = newEmails.map((e) => {
    const { score, reasons } = scoreEmail(e);
    const action = score >= IMPORTANCE_THRESHOLD ? 'ALERT' : 'skip';
    logger.info(
      `[email-watcher] [${action}] score=${score} "${e.subject}" from ${e.from} (${e.account}) | ${reasons.join(', ')}`
    );
    return { ...e, score, needsDraft: score >= IMPORTANCE_THRESHOLD };
  });

  // Mark all as seen before alerting (prevents duplicate alerts on retry)
  newEmails.forEach((e) => state.markEmailSeen(e.id));

  const importantEmails = scoredEmails.filter((e) => e.score >= IMPORTANCE_THRESHOLD);
  logger.info(
    `[email-watcher] ${importantEmails.length}/${scoredEmails.length} email(s) exceeded threshold (${IMPORTANCE_THRESHOLD})`
  );

  for (const email of importantEmails) {
    try {
      logger.info(`[email-watcher] Sending alert for: "${email.subject}"`);
      await processImportantEmail(email, sendAlertFn);
    } catch (err) {
      logger.error(`[email-watcher] Failed to process email ${email.id}:`, err.message);
    }
  }
}

async function processImportantEmail(email, sendAlertFn) {
  const chatId = config.telegram.myChatId;
  const preview = email.snippet || '(no preview)';
  const accountTag = email.account === 'asu' ? ' (ASU)' : ' (Personal)';

  const alert =
    `📧 *New email${accountTag}*\n` +
    `*From:* ${email.from}\n` +
    `*Subject:* ${email.subject}\n\n` +
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

  const draftText = await claude.complete(draftReplyPrompt({ originalEmail: fullEmail }));

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
