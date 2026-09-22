import { sql } from "./db";
import { fetchSachetAlerts } from "./sachet";
import { fetchImdAlerts } from "./cap";
import { haversineKm, isNightIST, pointInPolygon } from "./geo";
import { mentionsDistrict, mentionsState } from "./places";
import { SEVERITY_RANK } from "./severity";
import type { CurrentAlert, Deprioritised, LiveAlert, NodeInfo, Profile } from "./types";

export { actionFor, hazardGuide, helplines } from "./actions";

// Live alerts from both real sources, merged. No invented/sample alerts —
// if both feeds are down, there simply are no live alerts, and the caller is
// told so (sachetOk/imdOk) so it can say that plainly instead of "all clear".
export async function fetchLiveAlerts(): Promise<{ sachetOk: boolean; imdOk: boolean; alerts: LiveAlert[] }> {
  const [sachet, imd] = await Promise.all([fetchSachetAlerts(), fetchImdAlerts()]);
  return { sachetOk: sachet.ok, imdOk: imd.ok, alerts: [...sachet.alerts, ...imd.alerts] };
}

// An alert "applies" to a point if:
//  - the agency gave polygons (CAP) and the point is inside one, or
//  - the agency gave a centre + area (SACHET) / circle (CAP) and the point is
//    within that radius plus a 20km buffer for imprecision, or
//  - the alert has no geometry at all (IMD bulletins often don't) and names
//    the person's district — or failing that their state — in its area text.
export function alertsNear(alerts: LiveAlert[], lat: number, lng: number, district: string, state: string): LiveAlert[] {
  return alerts.filter((a) => {
    if (a.polygons?.length) return a.polygons.some((ring) => pointInPolygon(lat, lng, ring));
    if (a.lat != null && a.lng != null) {
      const radius = (a.radius_km ?? 25) + 20;
      return haversineKm({ lat, lng }, { lat: a.lat, lng: a.lng }) <= radius;
    }
    return (!!district && mentionsDistrict(a.area_text, district, state)) || (!!state && mentionsState(a.area_text, state));
  });
}

// Time-aware ranking. Severity leads, but:
//  - a heat advisory at night (8pm–7am IST) drops below other hazards unless
//    it is Extreme — heat risk peaks 11am–4pm, while a thunderstorm nowcast
//    tonight is the thing to act on now. It is never hidden, only ranked.
//  - an alert whose validity window hasn't started yet ranks below one
//    that is in effect now.
function priority(a: LiveAlert, now: Date): { score: number; why: Deprioritised } {
  let score = SEVERITY_RANK[a.severity] * 10;
  let why: Deprioritised = null;
  if (a.hazard_type === "heatwave" && a.severity !== "Extreme" && isNightIST(now)) { score -= 15; why = "night_heat"; }
  if (new Date(a.timestamp).getTime() > now.getTime() + 5 * 60_000) { score -= 5; why = why ?? "upcoming"; }
  return { score, why };
}

// Highest-priority alert in scope, plus every agency reporting the same
// hazard type — if they disagree on severity, the higher one is shown and
// every agency is still listed.
export function currentAlert(alerts: LiveAlert[], now: Date = new Date()): CurrentAlert | null {
  if (!alerts.length) return null;

  // A feed can carry both an older and a newer alert from the same agency
  // for the same hazard at once (an update that hasn't displaced the
  // original entry). Keeping the stale one could show a severity that's
  // already been downgraded, or register a false "disagreement" between
  // an agency and its own earlier alert — so only the newest per
  // agency+hazard counts from here on.
  const latestByAgencyHazard = new Map<string, LiveAlert>();
  for (const a of alerts) {
    const key = `${a.source_agency}|${a.hazard_type}`;
    const prev = latestByAgencyHazard.get(key);
    if (!prev || a.timestamp > prev.timestamp) latestByAgencyHazard.set(key, a);
  }
  const ranked = [...latestByAgencyHazard.values()]
    .map((a) => ({ a, ...priority(a, now) }))
    .sort((x, y) => y.score - x.score || y.a.timestamp.localeCompare(x.a.timestamp));

  const top = ranked[0];
  const sameHazard = ranked.filter((r) => r.a.hazard_type === top.a.hazard_type);
  // The shown severity for the hazard is the most cautious one any agency gives.
  const alert = sameHazard.reduce((best, r) => (SEVERITY_RANK[r.a.severity] > SEVERITY_RANK[best.severity] ? r.a : best), top.a);
  const sources = sameHazard.map((r) => ({ agency: r.a.source_agency, severity: r.a.severity, headline: r.a.headline }));
  const conflict = new Set(sources.map((s) => s.severity)).size > 1;

  const seen = new Set<string>([top.a.hazard_type]);
  const others: CurrentAlert["others"] = [];
  for (const r of ranked) {
    if (seen.has(r.a.hazard_type)) continue;
    seen.add(r.a.hazard_type);
    others.push({ id: r.a.id, hazard_type: r.a.hazard_type, severity: r.a.severity, source_agency: r.a.source_agency, headline: r.a.headline, deprioritised: r.why });
  }
  return { alert, sources, conflict, deprioritised: top.why, others };
}

async function withDb<T>(run: (db: NonNullable<typeof sql>) => Promise<T>, fallback: () => T): Promise<T> {
  if (!sql) return fallback();
  try {
    return await run(sql);
  } catch (err) {
    console.error("[DB] query failed:", err);
    return fallback();
  }
}

// One row per device (device_id is a random id the browser generates once),
// so editing a profile updates it instead of piling up duplicates.
export async function saveUser(p: Profile) {
  return withDb<{ saved: boolean }>(
    async (db) => {
      const id = p.device_id || null;
      await db`insert into users (device_id, label, lat, lng, district, state, dwelling_type, occupation, vulnerabilities, language)
        values (${id}, ${p.label}, ${p.lat}, ${p.lng}, ${p.district}, ${p.state}, ${p.dwelling_type}, ${p.occupation}, ${p.vulnerabilities}, ${p.language})
        on conflict (device_id) do update set label = excluded.label, lat = excluded.lat, lng = excluded.lng,
          district = excluded.district, state = excluded.state, dwelling_type = excluded.dwelling_type,
          occupation = excluded.occupation, vulnerabilities = excluded.vulnerabilities, language = excluded.language,
          updated_at = now()`;
      return { saved: true };
    },
    () => ({ saved: false })
  );
}

// ESP32 nodes have a fixed physical location (set once in the firmware), so
// they report lat/lng directly rather than a district name. Nodes with a
// water-level sensor also report the measured depth.
type NodePing = { node_id: string; lat: number; lng: number; last_cached_ts: number | null; last_seen: string; water_cm: number | null; water_state: string | null };
const memoryPings = new Map<string, NodePing>();

export async function recordPing(p: Omit<NodePing, "last_seen">) {
  memoryPings.set(p.node_id, { ...p, last_seen: new Date().toISOString() });
  await withDb<unknown>(
    (db) => db`insert into esp32_nodes (node_id, lat, lng, last_cached_ts, water_cm, water_state, last_seen)
      values (${p.node_id}, ${p.lat}, ${p.lng}, ${p.last_cached_ts}, ${p.water_cm}, ${p.water_state}, now())
      on conflict (node_id) do update set lat = excluded.lat, lng = excluded.lng,
        last_cached_ts = excluded.last_cached_ts, water_cm = excluded.water_cm,
        water_state = excluded.water_state, last_seen = now()`,
    () => null
  );
}

const NODE_RADIUS_KM = 50;
const toNodeInfo = (n: any, lat: number, lng: number): NodeInfo => ({
  node_id: String(n.node_id),
  lat: Number(n.lat),
  lng: Number(n.lng),
  last_cached_ts: n.last_cached_ts == null ? null : Number(n.last_cached_ts),
  last_seen: new Date(n.last_seen).toISOString(),
  distance_km: haversineKm({ lat, lng }, { lat: Number(n.lat), lng: Number(n.lng) }),
  water_cm: n.water_cm == null ? null : Number(n.water_cm),
  water_state: n.water_state ?? null,
});

// The nearest node reporting from within 50km, if any.
export async function nearestNode(lat: number, lng: number): Promise<NodeInfo | null> {
  const pick = (rows: any[]) => {
    const near = rows.map((n) => toNodeInfo(n, lat, lng)).filter((n) => n.distance_km <= NODE_RADIUS_KM);
    return near.sort((a, b) => a.distance_km - b.distance_km)[0] ?? null;
  };
  return withDb(async (db) => pick((await db`select * from esp32_nodes`) as any[]), () => pick([...memoryPings.values()]));
}
