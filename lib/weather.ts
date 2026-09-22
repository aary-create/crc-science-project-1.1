import type { Conditions, DailyPoint } from "./conditions";
import { heatIndexC, heatCategory, naqiFromPm } from "./conditions";
import { memo } from "./memo";

// Open-Meteo — free, keyless weather and air-quality model data (forecast
// from national weather models incl. IMD-relevant global models; air quality
// from the Copernicus CAMS model). Non-commercial use needs no key.
// https://open-meteo.com/en/terms
const FORECAST = process.env.OPEN_METEO_URL ?? "https://api.open-meteo.com/v1/forecast";
const AIR = process.env.OPEN_METEO_AIR_URL ?? "https://air-quality-api.open-meteo.com/v1/air-quality";
const REUSE_MS = 10 * 60_000; // model data updates hourly; reuse for 10 minutes
const TZ = "Asia/Kolkata";

async function getJson(url: string): Promise<{ value: any; at: number }> {
  return memo(`om:${url}`, REUSE_MS, async () => {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(7000) });
    if (!res.ok) throw new Error(`${new URL(url).host} returned ${res.status}`);
    return res.json();
  });
}

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const at = (arr: unknown, i: number) => (Array.isArray(arr) ? num(arr[i]) : null);

function forecastUrl(lat: number, lng: number) {
  const p = new URLSearchParams({
    latitude: lat.toFixed(2),
    longitude: lng.toFixed(2),
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day",
    hourly: "temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_gusts_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,uv_index_max",
    timezone: TZ,
    past_days: "14",
    forecast_days: "7",
    wind_speed_unit: "kmh",
  });
  return `${FORECAST}?${p}`;
}

function airUrl(lat: number, lng: number) {
  const p = new URLSearchParams({
    latitude: lat.toFixed(2),
    longitude: lng.toFixed(2),
    current: "pm10,pm2_5,us_aqi,dust",
    hourly: "pm10,pm2_5",
    past_days: "1",
    forecast_days: "1",
    timezone: TZ,
  });
  return `${AIR}?${p}`;
}

// Index of the hourly slot matching "now" in the response's own local time.
function hourIndex(times: string[], currentTime: string | undefined) {
  if (!currentTime) return -1;
  const hour = currentTime.slice(0, 13); // "2026-09-22T10"
  return times.findIndex((t) => t.startsWith(hour));
}

export async function fetchConditions(lat: number, lng: number): Promise<Conditions> {
  const [fc, aq] = await Promise.allSettled([getJson(forecastUrl(lat, lng)), getJson(airUrl(lat, lng))]);
  const out: Conditions = {
    ok: false, airOk: false, fetchedAt: new Date().toISOString(),
    current: null, heat: null, air: null, daily: [], next24: null, past: null,
  };

  if (fc.status === "fulfilled") {
    const f = fc.value.value;
    out.fetchedAt = new Date(fc.value.at).toISOString();
    const c = f.current ?? {};
    out.ok = true;
    out.current = {
      time: String(c.time ?? ""),
      temp: num(c.temperature_2m),
      humidity: num(c.relative_humidity_2m),
      apparent: num(c.apparent_temperature),
      precip: num(c.precipitation),
      weather_code: num(c.weather_code),
      pressure: num(c.pressure_msl),
      wind: num(c.wind_speed_10m),
      wind_dir: num(c.wind_direction_10m),
      gusts: num(c.wind_gusts_10m),
      is_day: c.is_day === 1,
    };

    const h = f.hourly ?? {};
    const times: string[] = Array.isArray(h.time) ? h.time : [];
    const i0 = hourIndex(times, out.current.time);

    // Heat index now, and the peak over the next 24 hours.
    const nowHi = out.current.temp != null && out.current.humidity != null ? heatIndexC(out.current.temp, out.current.humidity) : null;
    let peak: { hi: number; time: string } | null = null;
    let rain24 = 0, maxGust24 = 0, thunderAt: string | null = null;
    if (i0 >= 0) {
      for (let i = i0; i < Math.min(times.length, i0 + 24); i++) {
        const t = at(h.temperature_2m, i), rh = at(h.relative_humidity_2m, i);
        if (t != null && rh != null) {
          const hi = heatIndexC(t, rh);
          if (!peak || hi > peak.hi) peak = { hi, time: times[i] };
        }
        rain24 += at(h.precipitation, i) ?? 0;
        maxGust24 = Math.max(maxGust24, at(h.wind_gusts_10m, i) ?? 0);
        const code = at(h.weather_code, i);
        if (!thunderAt && code != null && code >= 95 && i < i0 + 12) thunderAt = times[i];
      }
      out.next24 = { rain_mm: Math.round(rain24 * 10) / 10, max_gust: Math.round(maxGust24), thunder: !!thunderAt, thunder_at: thunderAt };
    }
    if (nowHi != null) {
      out.heat = {
        index_c: Math.round(nowHi * 10) / 10,
        category: heatCategory(nowHi),
        peak_index_c: peak ? Math.round(peak.hi * 10) / 10 : null,
        peak_category: peak ? heatCategory(peak.hi) : null,
        peak_time: peak?.time ?? null,
      };
    }

    // Daily: the 14 past days feed the post-flood disease check; the 7
    // forecast days (today onwards) feed the outlook charts.
    const d = f.daily ?? {};
    const dates: string[] = Array.isArray(d.time) ? d.time : [];
    const today = (out.current.time || new Date().toISOString()).slice(0, 10);
    const days: DailyPoint[] = dates.map((date, i) => ({
      date,
      code: at(d.weather_code, i),
      tmax: at(d.temperature_2m_max, i),
      tmin: at(d.temperature_2m_min, i),
      feels_max: at(d.apparent_temperature_max, i),
      rain: at(d.precipitation_sum, i),
      rain_prob: at(d.precipitation_probability_max, i),
      wind_max: at(d.wind_speed_10m_max, i),
      gust_max: at(d.wind_gusts_10m_max, i),
      uv: at(d.uv_index_max, i),
    }));
    out.daily = days.filter((x) => x.date >= today).slice(0, 7);
    const past = days.filter((x) => x.date < today);
    if (past.length) {
      const wettest = past.reduce((a, b) => ((b.rain ?? 0) > (a.rain ?? 0) ? b : a));
      out.past = {
        days: past.length,
        max_daily_rain: wettest.rain ?? 0,
        max_rain_date: wettest.date,
        rain_3d_total: Math.round(past.slice(-3).reduce((s, x) => s + (x.rain ?? 0), 0) * 10) / 10,
      };
    }
  } else {
    console.error("[Open-Meteo] forecast unavailable:", fc.reason);
  }

  if (aq.status === "fulfilled") {
    const a = aq.value.value;
    const h = a.hourly ?? {};
    const times: string[] = Array.isArray(h.time) ? h.time : [];
    const i0 = hourIndex(times, a.current?.time);
    // India's NAQI uses 24-hour averages for PM2.5 and PM10.
    const window = (key: string) => {
      const end = i0 >= 0 ? i0 + 1 : times.length;
      const vals = (Array.isArray(h[key]) ? h[key] : []).slice(Math.max(0, end - 24), end).filter((v: unknown) => num(v) != null) as number[];
      return vals.length >= 12 ? vals.reduce((s, v) => s + v, 0) / vals.length : num(a.current?.[key]);
    };
    const pm25 = window("pm2_5");
    const pm10 = window("pm10");
    const naqi = naqiFromPm(pm25, pm10);
    if (naqi) {
      out.airOk = true;
      out.air = {
        ...naqi,
        pm25_24h: pm25 == null ? null : Math.round(pm25),
        pm10_24h: pm10 == null ? null : Math.round(pm10),
        dust: num(a.current?.dust),
        us_aqi: num(a.current?.us_aqi),
      };
    }
  } else {
    console.error("[Open-Meteo] air quality unavailable:", aq.reason);
  }

  return out;
}
