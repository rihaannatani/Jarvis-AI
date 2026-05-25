'use strict';
require('dotenv').config();

const REQUIRED = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_MY_CHAT_ID',
  'ANTHROPIC_API_KEY',
  'OPENWEATHERMAP_API_KEY',
];

const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`[config] Missing required env vars: ${missing.join(', ')}`);
  console.error('[config] Copy .env.example to .env and fill in all values.');
  process.exit(1);
}

const config = {
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    myChatId: String(process.env.TELEGRAM_MY_CHAT_ID),
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: 'claude-sonnet-4-6',
  },
  google: {
    credentialsPath: process.env.GOOGLE_CREDENTIALS_PATH || './credentials.json',
    tokenPath: process.env.GOOGLE_TOKEN_PATH || './data/google-token.json',
  },
  canvas: {
    baseUrl: (process.env.CANVAS_BASE_URL || '').replace(/\/$/, ''),
    apiToken: process.env.CANVAS_API_TOKEN || '',
  },
  teams: {
    enabled: process.env.TEAMS_ENABLED === 'true',
  },
  weather: {
    apiKey: process.env.OPENWEATHERMAP_API_KEY,
    lat: process.env.WEATHER_LAT || '33.4484',
    lon: process.env.WEATHER_LON || '-112.0740',
    units: process.env.WEATHER_UNITS || 'imperial',
  },
  maps: {
    apiKey: process.env.GOOGLE_MAPS_API_KEY || '',
    homeAddress: process.env.HOME_ADDRESS || '1260 E University Dr, Tempe, AZ 85281',
  },
  app: {
    nodeEnv: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT || '3000', 10),
    timezone: process.env.TIMEZONE || 'America/Phoenix',
    logLevel: process.env.LOG_LEVEL || 'info',
    dbPath: process.env.DB_PATH || './data/jarvis.db',
  },
};

module.exports = config;
