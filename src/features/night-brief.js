'use strict';
const logger = require('../logger');
const { complete } = require('../claude');
const { nightBriefPrompt } = require('../prompts/brief');
const state = require('../state');
const config = require('../config');

async function assemblNightBrief() {
  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/Phoenix',
  });

  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const tomorrowStart = new Date(
    tomorrow.toLocaleDateString('en-US', { timeZone: 'America/Phoenix' })
  );
  const tomorrowEnd = new Date(tomorrowStart.getTime() + 24 * 60 * 60 * 1000);

  const results = await Promise.allSettled([
    require('../integrations/calendar').getTodayEvents(),
    require('../integrations/canvas').getAssignments(),
    require('../integrations/calendar').getWeekEvents(),
  ]);

  const [calendarResult, canvasResult, weekCalResult] = results;

  const pendingDrafts = state.getPendingDrafts(config.telegram.myChatId);

  // Assignments due tomorrow only
  let dueTomorrow = null;
  if (canvasResult.status === 'fulfilled') {
    dueTomorrow = canvasResult.value
      .filter((a) => {
        const due = new Date(a.dueAt);
        return due >= tomorrowStart && due < tomorrowEnd;
      })
      .map((a) => ({ name: a.name, course: a.courseCode || a.course, dueAt: a.dueAt }));
  }

  // Tomorrow's calendar — lean fields only
  let tomorrowCalendar = null;
  if (weekCalResult.status === 'fulfilled') {
    tomorrowCalendar = weekCalResult.value
      .filter((e) => {
        const start = new Date(e.start);
        return start >= tomorrowStart && start < tomorrowEnd;
      })
      .map((e) => ({ summary: e.summary, start: e.start, end: e.end, location: e.location || undefined }));
  }

  // Today's calendar — lean fields only
  const calendarToday = calendarResult.status === 'fulfilled'
    ? calendarResult.value.map((e) => ({ summary: e.summary, start: e.start, end: e.end }))
    : null;

  // Pending drafts — just subject + to (no full draft text, saves tokens)
  const draftsClean = pendingDrafts.length
    ? pendingDrafts.map((d) => ({ id: d.id, subject: d.subject, to: d.to_address }))
    : [];

  // API usage summary for the day
  const usage = state.getApiUsageToday();
  const usageSummary = usage?.calls
    ? {
        calls: usage.calls,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        estimatedCost: (
          (usage.input_tokens / 1000) * 0.003 +
          (usage.output_tokens / 1000) * 0.015
        ).toFixed(4),
      }
    : null;

  results.forEach((r, i) => {
    const names = ['calendar', 'canvas', 'week-calendar'];
    if (r.status === 'rejected') logger.warn(`[night-brief] ${names[i]} fetch failed:`, r.reason?.message);
  });

  const data = {
    date,
    calendar: calendarToday,
    canvasAssignments: dueTomorrow,
    pendingDrafts: draftsClean,
    tomorrowCalendar,
    apiUsage: usageSummary,
  };

  const prompt = nightBriefPrompt(data);
  return complete(prompt, { maxTokens: 400, purpose: 'night-brief' });
}

// Export with correct name (was typo'd above — keep both to avoid breaking scheduler)
async function assembleNightBrief() { return assemblNightBrief(); }

module.exports = { assembleNightBrief };
