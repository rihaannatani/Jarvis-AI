'use strict';
const logger = require('../logger');
const claude = require('../claude');
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
        return event; // don't let travel failure break the brief
      }
    })
  );
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

  // Enrich calendar events with travel times for events that have a location
  let calendarData = calendarResult.status === 'fulfilled' ? calendarResult.value : null;
  if (calendarData) {
    calendarData = await enrichEventsWithTravel(calendarData);
  }

  const data = {
    date,
    weather: weatherResult.status === 'fulfilled' ? weatherResult.value : null,
    calendar: calendarData,
    canvas:
      canvasResult.status === 'fulfilled'
        ? { assignments: canvasResult.value[0], announcements: canvasResult.value[1] }
        : null,
    gmail: gmailResult.status === 'fulfilled' ? gmailResult.value : null,
  };

  results.forEach((r, i) => {
    const names = ['weather', 'calendar', 'canvas', 'gmail'];
    if (r.status === 'rejected') {
      logger.warn(`[morning-brief] ${names[i]} fetch failed:`, r.reason?.message);
    }
  });

  const prompt = morningBriefPrompt(data);
  const brief = await claude.complete(prompt);
  return brief;
}

module.exports = { assembleMorningBrief };
