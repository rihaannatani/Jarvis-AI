'use strict';
const logger = require('./logger');
const state = require('./state');

async function execute(toolName, toolInput, chatId) {
  logger.info(`[router] Executing tool: ${toolName}`);

  switch (toolName) {
    case 'get_calendar_today': {
      const { getTodayEventsAllAccounts } = require('./integrations/calendar');
      return await getTodayEventsAllAccounts();
    }

    case 'get_calendar_week': {
      const { getWeekEventsAllAccounts } = require('./integrations/calendar');
      return await getWeekEventsAllAccounts();
    }

    case 'create_calendar_event': {
      const { createEvent } = require('./integrations/calendar');
      const account = toolInput.account || 'asu';
      const created = await createEvent(toolInput, account);
      return {
        success: true,
        summary: created.summary,
        start: created.start.dateTime || created.start.date,
        end: created.end.dateTime || created.end.date,
        link: created.htmlLink,
        account,
      };
    }

    case 'delete_calendar_event': {
      const { deleteEvent } = require('./integrations/calendar');
      const account = toolInput.account || 'personal';
      return await deleteEvent(toolInput.event_id, account);
    }

    case 'update_event_attendees': {
      const { updateEventAttendees } = require('./integrations/calendar');
      const account = toolInput.account || 'personal';
      return await updateEventAttendees(toolInput.event_id, toolInput.attendees, account);
    }

    case 'get_weather': {
      const { getWeatherSummary } = require('./integrations/weather');
      return await getWeatherSummary();
    }

    case 'get_canvas_assignments': {
      const { getAssignments } = require('./integrations/canvas');
      return await getAssignments();
    }

    case 'get_canvas_announcements': {
      const { getAnnouncements } = require('./integrations/canvas');
      return await getAnnouncements();
    }

    case 'get_gmail_important': {
      const { getImportantEmailsAllAccounts } = require('./integrations/gmail');
      return await getImportantEmailsAllAccounts();
    }

    case 'set_reminder': {
      const { message, fire_at } = toolInput;
      if (!message || !fire_at) return { error: 'message and fire_at are required' };
      const fireDate = new Date(fire_at);
      if (isNaN(fireDate.getTime())) return { error: 'Invalid fire_at datetime' };
      state.saveReminder(chatId, message, fireDate.toISOString());
      logger.info(`[router] Reminder set: "${message}" at ${fire_at}`);
      return { success: true, scheduledFor: fire_at };
    }

    case 'get_pending_drafts': {
      const drafts = state.getPendingDrafts(chatId);
      return { count: drafts.length, drafts };
    }

    case 'get_travel_time': {
      const { getTravelTime } = require('./integrations/maps');
      const { destination, origin, mode } = toolInput;
      return await getTravelTime(destination, origin, mode || 'driving');
    }

    case 'find_nearby_places': {
      const { findNearbyPlaces } = require('./integrations/maps');
      const { query, location } = toolInput;
      return await findNearbyPlaces(query, location);
    }

    case 'get_directions': {
      const { getDirections } = require('./integrations/maps');
      const { destination, origin, mode } = toolInput;
      return await getDirections(destination, origin, mode || 'driving');
    }

    default:
      logger.warn(`[router] Unknown tool: ${toolName}`);
      return { error: `Unknown tool: ${toolName}` };
  }
}

module.exports = { execute };
