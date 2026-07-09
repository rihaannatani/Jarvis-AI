'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const logger = require('./logger');

const dbPathRaw = config.app.dbPath;
const DB_PATH = dbPathRaw === ':memory:' ? ':memory:' : path.resolve(process.cwd(), dbPathRaw);

// Ensure the data directory exists (skip for in-memory DB)
if (DB_PATH !== ':memory:') {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_chat_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pending_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_chat_id TEXT NOT NULL,
    email_id TEXT,
    thread_id TEXT,
    to_address TEXT,
    subject TEXT,
    draft_text TEXT NOT NULL,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'edited', 'discarded')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS seen_emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id TEXT UNIQUE NOT NULL,
    alerted_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_chat_id TEXT NOT NULL,
    message TEXT NOT NULL,
    fire_at DATETIME NOT NULL,
    fired INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Memories table
db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT,
    content TEXT,
    source TEXT DEFAULT 'auto',
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Tasks table — dedicated to-dos, separate from the general memories table
// so they get a real due_date and done state instead of sharing memories'
// blunt active/inactive flag with facts/preferences/context.
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    due_date TEXT,
    done INTEGER DEFAULT 0,
    source TEXT DEFAULT 'auto',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    done_at DATETIME
  );
`);

// Canvas watcher tables
db.exec(`
  CREATE TABLE IF NOT EXISTS seen_announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    announcement_id TEXT UNIQUE,
    course_name TEXT,
    alerted_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS seen_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assignment_id TEXT UNIQUE,
    course_id TEXT,
    due_at TEXT,
    alerted_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Maps travel-time cache (30-min TTL)
db.exec(`
  CREATE TABLE IF NOT EXISTS maps_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cache_key TEXT UNIQUE NOT NULL,
    result TEXT NOT NULL,
    cached_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// API usage log for cost tracking
db.exec(`
  CREATE TABLE IF NOT EXISTS api_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purpose TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    logged_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Workday job watcher table
db.exec(`
  CREATE TABLE IF NOT EXISTS seen_workday_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT UNIQUE NOT NULL,
    title TEXT,
    url TEXT,
    applied INTEGER DEFAULT 0,
    seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    applied_at DATETIME
  );
`);

// Pantry / food expiry tracking
db.exec(`
  CREATE TABLE IF NOT EXISTS pantry_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT,
    purchase_date TEXT,
    expiry_date TEXT,
    storage_location TEXT,
    quantity TEXT,
    notes TEXT,
    consumed INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS expiry_alerts_sent (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pantry_item_id INTEGER,
    alert_type TEXT,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migrations for existing DBs
try { db.exec(`ALTER TABLE pending_drafts ADD COLUMN account TEXT DEFAULT 'personal'`); } catch { /* already exists */ }

logger.info('[state] Database ready at ' + DB_PATH);

// ─── Conversation helpers ────────────────────────────────────────────────────

// Raised from 30 — history now also captures proactive notifications
// (email/Canvas alerts, reminders, briefs), which consume slots faster
// than pure back-and-forth chat did.
const MAX_MESSAGES = 50;

function getMessages(chatId) {
  return db
    .prepare(
      `SELECT role, content FROM conversations
       WHERE telegram_chat_id = ?
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(String(chatId), MAX_MESSAGES)
    .reverse();
}

function saveMessage(chatId, role, content) {
  db.prepare(
    `INSERT INTO conversations (telegram_chat_id, role, content) VALUES (?, ?, ?)`
  ).run(String(chatId), role, content);

  // Prune old messages beyond MAX_MESSAGES
  db.prepare(
    `DELETE FROM conversations
     WHERE telegram_chat_id = ? AND id NOT IN (
       SELECT id FROM conversations WHERE telegram_chat_id = ?
       ORDER BY created_at DESC LIMIT ?
     )`
  ).run(String(chatId), String(chatId), MAX_MESSAGES);
}

// ─── Draft helpers ────────────────────────────────────────────────────────────

function saveDraft({ chatId, emailId, threadId, toAddress, subject, draftText, account = 'personal' }) {
  const result = db
    .prepare(
      `INSERT INTO pending_drafts (telegram_chat_id, email_id, thread_id, to_address, subject, draft_text, account)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(String(chatId), emailId, threadId, toAddress, subject, draftText, account);
  return result.lastInsertRowid;
}

function getPendingDrafts(chatId) {
  return db
    .prepare(
      `SELECT * FROM pending_drafts WHERE telegram_chat_id = ? AND status = 'pending'
       ORDER BY created_at DESC`
    )
    .all(String(chatId));
}

function getPendingDraft(chatId) {
  return db
    .prepare(
      `SELECT * FROM pending_drafts WHERE telegram_chat_id = ? AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(String(chatId));
}

function updateDraftStatus(draftId, status) {
  db.prepare(`UPDATE pending_drafts SET status = ? WHERE id = ?`).run(status, draftId);
}

function updateDraftText(draftId, newText) {
  db.prepare(`UPDATE pending_drafts SET draft_text = ? WHERE id = ?`).run(newText, draftId);
}

function getDraftById(draftId) {
  return db.prepare(`SELECT * FROM pending_drafts WHERE id = ?`).get(draftId);
}

function discardAllPendingDrafts(chatId) {
  const result = db
    .prepare(`UPDATE pending_drafts SET status = 'discarded' WHERE telegram_chat_id = ? AND status = 'pending'`)
    .run(String(chatId));
  return result.changes;
}

// ─── Seen email helpers ───────────────────────────────────────────────────────

function isEmailSeen(emailId) {
  return !!db.prepare(`SELECT 1 FROM seen_emails WHERE email_id = ?`).get(emailId);
}

function markEmailSeen(emailId) {
  db.prepare(`INSERT OR IGNORE INTO seen_emails (email_id) VALUES (?)`).run(emailId);
}

// ─── Reminder helpers ─────────────────────────────────────────────────────────

function saveReminder(chatId, message, fireAt) {
  db.prepare(
    `INSERT INTO reminders (telegram_chat_id, message, fire_at) VALUES (?, ?, ?)`
  ).run(String(chatId), message, fireAt);
}

function getDueReminders() {
  return db
    .prepare(
      `SELECT * FROM reminders WHERE fired = 0 AND fire_at <= datetime('now')`
    )
    .all();
}

function markReminderFired(reminderId) {
  db.prepare(`UPDATE reminders SET fired = 1 WHERE id = ?`).run(reminderId);
}

// ─── Settings helpers ─────────────────────────────────────────────────────────

function getSetting(key) {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, String(value));
}

// ─── Canvas watcher helpers ───────────────────────────────────────────────────

function isAnnouncementSeen(announcementId) {
  return !!db.prepare(`SELECT 1 FROM seen_announcements WHERE announcement_id = ?`).get(announcementId);
}

function markAnnouncementSeen(announcementId, courseName) {
  db.prepare(`INSERT OR IGNORE INTO seen_announcements (announcement_id, course_name) VALUES (?, ?)`).run(announcementId, courseName || '');
}

function countSeenAnnouncements() {
  return db.prepare(`SELECT COUNT(*) as count FROM seen_announcements`).get().count;
}

function getSeenAssignment(assignmentId) {
  return db.prepare(`SELECT * FROM seen_assignments WHERE assignment_id = ?`).get(assignmentId);
}

function markAssignmentSeen(assignmentId, courseId, dueAt) {
  db.prepare(`INSERT OR IGNORE INTO seen_assignments (assignment_id, course_id, due_at) VALUES (?, ?, ?)`).run(assignmentId, courseId || '', dueAt || '');
}

function updateAssignmentDueAt(assignmentId, dueAt) {
  db.prepare(`UPDATE seen_assignments SET due_at = ? WHERE assignment_id = ?`).run(dueAt, assignmentId);
}

function countSeenAssignments() {
  return db.prepare(`SELECT COUNT(*) as count FROM seen_assignments`).get().count;
}

// ─── Memory helpers ───────────────────────────────────────────────────────────

const CATEGORY_LABELS = {
  task: 'Tasks',
  fact: 'Facts',
  preference: 'Preferences',
  reminder: 'Reminders',
  context: 'Context',
};

function saveMemory(category, content, source = 'auto') {
  const result = db.prepare(
    `INSERT INTO memories (category, content, source) VALUES (?, ?, ?)`
  ).run(category || 'fact', content, source);
  return result.lastInsertRowid;
}

function forgetMemory(id) {
  db.prepare(`UPDATE memories SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
}

function listActiveMemories() {
  return db.prepare(
    `SELECT id, category, content, source, created_at FROM memories WHERE active = 1 ORDER BY category, created_at DESC`
  ).all();
}

// Returns a formatted string ready to append to the system prompt, or '' if no memories.
function getActiveMemories() {
  const memories = listActiveMemories();
  if (!memories.length) return '';

  const byCategory = {};
  for (const m of memories) {
    const cat = m.category || 'context';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(m);
  }

  const sections = Object.entries(byCategory).map(([cat, mems]) => {
    const label = CATEGORY_LABELS[cat] || (cat.charAt(0).toUpperCase() + cat.slice(1));
    const bullets = mems.map((m) => `- [#${m.id}] ${m.content}`).join('\n');
    return `*${label}:*\n${bullets}`;
  });

  return `\n\n## What I remember about you:\n${sections.join('\n\n')}`;
}

// ─── Task helpers ─────────────────────────────────────────────────────────────

function addTask(content, dueDate, source = 'auto') {
  const result = db.prepare(
    `INSERT INTO tasks (content, due_date, source) VALUES (?, ?, ?)`
  ).run(content, dueDate || null, source);
  return result.lastInsertRowid;
}

function listOpenTasks() {
  return db.prepare(
    `SELECT id, content, due_date, source, created_at FROM tasks WHERE done = 0 ORDER BY (due_date IS NULL), due_date ASC, created_at ASC`
  ).all();
}

function getTask(id) {
  return db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
}

function completeTask(id) {
  db.prepare(`UPDATE tasks SET done = 1, done_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
}

function deleteTask(id) {
  db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
}

// ─── Maps cache helpers ───────────────────────────────────────────────────────

const MAPS_CACHE_TTL_MIN = 30;

function getMapsCache(key) {
  const row = db.prepare(
    `SELECT result FROM maps_cache
     WHERE cache_key = ?
       AND cached_at >= datetime('now', '-${MAPS_CACHE_TTL_MIN} minutes')`
  ).get(key);
  return row ? JSON.parse(row.result) : null;
}

function setMapsCache(key, result) {
  db.prepare(
    `INSERT OR REPLACE INTO maps_cache (cache_key, result, cached_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)`
  ).run(key, JSON.stringify(result));
}

// ─── API usage helpers ────────────────────────────────────────────────────────

function logApiUsage(purpose, model, inputTokens, outputTokens) {
  db.prepare(
    `INSERT INTO api_usage (purpose, model, input_tokens, output_tokens) VALUES (?, ?, ?, ?)`
  ).run(purpose, model, inputTokens, outputTokens);
}

function getApiUsageToday() {
  return db.prepare(
    `SELECT
       SUM(input_tokens)  AS input_tokens,
       SUM(output_tokens) AS output_tokens,
       COUNT(*)           AS calls
     FROM api_usage
     WHERE logged_at >= date('now')`
  ).get();
}

// ─── Workday job watcher helpers ──────────────────────────────────────────────

function isWorkdayJobSeen(jobId) {
  return !!db.prepare(`SELECT 1 FROM seen_workday_jobs WHERE job_id = ?`).get(jobId);
}

function markWorkdayJobSeen(jobId, title, url) {
  db.prepare(
    `INSERT OR IGNORE INTO seen_workday_jobs (job_id, title, url) VALUES (?, ?, ?)`
  ).run(jobId, title || '', url || '');
}

function markWorkdayJobApplied(jobId) {
  db.prepare(
    `UPDATE seen_workday_jobs SET applied = 1, applied_at = CURRENT_TIMESTAMP WHERE job_id = ?`
  ).run(jobId);
}

function getWorkdayStats() {
  return db.prepare(
    `SELECT COUNT(*) as total_seen, SUM(applied) as total_applied FROM seen_workday_jobs`
  ).get();
}

// ─── Pantry helpers ───────────────────────────────────────────────────────────

function addPantryItem({ name, category, purchase_date, expiry_date, storage_location, quantity, notes }) {
  const result = db.prepare(
    `INSERT INTO pantry_items (name, category, purchase_date, expiry_date, storage_location, quantity, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(name, category || null, purchase_date || null, expiry_date || null, storage_location || null, quantity || null, notes || null);
  return result.lastInsertRowid;
}

function getActivePantryItems() {
  return db.prepare(
    `SELECT * FROM pantry_items WHERE consumed = 0 ORDER BY expiry_date ASC NULLS LAST`
  ).all();
}

function markPantryItemConsumed(itemName) {
  const item = db.prepare(
    `SELECT id FROM pantry_items WHERE consumed = 0 AND name LIKE ? LIMIT 1`
  ).get(`%${itemName}%`);
  if (!item) return false;
  db.prepare(`UPDATE pantry_items SET consumed = 1 WHERE id = ?`).run(item.id);
  return true;
}

function isExpiryAlertSent(pantryItemId, alertType) {
  return !!db.prepare(
    `SELECT 1 FROM expiry_alerts_sent WHERE pantry_item_id = ? AND alert_type = ?`
  ).get(pantryItemId, alertType);
}

function markExpiryAlertSent(pantryItemId, alertType) {
  db.prepare(
    `INSERT INTO expiry_alerts_sent (pantry_item_id, alert_type) VALUES (?, ?)`
  ).run(pantryItemId, alertType);
}

function getExpiringPantryItems(withinDays) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + withinDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const todayStr = new Date().toISOString().slice(0, 10);
  return db.prepare(
    `SELECT * FROM pantry_items
     WHERE consumed = 0
       AND expiry_date IS NOT NULL
       AND expiry_date >= ?
       AND expiry_date <= ?
     ORDER BY expiry_date ASC`
  ).all(todayStr, cutoffStr);
}

module.exports = {
  db,
  getMessages,
  saveMemory,
  forgetMemory,
  listActiveMemories,
  getActiveMemories,
  addTask,
  listOpenTasks,
  getTask,
  completeTask,
  deleteTask,
  saveMessage,
  saveDraft,
  getPendingDrafts,
  getPendingDraft,
  updateDraftStatus,
  updateDraftText,
  getDraftById,
  discardAllPendingDrafts,
  isEmailSeen,
  markEmailSeen,
  saveReminder,
  getDueReminders,
  markReminderFired,
  getSetting,
  setSetting,
  isAnnouncementSeen,
  markAnnouncementSeen,
  countSeenAnnouncements,
  getSeenAssignment,
  markAssignmentSeen,
  updateAssignmentDueAt,
  countSeenAssignments,
  getMapsCache,
  setMapsCache,
  logApiUsage,
  getApiUsageToday,
  isWorkdayJobSeen,
  markWorkdayJobSeen,
  markWorkdayJobApplied,
  getWorkdayStats,
  addPantryItem,
  getActivePantryItems,
  markPantryItemConsumed,
  isExpiryAlertSent,
  markExpiryAlertSent,
  getExpiringPantryItems,
};
