'use strict';
// Teams integration is disabled. Stub returns empty data.

async function getUnreadMessages() {
  return { count: 0, messages: [] };
}

async function getMentions() {
  return [];
}

async function getRecentActivity() {
  return { unread: 0, mentions: 0 };
}

module.exports = { getUnreadMessages, getMentions, getRecentActivity };
