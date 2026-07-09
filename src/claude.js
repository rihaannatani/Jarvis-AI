'use strict';
const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const logger = require('./logger');
const state = require('./state');
const { buildSystemPrompt } = require('./prompts/system');

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

const MODEL_SMART = config.anthropic.model;       // sonnet — conversation, briefs, drafts
const MODEL_FAST  = config.anthropic.modelFast;   // haiku  — scoring, simple formatting

// Sonnet pricing (per 1K tokens)
const COST_PER_1K = {
  input:  0.003,
  output: 0.015,
};

function logUsage(purpose, model, usage) {
  const { input_tokens: i, output_tokens: o } = usage;
  const cost = ((i / 1000) * COST_PER_1K.input + (o / 1000) * COST_PER_1K.output).toFixed(4);
  logger.info(`[claude] ${purpose} — input: ${i}, output: ${o}, ~$${cost} (${model.split('-').slice(-2).join('-')})`);
  state.logApiUsage(purpose, model, i, o);
}

// Tool definitions that Claude can call to fetch live data
const TOOLS = [
  {
    name: 'get_calendar_today',
    description: "Get today's calendar events from Google Calendar",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_calendar_week',
    description: 'Get calendar events for the next 7 days',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_weather',
    description: 'Get current weather conditions and forecast for Phoenix, AZ',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_canvas_assignments',
    description: 'Get upcoming Canvas LMS assignments and deadlines',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_canvas_announcements',
    description: 'Get recent Canvas LMS course announcements',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_gmail_important',
    description: 'Get a summary of important unread emails',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'set_reminder',
    description: 'Set a reminder to fire at a specific time',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The reminder message to send' },
        fire_at: { type: 'string', description: 'ISO 8601 datetime string (America/Phoenix timezone)' },
      },
      required: ['message', 'fire_at'],
    },
  },
  {
    name: 'create_calendar_event',
    description: "Create a new event on the user's Google Calendar",
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Event title' },
        start: { type: 'string', description: 'ISO 8601 datetime e.g. 2026-05-25T18:00:00 in America/Phoenix' },
        end: { type: 'string', description: 'ISO 8601 datetime e.g. 2026-05-25T20:00:00 in America/Phoenix' },
        description: { type: 'string', description: 'Optional notes or event description' },
        account: {
          type: 'string',
          enum: ['personal', 'asu'],
          description: "Which Google calendar to add it to. Default 'asu' for school/work, 'personal' for everything else.",
        },
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description: 'Email addresses to invite. They will receive a calendar invite automatically.',
        },
      },
      required: ['summary', 'start', 'end'],
    },
  },
  {
    name: 'get_pending_drafts',
    description: 'Check for email drafts pending approval',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_email_content',
    description: "Fetch the full original body of a specific email — use this when the user asks to re-check, re-read, or find details in an email that's no longer in the recent unread scan (e.g. it's already been processed into a draft, or fell out of get_gmail_important). Prefer draft_id when the request is about a pending draft's source email.",
    input_schema: {
      type: 'object',
      properties: {
        draft_id: { type: 'number', description: "The draft ID from get_pending_drafts — resolves to that draft's original email automatically" },
        email_id: { type: 'string', description: 'The Gmail message ID, if known directly (not needed if draft_id is given)' },
        account: { type: 'string', enum: ['personal', 'asu'], description: 'Which inbox, if using email_id directly' },
      },
      required: [],
    },
  },
  {
    name: 'send_draft',
    description: 'Approve and send a pending email draft. Use this whenever the user asks to send/approve a draft in natural conversation, not just via the exact word "approve".',
    input_schema: {
      type: 'object',
      properties: {
        draft_id: { type: 'number', description: 'The draft ID from get_pending_drafts. If omitted, sends the most recently created pending draft.' },
      },
      required: [],
    },
  },
  {
    name: 'discard_draft',
    description: 'Discard a single pending email draft without sending it',
    input_schema: {
      type: 'object',
      properties: {
        draft_id: { type: 'number', description: 'The draft ID from get_pending_drafts. If omitted, discards the most recently created pending draft.' },
      },
      required: [],
    },
  },
  {
    name: 'discard_all_drafts',
    description: 'Discard every pending email draft at once — use when the user wants to clear the whole backlog (e.g. "clear all my drafts")',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'add_task',
    description: 'Add a to-do task to the tracked task list. Use this for anything Rihaan needs to get done, as opposed to save_memory which is for facts/preferences/context.',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'What needs to be done' },
        due_date: { type: 'string', description: 'Optional due date, ISO 8601 (YYYY-MM-DD or full datetime)' },
        source: { type: 'string', enum: ['user', 'auto'], description: 'user = explicitly asked, auto = inferred from conversation' },
      },
      required: ['content'],
    },
  },
  {
    name: 'complete_task',
    description: 'Mark a tracked task as done',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'The numeric task ID shown as [#N] in the task list' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'list_tasks',
    description: 'Get the list of currently open (not done) tracked tasks',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'save_memory',
    description: 'Persist an important fact, task, preference, or context so it survives across conversations',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'What to remember' },
        category: {
          type: 'string',
          enum: ['task', 'fact', 'preference', 'reminder', 'context'],
          description: 'task = something to do, fact = personal info, preference = how they like things, reminder = time-sensitive, context = general background',
        },
        source: { type: 'string', enum: ['user', 'auto'], description: 'user = explicitly asked, auto = extracted from conversation' },
      },
      required: ['content', 'category'],
    },
  },
  {
    name: 'forget_memory',
    description: 'Mark a memory as done or no longer relevant',
    input_schema: {
      type: 'object',
      properties: {
        memory_id: { type: 'number', description: 'The numeric ID shown as [#N] in the memory list' },
      },
      required: ['memory_id'],
    },
  },
  {
    name: 'list_memories',
    description: 'Retrieve all currently active memories',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'delete_calendar_event',
    description: 'Delete a calendar event by its event ID',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'The Google Calendar event ID' },
        account: { type: 'string', enum: ['personal', 'asu'], description: 'Which calendar the event is on' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'update_event_attendees',
    description: 'Add guests to an existing calendar event — sends them an invite',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'The Google Calendar event ID' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'Email addresses to add as guests' },
        account: { type: 'string', enum: ['personal', 'asu'], description: 'Which calendar the event is on' },
      },
      required: ['event_id', 'attendees'],
    },
  },
  {
    name: 'update_calendar_event',
    description: 'Reschedule, retitle, relocate, or redescribe an existing calendar event. Only pass the fields that are changing.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'The Google Calendar event ID' },
        summary: { type: 'string', description: 'New event title, if changing' },
        start: { type: 'string', description: 'New ISO 8601 start datetime in America/Phoenix, if changing' },
        end: { type: 'string', description: 'New ISO 8601 end datetime in America/Phoenix, if changing' },
        location: { type: 'string', description: 'New location, if changing' },
        description: { type: 'string', description: 'New description, if changing' },
        account: { type: 'string', enum: ['personal', 'asu'], description: 'Which calendar the event is on' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'get_travel_time',
    description: 'Get drive time from home (or a custom origin) to a destination, including live traffic',
    input_schema: {
      type: 'object',
      properties: {
        destination: { type: 'string', description: 'Where they are going' },
        origin: { type: 'string', description: 'Starting point — defaults to home address if omitted' },
        mode: { type: 'string', enum: ['driving', 'walking', 'transit'], description: 'Travel mode, default driving' },
      },
      required: ['destination'],
    },
  },
  {
    name: 'find_nearby_places',
    description: 'Find restaurants, coffee, stores, or any place near a location',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for, e.g. "coffee near ASU Tempe"' },
        location: { type: 'string', description: 'lat,lng or area name to search near — defaults to Phoenix area' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_directions',
    description: 'Get turn-by-turn directions and route summary between two places',
    input_schema: {
      type: 'object',
      properties: {
        destination: { type: 'string', description: 'Where they want to go' },
        origin: { type: 'string', description: 'Starting point — defaults to home address if omitted' },
        mode: { type: 'string', enum: ['driving', 'walking', 'transit'], description: 'Travel mode, default driving' },
      },
      required: ['destination'],
    },
  },
  {
    name: 'get_pantry',
    description: "Get list of food items in the pantry/fridge, optionally filtered",
    input_schema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: ['all', 'expiring_soon', 'expired', 'by_location'],
          description: 'all = everything active, expiring_soon = within 7 days, expired = past expiry date, by_location = grouped by fridge/freezer/pantry/counter',
        },
      },
      required: [],
    },
  },
  {
    name: 'mark_consumed',
    description: 'Mark a pantry item as used up or thrown away',
    input_schema: {
      type: 'object',
      properties: {
        item_name: { type: 'string', description: 'Name of the pantry item (partial match is fine)' },
      },
      required: ['item_name'],
    },
  },
  {
    name: 'add_pantry_item',
    description: 'Manually add a food item to the pantry without scanning a receipt',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Item name' },
        expiry_date: { type: 'string', description: 'Expiry date as YYYY-MM-DD' },
        storage_location: { type: 'string', enum: ['fridge', 'freezer', 'pantry', 'counter'], description: 'Where to store it' },
        category: { type: 'string', description: 'produce/dairy/meat/seafood/frozen/pantry/snacks/drinks/bread/eggs' },
        notes: { type: 'string', description: 'Optional storage tip or note' },
      },
      required: ['name'],
    },
  },
];

// Keywords mapping topics to memory categories/terms for relevance filtering
const TOPIC_KEYWORDS = {
  calendar: ['calendar', 'event', 'meeting', 'schedule', 'appointment', 'class', 'today', 'tomorrow', 'week'],
  school:   ['assignment', 'homework', 'canvas', 'class', 'course', 'grade', 'exam', 'quiz', 'asu', 'professor', 'due'],
  email:    ['email', 'gmail', 'message', 'reply', 'draft', 'inbox', 'sent'],
  maps:     ['drive', 'travel', 'directions', 'traffic', 'restaurant', 'place', 'near', 'location', 'get to'],
  weather:  ['weather', 'rain', 'temperature', 'forecast', 'hot', 'cold', 'sunny'],
  pantry:   ['pantry', 'fridge', 'freezer', 'food', 'groceries', 'receipt', 'expir', 'expired', 'milk', 'chicken', 'produce', 'consume', 'toss', 'ate', 'used up', 'pantry'],
};

function getRelevantMemories(userMessage) {
  const all = state.listActiveMemories();
  if (!all.length) return '';

  const msg = userMessage.toLowerCase();

  // Determine which topics the message touches
  const activeTopics = Object.entries(TOPIC_KEYWORDS)
    .filter(([, kw]) => kw.some((k) => msg.includes(k)))
    .map(([topic]) => topic);

  // If no specific topic detected, fall back to all memories (keeps task/fact always)
  if (!activeTopics.length) return state.getActiveMemories();

  // Always include tasks and facts; filter context/preference/reminder by relevance
  const relevant = all.filter((m) => {
    if (['task', 'fact'].includes(m.category)) return true;
    const content = (m.content || '').toLowerCase();
    return activeTopics.some((topic) =>
      TOPIC_KEYWORDS[topic].some((kw) => content.includes(kw))
    );
  });

  if (!relevant.length) return '';

  const byCategory = {};
  for (const m of relevant) {
    const cat = m.category || 'context';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(m);
  }

  const LABELS = { task: 'Tasks', fact: 'Facts', preference: 'Preferences', reminder: 'Reminders', context: 'Context' };
  const sections = Object.entries(byCategory).map(([cat, mems]) => {
    const label = LABELS[cat] || cat;
    return `*${label}:*\n${mems.map((m) => `- [#${m.id}] ${m.content}`).join('\n')}`;
  });

  return `\n\n## What I remember about you:\n${sections.join('\n\n')}`;
}

async function executeTool(toolName, toolInput, chatId) {
  const router = require('./router');
  try {
    return await router.execute(toolName, toolInput, chatId);
  } catch (err) {
    logger.error(`[claude] Tool ${toolName} failed:`, err.message);
    return { error: `${toolName} is temporarily unavailable` };
  }
}

// The Anthropic API requires strictly alternating user/assistant turns.
// History now includes proactive notifications (email/Canvas alerts,
// reminders, draft previews) saved back-to-back with no user turn between
// them, so collapse consecutive same-role entries into one before sending.
function collapseConsecutiveRoles(msgs) {
  const out = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`;
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

async function chat(chatId, userMessage) {
  const history = state.getMessages(chatId);  // capped at MAX_MESSAGES in state.js
  // Last 16 messages — raised from 10 now that history also includes
  // proactive notifications, which would otherwise crowd out real
  // back-and-forth turns before the model ever sees them.
  const recentHistory = history.slice(-16);
  const messages = collapseConsecutiveRoles([
    ...recentHistory.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ]);

  state.saveMessage(chatId, 'user', userMessage);

  const relevantMemories = getRelevantMemories(userMessage);
  const systemPrompt = buildSystemPrompt(relevantMemories);
  let currentMessages = [...messages];

  for (let i = 0; i < 10; i++) {
    const response = await anthropic.messages.create({
      model: MODEL_SMART,
      max_tokens: 1024,
      system: systemPrompt,
      tools: TOOLS,
      messages: currentMessages,
    });

    logger.debug(`[claude] stop_reason: ${response.stop_reason}, turn: ${i + 1}`);
    if (response.usage) logUsage('conversation', MODEL_SMART, response.usage);

    if (response.stop_reason === 'end_turn') {
      // Not saved here — sendSafe() saves it once the reply is actually
      // delivered, so history reflects what the user was shown, not just
      // what got generated (same single save-point every other outbound
      // message goes through).
      const textContent = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();

      return textContent;
    }

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
      currentMessages.push({ role: 'assistant', content: response.content });

      const toolResults = await Promise.all(
        toolUseBlocks.map(async (block) => {
          const result = await executeTool(block.name, block.input, chatId);
          return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) };
        })
      );

      currentMessages.push({ role: 'user', content: toolResults });
      continue;
    }

    logger.warn('[claude] Unexpected stop_reason:', response.stop_reason);
    break;
  }

  return "I ran into an issue processing that. Try again in a moment.";
}

// Full-context Sonnet call — briefs, email drafts, complex reasoning
async function complete(prompt, { system, maxTokens = 1024, purpose = 'complete' } = {}) {
  const response = await anthropic.messages.create({
    model: MODEL_SMART,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content: prompt }],
  });

  if (response.usage) logUsage(purpose, MODEL_SMART, response.usage);

  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// Cheap Haiku call — scoring, formatting, single-fact lookups
async function quickComplete(prompt, { maxTokens = 256, purpose = 'quick' } = {}) {
  const response = await anthropic.messages.create({
    model: MODEL_FAST,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });

  if (response.usage) logUsage(purpose, MODEL_FAST, response.usage);

  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

module.exports = { chat, complete, quickComplete };
