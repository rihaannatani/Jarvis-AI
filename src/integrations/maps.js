'use strict';
const axios = require('axios');
const config = require('../config');
const logger = require('../logger');

const BASE = 'https://maps.googleapis.com/maps/api';

function apiKey() {
  if (!config.maps.apiKey) {
    throw new Error('GOOGLE_MAPS_API_KEY is not set in .env');
  }
  return config.maps.apiKey;
}

function homeAddress() {
  return config.maps.homeAddress || '1260 E University Dr, Tempe, AZ 85281';
}

function stripHtml(str) {
  return str.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function getTravelTime(destination, origin, mode = 'driving') {
  try {
    const params = {
      origins: origin || homeAddress(),
      destinations: destination,
      mode,
      key: apiKey(),
      units: 'imperial',
    };
    // Traffic data only available for driving/transit with departure_time
    if (mode === 'driving' || mode === 'transit') {
      params.departure_time = 'now';
      if (mode === 'driving') params.traffic_model = 'best_guess';
    }

    const res = await axios.get(`${BASE}/distancematrix/json`, { params });
    const el = res.data.rows?.[0]?.elements?.[0];

    if (!el || el.status !== 'OK') {
      throw new Error(`Distance Matrix returned status: ${el?.status || 'no result'}`);
    }

    return {
      duration: el.duration?.text || 'unknown',
      durationInTraffic: el.duration_in_traffic?.text || el.duration?.text || 'unknown',
      durationInTrafficSeconds: el.duration_in_traffic?.value || el.duration?.value || 0,
      durationSeconds: el.duration?.value || 0,
      distance: el.distance?.text || 'unknown',
      origin: params.origins,
      destination,
    };
  } catch (err) {
    logger.error('[maps] getTravelTime failed:', err.message);
    throw err;
  }
}

async function findNearbyPlaces(query, location) {
  try {
    const params = {
      query,
      location: location || `${config.weather.lat},${config.weather.lon}`,
      radius: 8000,
      key: apiKey(),
    };

    const res = await axios.get(`${BASE}/place/textsearch/json`, { params });

    if (res.data.status !== 'OK' && res.data.status !== 'ZERO_RESULTS') {
      throw new Error(`Places API returned status: ${res.data.status}`);
    }

    return (res.data.results || []).slice(0, 5).map((p) => ({
      name: p.name,
      address: p.formatted_address,
      rating: p.rating,
      openNow: p.opening_hours?.open_now,
      priceLevel: p.price_level,
      googleMapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name)}&query_place_id=${p.place_id}`,
    }));
  } catch (err) {
    logger.error('[maps] findNearbyPlaces failed:', err.message);
    throw err;
  }
}

async function getDirections(destination, origin, mode = 'driving') {
  try {
    const params = {
      origin: origin || homeAddress(),
      destination,
      mode,
      key: apiKey(),
      units: 'imperial',
    };
    if (mode === 'driving' || mode === 'transit') {
      params.departure_time = 'now';
    }

    const res = await axios.get(`${BASE}/directions/json`, { params });

    if (res.data.status !== 'OK') {
      throw new Error(`Directions API returned status: ${res.data.status}`);
    }

    const route = res.data.routes[0];
    const leg = route.legs[0];
    const steps = (leg.steps || []).slice(0, 5).map((s) => stripHtml(s.html_instructions));

    const originEnc = encodeURIComponent(params.origin);
    const destEnc = encodeURIComponent(destination);

    return {
      summary: route.summary,
      duration: leg.duration?.text || 'unknown',
      durationInTraffic: leg.duration_in_traffic?.text || leg.duration?.text || 'unknown',
      durationInTrafficSeconds: leg.duration_in_traffic?.value || leg.duration?.value || 0,
      distance: leg.distance?.text || 'unknown',
      steps,
      googleMapsUrl: `https://www.google.com/maps/dir/${originEnc}/${destEnc}`,
    };
  } catch (err) {
    logger.error('[maps] getDirections failed:', err.message);
    throw err;
  }
}

// Returns a formatted alert string if traffic adds > 10 min, otherwise null
async function getTrafficAlert(destination, origin) {
  try {
    const travel = await getTravelTime(destination, origin, 'driving');
    const extraSeconds = travel.durationInTrafficSeconds - travel.durationSeconds;
    if (extraSeconds > 10 * 60) {
      const extraMin = Math.round(extraSeconds / 60);
      return `Traffic is adding ~${extraMin} min to your drive to ${destination} (${travel.durationInTraffic} total)`;
    }
    return null;
  } catch (err) {
    logger.warn('[maps] getTrafficAlert failed:', err.message);
    return null;
  }
}

module.exports = { getTravelTime, findNearbyPlaces, getDirections, getTrafficAlert };
