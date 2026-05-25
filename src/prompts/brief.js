'use strict';

function morningBriefPrompt(data) {
  const { weather, calendar, canvas, gmail, date } = data;

  return `Write a morning brief for ${date}. You're Jarvis giving a quick, natural rundown — like a sharp assistant who already knows everything and is catching you up before your day starts.

DATA AVAILABLE:
${weather ? `WEATHER:\n${JSON.stringify(weather, null, 2)}` : 'WEATHER: unavailable'}

${calendar ? `CALENDAR TODAY:\n${JSON.stringify(calendar, null, 2)}` : 'CALENDAR: unavailable'}

${canvas ? `CANVAS ASSIGNMENTS & ANNOUNCEMENTS:\n${JSON.stringify(canvas, null, 2)}` : 'CANVAS: unavailable'}

${gmail ? `GMAIL SUMMARY:\n${JSON.stringify(gmail, null, 2)}` : 'GMAIL: unavailable'}

WRITING INSTRUCTIONS:
- Open with a good morning greeting and today's date
- Lead with weather: temperature now, expected high/low, and conditions
- Then calendar: what's happening today (be specific with times)
- Then academics: anything due today or very soon, any announcements worth noting
- Then comms: flag anything in email that needs attention (just a heads up, not full content)
- Close with one short, useful thought — could be a gentle heads-up, something motivational, or just practical
- Write naturally, like a smart assistant talking, not a report being filed
- Aim for 350-550 words
- Use *bold* for Telegram emphasis on key items like event times and deadlines
- Flag URGENT items clearly but don't be alarmist`;
}

function nightBriefPrompt(data) {
  const { calendar, canvasAssignments, pendingDrafts, tomorrowCalendar, date } = data;

  return `Write a night brief for the evening of ${date}. Tone should be calm and winding-down — like a good assistant helping wrap up the day and set up for tomorrow.

DATA AVAILABLE:
${calendar ? `TODAY'S CALENDAR (recap):\n${JSON.stringify(calendar, null, 2)}` : 'CALENDAR: unavailable'}

${canvasAssignments ? `CANVAS — DUE TOMORROW:\n${JSON.stringify(canvasAssignments, null, 2)}` : 'CANVAS: unavailable'}

${pendingDrafts && pendingDrafts.length ? `PENDING EMAIL DRAFTS (awaiting approval):\n${JSON.stringify(pendingDrafts, null, 2)}` : ''}

${tomorrowCalendar ? `TOMORROW'S CALENDAR:\n${JSON.stringify(tomorrowCalendar, null, 2)}` : 'TOMORROW: unavailable'}

WRITING INSTRUCTIONS:
- Brief, warm opening — acknowledge it's evening
- Recap today's key events (1-2 sentences, not a full rundown)
- Flag anything due tomorrow clearly — last reminder tone
- If there are pending email drafts, mention them simply
- Preview tomorrow: what's coming up
- Close gently — no cheerleading, just practical and calm
- Aim for 150-250 words, shorter than the morning brief`;
}

module.exports = { morningBriefPrompt, nightBriefPrompt };
