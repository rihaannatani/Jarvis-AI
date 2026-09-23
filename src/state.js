'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const logger = require('./logger');
const { phoenixTodayStr } = require('./date-utils');

const dbPathRaw = config.app.dbPath;
const DB_PATH = dbPathRaw === ':memory:' ? ':memory:' : path.resolve(process.cwd(), dbPathRaw);

// Ensure the data directory exists (skip for in-memory DB)
if (DB_PATH !== ':memory:') {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new Database(DB_PATH);

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

  CREATE TABLE IF NOT EXISTS location_reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_chat_id TEXT NOT NULL,
    message TEXT NOT NULL,
    trigger_event TEXT NOT NULL,
    place_label TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'fired', 'cancelled')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    fired_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS calorie_profile (
    id INTEGER PRIMARY KEY,
    age INTEGER,
    gender TEXT CHECK(gender IN ('M', 'F')),
    height_cm INTEGER,
    weight_kg REAL,
    activity_level TEXT CHECK(activity_level IN ('sedentary', 'light', 'moderate', 'active', 'very_active')),
    goal TEXT CHECK(goal IN ('lose', 'maintain', 'gain')),
    goal_rate TEXT DEFAULT 'moderate' CHECK(goal_rate IN ('slow', 'moderate', 'aggressive')),
    tdee_calories INTEGER,
    daily_target INTEGER,
    setup_complete INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS food_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    log_date TEXT NOT NULL,
    food_name TEXT NOT NULL,
    calories INTEGER NOT NULL,
    protein_g REAL,
    carbs_g REAL,
    fat_g REAL,
    notes TEXT,
    image_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS daily_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    summary_date TEXT UNIQUE NOT NULL,
    total_calories INTEGER DEFAULT 0,
    target_calories INTEGER,
    protein_g REAL DEFAULT 0,
    carbs_g REAL DEFAULT 0,
    fat_g REAL DEFAULT 0,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

// ─── Location-reminder helpers ────────────────────────────────────────────────
// Fire on the next matching phone-side event (arrived/left/driving_start/
// driving_stop) instead of a specific time — see webhook-server.js.

function saveLocationReminder({ chatId, message, triggerEvent, placeLabel }) {
  const result = db
    .prepare(
      `INSERT INTO location_reminders (telegram_chat_id, message, trigger_event, place_label)
       VALUES (?, ?, ?, ?)`
    )
    .run(String(chatId), message, triggerEvent, placeLabel || null);
  return result.lastInsertRowid;
}

// place_label NULL on a reminder means "any place" — matches every event of
// that trigger_event type regardless of what place (if any) the event named.
function getPendingLocationReminders(triggerEvent, placeLabel) {
  return db
    .prepare(
      `SELECT * FROM location_reminders
       WHERE status = 'pending' AND trigger_event = ?
         AND (place_label IS NULL OR place_label = ?)`
    )
    .all(triggerEvent, placeLabel || null);
}

function listPendingLocationReminders(chatId) {
  return db
    .prepare(
      `SELECT * FROM location_reminders WHERE telegram_chat_id = ? AND status = 'pending'
       ORDER BY created_at DESC`
    )
    .all(String(chatId));
}

function markLocationReminderFired(id) {
  db.prepare(`UPDATE location_reminders SET status = 'fired', fired_at = datetime('now') WHERE id = ?`).run(id);
}

function cancelLocationReminder(id) {
  db.prepare(`UPDATE location_reminders SET status = 'cancelled' WHERE id = ?`).run(id);
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
  const cutoff = new Date(`${phoenixTodayStr()}T00:00:00`);
  cutoff.setDate(cutoff.getDate() + withinDays);
  const cutoffStr = cutoff.toLocaleDateString('en-CA');
  const todayStr = phoenixTodayStr();
  return db.prepare(
    `SELECT * FROM pantry_items
     WHERE consumed = 0
       AND expiry_date IS NOT NULL
       AND expiry_date >= ?
       AND expiry_date <= ?
     ORDER BY expiry_date ASC`
  ).all(todayStr, cutoffStr);
}

// ─── Calorie tracker helpers ──────────────────────────────────────────────────

function saveCalorieProfile(profile) {
  const { age, gender, heightCm, weightKg, activityLevel, goal, goalRate } = profile;
  const tdee = calculateTDEE(age, gender, heightCm, weightKg, activityLevel);
  const dailyTarget = calculateDailyTarget(tdee, goal, goalRate);
  db.prepare(
    `INSERT OR REPLACE INTO calorie_profile
     (age, gender, height_cm, weight_kg, activity_level, goal, goal_rate, tdee_calories, daily_target, setup_complete, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))`
  ).run(age, gender, heightCm, weightKg, activityLevel, goal, goalRate, tdee, dailyTarget);
}

function getCalorieProfile() {
  return db.prepare(`SELECT * FROM calorie_profile WHERE id = 1`).get();
}

function addFoodLog(logDate, foodName, calories, protein, carbs, fat, notes, imageUrl) {
  db.prepare(
    `INSERT INTO food_logs (log_date, food_name, calories, protein_g, carbs_g, fat_g, notes, image_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(logDate, foodName, calories, protein || null, carbs || null, fat || null, notes || null, imageUrl || null);
  updateDailySummary(logDate);
}

function getFoodLogs(logDate) {
  return db.prepare(`SELECT * FROM food_logs WHERE log_date = ? ORDER BY created_at ASC`).all(logDate);
}

function getDailySummary(summaryDate) {
  let summary = db.prepare(`SELECT * FROM daily_summaries WHERE summary_date = ?`).get(summaryDate);
  if (!summary) {
    const profile = getCalorieProfile();
    const target = profile?.daily_target || 2000;
    summary = {
      summary_date: summaryDate,
      total_calories: 0,
      target_calories: target,
      protein_g: 0,
      carbs_g: 0,
      fat_g: 0,
    };
  }
  return summary;
}

function updateDailySummary(logDate) {
  const logs = getFoodLogs(logDate);
  const profile = getCalorieProfile();
  const target = profile?.daily_target || 2000;
  const totals = logs.reduce(
    (acc, log) => ({
      calories: acc.calories + (log.calories || 0),
      protein: acc.protein + (log.protein_g || 0),
      carbs: acc.carbs + (log.carbs_g || 0),
      fat: acc.fat + (log.fat_g || 0),
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 }
  );
  db.prepare(
    `INSERT OR REPLACE INTO daily_summaries
     (summary_date, total_calories, target_calories, protein_g, carbs_g, fat_g, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(logDate, totals.calories, target, totals.protein, totals.carbs, totals.fat);
}

function calculateTDEE(age, gender, heightCm, weightKg, activityLevel) {
  // Mifflin-St Jeor equation for BMR
  let bmr = 10 * weightKg + 6.25 * heightCm - 5 * age;
  if (gender === 'F') bmr -= 161;
  else bmr += 5;

  const activityMultipliers = {
    sedentary: 1.2,
    light: 1.375,
    moderate: 1.55,
    active: 1.725,
    very_active: 1.9,
  };
  return Math.round(bmr * (activityMultipliers[activityLevel] || 1.55));
}

function calculateDailyTarget(tdee, goal, goalRate) {
  const rateFactors = {
    slow: 250,
    moderate: 500,
    aggressive: 750,
  };
  const deficit = rateFactors[goalRate] || 500;
  if (goal === 'lose') return tdee - deficit;
  if (goal === 'gain') return tdee + deficit;
  return tdee;
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
  saveLocationReminder,
  getPendingLocationReminders,
  listPendingLocationReminders,
  markLocationReminderFired,
  cancelLocationReminder,
  getSetting,
  setSetting,
  isAnnouncementSeen,
  markAnnouncementSeen,
  countSeenAnnouncements,
  getSeenAssignment,
  markAssignmentSeen,
  updateAssignmentDueAt,
  countSeenAssignments,
  saveCalorieProfile,
  getCalorieProfile,
  addFoodLog,
  getFoodLogs,
  getDailySummary,
  updateDailySummary,
  calculateTDEE,
  calculateDailyTarget,
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
