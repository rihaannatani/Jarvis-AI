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

    case 'add_task': {
      const id = state.addTask(toolInput.content, toolInput.due_date || null, toolInput.source || 'auto');
      logger.info(`[router] Task added [#${id}]: ${toolInput.content}`);
      return { success: true, id };
    }

    case 'complete_task': {
      state.completeTask(toolInput.task_id);
      logger.info(`[router] Task completed: #${toolInput.task_id}`);
      return { success: true };
    }

    case 'list_tasks': {
      return state.listOpenTasks();
    }

    case 'save_memory': {
      const id = state.saveMemory(toolInput.category, toolInput.content, toolInput.source || 'auto');
      logger.info(`[router] Memory saved [#${id}]: ${toolInput.content}`);
      return { success: true, id };
    }

    case 'forget_memory': {
      state.forgetMemory(toolInput.memory_id);
      logger.info(`[router] Memory forgotten: #${toolInput.memory_id}`);
      return { success: true };
    }

    case 'list_memories': {
      return state.listActiveMemories();
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

    case 'get_pantry': {
      const filter = toolInput.filter || 'all';
      const items = state.getActivePantryItems();
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      let filtered = items;
      if (filter === 'expiring_soon') {
        filtered = items.filter((i) => {
          if (!i.expiry_date) return false;
          const expiry = new Date(i.expiry_date + 'T00:00:00');
          const days = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));
          return days <= 7;
        });
      } else if (filter === 'expired') {
        filtered = items.filter((i) => {
          if (!i.expiry_date) return false;
          const expiry = new Date(i.expiry_date + 'T00:00:00');
          return expiry < today;
        });
      } else if (filter === 'by_location') {
        const byLoc = {};
        for (const i of items) {
          const loc = i.storage_location || 'unknown';
          if (!byLoc[loc]) byLoc[loc] = [];
          byLoc[loc].push(i);
        }
        return byLoc;
      }

      return filtered.map((i) => {
        const days = i.expiry_date
          ? Math.ceil((new Date(i.expiry_date + 'T00:00:00') - today) / (1000 * 60 * 60 * 24))
          : null;
        return { ...i, days_until_expiry: days };
      });
    }

    case 'mark_consumed': {
      const { item_name } = toolInput;
      if (!item_name) return { error: 'item_name is required' };
      const found = state.markPantryItemConsumed(item_name);
      return found
        ? { success: true, message: `Marked "${item_name}" as consumed` }
        : { success: false, message: `No active pantry item matching "${item_name}" found` };
    }

    case 'add_pantry_item': {
      const { name, expiry_date, storage_location, category, notes } = toolInput;
      if (!name) return { error: 'name is required' };
      const today = new Date().toISOString().slice(0, 10);
      const id = state.addPantryItem({
        name,
        category: category || 'pantry',
        purchase_date: today,
        expiry_date: expiry_date || null,
        storage_location: storage_location || null,
        notes: notes || null,
      });
      return { success: true, id, name, expiry_date, storage_location };
    }

    default:
      logger.warn(`[router] Unknown tool: ${toolName}`);
      return { error: `Unknown tool: ${toolName}` };
  }
}

module.exports = { execute };
