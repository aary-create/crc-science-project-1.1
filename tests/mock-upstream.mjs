// A stand-in for every upstream the app calls (SACHET, IMD CAP, Open-Meteo,
// Nominatim, Overpass), serving realistic responses in each service's real
// format, so the whole app can be exercised offline:
//
//   node tests/mock-upstream.mjs            # listens on :4010
//   SACHET_URL=http://localhost:4010/sachet IMD_RSS_URL=http://localhost:4010/imd/rss.xml \
//   OPEN_METEO_URL=http://localhost:4010/om/forecast OPEN_METEO_AIR_URL=http://localhost:4010/om/air \
//   NOMINATIM_URL=http://localhost:4010/nominatim OVERPASS_URL=http://localhost:4010/overpass npm start
//
// Scenario: Palanpur (Banaskantha), monsoon — an orange heavy-rain alert from
// Gujarat SDMA and a Severe IMD bulletin, thunderstorms and ~120 mm of rain
// forecast, a wet fortnight behind it. Set MOCK_MODE=down to make both alert
// feeds fail (tests the "couldn't reach the sources" path).
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 4010);
const MODE = () => process.env.MOCK_MODE ?? "normal";
const PALANPUR = { lat: 24.1724, lng: 72.4346 };

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Java Date#toString in IST, the way SACHET writes it.
function javaIst(ms) {
  const d = new Date(ms + 330 * 60_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${DAY[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} IST ${d.getUTCFullYear()}`;
}
// "YYYY-MM-DDTHH:MM" in IST, the way Open-Meteo writes local times.
function localIso(ms) {
  return new Date(ms + 330 * 60_000).toISOString().slice(0, 16);
}

function sachet() {
  const now = Date.now();
  const H = 3600_000;
  return [
    {
      severity: "WARNING", identifier: 1790051900000001, effective_start_time: javaIst(now - 2 * H), effective_end_time: javaIst(now + 20 * H),
      disaster_type: "Heavy Rain", area_description: "Banaskantha, Patan districts of Gujarat", severity_level: "Likely", type: 0, actual_lang: "gu",
      warning_message: "આગામી 24 કલાકમાં બનાસકાંઠા અને પાટણ જિલ્લામાં ભારે થી અતિ ભારે વરસાદની શક્યતા છે. નીચાણવાળા વિસ્તારના લોકો સાવચેત રહે.",
      disseminated: "true", severity_color: "orange", alert_id_sdma_autoinc: 150001, centroid: "72.30,24.10", alert_source: "Gujarat SDMA", area_covered: "9000.5", sender_org_id: "7",
    },
    // Same agency + hazard, older and milder: must be dropped as stale, not shown as a disagreement.
    {
      severity: "WATCH", identifier: 1790051800000002, effective_start_time: javaIst(now - 9 * H), effective_end_time: javaIst(now + 6 * H),
      disaster_type: "Moderate Rain", area_description: "Banaskantha district of Gujarat", severity_level: "Likely", type: 0, actual_lang: "en",
      warning_message: "Moderate rain likely.", disseminated: "true", severity_color: "yellow", alert_id_sdma_autoinc: 150000,
      centroid: "72.40,24.15", alert_source: "Gujarat SDMA", area_covered: "4000", sender_org_id: "7",
    },
    {
      severity: "WATCH", identifier: 1790051900000003, effective_start_time: javaIst(now - 1 * H), effective_end_time: javaIst(now + 3 * H),
      disaster_type: "Thunderstorm & Lightning with Moderate Rain", area_description: "4 districts of Gujarat", severity_level: "Very Likely", type: 0, actual_lang: "en",
      warning_message: "Thunderstorm with lightning and moderate rain very likely at isolated places in Banaskantha, Patan, Mahesana and Sabarkantha during next 3 hours.",
      disseminated: "true", severity_color: "yellow", alert_id_sdma_autoinc: 150002, centroid: "72.45,24.05", alert_source: "IMD Ahmedabad", area_covered: "12000", sender_org_id: "3",
    },
    // Expired an hour ago: must not be shown.
    {
      severity: "ALERT", identifier: 1790051700000004, effective_start_time: javaIst(now - 12 * H), effective_end_time: javaIst(now - 1 * H),
      disaster_type: "Flood", area_description: "Palanpur taluka", severity_level: "Likely", type: 0, actual_lang: "en", warning_message: "Old flood alert.",
      disseminated: "true", severity_color: "red", alert_id_sdma_autoinc: 149000, centroid: "72.43,24.17", alert_source: "CWC", area_covered: "800", sender_org_id: "5",
    },
    // Far away (Mumbai): must not match Palanpur.
    {
      severity: "WATCH", identifier: 1790051844209029, effective_start_time: javaIst(now - H), effective_end_time: javaIst(now + 2 * H),
      disaster_type: "Moderate Rain", area_description: "4 districts of Maharashtra", severity_level: "Very Likely", type: 0, actual_lang: "mr",
      warning_message: "पुढील ३ तासात मुंबई शहर, मुंबई उपनगर, पालघर आणि ठाणे जिल्ह्यात मध्यम स्वरूपाचा पाऊस पडण्याची दाट शक्यता आहे.",
      disseminated: "true", severity_color: "yellow", alert_id_sdma_autoinc: 148151, centroid: "72.83848679892887,18.986795912025332", alert_source: "Maharashtra SDMA", area_covered: "9931.72612933511", sender_org_id: "29",
    },
  ];
}

function imdRss(base) {
  const now = new Date().toUTCString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>IMD CAP alerts</title>
<item><title>Heavy Rainfall warning for North Gujarat</title><link>${base}/imd/cap-1.xml</link><description>North Gujarat</description><pubDate>${now}</pubDate><guid>imd-cap-1</guid></item>
<item><title>Heat wave for Saurashtra</title><link>${base}/imd/cap-2.xml</link><description>Saurashtra</description><pubDate>${now}</pubDate><guid>imd-cap-2</guid></item>
</channel></rss>`;
}

function imdCap(n) {
  const sent = new Date(Date.now() - 3 * 3600_000).toISOString();
  const expires = new Date(Date.now() + 24 * 3600_000).toISOString();
  if (n === "1") {
    return `<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>IMD-AHD-1</identifier><sender>imd.gov.in</sender><sent>${sent}</sent><status>Actual</status><msgType>Alert</msgType><scope>Public</scope>
<info><language>en</language><category>Met</category><event>Heavy Rainfall</event><urgency>Expected</urgency><severity>Severe</severity><certainty>Likely</certainty>
<effective>${sent}</effective><expires>${expires}</expires><senderName>IMD Ahmedabad</senderName>
<headline>Heavy to very heavy rainfall at isolated places in Banaskantha and Patan</headline>
<description>Heavy to very heavy rainfall very likely at isolated places in Banaskantha and Patan districts during next 24 hours. Orange alert.</description>
<instruction>Avoid travel through low-lying areas. Stay away from rivers and streams.</instruction>
<area><areaDesc>Banaskantha, Patan</areaDesc><polygon>23.8,71.9 24.9,71.9 24.9,73.0 23.8,73.0 23.8,71.9</polygon></area></info></alert>`;
  }
  // A heat bulletin for Saurashtra, by name only (no geometry) — must not match Palanpur.
  return `<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>IMD-AHD-2</identifier><sender>imd.gov.in</sender><sent>${sent}</sent><status>Actual</status><msgType>Alert</msgType><scope>Public</scope>
<info><language>en</language><event>Heat Wave</event><severity>Moderate</severity><expires>${expires}</expires>
<headline>Heat wave conditions in Rajkot and Amreli</headline><description>Heat wave conditions likely.</description>
<area><areaDesc>Rajkot, Amreli</areaDesc></area></info></alert>`;
}

// Open-Meteo forecast: 14 past days + 7 forecast days, hourly and daily.
function forecast() {
  const now = Date.now();
  const hour0 = Math.floor((now + 330 * 60_000) / 3600_000) * 3600_000 - 330 * 60_000; // top of the current IST hour
  const dayStart = Math.floor((now + 330 * 60_000) / 86400_000) * 86400_000 - 330 * 60_000; // IST midnight
  const start = dayStart - 14 * 86400_000;
  const hours = 21 * 24;
  const time = [], temperature_2m = [], relative_humidity_2m = [], precipitation = [], weather_code = [], wind_gusts_10m = [];
  for (let i = 0; i < hours; i++) {
    const t = start + i * 3600_000;
    const h = new Date(t + 330 * 60_000).getUTCHours();
    const ahead = (t - hour0) / 3600_000;
    time.push(localIso(t));
    temperature_2m.push(Math.round((28 + 4 * Math.sin(((h - 9) / 24) * 2 * Math.PI)) * 10) / 10);
    relative_humidity_2m.push(h > 10 && h < 18 ? 72 : 88);
    const wet = ahead >= 0 && ahead < 24;
    precipitation.push(wet ? (ahead > 4 && ahead < 14 ? 11.5 : 1.2) : 0.3);
    weather_code.push(wet && ahead > 3 && ahead < 9 ? 95 : wet ? 63 : 3);
    wind_gusts_10m.push(wet && ahead > 3 && ahead < 9 ? 58 : 24);
  }
  const days = 21;
  const daily = { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [], apparent_temperature_max: [], precipitation_sum: [], precipitation_probability_max: [], wind_speed_10m_max: [], wind_gusts_10m_max: [], uv_index_max: [] };
  const rainPast = [2, 0, 5, 12, 38, 91.2, 44, 8, 0, 0, 3, 17, 26, 9];
  const rainNext = [118.6, 72.1, 21.4, 6, 0.4, 0, 2.2];
  for (let d = 0; d < days; d++) {
    const future = d - 14;
    daily.time.push(localIso(start + d * 86400_000).slice(0, 10));
    daily.weather_code.push(future === 0 ? 95 : future === 1 ? 65 : future >= 4 ? 2 : 61);
    daily.temperature_2m_max.push([31.8, 30.2, 31.5, 33.1, 34.6, 35.2, 34.9][future] ?? 31);
    daily.temperature_2m_min.push([25.1, 24.6, 25.0, 25.8, 26.3, 26.8, 26.5][future] ?? 25);
    daily.apparent_temperature_max.push([37.9, 35.8, 37.4, 39.6, 41.2, 42.0, 41.5][future] ?? 36);
    daily.precipitation_sum.push(future < 0 ? rainPast[d] : rainNext[future]);
    daily.precipitation_probability_max.push(future < 0 ? 0 : [96, 88, 64, 31, 12, 5, 18][future]);
    daily.wind_speed_10m_max.push(future === 0 ? 34 : 18);
    daily.wind_gusts_10m_max.push(future < 0 ? 30 : [62, 48, 36, 28, 25, 22, 27][future]);
    daily.uv_index_max.push(future < 0 ? 6 : [4.1, 5.2, 7.8, 9.1, 9.6, 9.8, 9.4][future]);
  }
  const cur = localIso(Math.floor(now / 900_000) * 900_000);
  return {
    latitude: PALANPUR.lat, longitude: PALANPUR.lng, generationtime_ms: 0.5, utc_offset_seconds: 19800, timezone: "Asia/Kolkata", timezone_abbreviation: "GMT+5:30", elevation: 213,
    current_units: { time: "iso8601", interval: "seconds", temperature_2m: "°C" },
    current: { time: cur, interval: 900, temperature_2m: 29.4, relative_humidity_2m: 84, apparent_temperature: 35.1, is_day: 1, precipitation: 2.4, weather_code: 63, pressure_msl: 998.6, wind_speed_10m: 22.3, wind_direction_10m: 240, wind_gusts_10m: 41.8 },
    hourly: { time, temperature_2m, relative_humidity_2m, precipitation, weather_code, wind_gusts_10m },
    daily,
  };
}

function air() {
  const now = Date.now();
  const dayStart = Math.floor((now + 330 * 60_000) / 86400_000) * 86400_000 - 330 * 60_000 - 86400_000;
  const time = [], pm10 = [], pm2_5 = [];
  for (let i = 0; i < 48; i++) {
    time.push(localIso(dayStart + i * 3600_000));
    pm10.push(118 + (i % 5) * 6);
    pm2_5.push(64 + (i % 7) * 3);
  }
  return {
    latitude: PALANPUR.lat, longitude: PALANPUR.lng, timezone: "Asia/Kolkata",
    current: { time: localIso(Math.floor(now / 3600_000) * 3600_000), interval: 3600, pm10: 131.2, pm2_5: 72.9, us_aqi: 158, dust: 42 },
    hourly: { time, pm10, pm2_5 },
  };
}

function nominatimSearch(q) {
  const s = q.toLowerCase();
  if (s.includes("xyzzy")) return [];
  // A tiny village the map doesn't know resolves only at taluka level.
  if (s.includes("chandisar") && !s.startsWith("palanpur")) return [];
  return [{
    lat: String(PALANPUR.lat), lon: String(PALANPUR.lng),
    display_name: "Palanpur, Palanpur Taluka, Banaskantha, Gujarat, 385001, India",
    address: { town: "Palanpur", county: "Palanpur Taluka", state_district: "Banaskantha District", state: "Gujarat", country: "India" },
  }];
}

function overpass() {
  return {
    elements: [
      { type: "node", id: 1, lat: 24.1752, lon: 72.4311, tags: { amenity: "hospital", name: "Civil Hospital Palanpur", phone: "+91 2742 252 000" } },
      { type: "way", id: 2, center: { lat: 24.1689, lon: 72.4402 }, tags: { healthcare: "hospital", name: "Banas Medical College Hospital" } },
      { type: "node", id: 3, lat: 24.1801, lon: 72.4205, tags: { amenity: "clinic", name: "Community Health Centre" } },
    ],
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const base = `http://localhost:${PORT}`;
  const json = (o, code = 200) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(o)); };
  const xml = (s) => { res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8" }); res.end(s); };
  const down = MODE() === "down";
  const p = url.pathname;
  if (p === "/mode") { process.env.MOCK_MODE = url.searchParams.get("set") ?? "normal"; return json({ mode: MODE() }); }
  if (p === "/sachet") return down ? json({ error: "down" }, 503) : json(sachet());
  if (p === "/imd/rss.xml") return down ? json({ error: "down" }, 503) : xml(imdRss(base));
  if (p.startsWith("/imd/cap-")) return xml(imdCap(p.slice(9, 10)));
  if (p === "/om/forecast") return json(forecast());
  if (p === "/om/air") return json(air());
  if (p === "/nominatim/search") return json(nominatimSearch(url.searchParams.get("q") ?? ""));
  if (p === "/nominatim/reverse") return json(nominatimSearch("palanpur")[0]);
  if (p === "/overpass") return json(overpass());
  json({ error: "not found" }, 404);
});
server.listen(PORT, () => console.log(`mock upstream on :${PORT}`));
