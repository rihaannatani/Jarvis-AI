'use strict';
const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const logger = require('./logger');
const state = require('./state');
const { buildSystemPrompt } = require('./prompts/system');

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

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
        fire_at: {
          type: 'string',
          description: 'ISO 8601 datetime string (America/Phoenix timezone)',
        },
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
        start: { type: 'string', description: "ISO 8601 datetime e.g. 2026-05-25T18:00:00 in America/Phoenix" },
        end: { type: 'string', description: "ISO 8601 datetime e.g. 2026-05-25T20:00:00 in America/Phoenix" },
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
        source: { type: 'string', enum: ['user', 'auto'], description: "user = explicitly asked, auto = extracted from conversation" },
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
        account: { type: 'string', enum: ['personal', 'asu'], description: "Which calendar the event is on" },
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
        account: { type: 'string', enum: ['personal', 'asu'], description: "Which calendar the event is on" },
      },
      required: ['event_id', 'attendees'],
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
];

async function executeTool(toolName, toolInput, chatId) {
  // Lazy-load integrations to avoid circular deps and keep startup fast
  const router = require('./router');
  try {
    return await router.execute(toolName, toolInput, chatId);
  } catch (err) {
    logger.error(`[claude] Tool ${toolName} failed:`, err.message);
    return { error: `${toolName} is temporarily unavailable` };
  }
}

async function chat(chatId, userMessage) {
  // Load conversation history from DB
  const history = state.getMessages(chatId);
  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  // Save user message
  state.saveMessage(chatId, 'user', userMessage);

  const systemPrompt = buildSystemPrompt(state.getActiveMemories());
  let currentMessages = [...messages];

  // Agentic loop — Claude may call tools multiple times before final answer
  for (let i = 0; i < 10; i++) {
    const response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 4096,
      system: systemPrompt,
      tools: TOOLS,
      messages: currentMessages,
    });

    logger.debug(`[claude] stop_reason: ${response.stop_reason}, turn: ${i + 1}`);

    if (response.stop_reason === 'end_turn') {
      const textContent = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();

      state.saveMessage(chatId, 'assistant', textContent);
      return textContent;
    }

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');

      // Add Claude's response (including tool_use blocks) to message history
      currentMessages.push({ role: 'assistant', content: response.content });

      // Execute all tools (in parallel if multiple were called)
      const toolResults = await Promise.all(
        toolUseBlocks.map(async (block) => {
          const result = await executeTool(block.name, block.input, chatId);
          return {
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
          };
        })
      );

      // Feed results back to Claude
      currentMessages.push({ role: 'user', content: toolResults });
      continue;
    }

    // Unexpected stop reason
    logger.warn('[claude] Unexpected stop_reason:', response.stop_reason);
    break;
  }

  const fallback = "I ran into an issue processing that. Try again in a moment.";
  state.saveMessage(chatId, 'assistant', fallback);
  return fallback;
}

// One-shot call with no conversation memory (for briefs, emails, etc.)
async function complete(prompt, { system, maxTokens = 4096 } = {}) {
  const response = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: maxTokens,
    system: system || buildSystemPrompt(),
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

module.exports = { chat, complete };
