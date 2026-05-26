'use strict';
const logger = require('../logger');
const { complete } = require('../claude');
const config = require('../config');
const { morningBriefPrompt } = require('../prompts/brief');

async function enrichEventsWithTravel(events) {
  if (!config.maps.apiKey || !events?.length) return events;
  const { getTravelTime } = require('../integrations/maps');

  return Promise.all(
    events.map(async (event) => {
      if (!event.location) return event;
      try {
        const travel = await getTravelTime(event.location);
        return { ...event, travelTime: travel.durationInTraffic, travelDistance: travel.distance };
      } catch {
        return event;
      }
    })
  );
}

// Trim data to reduce input tokens before handing to Claude
function prefilterForBrief(data) {
  const { weather, calendar, canvas, gmail } = data;

  // Calendar: drop internal Google fields, keep only what Claude needs
  const calendarClean = calendar?.map((e) => ({
    summary: e.summary,
    start: e.start,
    end: e.end,
    location: e.location || undefined,
    travelTime: e.travelTime || undefined,
    account: e.account,
  })) || null;

  // Canvas: only assignments due within 7 days
  const now = Date.now();
  const sevenDays = now + 7 * 24 * 60 * 60 * 1000;
  const assignmentsDue = canvas?.assignments
    ?.filter((a) => {
      const due = new Date(a.dueAt).getTime();
      return due >= now && due <= sevenDays;
    })
    .map((a) => ({ name: a.name, course: a.courseCode || a.course, dueAt: a.dueAt })) || null;

  // Announcements: just title + course, no full body
  const announcements = canvas?.announcements
    ?.slice(0, 3)
    .map((a) => ({ title: a.title, course: a.course })) || null;

  // Gmail: just count + subjects, no snippets or body
  const gmailClean = gmail?.length
    ? { count: gmail.length, subjects: gmail.slice(0, 5).map((e) => ({ from: e.from, subject: e.subject, account: e.account })) }
    : null;

  return { weather, calendar: calendarClean, assignments: assignmentsDue, announcements, gmail: gmailClean };
}

async function assembleMorningBrief() {
  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/Phoenix',
  });

  const results = await Promise.allSettled([
    require('../integrations/weather').getWeatherSummary(),
    require('../integrations/calendar').getTodayEventsAllAccounts(),
    Promise.all([
      require('../integrations/canvas').getAssignments(),
      require('../integrations/canvas').getAnnouncements(),
    ]),
    require('../integrations/gmail').getImportantEmailsAllAccounts(),
  ]);

  const [weatherResult, calendarResult, canvasResult, gmailResult] = results;

  let calendarData = calendarResult.status === 'fulfilled' ? calendarResult.value : null;
  if (calendarData) calendarData = await enrichEventsWithTravel(calendarData);

  const raw = {
    date,
    weather: weatherResult.status === 'fulfilled' ? weatherResult.value : null,
    calendar: calendarData,
    canvas: canvasResult.status === 'fulfilled'
      ? { assignments: canvasResult.value[0], announcements: canvasResult.value[1] }
      : null,
    gmail: gmailResult.status === 'fulfilled' ? gmailResult.value : null,
  };

  results.forEach((r, i) => {
    const names = ['weather', 'calendar', 'canvas', 'gmail'];
    if (r.status === 'rejected') logger.warn(`[morning-brief] ${names[i]} fetch failed:`, r.reason?.message);
  });

  const filtered = prefilterForBrief(raw);
  const prompt = morningBriefPrompt({ ...filtered, date });
  return complete(prompt, { maxTokens: 600, purpose: 'morning-brief' });
}

module.exports = { assembleMorningBrief };
