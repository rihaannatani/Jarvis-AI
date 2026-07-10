'use strict';
const axios = require('axios');
const config = require('../config');
const logger = require('../logger');
const { withResilience } = require('./api-utils');

const BASE = 'https://api.openweathermap.org/data/2.5';

async function getCurrentWeather() {
  const { apiKey, lat, lon, units } = config.weather;
  const res = await withResilience('weather', () =>
    axios.get(`${BASE}/weather`, { params: { lat, lon, appid: apiKey, units } })
  );
  const d = res.data;
  return {
    description: d.weather[0].description,
    temp: Math.round(d.main.temp),
    feelsLike: Math.round(d.main.feels_like),
    humidity: d.main.humidity,
    windSpeed: Math.round(d.wind.speed),
    units: units === 'imperial' ? 'F' : 'C',
  };
}

async function getTodayForecast() {
  const { apiKey, lat, lon, units } = config.weather;
  const res = await withResilience('weather', () =>
    axios.get(`${BASE}/forecast`, { params: { lat, lon, appid: apiKey, units, cnt: 8 } })
  );
  const entries = res.data.list;
  const temps = entries.map((e) => e.main.temp);
  const descriptions = entries.map((e) => e.weather[0].description);
  return {
    high: Math.round(Math.max(...temps)),
    low: Math.round(Math.min(...temps)),
    conditions: [...new Set(descriptions)].slice(0, 3),
    units: units === 'imperial' ? 'F' : 'C',
  };
}

async function getWeekForecast() {
  const { apiKey, lat, lon, units } = config.weather;
  const res = await withResilience('weather', () =>
    axios.get(`${BASE}/forecast`, { params: { lat, lon, appid: apiKey, units, cnt: 40 } })
  );

  const byDay = {};
  for (const entry of res.data.list) {
    const day = entry.dt_txt.slice(0, 10);
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push(entry);
  }

  return Object.entries(byDay)
    .slice(0, 7)
    .map(([date, entries]) => {
      const temps = entries.map((e) => e.main.temp);
      return {
        date,
        high: Math.round(Math.max(...temps)),
        low: Math.round(Math.min(...temps)),
        description: entries[Math.floor(entries.length / 2)].weather[0].description,
      };
    });
}

async function getWeatherSummary() {
  try {
    const [current, today] = await Promise.all([getCurrentWeather(), getTodayForecast()]);
    return { current, today };
  } catch (err) {
    logger.error('[weather] Failed to fetch weather:', err.message);
    throw err;
  }
}

module.exports = { getCurrentWeather, getTodayForecast, getWeekForecast, getWeatherSummary };
