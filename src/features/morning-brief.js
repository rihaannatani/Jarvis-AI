'use strict';
const logger = require('../logger');
const { complete } = require('../claude');
const config = require('../config');
const state = require('../state');
const { morningBriefPrompt } = require('../prompts/brief');
const { phoenixToday } = require('../date-utils');

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

function buildExpiringSoonSection() {
  try {
    const items = state.getExpiringPantryItems(3);
    if (!items.length) return null;

    const today = phoenixToday();

    const lines = ['🥗 *Use soon:*'];
    for (const item of items) {
      const expiry = new Date(item.expiry_date + 'T00:00:00');
      const days = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));
      const loc = item.storage_location || 'unknown';
      if (days <= 0) {
        lines.push(`- ${item.name} — *expires today* (${loc})`);
      } else if (days === 1) {
        lines.push(`- ${item.name} — *expires tomorrow* (${loc})`);
      } else {
        lines.push(`- ${item.name} — expires in ${days} days (${loc})`);
      }
    }
    return lines.join('\n');
  } catch (err) {
    logger.warn('[morning-brief] Could not load expiring items:', err.message);
    return null;
  }
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
    // allSettled (not all) so one failing sub-call doesn't blank the whole
    // Canvas section when the other one would've succeeded.
    Promise.allSettled([
      require('../integrations/canvas').getAssignments(),
      require('../integrations/canvas').getAnnouncements(),
    ]),
    require('../integrations/gmail').getImportantEmailsAllAccounts(),
  ]);

  const [weatherResult, calendarResult, canvasResult, gmailResult] = results;

  let calendarData = calendarResult.status === 'fulfilled' ? calendarResult.value : null;
  if (calendarData) calendarData = await enrichEventsWithTravel(calendarData);

  const [assignmentsResult, announcementsResult] =
    canvasResult.status === 'fulfilled' ? canvasResult.value : [null, null];

  const raw = {
    date,
    weather: weatherResult.status === 'fulfilled' ? weatherResult.value : null,
    calendar: calendarData,
    canvas: {
      assignments: assignmentsResult?.status === 'fulfilled' ? assignmentsResult.value : null,
      announcements: announcementsResult?.status === 'fulfilled' ? announcementsResult.value : null,
    },
    gmail: gmailResult.status === 'fulfilled' ? gmailResult.value : null,
  };

  if (weatherResult.status === 'rejected') logger.warn('[morning-brief] weather fetch failed:', weatherResult.reason?.message);
  if (calendarResult.status === 'rejected') logger.warn('[morning-brief] calendar fetch failed:', calendarResult.reason?.message);
  if (assignmentsResult?.status === 'rejected') logger.warn('[morning-brief] canvas assignments fetch failed:', assignmentsResult.reason?.message);
  if (announcementsResult?.status === 'rejected') logger.warn('[morning-brief] canvas announcements fetch failed:', announcementsResult.reason?.message);
  if (gmailResult.status === 'rejected') logger.warn('[morning-brief] gmail fetch failed:', gmailResult.reason?.message);

  const filtered = prefilterForBrief(raw);
  const expiringSection = buildExpiringSoonSection();
  const brief = await complete(morningBriefPrompt({ ...filtered, date }), { maxTokens: 600, purpose: 'morning-brief' });

  if (expiringSection) {
    return brief + '\n\n' + expiringSection;
  }
  return brief;
}

module.exports = { assembleMorningBrief };
