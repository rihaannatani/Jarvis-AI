'use strict';
const logger = require('../logger');
const state = require('../state');
const config = require('../config');

async function checkReminders(sendFn) {
  const due = state.getDueReminders();
  if (!due.length) return;

  for (const reminder of due) {
    try {
      await sendFn(reminder.telegram_chat_id, `⏰ Reminder: ${reminder.message}`);
      state.markReminderFired(reminder.id);
      logger.info(`[reminders] Fired reminder ${reminder.id}: ${reminder.message}`);
    } catch (err) {
      logger.error(`[reminders] Failed to fire reminder ${reminder.id}:`, err.message);
    }
  }
}

async function checkCalendarReminders(sendFn) {
  try {
    const { getUpcomingEventsAllAccounts } = require('../integrations/calendar');
    const events = await getUpcomingEventsAllAccounts(0.75); // next 45 minutes
    const chatId = config.telegram.myChatId;

    for (const event of events) {
      const startTime = new Date(event.start).getTime();
      const minutesUntil = Math.round((startTime - Date.now()) / 60000);

      if (minutesUntil >= 25 && minutesUntil <= 35) {
        const reminderKey = `cal_reminder_${event.id}`;
        if (!state.getSetting(reminderKey)) {
          const timeStr = new Date(event.start).toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            timeZone: 'America/Phoenix',
          });

          let msg = `⏰ *${event.summary}* starts at ${timeStr} (in ~${minutesUntil} min)`;

          // Add travel time if the event has a location and Maps is configured
          if (event.location && config.maps.apiKey) {
            try {
              const { getTravelTime } = require('../integrations/maps');
              const travel = await getTravelTime(event.location);
              const travelMin = Math.round(travel.durationInTrafficSeconds / 60);

              msg += `\n🗺️ Drive to ${event.location}: *${travel.durationInTraffic}*`;

              // If they need to leave very soon or right now, make it urgent
              if (travelMin + 10 >= minutesUntil) {
                msg += ` — *leave now* to arrive on time`;
              }

              // If travel takes significantly longer than standard 30-min buffer,
              // schedule an earlier dynamic reminder so they aren't caught off guard
              const shouldLeaveAt = startTime - (travelMin + 10) * 60 * 1000;
              const leaveReminderKey = `cal_leave_${event.id}`;
              if (shouldLeaveAt > Date.now() + 60000 && !state.getSetting(leaveReminderKey)) {
                const leaveTime = new Date(shouldLeaveAt).toLocaleTimeString('en-US', {
                  hour: 'numeric', minute: '2-digit', timeZone: 'America/Phoenix',
                });
                const leaveMsg =
                  `🗺️ *Leave for ${event.summary}*\n` +
                  `Drive: *${travel.durationInTraffic}* to ${event.location}\n` +
                  `Leave by *${leaveTime}* to arrive on time\n` +
                  `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(event.location)}`;
                state.saveReminder(chatId, leaveMsg, new Date(shouldLeaveAt).toISOString());
                state.setSetting(leaveReminderKey, 'scheduled');
              }
            } catch (err) {
              logger.warn(`[reminders] Travel time fetch failed for "${event.summary}":`, err.message);
            }
          }

          await sendFn(chatId, msg);
          state.setSetting(reminderKey, 'sent');
          logger.info(`[reminders] Sent calendar reminder for: ${event.summary}`);
        }
      }
    }
  } catch (err) {
    logger.warn('[reminders] Calendar reminder check failed:', err.message);
  }
}

async function checkAssignmentReminders(sendFn) {
  try {
    const { getAssignments } = require('../integrations/canvas');
    const assignments = await getAssignments();
    const chatId = config.telegram.myChatId;
    const now = Date.now();

    for (const assignment of assignments) {
      const dueTime = new Date(assignment.dueAt).getTime();
      const hoursUntil = (dueTime - now) / (1000 * 60 * 60);

      if (hoursUntil >= 23.5 && hoursUntil <= 24.5) {
        const key = `canvas_24h_${assignment.id}`;
        if (!state.getSetting(key)) {
          await sendFn(chatId, `📚 *24-hour reminder:* "${assignment.name}" (${assignment.courseCode}) is due tomorrow`);
          state.setSetting(key, 'sent');
        }
      }

      if (hoursUntil >= 0.75 && hoursUntil <= 1.25) {
        const key = `canvas_1h_${assignment.id}`;
        if (!state.getSetting(key)) {
          await sendFn(chatId, `🚨 *1-hour reminder:* "${assignment.name}" (${assignment.courseCode}) is due soon!`);
          state.setSetting(key, 'sent');
        }
      }
    }
  } catch (err) {
    logger.warn('[reminders] Assignment reminder check failed:', err.message);
  }
}

module.exports = { checkReminders, checkCalendarReminders, checkAssignmentReminders };
