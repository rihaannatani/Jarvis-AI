'use strict';
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../logger');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',  // read + write
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
];

// Token file per account. Falls back to legacy path for personal if new path absent.
const ACCOUNT_TOKEN_PATHS = {
  personal: './data/google-token-personal.json',
  asu: './data/google-token-asu.json',
};

function getOAuth2Client() {
  const credPath = path.resolve(process.cwd(), config.google.credentialsPath);
  if (!fs.existsSync(credPath)) {
    throw new Error(
      `Google credentials not found at ${credPath}. ` +
      'Download credentials.json from Google Cloud Console and place it in the project root.'
    );
  }
  const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const { client_secret, client_id, redirect_uris } = creds.installed || creds.web;
  return new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
}

function resolveTokenPath(account = 'personal') {
  const newPath = path.resolve(process.cwd(), ACCOUNT_TOKEN_PATHS[account] || ACCOUNT_TOKEN_PATHS.personal);
  if (account === 'personal') {
    // Fall back to legacy single-token path so existing setups keep working
    const legacyPath = path.resolve(process.cwd(), config.google.tokenPath);
    return fs.existsSync(newPath) ? newPath : legacyPath;
  }
  return newPath;
}

function loadTokenFromPath(auth, tokenPath) {
  if (!fs.existsSync(tokenPath)) {
    throw new Error(
      `Google token not found at ${tokenPath}. Run \`npm run setup\` to complete OAuth flow.`
    );
  }
  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  auth.setCredentials(token);
  auth.on('tokens', (newTokens) => {
    if (newTokens.refresh_token) token.refresh_token = newTokens.refresh_token;
    Object.assign(token, newTokens);
    fs.writeFileSync(tokenPath, JSON.stringify(token, null, 2));
  });
  return auth;
}

function getAuthedClient(account = 'personal') {
  const auth = getOAuth2Client();
  return loadTokenFromPath(auth, resolveTokenPath(account));
}

function hasToken(account = 'personal') {
  return fs.existsSync(resolveTokenPath(account));
}

function getAuthUrl(account = 'personal') {
  const auth = getOAuth2Client();
  const params = { access_type: 'offline', scope: SCOPES, prompt: 'consent' };
  if (account === 'asu') params.login_hint = 'rnatani1@asu.edu';
  return auth.generateAuthUrl(params);
}

async function exchangeCode(code, account = 'personal') {
  const auth = getOAuth2Client();
  const { tokens } = await auth.getToken(code);
  const tokenPath = account === 'asu'
    ? path.resolve(process.cwd(), ACCOUNT_TOKEN_PATHS.asu)
    : path.resolve(process.cwd(), ACCOUNT_TOKEN_PATHS.personal);
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  logger.info(`[calendar] Token saved for account '${account}' → ${tokenPath}`);
  return tokens;
}

function formatEvent(event, account = 'personal') {
  const start = event.start.dateTime || event.start.date;
  const end = event.end.dateTime || event.end.date;
  return {
    id: event.id,
    summary: event.summary || '(No title)',
    start,
    end,
    location: event.location,
    description: event.description?.slice(0, 200),
    isAllDay: !event.start.dateTime,
    account,
  };
}

async function getTodayEvents(account = 'personal') {
  try {
    const auth = getAuthedClient(account);
    const calendar = google.calendar({ version: 'v3', auth });
    const tz = config.app.timezone;
    const now = new Date();
    const startOfDay = new Date(now.toLocaleDateString('en-US', { timeZone: tz }));
    const endOfDay = new Date(startOfDay);
    endOfDay.setDate(endOfDay.getDate() + 1);

    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });
    return (res.data.items || []).map((e) => formatEvent(e, account));
  } catch (err) {
    logger.error(`[calendar] getTodayEvents (${account}) failed:`, err.message);
    throw err;
  }
}

async function getWeekEvents(account = 'personal') {
  try {
    const auth = getAuthedClient(account);
    const calendar = google.calendar({ version: 'v3', auth });
    const now = new Date();
    const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: nextWeek.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50,
    });
    return (res.data.items || []).map((e) => formatEvent(e, account));
  } catch (err) {
    logger.error(`[calendar] getWeekEvents (${account}) failed:`, err.message);
    throw err;
  }
}

async function getUpcomingEvents(hours = 24, account = 'personal') {
  try {
    const auth = getAuthedClient(account);
    const calendar = google.calendar({ version: 'v3', auth });
    const now = new Date();
    const future = new Date(now.getTime() + hours * 60 * 60 * 1000);

    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: future.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });
    return (res.data.items || []).map((e) => formatEvent(e, account));
  } catch (err) {
    logger.error(`[calendar] getUpcomingEvents (${account}) failed:`, err.message);
    throw err;
  }
}

async function createEvent({ summary, start, end, description, attendees }, account = 'personal') {
  try {
    const auth = getAuthedClient(account);
    const calendar = google.calendar({ version: 'v3', auth });

    const resource = {
      summary,
      description: description || '',
      start: { dateTime: start, timeZone: 'America/Phoenix' },
      end: { dateTime: end, timeZone: 'America/Phoenix' },
    };

    if (attendees?.length) {
      resource.attendees = attendees.map((email) => ({ email }));
    }

    const res = await calendar.events.insert({
      calendarId: 'primary',
      sendUpdates: attendees?.length ? 'all' : 'none',
      resource,
    });
    logger.info(`[calendar] Event created on ${account}: "${summary}"${attendees?.length ? ` (invited ${attendees.length})` : ''}`);
    return res.data;
  } catch (err) {
    logger.error(`[calendar] createEvent (${account}) failed:`, err.message);
    throw err;
  }
}

async function deleteEvent(eventId, account = 'personal') {
  try {
    const auth = getAuthedClient(account);
    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.delete({
      calendarId: 'primary',
      eventId,
      sendUpdates: 'all',
    });
    logger.info(`[calendar] Event deleted on ${account}: ${eventId}`);
    return { success: true, eventId };
  } catch (err) {
    logger.error(`[calendar] deleteEvent (${account}) failed:`, err.message);
    throw err;
  }
}

async function updateEventAttendees(eventId, attendees, account = 'personal') {
  try {
    const auth = getAuthedClient(account);
    const calendar = google.calendar({ version: 'v3', auth });

    // Fetch existing attendees first so we don't overwrite them
    const existing = await calendar.events.get({ calendarId: 'primary', eventId });
    const existingEmails = new Set((existing.data.attendees || []).map((a) => a.email));
    const merged = [
      ...(existing.data.attendees || []),
      ...attendees.filter((email) => !existingEmails.has(email)).map((email) => ({ email })),
    ];

    const res = await calendar.events.patch({
      calendarId: 'primary',
      eventId,
      sendUpdates: 'all',
      resource: { attendees: merged },
    });
    logger.info(`[calendar] Patched attendees on ${account} event ${eventId}: added ${attendees.join(', ')}`);
    return res.data;
  } catch (err) {
    logger.error(`[calendar] updateEventAttendees (${account}) failed:`, err.message);
    throw err;
  }
}

// ── Multi-account helpers ────────────────────────────────────────────────────

async function mergeFromAccounts(fetchFn) {
  const accounts = ['personal', 'asu'].filter(hasToken);
  const results = await Promise.allSettled(accounts.map((a) => fetchFn(a)));
  const all = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') all.push(...results[i].value);
    else logger.warn(`[calendar] ${accounts[i]} fetch failed:`, results[i].reason?.message);
  }
  return all.sort((a, b) => new Date(a.start) - new Date(b.start));
}

async function getTodayEventsAllAccounts() {
  return mergeFromAccounts(getTodayEvents);
}

async function getWeekEventsAllAccounts() {
  return mergeFromAccounts(getWeekEvents);
}

async function getUpcomingEventsAllAccounts(hours = 24) {
  return mergeFromAccounts((account) => getUpcomingEvents(hours, account));
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  getAuthedClient,
  hasToken,
  getTodayEvents,
  getWeekEvents,
  getUpcomingEvents,
  createEvent,
  deleteEvent,
  updateEventAttendees,
  getTodayEventsAllAccounts,
  getWeekEventsAllAccounts,
  getUpcomingEventsAllAccounts,
  SCOPES,
};
