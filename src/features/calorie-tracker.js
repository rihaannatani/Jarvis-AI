'use strict';
const logger = require('../logger');
const state = require('../state');
const { quickComplete } = require('../claude');
const { phoenixTodayStr } = require('../date-utils');

async function analyzeFood(imageBase64, imageMediaType) {
  const prompt = `You are a nutritionist analyzing a food photo. Identify the food/meal and estimate calories and macros.

Respond with ONLY valid JSON (no markdown, no explanation):
{
  "foods": [
    {
      "name": "food item",
      "calories": 150,
      "protein_g": 10,
      "carbs_g": 20,
      "fat_g": 5
    }
  ],
  "total_calories": 150,
  "confidence": "high",
  "notes": "brief description of what you see"
}

Be realistic with portion sizes. If unsure about exact portions, estimate based on plate/container size visible in image.`;

  try {
    const response = await quickComplete(
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: imageMediaType || 'image/jpeg',
              data: imageBase64,
            },
          },
          {
            type: 'text',
            text: prompt,
          },
        ],
      },
      {
        maxTokens: 500,
        purpose: 'food-analysis',
      }
    );

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    const analysis = JSON.parse(jsonMatch[0]);
    return analysis;
  } catch (err) {
    logger.error('[calorie-tracker] Food analysis failed:', err.message);
    throw err;
  }
}

async function logFood(foodName, calories, protein, carbs, fat, notes) {
  const today = phoenixTodayStr();
  state.addFoodLog(today, foodName, calories, protein, carbs, fat, notes);
  logger.info(`[calorie-tracker] Logged: ${foodName} (${calories} cal)`);
}

function getProgressMessage() {
  const today = phoenixTodayStr();
  const summary = state.getDailySummary(today);
  const profile = state.getCalorieProfile();

  if (!profile || !profile.setup_complete) {
    return '📊 Calorie tracking not set up yet. Run /setup_calories to start.';
  }

  const remaining = summary.target_calories - summary.total_calories;
  const percentOfGoal = Math.round((summary.total_calories / summary.target_calories) * 100);
  const statusEmoji = remaining > 200 ? '🟢' : remaining > 0 ? '🟡' : '🔴';

  let message = `📊 *Today's Progress*\n`;
  message += `${statusEmoji} ${summary.total_calories}/${summary.target_calories} cal (${percentOfGoal}%)\n`;
  message += `Remaining: ${Math.max(0, remaining)} cal\n\n`;

  if (summary.protein_g || summary.carbs_g || summary.fat_g) {
    message += `*Macros:*\n`;
    message += `🥚 Protein: ${Math.round(summary.protein_g || 0)}g\n`;
    message += `🍞 Carbs: ${Math.round(summary.carbs_g || 0)}g\n`;
    message += `🧈 Fat: ${Math.round(summary.fat_g || 0)}g\n\n`;
  }

  // Coaching
  if (remaining > 500) {
    message += `💡 *Advice:* You have room for a snack or meal. Consider eating something nutritious!`;
  } else if (remaining > 0) {
    message += `💡 *Advice:* Get close to your goal. A light snack might help.`;
  } else if (remaining > -200) {
    message += `💡 *Advice:* You've hit your goal! Stop here for the day unless you exercise.`;
  } else {
    message += `💡 *Advice:* You're over. No problem — the goal is an average, not perfection. Tomorrow reset!`;
  }

  return message;
}

async function setupCalories(sendFn) {
  const conversationId = Math.random().toString(36);
  const responses = {};

  const questions = [
    { key: 'age', text: '🎂 What\'s your age?' },
    { key: 'gender', text: '👤 Gender? (M/F)' },
    { key: 'height', text: '📏 Height in cm?' },
    { key: 'weight', text: '⚖️ Weight in kg?' },
    {
      key: 'activity',
      text: '🏃 Activity level?\n(sedentary, light, moderate, active, very_active)',
    },
    {
      key: 'goal',
      text: '🎯 Goal? (lose/maintain/gain)',
    },
    {
      key: 'goalRate',
      text: '⚡ Rate of change?\n(slow, moderate, aggressive)',
    },
  ];

  // In a real setup, this would be interactive. For now, return instruction message.
  let msg = '⚙️ *Calorie Tracker Setup*\n\n';
  msg += 'I\'ll help you set your calorie goal based on your health stats.\n\n';
  msg += 'Tell me: age, gender (M/F), height (cm), weight (kg), activity level (sedentary/light/moderate/active/very_active), goal (lose/maintain/gain), and rate (slow/moderate/aggressive).\n\n';
  msg += 'Example: "25, M, 180, 75, moderate, lose, moderate"';

  return msg;
}

function completeSetup(setupData) {
  // Parse from user input (comma-separated or structured message)
  const parts = setupData.split(/[,\s]+/).filter((p) => p.trim());
  if (parts.length < 7) {
    return 'Please provide all 7 values: age, gender, height, weight, activity, goal, rate';
  }

  const profile = {
    age: parseInt(parts[0], 10),
    gender: parts[1].toUpperCase(),
    heightCm: parseInt(parts[2], 10),
    weightKg: parseFloat(parts[3]),
    activityLevel: parts[4].toLowerCase(),
    goal: parts[5].toLowerCase(),
    goalRate: parts[6].toLowerCase(),
  };

  // Validate
  if (
    !profile.age || !profile.gender || !profile.heightCm || !profile.weightKg ||
    !['sedentary', 'light', 'moderate', 'active', 'very_active'].includes(profile.activityLevel) ||
    !['lose', 'maintain', 'gain'].includes(profile.goal) ||
    !['slow', 'moderate', 'aggressive'].includes(profile.goalRate)
  ) {
    return 'Invalid input. Please check your values and try again.';
  }

  state.saveCalorieProfile(profile);
  const savedProfile = state.getCalorieProfile();

  let msg = '✅ *Calorie Profile Saved*\n\n';
  msg += `Age: ${savedProfile.age}, Gender: ${savedProfile.gender}\n`;
  msg += `Height: ${savedProfile.height_cm}cm, Weight: ${savedProfile.weight_kg}kg\n`;
  msg += `Activity: ${savedProfile.activity_level}\n`;
  msg += `Goal: ${savedProfile.goal.toUpperCase()} (${savedProfile.goal_rate})\n\n`;
  msg += `📊 Your daily calorie target: *${savedProfile.daily_target} calories*\n`;
  msg += `(TDEE: ${savedProfile.tdee_calories} cal)\n\n`;
  msg += `Now send me food photos and I'll track your calories! 📸`;

  return msg;
}

module.exports = {
  analyzeFood,
  logFood,
  getProgressMessage,
  setupCalories,
  completeSetup,
};
