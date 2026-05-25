'use strict';
const logger = require('../logger');
const claude = require('../claude');
const state = require('../state');
const config = require('../config');
const { getRecentEmailsAllAccounts, getEmailContent } = require('../integrations/gmail');
const { draftReplyPrompt, emailTriagePrompt } = require('../prompts/email');

const IMPORTANCE_THRESHOLD = 6;

function scoreEmail(email) {
  let score = 3;
  const subject = (email.subject || '').toLowerCase();
  const from = (email.from || '').toLowerCase();

  // Spam/newsletter signals (lower score)
  if (from.includes('noreply') || from.includes('no-reply') || from.includes('donotreply')) score -= 2;
  if (email.labelIds?.includes('CATEGORY_PROMOTIONS')) score -= 3;
  if (email.labelIds?.includes('CATEGORY_SOCIAL')) score -= 2;
  if (email.labelIds?.includes('CATEGORY_UPDATES')) score -= 1;

  // Urgency keywords
  const urgentWords = ['urgent', 'deadline', 'important', 'action required', 'asap', 'time-sensitive', 'overdue', 'final notice'];
  if (urgentWords.some((w) => subject.includes(w))) score += 3;

  // Direct reply indicators
  if (email.labelIds?.includes('INBOX') && !email.labelIds?.includes('CATEGORY_PROMOTIONS')) score += 2;
  if (subject.startsWith('re:') || subject.startsWith('fwd:')) score += 1;

  // Educational / professor signals
  if (from.includes('.edu') || from.includes('asu.edu') || from.includes('canvas')) score += 2;

  return Math.min(10, Math.max(1, score));
}

async function checkNewEmails(sendAlertFn) {
  const lastCheck = state.getSetting('last_email_check');
  const sinceTimestamp = lastCheck ? parseInt(lastCheck, 10) : Date.now() - 15 * 60 * 1000;
  const now = Date.now();

  let emails;
  try {
    emails = await getRecentEmailsAllAccounts(sinceTimestamp);
  } catch (err) {
    logger.error('[email-watcher] Failed to fetch emails:', err.message);
    return;
  }

  state.setSetting('last_email_check', String(now));

  // Filter out already-seen emails
  const newEmails = emails.filter((e) => !state.isEmailSeen(e.id));
  if (!newEmails.length) {
    logger.debug('[email-watcher] No new emails');
    return;
  }

  logger.info(`[email-watcher] Processing ${newEmails.length} new emails`);

  // Score emails — use Claude for richer triage if we have many
  let scoredEmails;
  try {
    if (newEmails.length <= 3) {
      scoredEmails = newEmails.map((e) => ({ ...e, score: scoreEmail(e), needsDraft: scoreEmail(e) >= IMPORTANCE_THRESHOLD }));
    } else {
      const triagePrompt = emailTriagePrompt(
        newEmails.map((e) => ({ id: e.id, from: e.from, subject: e.subject, snippet: e.snippet }))
      );
      const raw = await claude.complete(triagePrompt, { system: 'You are an email triage assistant. Output only valid JSON.' });
      const parsed = JSON.parse(raw);
      scoredEmails = newEmails.map((e) => {
        const triage = parsed.find((t) => t.id === e.id) || {};
        return { ...e, score: triage.score || scoreEmail(e), summary: triage.summary, needsDraft: triage.needsDraft };
      });
    }
  } catch (err) {
    logger.error('[email-watcher] Triage failed, using simple scoring:', err.message);
    scoredEmails = newEmails.map((e) => ({ ...e, score: scoreEmail(e), needsDraft: scoreEmail(e) >= IMPORTANCE_THRESHOLD }));
  }

  // Mark all as seen
  newEmails.forEach((e) => state.markEmailSeen(e.id));

  // Alert and draft for important emails
  const importantEmails = scoredEmails.filter((e) => e.score >= IMPORTANCE_THRESHOLD);
  for (const email of importantEmails) {
    try {
      await processImportantEmail(email, sendAlertFn);
    } catch (err) {
      logger.error(`[email-watcher] Failed to process email ${email.id}:`, err.message);
    }
  }
}

async function processImportantEmail(email, sendAlertFn) {
  const chatId = config.telegram.myChatId;
  const summary = email.summary || email.snippet || '(no preview)';

  const accountTag = email.account === 'asu' ? ' (ASU)' : ' (Personal)';
  const alert = `📧 *New email${accountTag} from ${email.from}*\n*Subject:* ${email.subject}\n\n${summary}`;
  await sendAlertFn(alert);

  if (!email.needsDraft) return;

  // Fetch full body for drafting if we only have a snippet
  let fullEmail = email;
  if (!email.body || email.body.length < 100) {
    try {
      fullEmail = await getEmailContent(email.id, email.account || 'personal');
    } catch {
      fullEmail = email;
    }
  }

  const draftPrompt = draftReplyPrompt({ originalEmail: fullEmail });
  const draftText = await claude.complete(draftPrompt);

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
    `Reply with:\n• *approve* — send this reply\n• *edit: [your changes]* — rewrite it\n• *discard* — skip this one`;
  await sendAlertFn(draftMsg);
}

module.exports = { checkNewEmails };
