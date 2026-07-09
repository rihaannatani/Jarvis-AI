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
- Flag URGENT items clearly but don't be alarmist
- Vary your phrasing from what you'd typically default to — don't reuse the same stock lines every day (e.g. not every empty calendar is "a gift or a blank canvas," not every outage needs "don't let X fool you"). Write like you're actually noticing today's specifics, not filling in yesterday's template with new numbers.
- If Canvas or Gmail is unavailable, say so once, briefly — don't build a whole paragraph of advice around an outage`;
}

function nightBriefPrompt(data) {
  const { calendar, canvasAssignments, pendingDrafts, tomorrowCalendar, date, apiUsage } = data;

  const usageStr = apiUsage
    ? `API USAGE TODAY: ${apiUsage.calls} calls, ${apiUsage.inputTokens} input tokens, ${apiUsage.outputTokens} output tokens (~$${apiUsage.estimatedCost})`
    : '';

  return `Write a night brief for the evening of ${date}. Tone should be calm and winding-down — like a good assistant helping wrap up the day and set up for tomorrow.

DATA AVAILABLE:
${calendar ? `TODAY'S CALENDAR (recap):\n${JSON.stringify(calendar, null, 2)}` : 'CALENDAR: unavailable'}

${canvasAssignments ? `CANVAS — DUE TOMORROW:\n${JSON.stringify(canvasAssignments, null, 2)}` : 'CANVAS: unavailable'}

${pendingDrafts && pendingDrafts.length ? `PENDING EMAIL DRAFTS (awaiting approval):\n${JSON.stringify(pendingDrafts, null, 2)}` : ''}

${tomorrowCalendar ? `TOMORROW'S CALENDAR:\n${JSON.stringify(tomorrowCalendar, null, 2)}` : 'TOMORROW: unavailable'}

${usageStr}

WRITING INSTRUCTIONS:
- Brief, warm opening — acknowledge it's evening
- Recap today's key events (1-2 sentences, not a full rundown)
- Flag anything due tomorrow clearly — last reminder tone
- If there are pending email drafts, mention them simply. Each draft includes daysOld — if a draft is more than 7 days old, don't call it "time-sensitive" anymore (it's stale, not urgent); instead suggest discarding it if it's no longer relevant, and mention the user can just say "discard draft #N" or "clear all my drafts" to act on it directly
- Don't re-flag the exact same drafts as urgent night after night — if nothing changed, say so briefly instead of repeating the full pitch
- Preview tomorrow: what's coming up
- If API usage data is present, add one line at the end: "API today: X calls, ~$Y"
- Close gently — no cheerleading, just practical and calm
- Vary your phrasing night to night rather than reusing the same stock structure and lines
- Aim for 150-250 words, shorter than the morning brief`;
}

module.exports = { morningBriefPrompt, nightBriefPrompt };
