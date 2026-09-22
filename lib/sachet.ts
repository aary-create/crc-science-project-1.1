import type { LiveAlert } from "./types";
import { hazardFrom, severityFromColor } from "./severity";
import { memo } from "./memo";

// SACHET (sachet.ndma.gov.in) is NDMA's national alert aggregator: IMD, CWC and
// every state SDMA publish into it. This endpoint is public, keyless JSON, no
// CAP-XML parsing needed — it already gives lat/lng ("centroid"), the warned
// area in km², the validity window and the agency's full warning text (often
// in the state's own language — Gujarati for Gujarat SDMA).
//
// HTTPS first; the plain-HTTP address from NDMA's own documentation is the
// fallback, since government certificate chains occasionally break.
const URLS = process.env.SACHET_URL
  ? [process.env.SACHET_URL]
  : [
      "https://sachet.ndma.gov.in/cap_public_website/FetchAllAlertDetails",
      "http://sachet.ndma.gov.in/cap_public_website/FetchAllAlertDetails",
    ];
const REUSE_MS = 60_000; // a successful response is reused for a minute

// Java Date#toString format: "Sat Sep 19 17:35:00 IST 2026". IST has no
// reliable cross-runtime parse, so read the fields and apply the +05:30 offset.
const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
export function parseIst(s: unknown): string | null {
  const m = /^\w+ (\w+) (\d+) (\d+):(\d+):(\d+) IST (\d+)$/.exec(String(s ?? "").trim());
  if (!m) return null;
  const [, mon, day, hh, mm, ss, year] = m;
  const ms = Date.UTC(+year, MONTHS[mon] ?? 0, +day, +hh, +mm, +ss) - (5 * 60 + 30) * 60_000;
  return new Date(ms).toISOString();
}

// "lng,lat" per the API's own samples (India's lng ~68-97, lat ~8-37 — the
// first number is always in the lng range), not GeoJSON's usual [lng,lat] array.
function parseCentroid(s: unknown): { lat: number; lng: number } | null {
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(String(s ?? "").trim());
  if (!m) return null;
  return { lng: Number(m[1]), lat: Number(m[2]) };
}

// A circle of this area, in km — used as the "is this alert local to you" radius.
function radiusFromArea(sqKm: unknown): number | null {
  const a = Number(sqKm);
  return Number.isFinite(a) && a > 0 ? Math.sqrt(a / Math.PI) : null;
}

export function sachetRowToAlert(r: any): LiveAlert {
  const c = parseCentroid(r.centroid);
  const start = parseIst(r.effective_start_time);
  const message = String(r.warning_message ?? "").trim();
  return {
    id: `sachet-${r.identifier}`,
    hazard_type: hazardFrom(`${r.disaster_type ?? ""}`),
    severity: severityFromColor(r.severity_color),
    source_agency: String(r.alert_source ?? "SACHET"),
    area_text: String(r.area_description ?? ""),
    headline: String(r.disaster_type ?? "Alert"),
    message: message || null,
    message_lang: r.actual_lang ? String(r.actual_lang) : null,
    instruction: null,
    timestamp: start ?? new Date().toISOString(),
    expires: parseIst(r.effective_end_time),
    lat: c?.lat ?? null,
    lng: c?.lng ?? null,
    radius_km: radiusFromArea(r.area_covered),
    polygons: null,
  };
}

async function fetchJson(url: string) {
  const { value } = await memo(`sachet:${url}`, REUSE_MS, async () => {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(7000) });
    if (!res.ok) throw new Error(`SACHET returned ${res.status}`);
    return (await res.json()) as unknown;
  });
  return value;
}

// Try whichever address worked last time first, so a broken HTTPS endpoint
// doesn't cost a timeout on every request.
let preferred = 0;

export async function fetchSachetAlerts(): Promise<{ ok: boolean; alerts: LiveAlert[] }> {
  const order = URLS.map((_, i) => (i + preferred) % URLS.length);
  for (const i of order) {
    const url = URLS[i];
    try {
      const rows = await fetchJson(url);
      preferred = i;
      if (!Array.isArray(rows)) throw new Error("SACHET response was not a list");
      const now = Date.now();
      const alerts = rows
        .map(sachetRowToAlert)
        // The feed can still list an alert after its own validity window has
        // closed; an expired warning must not be shown as current.
        .filter((a) => !a.expires || new Date(a.expires).getTime() > now);
      return { ok: true, alerts };
    } catch (err) {
      console.error(`[SACHET] ${url} unavailable:`, err);
    }
  }
  return { ok: false, alerts: [] };
}
