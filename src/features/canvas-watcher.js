'use strict';
const logger = require('../logger');
const state = require('../state');
const { getAssignments, getAnnouncements } = require('../integrations/canvas');

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

// sendFn = null means silent seed mode (no Telegram messages)
async function runCanvasWatcher(sendFn) {
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
    if (!seen) {
      state.markAnnouncementSeen(String(ann.id), ann.course);

      if (shouldAlert && sendFn) {
        const preview = firstSentences(ann.message, 3);
        const msg =
          `📢 *New Announcement — ${ann.course}*\n` +
          `*${ann.title}*\n\n` +
          `${preview}\n\n` +
          `_Ask me for the full announcement if you need it._`;
        await sendFn(msg).catch((err) =>
          logger.error('[canvas-watcher] Failed to send announcement alert:', err.message)
        );
        logger.info(`[canvas-watcher] Alerted: announcement "${ann.title}" (${ann.course})`);
      }
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
      // New assignment
      state.markAssignmentSeen(id, String(assignment.courseCode || ''), assignment.dueAt || '');

      if (shouldAlert && sendFn) {
        const pointsStr = assignment.pointsPossible != null ? `\nPoints: ${assignment.pointsPossible}` : '';
        const msg =
          `📝 *New Assignment — ${assignment.course}*\n` +
          `*${assignment.name}*\n` +
          `Due: ${formatDue(assignment.dueAt)}` +
          pointsStr;
        await sendFn(msg).catch((err) =>
          logger.error('[canvas-watcher] Failed to send new assignment alert:', err.message)
        );
        logger.info(`[canvas-watcher] Alerted: new assignment "${assignment.name}"`);
      }
    } else if (existing.due_at && assignment.dueAt && existing.due_at !== assignment.dueAt) {
      // Due date changed
      const oldDue = existing.due_at;
      state.updateAssignmentDueAt(id, assignment.dueAt);

      if (shouldAlert && sendFn) {
        const msg =
          `⚠️ *Due Date Changed — ${assignment.course}*\n` +
          `*${assignment.name}*\n` +
          `Old due: ${formatDue(oldDue)}\n` +
          `New due: ${formatDue(assignment.dueAt)}`;
        await sendFn(msg).catch((err) =>
          logger.error('[canvas-watcher] Failed to send due date change alert:', err.message)
        );
        logger.info(`[canvas-watcher] Alerted: due date changed for "${assignment.name}"`);
      }
    }
  }
}

module.exports = { runCanvasWatcher };
