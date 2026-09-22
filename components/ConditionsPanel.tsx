"use client";
import Gauge from "@/components/Gauge";
import { NAQI_COLOR, type Conditions, weatherKey } from "@/lib/conditions";
import { timeAgo, type Key, type T } from "@/lib/i18n";

const ACCENT = "var(--focus)";
const WARN = "var(--moderate)";
const DANGER = "var(--extreme)";

// Live telemetry: temperature, humidity, air quality (NAQI estimate), wind
// and pressure, from Open-Meteo. Model data, labelled as such.
export default function ConditionsPanel({ c, t }: { c: Conditions | null; t: T }) {
  if (!c || (!c.ok && !c.airOk)) return <p className="muted">{t("condUnavailable")}</p>;
  const cur = c.current;
  const temp = cur?.temp ?? null;
  const gust = cur?.gusts ?? null;
  const pres = cur?.pressure ?? null;

  const tempColor = temp == null ? ACCENT : temp >= 45 ? DANGER : temp >= 40 ? WARN : ACCENT;
  const tempStatus = temp == null ? undefined : temp >= 45 ? t("g_status_very_high") : temp >= 40 ? t("g_status_high") : t("g_status_normal");
  const windColor = gust == null ? ACCENT : gust >= 75 ? DANGER : gust >= 50 ? WARN : ACCENT;
  const windStatus = gust == null ? undefined : gust >= 75 ? t("g_status_very_strong") : gust >= 50 ? t("g_status_strong") : t("g_status_normal");
  const presColor = pres == null ? ACCENT : pres < 990 ? DANGER : pres < 1000 ? WARN : ACCENT;

  return (
    <div>
      {cur && (
        <p className="cond-now">
          <b>{t(weatherKey(cur.weather_code) as Key)}</b>
          {c.next24 && c.next24.rain_mm >= 1 && <span className="muted"> · {t("rainNext24", { mm: Math.round(c.next24.rain_mm) })}</span>}
        </p>
      )}
      <div className="gauges">
        {cur && (
          <Gauge label={t("g_temp")} value={temp} unit="°C" min={0} max={50} color={tempColor} status={tempStatus}
            sub={cur.apparent != null ? t("feelsLike", { t: Math.round(cur.apparent) }) : undefined} />
        )}
        {cur && <Gauge label={t("g_humidity")} value={cur.humidity} unit="%" min={0} max={100} color={ACCENT} />}
        {c.air && (
          <Gauge label={t("g_aqi")} value={c.air.naqi} unit="NAQI" min={0} max={500} color={NAQI_COLOR[c.air.category]}
            status={t(`aq_${c.air.category}` as Key)} sub={`${c.air.dominant} · ${c.air.dominant === "PM2.5" ? c.air.pm25_24h : c.air.pm10_24h} µg/m³`} />
        )}
        {cur && (
          <Gauge label={t("g_wind")} value={cur.wind} unit="km/h" min={0} max={120} color={windColor} status={windStatus}
            sub={gust != null ? t("gustsTo", { g: Math.round(gust) }) : undefined} />
        )}
        {cur && (
          <Gauge label={t("g_pressure")} value={pres} unit="hPa" min={960} max={1040} color={presColor}
            status={pres == null ? undefined : pres < 1000 ? t("pressureLow") : t("pressureNormal")} />
        )}
      </div>
      <p className="muted small">{t("condSource", { ago: timeAgo(c.fetchedAt, t) })}</p>
      {c.air && <p className="muted small">{t("aqiEstimate")}</p>}
    </div>
  );
}
