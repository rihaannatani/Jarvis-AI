'use strict';
const logger = require('../logger');
const claude = require('../claude');
const { nightBriefPrompt } = require('../prompts/brief');
const state = require('../state');
const config = require('../config');

async function assembleNightBrief() {
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

  // Filter canvas assignments due tomorrow
  let dueTomorrow = null;
  if (canvasResult.status === 'fulfilled') {
    const all = canvasResult.value;
    dueTomorrow = all.filter((a) => {
      const due = new Date(a.dueAt);
      return due >= tomorrowStart && due < tomorrowEnd;
    });
  }

  // Filter tomorrow's calendar
  let tomorrowCalendar = null;
  if (weekCalResult.status === 'fulfilled') {
    tomorrowCalendar = weekCalResult.value.filter((e) => {
      const start = new Date(e.start);
      return start >= tomorrowStart && start < tomorrowEnd;
    });
  }

  const data = {
    date,
    calendar: calendarResult.status === 'fulfilled' ? calendarResult.value : null,
    canvasAssignments: dueTomorrow,
    pendingDrafts,
    tomorrowCalendar,
  };

  results.forEach((r, i) => {
    const names = ['calendar', 'canvas', 'week-calendar'];
    if (r.status === 'rejected') {
      logger.warn(`[night-brief] ${names[i]} fetch failed:`, r.reason?.message);
    }
  });

  const prompt = nightBriefPrompt(data);
  const brief = await claude.complete(prompt);
  return brief;
}

module.exports = { assembleNightBrief };
