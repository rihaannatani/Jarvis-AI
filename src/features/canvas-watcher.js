'use strict';
const logger = require('../logger');
const state = require('../state');
const { getAssignments, getAnnouncements } = require('../integrations/canvas');
const { quickComplete } = require('../claude');
const { announcementInferencePrompt, assignmentInferencePrompt } = require('../prompts/canvas');
const { toPhoenixNaiveIso } = require('../date-utils');

// Adds a short 30-minute deadline block ending exactly at the due time —
// deliberately not an all-day event (that was the original complaint: Canvas
// due dates syncing as all-day events aren't useful for actually planning
// around). Best-effort: a calendar failure here should never block the
// Telegram alert or bubble up to the caller.
async function addAssignmentToCalendar(assignment) {
  const { createEvent } = require('../integrations/calendar');
  const due = new Date(assignment.dueAt);
  const start = toPhoenixNaiveIso(new Date(due.getTime() - 30 * 60 * 1000));
  const end = toPhoenixNaiveIso(due);
  const pointsStr = assignment.pointsPossible != null ? ` (${assignment.pointsPossible} pts)` : '';
  await createEvent(
    {
      summary: `📚 Due: ${assignment.name}${pointsStr}`,
      start,
      end,
      description: `${assignment.course}${assignment.htmlUrl ? `\n${assignment.htmlUrl}` : ''}`,
    },
    'asu'
  );
}

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

    // Silent seed/no-alert mode — nothing gets sent, so mark seen immediately.
    if (!shouldAlert) {
      state.markAnnouncementSeen(String(ann.id), ann.course);
      continue;
    }

    const inference = await inferAnnouncement(ann);

    let msg = null;
    if (!inference) {
      // Inference unavailable — fall back to the old behavior so nothing gets silently dropped
      const preview = firstSentences(ann.message, 3);
      msg =
        `📢 *New Announcement — ${ann.course}*\n*${ann.title}*\n\n${preview}\n\n` +
        `_Ask me for the full announcement if you need it._`;
    } else if (inference.matters) {
      const urgencyTag = inference.urgency >= 8 ? '🔴' : inference.urgency >= 5 ? '🟡' : '';
      const actionLine = inference.actionNeeded ? `\n\n*Action needed:* ${inference.actionNeeded}` : '';
      msg = `📢 ${urgencyTag} *${ann.course}* — ${ann.title}\n\n${inference.summary}${actionLine}`;
    }

    if (!msg) {
      // Deliberately not alerting (routine) — nothing to retry, safe to mark seen.
      logger.info(`[canvas-watcher] Skip (routine): announcement "${ann.title}" (${ann.course})`);
      state.markAnnouncementSeen(String(ann.id), ann.course);
      continue;
    }

    // Only mark seen once the alert actually went out — a failed send
    // (Telegram hiccup) leaves it unseen so it's retried next poll instead
    // of being silently and permanently dropped.
    try {
      await sendFn(msg);
      state.markAnnouncementSeen(String(ann.id), ann.course);
      logger.info(`[canvas-watcher] Alerted${inference ? ` (urgency ${inference.urgency})` : ''}: announcement "${ann.title}" (${ann.course})`);
    } catch (err) {
      logger.error('[canvas-watcher] Failed to send announcement alert (will retry next poll):', err.message);
    }
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
      // New assignment. Silent mode — record and move on, nothing to send.
      if (!shouldAlert) {
        state.markAssignmentSeen(id, String(assignment.courseCode || ''), assignment.dueAt || '');
        continue;
      }

      const nearbyDeadlines = assignments
        .filter((a) => a.id !== assignment.id && a.dueAt && Math.abs(new Date(a.dueAt) - new Date(assignment.dueAt)) < 3 * 24 * 60 * 60 * 1000)
        .map((a) => `${a.name} (${a.course}) due ${a.dueAt}`)
        .join('; ');

      const inference = await inferAssignment(assignment, nearbyDeadlines);
      const pointsStr = assignment.pointsPossible != null ? `\nPoints: ${assignment.pointsPossible}` : '';
      const noteLine = inference?.noteworthy && inference.note ? `\n\n⚠️ ${inference.note}` : '';

      const msg =
        `📝 *New Assignment — ${assignment.course}*\n*${assignment.name}*\nDue: ${formatDue(assignment.dueAt)}${pointsStr}${noteLine}`;

      // Record seen only after a successful send — a delivery failure is
      // retried on the next poll instead of being lost for good. Calendar
      // add happens right alongside that (not before), so a retry after a
      // failed send can't create the same event twice.
      try {
        await sendFn(msg);
        state.markAssignmentSeen(id, String(assignment.courseCode || ''), assignment.dueAt || '');
        logger.info(`[canvas-watcher] Alerted: new assignment "${assignment.name}"${inference?.noteworthy ? ' [flagged]' : ''}`);
      } catch (err) {
        logger.error('[canvas-watcher] Failed to send new assignment alert (will retry next poll):', err.message);
        continue;
      }

      if (assignment.dueAt) {
        try {
          await addAssignmentToCalendar(assignment);
          logger.info(`[canvas-watcher] Added "${assignment.name}" to ASU calendar`);
        } catch (err) {
          logger.warn(`[canvas-watcher] Failed to add "${assignment.name}" to calendar:`, err.message);
        }
      }
    } else if (existing.due_at && assignment.dueAt && existing.due_at !== assignment.dueAt) {
      // Due date changed
      if (!shouldAlert) {
        state.updateAssignmentDueAt(id, assignment.dueAt);
        continue;
      }

      const oldDue = existing.due_at;
      const msg =
        `⚠️ *Due Date Changed — ${assignment.course}*\n*${assignment.name}*\nOld due: ${formatDue(oldDue)}\nNew due: ${formatDue(assignment.dueAt)}`;

      try {
        await sendFn(msg);
        state.updateAssignmentDueAt(id, assignment.dueAt);
        logger.info(`[canvas-watcher] Alerted: due date changed for "${assignment.name}"`);
      } catch (err) {
        logger.error('[canvas-watcher] Failed to send due date change alert (will retry next poll):', err.message);
      }
    }
  }
}

module.exports = { runCanvasWatcher };
