// Types and pure calculations for live conditions. No network here, so the
// same code runs on the server and in the browser.

export type HeatCategory = "none" | "caution" | "extreme_caution" | "danger" | "extreme_danger";
export type NaqiCategory = "good" | "satisfactory" | "moderate" | "poor" | "very_poor" | "severe";

export type DailyPoint = {
  date: string; code: number | null; tmax: number | null; tmin: number | null; feels_max: number | null;
  rain: number | null; rain_prob: number | null; wind_max: number | null; gust_max: number | null; uv: number | null;
};

export type Conditions = {
  ok: boolean;       // forecast model reachable
  airOk: boolean;    // air-quality model reachable
  fetchedAt: string;
  current: {
    time: string; temp: number | null; humidity: number | null; apparent: number | null; precip: number | null;
    weather_code: number | null; pressure: number | null; wind: number | null; wind_dir: number | null;
    gusts: number | null; is_day: boolean;
  } | null;
  heat: { index_c: number; category: HeatCategory; peak_index_c: number | null; peak_category: HeatCategory | null; peak_time: string | null } | null;
  air: { naqi: number; category: NaqiCategory; dominant: "PM2.5" | "PM10"; pm25_24h: number | null; pm10_24h: number | null; dust: number | null; us_aqi: number | null } | null;
  daily: DailyPoint[];
  next24: { rain_mm: number; max_gust: number; thunder: boolean; thunder_at: string | null } | null;
  past: { days: number; max_daily_rain: number; max_rain_date: string; rain_3d_total: number } | null;
};

// US National Weather Service heat index (Rothfusz regression with its
// published low/high-humidity adjustments). Input/output in °C.
export function heatIndexC(tempC: number, rh: number): number {
  const T = tempC * 9 / 5 + 32;
  let hi = 0.5 * (T + 61 + (T - 68) * 1.2 + rh * 0.094);
  if ((hi + T) / 2 >= 80) {
    hi = -42.379 + 2.04901523 * T + 10.14333127 * rh - 0.22475541 * T * rh - 0.00683783 * T * T
      - 0.05481717 * rh * rh + 0.00122874 * T * T * rh + 0.00085282 * T * rh * rh - 0.00000199 * T * T * rh * rh;
    if (rh < 13 && T >= 80 && T <= 112) hi -= ((13 - rh) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
    else if (rh > 85 && T >= 80 && T <= 87) hi += ((rh - 85) / 10) * ((87 - T) / 5);
  } else {
    hi = (hi + T) / 2;
  }
  return ((hi - 32) * 5) / 9;
}

// NWS bands: 80°F / 90°F / 103°F / 125°F.
export function heatCategory(hiC: number): HeatCategory {
  if (hiC >= 51.7) return "extreme_danger";
  if (hiC >= 39.4) return "danger";
  if (hiC >= 32.2) return "extreme_caution";
  if (hiC >= 26.7) return "caution";
  return "none";
}

// India's National Air Quality Index (CPCB) sub-index breakpoints, 24-hour
// averages in µg/m³. The full NAQI needs at least three pollutants measured
// at a station; this is an estimate from modelled PM2.5 and PM10 only, and
// the app says so wherever it's shown.
const PM25: [number, number, number, number][] = [[0, 30, 0, 50], [30, 60, 51, 100], [60, 90, 101, 200], [90, 120, 201, 300], [120, 250, 301, 400], [250, 380, 401, 500]];
const PM10: [number, number, number, number][] = [[0, 50, 0, 50], [50, 100, 51, 100], [100, 250, 101, 200], [250, 350, 201, 300], [350, 430, 301, 400], [430, 600, 401, 500]];

function subIndex(c: number, table: [number, number, number, number][]) {
  for (const [bLo, bHi, iLo, iHi] of table) {
    if (c <= bHi) return Math.round(((iHi - iLo) / (bHi - bLo)) * (Math.max(c, bLo) - bLo) + iLo);
  }
  return 500;
}

export function naqiCategory(v: number): NaqiCategory {
  if (v <= 50) return "good";
  if (v <= 100) return "satisfactory";
  if (v <= 200) return "moderate";
  if (v <= 300) return "poor";
  if (v <= 400) return "very_poor";
  return "severe";
}

export function naqiFromPm(pm25: number | null, pm10: number | null) {
  const a = pm25 == null ? null : subIndex(pm25, PM25);
  const b = pm10 == null ? null : subIndex(pm10, PM10);
  if (a == null && b == null) return null;
  const naqi = Math.max(a ?? 0, b ?? 0);
  return { naqi, category: naqiCategory(naqi), dominant: (a ?? 0) >= (b ?? 0) ? "PM2.5" as const : "PM10" as const };
}

export const NAQI_COLOR: Record<NaqiCategory, string> = {
  good: "#35d48c", satisfactory: "#9bd35a", moderate: "#e3b23c", poor: "#ff9142", very_poor: "#ff5a52", severe: "#b8325f",
};

// WMO weather interpretation codes, as used by Open-Meteo, bucketed into the
// labels the app shows (see wx_* keys in lib/i18n.ts).
export function weatherKey(code: number | null): string {
  if (code == null) return "wx_unknown";
  if (code === 0) return "wx_clear";
  if (code <= 2) return "wx_partly";
  if (code === 3) return "wx_overcast";
  if (code === 45 || code === 48) return "wx_fog";
  if (code >= 51 && code <= 57) return "wx_drizzle";
  if ((code >= 61 && code <= 63) || code === 80 || code === 81) return "wx_rain";
  if (code === 65 || code === 82 || code === 66 || code === 67) return "wx_heavy_rain";
  if (code >= 71 && code <= 86) return "wx_snow";
  if (code >= 95) return "wx_thunder";
  return "wx_unknown";
}

// IMD's 24-hour rainfall categories (mm).
export const IMD_RAIN = { heavy: 64.5, very_heavy: 115.6, extremely_heavy: 204.5 } as const;
