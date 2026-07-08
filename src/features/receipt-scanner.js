'use strict';
const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');
const logger = require('../logger');
const state = require('../state');

const MODEL = config.anthropic.model;

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

const CATEGORY_EMOJI = {
  produce:   '🥦',
  dairy:     '🥛',
  meat:      '🥩',
  seafood:   '🐟',
  frozen:    '🧊',
  pantry:    '🥫',
  snacks:    '🍿',
  drinks:    '🧃',
  household: '🧴',
  bread:     '🍞',
  eggs:      '🥚',
  leftovers: '🍱',
};

const CATEGORY_ORDER = ['produce', 'dairy', 'meat', 'seafood', 'frozen', 'eggs', 'bread', 'leftovers', 'snacks', 'drinks', 'pantry', 'household'];

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function formatDisplayDate(isoDate) {
  if (!isoDate) return 'unknown';
  const d = new Date(isoDate + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function daysUntil(isoDate) {
  if (!isoDate) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiry = new Date(isoDate + 'T00:00:00');
  return Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));
}

function buildSummaryMessage(items) {
  const grouped = {};
  for (const item of items) {
    const cat = item.category || 'pantry';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(item);
  }

  const lines = [`🧾 *Receipt scanned — ${items.length} item${items.length !== 1 ? 's' : ''} added*\n`];

  const orderedCats = [
    ...CATEGORY_ORDER.filter((c) => grouped[c]),
    ...Object.keys(grouped).filter((c) => !CATEGORY_ORDER.includes(c)),
  ];

  for (const cat of orderedCats) {
    const catItems = grouped[cat];
    const emoji = CATEGORY_EMOJI[cat] || '📦';
    const label = cat.charAt(0).toUpperCase() + cat.slice(1);
    lines.push(`${emoji} *${label}:*`);

    for (const item of catItems) {
      const days = daysUntil(item.expiry_date);
      const dateStr = item.expiry_date ? formatDisplayDate(item.expiry_date) : null;
      const loc = item.storage_location || 'unknown';

      let line = `• ${item.name} → ${loc}`;
      if (dateStr && days !== null) {
        if (days <= 0) {
          line += `, use today`;
        } else if (days === 1) {
          line += `, use by *tomorrow*`;
        } else {
          line += `, use by ${dateStr} (${days} days)`;
        }
      } else if (item.notes) {
        line += `, ${item.notes}`;
      }

      if (item.notes && dateStr) line += ` — _${item.notes}_`;
      lines.push(line);
    }
    lines.push('');
  }

  lines.push("I'll remind you a week before things expire and again on the last day.");
  return lines.join('\n').trim();
}

async function processReceiptImage(base64Image, caption = '') {
  const today = todayStr();
  const purchaseDate = today;

  const prompt = `This is a grocery/shopping receipt. Extract all food and household items purchased. For each item, estimate:
- Item name (clean, readable)
- Category (produce/dairy/meat/seafood/frozen/pantry/snacks/drinks/household/bread/eggs/leftovers)
- Typical expiry from purchase date (in days):
  * Produce (leafy greens): 5-7 days
  * Produce (fruits): 5-10 days
  * Produce (root vegetables): 14-28 days
  * Dairy (milk): 7-10 days
  * Dairy (cheese): 14-28 days
  * Meat (raw): 2-3 days fridge
  * Seafood: 1-2 days fridge
  * Frozen items: 90-180 days
  * Pantry items (canned/dry): 365 days
  * Bread: 5-7 days
  * Eggs: 21-35 days
  * Leftovers: 3-4 days
  * Snacks/drinks: 30-90 days
- Where to store it (fridge/freezer/pantry/counter)
- Any brief storage tip (optional, max 6 words)

Today's date is ${today}. Purchase date is ${purchaseDate}.${caption ? `\nAdditional context from user: ${caption}` : ''}

Reply ONLY with a valid JSON array, no markdown, no commentary:
[
  {
    "name": "Whole Milk",
    "category": "dairy",
    "expiry_days": 9,
    "expiry_date": "YYYY-MM-DD",
    "storage_location": "fridge",
    "storage_tip": "Keep on middle shelf"
  }
]`;

  logger.info('[receipt-scanner] Sending image to Claude Vision');

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: base64Image,
            },
          },
          { type: 'text', text: prompt },
        ],
      },
    ],
  });

  const usage = response.usage;
  if (usage) {
    state.logApiUsage('receipt-scan', MODEL, usage.input_tokens, usage.output_tokens);
    logger.info(`[receipt-scanner] Vision call — input: ${usage.input_tokens}, output: ${usage.output_tokens}`);
  }

  const rawText = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();

  // Strip markdown code fences if present
  const jsonStr = rawText.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();

  let items;
  try {
    items = JSON.parse(jsonStr);
    if (!Array.isArray(items)) throw new Error('Not an array');
  } catch (err) {
    logger.error('[receipt-scanner] Failed to parse Claude response:', err.message, '\nRaw:', rawText.slice(0, 500));
    throw new Error('Could not parse receipt — Claude returned unexpected output');
  }

  // Persist each item to DB
  const savedItems = [];
  for (const item of items) {
    if (!item.name) continue;
    const id = state.addPantryItem({
      name: item.name,
      category: item.category || 'pantry',
      purchase_date: purchaseDate,
      expiry_date: item.expiry_date || null,
      storage_location: item.storage_location || null,
      quantity: item.quantity || null,
      notes: item.storage_tip || null,
    });
    savedItems.push({ id, ...item });
  }

  logger.info(`[receipt-scanner] Saved ${savedItems.length} pantry items from receipt`);
  return { items: savedItems, summary: buildSummaryMessage(savedItems) };
}

module.exports = { processReceiptImage };
