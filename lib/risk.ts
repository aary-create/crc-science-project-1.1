import type { Key } from "./i18n";
import type { Conditions } from "./conditions";
import { IMD_RAIN } from "./conditions";
import type { HistoryEntry } from "./history";
import { SEVERITY_RANK } from "./severity";
import type { CurrentAlert, NodeInfo, Profile, Severity } from "./types";

// Rule-based risk cards built only from real inputs: the live alert, the
// Open-Meteo model data, the nearest ESP32 node's measured water level, and
// this device's own 5-day history. Every card lists the data behind it.

export type Level = "info" | "watch" | "warning" | "danger";
export type Reason = { key: Key; vars?: Record<string, string | number> };
export type RiskItem = { id: string; level: Level; title: Key; body: Key; vars?: Record<string, string | number>; reasons: Reason[] };

export const LEVEL_RANK: Record<Level, number> = { info: 0, watch: 1, warning: 2, danger: 3 };
const maxLevel = (a: Level, b: Level) => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a);
const atLeast = (s: Severity | undefined, min: Severity) => !!s && SEVERITY_RANK[s] >= SEVERITY_RANK[min];
const hhmm = (iso: string | null) => (iso ? iso.slice(11, 16) : "");
const OUTDOOR = ["farmer", "fisherman", "daily_wage_worker"];

type P = Pick<Profile, "dwelling_type" | "occupation" | "vulnerabilities">;

// ---------------------------------------------------------------------------
// Floor-level flood triggers
// ---------------------------------------------------------------------------
const GROUND = ["ground_floor", "flood_prone_lane", "kutcha_house"];
const NODE_NEAR_KM = 5;

function floorGroup(d: string) {
  if (GROUND.includes(d)) return "ground";
  if (d === "mid_floor") return "mid";
  if (d === "high_rise") return "high";
  return "higher";
}

export function floorTrigger(p: P, current: CurrentAlert | null, cond: Conditions | null, node: NodeInfo | null): RiskItem | null {
  const group = floorGroup(p.dwelling_type);
  const reasons: Reason[] = [];
  let level: Level | null = null;
  const bump = (l: Level) => { level = level ? maxLevel(level, l) : l; };

  // 1. Measured: a Suraksha Setu node with a water-level sensor nearby.
  if (node && node.water_cm != null && node.distance_km <= NODE_NEAR_KM && (node.water_state === "warn" || node.water_state === "danger")) {
    reasons.push({ key: "reason_node_water", vars: { node: node.node_id, cm: Math.round(node.water_cm), km: node.distance_km.toFixed(1) } });
    if (node.water_state === "danger") bump(group === "ground" ? "danger" : "warning");
    else bump(group === "ground" ? "warning" : "watch");
  }

  // 2. Official: a flood / heavy-rain / cyclone alert for this spot.
  const floodish = [current?.alert, ...(current?.others ?? [])].filter(Boolean).filter((a) => ["flood", "heavy_rain", "cyclone"].includes(a!.hazard_type));
  for (const a of floodish) {
    const sev = a!.severity;
    reasons.push({ key: "reason_flood_alert", vars: { hazard: `h_${a!.hazard_type}`, severity: `s_${sev}`, agency: a!.source_agency } });
    if (a!.hazard_type === "flood") {
      if (atLeast(sev, "Severe")) bump(group === "ground" ? "danger" : "warning");
      else bump(group === "ground" ? "warning" : "watch");
    } else if (atLeast(sev, "Severe")) {
      bump(group === "ground" ? "warning" : "watch");
    } else {
      bump("watch");
    }
  }

  // 3. Forecast: IMD rainfall categories over the next 24 hours.
  const rain = cond?.next24?.rain_mm ?? 0;
  if (rain >= IMD_RAIN.heavy) {
    reasons.push({ key: "reason_rain_forecast", vars: { mm: Math.round(rain) } });
    if (rain >= IMD_RAIN.extremely_heavy) bump(group === "ground" ? "danger" : "watch");
    else if (rain >= IMD_RAIN.very_heavy) bump(group === "ground" ? "warning" : "watch");
    else bump("watch");
  }

  if (!level) return null;
  const lv = level as Level;
  const tier = lv === "danger" ? "act" : lv === "warning" ? "prepare" : "watch";
  return { id: "floor", level: lv, title: `floor_title_${tier}` as Key, body: `floor_${group}_${tier}` as Key, reasons };
}

// ---------------------------------------------------------------------------
// Compound (multi-hazard) risks
// ---------------------------------------------------------------------------
export function compoundRisks(p: P, current: CurrentAlert | null, cond: Conditions | null): RiskItem[] {
  if (!cond?.ok) return [];
  const out: RiskItem[] = [];
  const today = cond.daily[0];
  const outdoor = OUTDOOR.includes(p.occupation);

  // Heat + humidity → heat index.
  const h = cond.heat;
  if (h) {
    const worst = Math.max(h.index_c, h.peak_index_c ?? -99);
    const cat = (h.peak_index_c ?? -99) > h.index_c ? h.peak_category! : h.category;
    if (worst >= 32.2) {
      const level: Level = cat === "extreme_danger" ? "danger" : cat === "danger" ? "warning" : "watch";
      out.push({
        id: "heat_humidity", level, title: "cr_heat_title", body: outdoor ? "cr_heat_body_outdoor" : "cr_heat_body",
        vars: { hi: Math.round(worst), time: hhmm(h.peak_time) },
        reasons: [{ key: "reason_heat_index", vars: { temp: Math.round(cond.current?.temp ?? 0), rh: Math.round(cond.current?.humidity ?? 0), now: Math.round(h.index_c), peak: Math.round(h.peak_index_c ?? h.index_c), time: hhmm(h.peak_time) } }],
      });
    }
  }

  // Heat + poor air together.
  const hot = (h && Math.max(h.index_c, h.peak_index_c ?? -99) >= 32.2) || (today?.tmax ?? 0) >= 38;
  if (hot && cond.air && cond.air.naqi >= 201) {
    out.push({
      id: "heat_air", level: "warning", title: "cr_heat_air_title", body: "cr_heat_air_body",
      reasons: [{ key: "reason_naqi", vars: { naqi: cond.air.naqi, cat: `aq_${cond.air.category}` } }, { key: "reason_tmax", vars: { t: Math.round(today?.tmax ?? cond.current?.temp ?? 0) } }],
    });
  }

  // Wind + rain → storm damage.
  const n = cond.next24;
  if (n && n.max_gust >= 50 && n.rain_mm >= 10) {
    out.push({
      id: "storm", level: n.max_gust >= 75 ? "danger" : "warning", title: "cr_storm_title", body: "cr_storm_body",
      reasons: [{ key: "reason_gust_rain", vars: { gust: n.max_gust, mm: Math.round(n.rain_mm) } }],
    });
  } else if (n && n.max_gust >= 60) {
    out.push({ id: "wind", level: "watch", title: "cr_wind_title", body: "cr_wind_body", reasons: [{ key: "reason_gust", vars: { gust: n.max_gust } }] });
  }

  // Lightning.
  const thunderAlert = current?.alert.hazard_type === "thunderstorm" || current?.others.some((o) => o.hazard_type === "thunderstorm");
  if (n?.thunder || thunderAlert) {
    out.push({
      id: "lightning", level: outdoor ? "warning" : "watch", title: "cr_lightning_title", body: outdoor ? "cr_lightning_body_outdoor" : "cr_lightning_body",
      reasons: n?.thunder ? [{ key: "reason_thunder", vars: { time: hhmm(n.thunder_at) } }] : [{ key: "reason_thunder_alert" }],
    });
  }

  // Sea state for fishers.
  const cycloneAlert = current?.alert.hazard_type === "cyclone" || current?.others.some((o) => o.hazard_type === "cyclone");
  if (p.occupation === "fisherman" && ((n?.max_gust ?? 0) >= 45 || cycloneAlert)) {
    out.push({
      id: "sea", level: "danger", title: "cr_sea_title", body: "cr_sea_body",
      reasons: cycloneAlert ? [{ key: "reason_cyclone_alert" }] : [{ key: "reason_gust", vars: { gust: n!.max_gust } }],
    });
  }

  // Sun for outdoor workers.
  if (outdoor && (today?.uv ?? 0) >= 8) {
    out.push({ id: "uv", level: "watch", title: "cr_uv_title", body: "cr_uv_body", reasons: [{ key: "reason_uv", vars: { uv: Math.round(today!.uv!) } }] });
  }

  return out.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
}

// ---------------------------------------------------------------------------
// Air quality, cross-referenced with breathing conditions
// ---------------------------------------------------------------------------
export function airAdvice(p: P, current: CurrentAlert | null, cond: Conditions | null): RiskItem[] {
  if (!cond?.air) return [];
  const a = cond.air;
  const out: RiskItem[] = [];
  const reason: Reason = { key: "reason_naqi_detail", vars: { naqi: a.naqi, cat: `aq_${a.category}`, pm25: a.pm25_24h ?? "–", pm10: a.pm10_24h ?? "–" } };
  const vulns = p.vulnerabilities ?? [];

  if (vulns.includes("respiratory")) {
    const level: Level = ({ good: "info", satisfactory: "info", moderate: "watch", poor: "warning", very_poor: "danger", severe: "danger" } as const)[a.category];
    out.push({ id: "air_resp", level, title: "air_resp_title", body: `air_resp_${a.category}` as Key, vars: { naqi: a.naqi }, reasons: [reason] });

    const thunder = cond.next24?.thunder || current?.alert.hazard_type === "thunderstorm" || current?.others.some((o) => o.hazard_type === "thunderstorm");
    if (thunder) out.push({ id: "air_thunder", level: "warning", title: "air_thunder_title", body: "air_thunder_body", reasons: [{ key: "reason_thunder_any" }] });

    if ((a.dust ?? 0) >= 150) out.push({ id: "air_dust", level: "warning", title: "air_dust_title", body: "air_dust_body", reasons: [{ key: "reason_dust", vars: { dust: Math.round(a.dust!) } }] });

    const hi = cond.heat ? Math.max(cond.heat.index_c, cond.heat.peak_index_c ?? -99) : 0;
    if (hi >= 39.4) out.push({ id: "air_heat", level: "watch", title: "air_heat_title", body: "air_heat_body", reasons: [{ key: "reason_heat_only", vars: { hi: Math.round(hi) } }] });
  } else if (vulns.some((v) => ["elderly", "infant_or_pregnant", "chronic_illness"].includes(v)) && a.naqi >= 201) {
    out.push({ id: "air_sensitive", level: "warning", title: "air_sensitive_title", body: "air_sensitive_body", reasons: [reason] });
  } else if (a.naqi >= 301) {
    out.push({ id: "air_everyone", level: "warning", title: "air_everyone_title", body: "air_everyone_body", reasons: [reason] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Post-flood disease advisory (dengue, malaria, leptospirosis, water-borne)
// ---------------------------------------------------------------------------
const WET = ["flood", "heavy_rain", "cyclone"];

export function diseaseTriggers(current: CurrentAlert | null, history: HistoryEntry[], cond: Conditions | null): Reason[] {
  const reasons: Reason[] = [];
  const now = [current?.alert, ...(current?.others ?? [])].find((a) => a && WET.includes(a.hazard_type) && (a.hazard_type === "flood" || atLeast(a.severity, "Severe")));
  if (now) reasons.push({ key: "dz_reason_alert", vars: { hazard: `h_${now.hazard_type}` } });

  const logged = history.find((h) => h.hazard_type && WET.includes(h.hazard_type));
  if (logged) reasons.push({ key: "dz_reason_history", vars: { hazard: `h_${logged.hazard_type}`, date: logged.timestamp.slice(0, 10) } });

  if (cond?.past && cond.past.max_daily_rain >= IMD_RAIN.heavy) {
    reasons.push({ key: "dz_reason_rain", vars: { mm: Math.round(cond.past.max_daily_rain), date: cond.past.max_rain_date, days: cond.past.days } });
  }
  return reasons;
}
