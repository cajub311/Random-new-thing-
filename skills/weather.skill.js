// Current weather + next-24h outlook for any place via the free, keyless
// Open-Meteo API. Geocoding hits Open-Meteo's geocoding endpoint, so we get
// "New York" → lat/long → forecast in one skill call.

import { safeFetch } from '../lib/safe-fetch.js';

const CODE_TO_DESC = {
  0: 'clear sky', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'rime fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow',
  80: 'rain showers', 81: 'rain showers', 82: 'violent rain showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'severe thunderstorm with hail',
};

export default {
  name: 'weather',
  description:
    'Get current weather and the next-24h forecast for any place name or "lat,lon" coordinate. Uses the free Open-Meteo API — no key required.',
  parameters: {
    type: 'object',
    properties: {
      location: { type: 'string', description: 'City, "City, Country", or "lat,lon".' },
      units: { type: 'string', enum: ['metric', 'imperial'], description: 'Default: metric.' },
    },
    required: ['location'],
  },
  async run({ location, units = 'metric' }) {
    if (!location) throw new Error('weather: location is required');
    let lat, lon, resolved = location;
    const coordMatch = String(location).match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (coordMatch) {
      lat = parseFloat(coordMatch[1]); lon = parseFloat(coordMatch[2]);
    } else {
      const geo = await safeFetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(location)}`);
      if (!geo.ok) throw new Error(`geocoding failed: ${geo.status}`);
      const j = await geo.json();
      const hit = j.results?.[0];
      if (!hit) throw new Error(`no location found for "${location}"`);
      lat = hit.latitude; lon = hit.longitude;
      resolved = [hit.name, hit.admin1, hit.country].filter(Boolean).join(', ');
    }

    const tempUnit = units === 'imperial' ? 'fahrenheit' : 'celsius';
    const windUnit = units === 'imperial' ? 'mph' : 'kmh';
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      current: 'temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m',
      hourly: 'temperature_2m,precipitation_probability,weather_code',
      forecast_days: '2',
      temperature_unit: tempUnit,
      wind_speed_unit: windUnit,
    });
    const res = await safeFetch(`https://api.open-meteo.com/v1/forecast?${params}`);
    if (!res.ok) throw new Error(`forecast failed: ${res.status}`);
    const data = await res.json();

    const cur = data.current || {};
    const nowCode = cur.weather_code;
    const nextHours = (data.hourly?.time || []).slice(0, 24).map((t, i) => ({
      time: t,
      temp: data.hourly.temperature_2m[i],
      precip_prob: data.hourly.precipitation_probability[i],
      condition: CODE_TO_DESC[data.hourly.weather_code[i]] || `code ${data.hourly.weather_code[i]}`,
    }));

    return {
      location: resolved,
      lat, lon,
      units,
      current: {
        temp: cur.temperature_2m,
        humidity: cur.relative_humidity_2m,
        wind: cur.wind_speed_10m,
        condition: CODE_TO_DESC[nowCode] || `code ${nowCode}`,
      },
      next_24h: nextHours,
    };
  },
};
