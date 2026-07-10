'use strict';
// Centralizes "what day is it" so date-boundary math (pantry expiry, task due
// dates, receipt purchase-date fallback) agrees with the user's actual Arizona
// day, not the server's OS timezone (UTC by default on a GCP VM). Phoenix
// doesn't observe DST, so this is a fixed UTC-7 offset year-round.

function phoenixTodayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' });
}

// Midnight of "today" in Phoenix, as a Date object — safe to diff against
// other dates built the same way, e.g. `new Date(x.expiry_date + 'T00:00:00')`.
function phoenixToday() {
  return new Date(`${phoenixTodayStr()}T00:00:00`);
}

// Formats any Date/instant as a naive "YYYY-MM-DDTHH:mm:ss" string
// representing its wall-clock value in America/Phoenix, with no UTC offset
// suffix — the format calendar.js's createEvent expects (it always pairs
// start/end with an explicit timeZone: 'America/Phoenix' field, so the
// dateTime string itself must NOT carry its own offset or Google's API
// will use that instead and silently shift the event).
function toPhoenixNaiveIso(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Phoenix',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}

module.exports = { phoenixTodayStr, phoenixToday, toPhoenixNaiveIso };
