'use strict';
const { google } = require('googleapis');
const { getAuthedClient, hasToken } = require('./calendar');
const logger = require('../logger');

function gmailClient(account = 'personal') {
  const auth = getAuthedClient(account);
  return google.gmail({ version: 'v1', auth });
}

function decodeBase64(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function extractBody(payload) {
  if (!payload) return '';
  if (payload.body?.data) return decodeBase64(payload.body.data);
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) return decodeBase64(part.body.data);
    }
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return decodeBase64(part.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
    }
  }
  return '';
}

function getHeader(headers, name) {
  const h = headers?.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return h?.value || '';
}

async function getRecentEmails(sinceTimestamp, account = 'personal') {
  try {
    const gmail = gmailClient(account);
    const after = sinceTimestamp
      ? Math.floor(sinceTimestamp / 1000)
      : Math.floor((Date.now() - 15 * 60 * 1000) / 1000);

    const res = await gmail.users.messages.list({
      userId: 'me',
      q: `after:${after} -category:promotions -category:social`,
      maxResults: 30,
    });

    if (!res.data.messages?.length) return [];

    const messages = await Promise.all(
      res.data.messages.map(async (m) => {
        try {
          const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
          const headers = msg.data.payload?.headers || [];
          return {
            id: m.id,
            threadId: msg.data.threadId,
            from: getHeader(headers, 'From'),
            to: getHeader(headers, 'To'),
            cc: getHeader(headers, 'Cc'),
            subject: getHeader(headers, 'Subject'),
            date: getHeader(headers, 'Date'),
            snippet: msg.data.snippet,
            body: extractBody(msg.data.payload).slice(0, 1000),
            labelIds: msg.data.labelIds || [],
            account,
          };
        } catch { return null; }
      })
    );
    return messages.filter(Boolean);
  } catch (err) {
    logger.error(`[gmail] getRecentEmails (${account}) failed:`, err.message);
    throw err;
  }
}

async function getRecentEmailsAllAccounts(sinceTimestamp) {
  const accounts = ['personal', 'asu'].filter(hasToken);
  const results = await Promise.allSettled(accounts.map((a) => getRecentEmails(sinceTimestamp, a)));
  const all = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') all.push(...results[i].value);
    else logger.warn(`[gmail] getRecentEmails (${accounts[i]}) failed:`, results[i].reason?.message);
  }
  return all;
}

async function getEmailContent(id, account = 'personal') {
  try {
    const gmail = gmailClient(account);
    const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    const headers = msg.data.payload?.headers || [];
    return {
      id,
      threadId: msg.data.threadId,
      from: getHeader(headers, 'From'),
      to: getHeader(headers, 'To'),
      subject: getHeader(headers, 'Subject'),
      date: getHeader(headers, 'Date'),
      body: extractBody(msg.data.payload),
      snippet: msg.data.snippet,
      account,
    };
  } catch (err) {
    logger.error(`[gmail] getEmailContent (${account}) failed:`, err.message);
    throw err;
  }
}

async function getImportantEmails(account = 'personal') {
  try {
    const gmail = gmailClient(account);
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread -category:promotions -category:social -category:updates',
      maxResults: 20,
    });

    if (!res.data.messages?.length) return [];

    const messages = await Promise.all(
      res.data.messages.slice(0, 10).map(async (m) => {
        try {
          const msg = await gmail.users.messages.get({
            userId: 'me',
            id: m.id,
            format: 'metadata',
            metadataHeaders: ['From', 'Subject', 'Date'],
          });
          const headers = msg.data.payload?.headers || [];
          return {
            id: m.id,
            from: getHeader(headers, 'From'),
            subject: getHeader(headers, 'Subject'),
            snippet: msg.data.snippet,
            account,
          };
        } catch { return null; }
      })
    );
    return messages.filter(Boolean);
  } catch (err) {
    logger.error(`[gmail] getImportantEmails (${account}) failed:`, err.message);
    throw err;
  }
}

async function getImportantEmailsAllAccounts() {
  const accounts = ['personal', 'asu'].filter(hasToken);
  const results = await Promise.allSettled(accounts.map((a) => getImportantEmails(a)));
  const all = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') all.push(...results[i].value);
    else logger.warn(`[gmail] getImportantEmails (${accounts[i]}) failed:`, results[i].reason?.message);
  }
  return all;
}

function buildRaw(to, subject, body) {
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
  ].join('\r\n');
  const raw = `${headers}\r\n\r\n${body}`;
  return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function createDraft(to, subject, body, threadId, account = 'personal') {
  try {
    const gmail = gmailClient(account);
    const raw = buildRaw(to, subject, body);
    const res = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: { message: { raw, ...(threadId ? { threadId } : {}) } },
    });
    return res.data.id;
  } catch (err) {
    logger.error(`[gmail] createDraft (${account}) failed:`, err.message);
    throw err;
  }
}

async function sendRaw(to, subject, body, threadId, account = 'personal') {
  try {
    const gmail = gmailClient(account);
    const raw = buildRaw(to, subject, body);
    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw, ...(threadId ? { threadId } : {}) },
    });
    logger.info(`[gmail] Email sent to ${to} via ${account}`);
  } catch (err) {
    logger.error(`[gmail] sendRaw (${account}) failed:`, err.message);
    throw err;
  }
}

async function markAsRead(id, account = 'personal') {
  try {
    const gmail = gmailClient(account);
    await gmail.users.messages.modify({
      userId: 'me',
      id,
      requestBody: { removeLabelIds: ['UNREAD'] },
    });
  } catch (err) {
    logger.warn(`[gmail] markAsRead (${account}) failed:`, err.message);
  }
}

module.exports = {
  getRecentEmails,
  getRecentEmailsAllAccounts,
  getEmailContent,
  getImportantEmails,
  getImportantEmailsAllAccounts,
  createDraft,
  sendRaw,
  markAsRead,
};
