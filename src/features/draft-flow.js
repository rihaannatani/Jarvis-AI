'use strict';
const logger = require('../logger');
const claude = require('../claude');
const state = require('../state');
const { sendRaw } = require('../integrations/gmail');
const { draftReplyPrompt } = require('../prompts/email');

// Returns true if the message was handled as a draft action
async function handleDraftAction(chatId, message, sendFn) {
  const text = message.trim();
  const lower = text.toLowerCase();

  // Check for any pending draft
  const draft = state.getPendingDraft(chatId);
  if (!draft) return false;

  // "approve" — send the draft using the account it was received on
  if (lower === 'approve') {
    try {
      await sendRaw(draft.to_address, draft.subject, draft.draft_text, draft.thread_id, draft.account || 'personal');
      state.updateDraftStatus(draft.id, 'approved');
      await sendFn('Done — reply sent.');
      logger.info(`[draft-flow] Draft ${draft.id} approved and sent via ${draft.account || 'personal'}`);
    } catch (err) {
      logger.error('[draft-flow] Send failed:', err.message);
      await sendFn("Couldn't send the email right now. Try again or discard it.");
    }
    return true;
  }

  // "discard" — mark as discarded
  if (lower === 'discard') {
    state.updateDraftStatus(draft.id, 'discarded');
    await sendFn('Draft discarded.');
    logger.info(`[draft-flow] Draft ${draft.id} discarded`);
    return true;
  }

  // "edit: ..." — rewrite with instruction
  if (lower.startsWith('edit:')) {
    const instruction = text.slice(5).trim();
    try {
      // Fetch original email content for context
      let originalEmail;
      try {
        originalEmail = await require('../integrations/gmail').getEmailContent(draft.email_id, draft.account || 'personal');
      } catch {
        originalEmail = { from: draft.to_address, subject: draft.subject.replace(/^Re: /, ''), body: '' };
      }

      const prompt = draftReplyPrompt({ originalEmail, instruction });
      const newDraft = await claude.complete(prompt);
      state.updateDraftText(draft.id, newDraft);

      const msg =
        `*Updated draft:*\n\n${newDraft}\n\n` +
        `Reply *approve* to send, *edit: [changes]* to revise again, or *discard* to skip.`;
      await sendFn(msg);
      logger.info(`[draft-flow] Draft ${draft.id} edited`);
    } catch (err) {
      logger.error('[draft-flow] Edit failed:', err.message);
      await sendFn("Couldn't rewrite that draft. Try again.");
    }
    return true;
  }

  return false;
}

module.exports = { handleDraftAction };
