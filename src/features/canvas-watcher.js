'use strict';
const logger = require('../logger');
const state = require('../state');
const { getAssignments, getAnnouncements } = require('../integrations/canvas');
const { quickComplete } = require('../claude');
const { announcementInferencePrompt, assignmentInferencePrompt } = require('../prompts/canvas');

function formatDue(dueAt) {
  return new Date(dueAt).toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Phoenix',
  });
}

function stripHtml(str) {
  if (!str) return '';
  return str.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function firstSentences(text, n = 3) {
  const cleaned = stripHtml(text);
  const sentences = cleaned.match(/[^.!?]+[.!?]+/g) || [];
  return sentences.slice(0, n).join(' ').trim() || cleaned.slice(0, 300);
}

function extractJson(raw) {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found in response');
  return JSON.parse(match[0]);
}

async function inferAnnouncement(announcement) {
  try {
    const raw = await quickComplete(announcementInferencePrompt(announcement), {
      maxTokens: 250,
      purpose: 'canvas-announcement-inference',
    });
    const parsed = extractJson(raw);
    return {
      matters: Boolean(parsed.matters),
      urgency: Math.min(10, Math.max(1, Number(parsed.urgency) || 1)),
      summary: parsed.summary || '',
      actionNeeded: parsed.action_needed || null,
    };
  } catch (err) {
    logger.warn(`[canvas-watcher] Inference failed for announcement "${announcement.title}":`, err.message);
    return null;
  }
}

async function inferAssignment(assignment, context) {
  try {
    const raw = await quickComplete(assignmentInferencePrompt(assignment, context), {
      maxTokens: 150,
      purpose: 'canvas-assignment-inference',
    });
    const parsed = extractJson(raw);
    return { noteworthy: Boolean(parsed.noteworthy), note: parsed.note || null };
  } catch (err) {
    logger.warn(`[canvas-watcher] Inference failed for assignment "${assignment.name}":`, err.message);
    return null;
  }
}

// sendFn = null/undefined means silent seed mode (no Telegram messages)
async function runCanvasWatcher(sendFn) {
  if (sendFn === undefined) {
    logger.warn('[canvas-watcher] No sendFn provided — alerts will be logged only');
    sendFn = (msg) => { logger.info('[canvas-watcher] ALERT (no send fn):', msg.slice(0, 120)); return Promise.resolve(); };
  }
  const silent = sendFn === null;

  // Seed mode: if both tables are empty this is the very first run — populate without alerting
  const isFirstRun = state.countSeenAnnouncements() === 0 && state.countSeenAssignments() === 0;
  const shouldAlert = !silent && !isFirstRun;

  if (isFirstRun) {
    logger.info('[canvas-watcher] First run — seeding DB silently');
  }

  await Promise.allSettled([
    checkAnnouncements(shouldAlert, sendFn),
    checkAssignments(shouldAlert, sendFn),
  ]);
}

async function checkAnnouncements(shouldAlert, sendFn) {
  let announcements;
  try {
    announcements = await getAnnouncements();
  } catch (err) {
    logger.warn('[canvas-watcher] Failed to fetch announcements:', err.message);
    return;
  }

  for (const ann of announcements) {
    const seen = state.isAnnouncementSeen(String(ann.id));
    if (seen) continue;
    state.markAnnouncementSeen(String(ann.id), ann.course);

    if (!shouldAlert) continue;

    const inference = await inferAnnouncement(ann);

    // Inference unavailable — fall back to the old behavior so nothing gets silently dropped
    if (!inference) {
      const preview = firstSentences(ann.message, 3);
      const msg =
        `📢 *New Announcement — ${ann.course}*\n*${ann.title}*\n\n${preview}\n\n` +
        `_Ask me for the full announcement if you need it._`;
      await sendFn(msg).catch((err) => logger.error('[canvas-watcher] Failed to send announcement alert:', err.message));
      continue;
    }

    if (!inference.matters) {
      logger.info(`[canvas-watcher] Skip (routine): announcement "${ann.title}" (${ann.course})`);
      continue;
    }

    const urgencyTag = inference.urgency >= 8 ? '🔴' : inference.urgency >= 5 ? '🟡' : '';
    const actionLine = inference.actionNeeded ? `\n\n*Action needed:* ${inference.actionNeeded}` : '';
    const msg =
      `📢 ${urgencyTag} *${ann.course}* — ${ann.title}\n\n${inference.summary}${actionLine}`;
    await sendFn(msg).catch((err) => logger.error('[canvas-watcher] Failed to send announcement alert:', err.message));
    logger.info(`[canvas-watcher] Alerted (urgency ${inference.urgency}): announcement "${ann.title}" (${ann.course})`);
  }
}

async function checkAssignments(shouldAlert, sendFn) {
  let assignments;
  try {
    assignments = await getAssignments();
  } catch (err) {
    logger.warn('[canvas-watcher] Failed to fetch assignments:', err.message);
    return;
  }

  for (const assignment of assignments) {
    const id = String(assignment.id);
    const existing = state.getSeenAssignment(id);

    if (!existing) {
      // New assignment
      state.markAssignmentSeen(id, String(assignment.courseCode || ''), assignment.dueAt || '');
      if (!shouldAlert) continue;

      const nearbyDeadlines = assignments
        .filter((a) => a.id !== assignment.id && a.dueAt && Math.abs(new Date(a.dueAt) - new Date(assignment.dueAt)) < 3 * 24 * 60 * 60 * 1000)
        .map((a) => `${a.name} (${a.course}) due ${a.dueAt}`)
        .join('; ');

      const inference = await inferAssignment(assignment, nearbyDeadlines);
      const pointsStr = assignment.pointsPossible != null ? `\nPoints: ${assignment.pointsPossible}` : '';
      const noteLine = inference?.noteworthy && inference.note ? `\n\n⚠️ ${inference.note}` : '';

      const msg =
        `📝 *New Assignment — ${assignment.course}*\n*${assignment.name}*\nDue: ${formatDue(assignment.dueAt)}${pointsStr}${noteLine}`;
      await sendFn(msg).catch((err) => logger.error('[canvas-watcher] Failed to send new assignment alert:', err.message));
      logger.info(`[canvas-watcher] Alerted: new assignment "${assignment.name}"${inference?.noteworthy ? ' [flagged]' : ''}`);
    } else if (existing.due_at && assignment.dueAt && existing.due_at !== assignment.dueAt) {
      // Due date changed
      const oldDue = existing.due_at;
      state.updateAssignmentDueAt(id, assignment.dueAt);
      if (!shouldAlert) continue;

      const msg =
        `⚠️ *Due Date Changed — ${assignment.course}*\n*${assignment.name}*\nOld due: ${formatDue(oldDue)}\nNew due: ${formatDue(assignment.dueAt)}`;
      await sendFn(msg).catch((err) => logger.error('[canvas-watcher] Failed to send due date change alert:', err.message));
      logger.info(`[canvas-watcher] Alerted: due date changed for "${assignment.name}"`);
    }
  }
}

module.exports = { runCanvasWatcher };
