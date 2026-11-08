// Weather from Open-Meteo (free, no key). Forecast for where you are, saved for offline use,
// plus the weather at each entry's time and place (kept on each phone, not synced, so it can
// never overwrite an edit made on the other phone).
const WX = (() => {
  const API = 'https://api.open-meteo.com/v1/forecast';
  const CODES = {
    0: ['☀️', 'Clear'], 1: ['🌤', 'Mainly clear'], 2: ['⛅', 'Partly cloudy'], 3: ['☁️', 'Overcast'],
    45: ['🌫', 'Fog'], 48: ['🌫', 'Freezing fog'], 51: ['🌦', 'Light drizzle'], 53: ['🌦', 'Drizzle'], 55: ['🌦', 'Heavy drizzle'],
    56: ['🌧', 'Freezing drizzle'], 57: ['🌧', 'Freezing drizzle'], 61: ['🌧', 'Light rain'], 63: ['🌧', 'Rain'], 65: ['🌧', 'Heavy rain'],
    66: ['🌧', 'Freezing rain'], 67: ['🌧', 'Freezing rain'], 71: ['🌨', 'Light snow'], 73: ['🌨', 'Snow'], 75: ['❄️', 'Heavy snow'],
    77: ['🌨', 'Snow grains'], 80: ['🌦', 'Showers'], 81: ['🌧', 'Heavy showers'], 82: ['⛈', 'Violent showers'],
    85: ['🌨', 'Snow showers'], 86: ['🌨', 'Heavy snow showers'], 95: ['⛈', 'Thunderstorm'], 96: ['⛈', 'Thunderstorm, hail'], 99: ['⛈', 'Thunderstorm, hail'],
  };
  const icon = (c, isDay = 1) => (c <= 1 && !isDay ? '🌙' : (CODES[c] || ['🌡'])[0]);
  const label = (c) => (CODES[c] || ['', '—'])[1];
  const compass = (d) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((d % 360) + 360) % 360) / 45) % 8];
  const r = Math.round;

  let days = {};        // key -> { fetchedAt, data }   weather for a day at a place
  let busy = false;

  async function get(params) {
    const url = API + '?' + new URLSearchParams({ ...params, timezone: 'auto', timeformat: 'unixtime', wind_speed_unit: 'kmh' });
    const res = await fetch(url);
    if (!res.ok) throw new Error('Weather service ' + res.status);
    return res.json();
  }

  const FORECAST_HOURLY = 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation_probability,uv_index,is_day';
  async function fetchForecast(lat, lon) {
    return get({
      latitude: lat.toFixed(3), longitude: lon.toFixed(3),
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation_probability,uv_index,is_day',
      hourly: FORECAST_HOURLY,
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_probability_max,wind_gusts_10m_max,daylight_duration',
      forecast_days: 16,
    });
  }

  // ---------- sun position, for golden hour ----------
  function sunElevation(ms, lat, lon) {
    const rad = Math.PI / 180, d = ms / 864e5 + 2440587.5 - 2451545.0;
    const g = ((357.529 + 0.98560028 * d) % 360) * rad;
    const q = (280.459 + 0.98564736 * d) % 360;
    const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
    const e = (23.439 - 0.00000036 * d) * rad;
    const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
    const dec = Math.asin(Math.sin(e) * Math.sin(L));
    const gmst = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
    const H = (gmst * 15 + lon) * rad - ra;
    return Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(H)) / rad;
  }
  // Golden hour: sun between the horizon and 6° up.
  function goldenHours(sunriseS, sunsetS, lat, lon) {
    if (!sunriseS || !sunsetS) return null;
    const step = 60000, rise = sunriseS * 1000, set = sunsetS * 1000;
    let mEnd = null, eStart = null;
    for (let t = rise; t < rise + 5 * 3600e3; t += step) if (sunElevation(t, lat, lon) >= 6) { mEnd = t; break; }
    for (let t = set; t > set - 5 * 3600e3; t -= step) if (sunElevation(t, lat, lon) >= 6) { eStart = t; break; }
    return { morning: [rise, mEnd || rise + 3600e3], evening: [eStart || set - 3600e3, set] };
  }

  // ---------- where am I ----------
  function gps() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
        () => resolve(null), { enableHighAccuracy: false, timeout: 12000, maximumAge: 15 * 60000 });
    });
  }
  function km(a, b) {
    const rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(h));
  }
  // Name a spot from your own entries (nearest entry with a place name within 25 km).
  function placeNear(pt, entries) {
    let best = null, bestKm = 25;
    for (const e of entries) if (e.place && e.lat != null) { const k = km(pt, e); if (k < bestKm) { bestKm = k; best = e.place; } }
    return best;
  }

  // ---------- forecast (saved for offline) ----------
  async function refreshForecast({ force = false, entries = [] } = {}) {
    if (!navigator.onLine) return false;
    const saved = await DB.setting('wxForecast', null);
    let here = await gps();
    if (!here) {
      const last = [...entries].filter(e => e.lat != null).sort((a, b) => b.at - a.at)[0];
      here = last ? { lat: last.lat, lon: last.lon } : saved ? { lat: saved.lat, lon: saved.lon } : null;
    }
    if (!here) return false;
    const fresh = saved && Date.now() - saved.fetchedAt < 45 * 60000 && km(saved, here) < 15;
    if (fresh && !force) return false;
    const data = await fetchForecast(here.lat, here.lon);
    await DB.setSetting('wxForecast', { fetchedAt: Date.now(), lat: here.lat, lon: here.lon, place: placeNear(here, entries), data });
    return true;
  }

  // ---------- weather for each entry / day ----------
  const keyFor = (dateKey, lat, lon) => `${dateKey}|${lat.toFixed(1)}|${lon.toFixed(1)}`;
  async function loadDays() { days = await DB.setting('wxDays', {}) || {}; }

  async function fillEntries(entries, dayKeyOf) {
    if (!navigator.onLine || busy) return 0;
    busy = true;
    let n = 0;
    try {
      const today = dayKeyOf({ at: Date.now(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
      const oldest = Date.now() - 85 * 864e5;
      const want = new Map();
      for (const e of entries) {
        if (e.lat == null || e.at < oldest || e.at > Date.now() + 864e5) continue;
        const dk = dayKeyOf(e), k = keyFor(dk, e.lat, e.lon), have = days[k];
        // past days are final once fetched; today's weather is refreshed every 3 hours
        const stale = !have || (dk >= today && Date.now() - have.fetchedAt > 3 * 3600e3);
        if (stale && !want.has(k)) want.set(k, { dk, lat: e.lat, lon: e.lon });
      }
      for (const [k, w] of [...want].slice(0, 25)) {
        try {
          const data = await get({
            latitude: w.lat.toFixed(2), longitude: w.lon.toFixed(2), start_date: w.dk, end_date: w.dk,
            hourly: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day',
            daily: 'weather_code,temperature_2m_max,temperature_2m_min,wind_gusts_10m_max,precipitation_sum',
          });
          days[k] = { fetchedAt: Date.now(), data }; n++;
        } catch (err) { if (!navigator.onLine) break; }
      }
      if (n) await DB.setSetting('wxDays', days);
    } finally { busy = false; }
    return n;
  }

  // Weather at an entry's moment and place (or null if not fetched yet).
  function forEntry(e, dayKeyOf) {
    if (e.lat == null) return null;
    const d = days[keyFor(dayKeyOf(e), e.lat, e.lon)]?.data;
    if (!d?.hourly?.time?.length) return null;
    const t = e.at / 1000, h = d.hourly;
    let i = 0;
    for (let j = 0; j < h.time.length; j++) if (Math.abs(h.time[j] - t) < Math.abs(h.time[i] - t)) i = j;
    return {
      temp: r(h.temperature_2m[i]), feels: r(h.apparent_temperature[i]), code: h.weather_code[i],
      wind: r(h.wind_speed_10m[i]), gust: r(h.wind_gusts_10m[i]), dir: compass(h.wind_direction_10m[i]), isDay: h.is_day?.[i] ?? 1,
    };
  }
  // A day's weather where you were (from the day's entries).
  function forDay(dayEntries, dayKeyOf) {
    const counts = {};
    for (const e of dayEntries) if (e.lat != null) { const k = keyFor(dayKeyOf(e), e.lat, e.lon); if (days[k]) counts[k] = (counts[k] || 0) + 1; }
    const k = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    const d = k && days[k].data?.daily;
    if (!d?.time?.length) return null;
    return { code: d.weather_code[0], min: r(d.temperature_2m_min[0]), max: r(d.temperature_2m_max[0]), gust: r(d.wind_gusts_10m_max[0]), rain: d.precipitation_sum?.[0] };
  }

  return { icon, label, compass, refreshForecast, fillEntries, forEntry, forDay, loadDays, goldenHours, placeNear };
})();
