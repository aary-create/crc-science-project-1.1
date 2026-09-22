import { XMLParser } from "fast-xml-parser";
import type { LiveAlert } from "./types";
import { hazardFrom, normalizeSeverity } from "./severity";
import { memo } from "./memo";

// IMD's own district-bulletin CAP feed — a different product from the
// nowcasts SACHET carries (bulletin-level vs. short-range nowcast), so both
// are worth keeping. When a CAP document carries <polygon>/<circle> areas the
// app matches by geometry; otherwise it falls back to matching the place
// names in <areaDesc> against the person's district and state.
const RSS_URL = process.env.IMD_RSS_URL ?? "https://cap-sources.s3.amazonaws.com/in-imd-en/rss.xml";
const MAX_ITEMS = 30;
const RSS_REUSE_MS = 120_000;        // the list of current bulletins
const CAP_REUSE_MS = 6 * 3600_000;   // a CAP document at a given URL doesn't change

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
const list = <T>(x: T | T[] | undefined | null): T[] => (x == null ? [] : Array.isArray(x) ? x : [x]);
const text = (x: unknown) => (x && typeof x === "object" && "#text" in x ? String((x as any)["#text"]) : String(x ?? "")).trim();

async function fetchText(url: string, ms: number, reuseMs: number) {
  const { value } = await memo(`imd:${url}`, reuseMs, async () => {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(ms) });
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    return res.text();
  });
  return value;
}

function isoOrNull(s: string): string | null {
  if (!s) return null;
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// CAP 1.2: a polygon is space-separated "lat,lon" pairs, first == last.
export function parsePolygon(s: string): [number, number][] | null {
  const pts = s.trim().split(/\s+/).map((pair) => pair.split(",").map(Number) as [number, number]);
  if (pts.length < 4 || pts.some((p) => p.length !== 2 || !p.every(Number.isFinite))) return null;
  return pts;
}

// CAP 1.2: a circle is "lat,lon radius_km".
function parseCircle(s: string): { lat: number; lng: number; r: number } | null {
  const m = /^\s*(-?[\d.]+),(-?[\d.]+)\s+([\d.]+)\s*$/.exec(s);
  if (!m) return null;
  const [lat, lng, r] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return [lat, lng, r].every(Number.isFinite) ? { lat, lng, r } : null;
}

async function itemToAlert(item: any): Promise<LiveAlert> {
  const title = text(item.title);
  const alert: LiveAlert = {
    id: `imd-${text(item.guid) || text(item.link) || title}`,
    hazard_type: hazardFrom(title),
    severity: "Moderate",
    source_agency: "IMD",
    area_text: text(item.description),
    headline: title,
    message: null,
    message_lang: "en",
    instruction: null,
    timestamp: isoOrNull(text(item.pubDate)) ?? new Date().toISOString(),
    expires: null,
    lat: null,
    lng: null,
    radius_km: null,
    polygons: null,
  };
  if (!item.link) return alert;
  try {
    const cap = parser.parse(await fetchText(text(item.link), 4000, CAP_REUSE_MS))?.alert;
    const infos = list<any>(cap?.info);
    const info = infos.find((i) => text(i.language || "en").startsWith("en")) ?? infos[0];
    if (!info) return alert;
    alert.severity = normalizeSeverity(text(info.severity));
    alert.hazard_type = hazardFrom(`${text(info.event)} ${text(info.headline)}`);
    alert.headline = text(info.headline) || text(info.event) || title;
    alert.message = text(info.description) || null;
    alert.instruction = text(info.instruction) || null;
    alert.message_lang = text(info.language) || "en";
    const areas = list<any>(info.area);
    const names = areas.map((a) => text(a.areaDesc)).filter(Boolean);
    if (names.length) alert.area_text = names.join(", ");
    const polygons = areas.flatMap((a) => list<any>(a.polygon).map((p) => parsePolygon(text(p)))).filter(Boolean) as [number, number][][];
    if (polygons.length) alert.polygons = polygons;
    const circle = areas.flatMap((a) => list<any>(a.circle).map((c) => parseCircle(text(c)))).find(Boolean);
    if (circle) { alert.lat = circle.lat; alert.lng = circle.lng; alert.radius_km = circle.r; }
    alert.timestamp = isoOrNull(text(info.effective)) ?? isoOrNull(text(cap.sent)) ?? alert.timestamp;
    alert.expires = isoOrNull(text(info.expires));
  } catch {
    // keep the RSS-level fields if the linked CAP document can't be read
  }
  return alert;
}

export async function fetchImdAlerts(): Promise<{ ok: boolean; alerts: LiveAlert[] }> {
  try {
    const rss = parser.parse(await fetchText(RSS_URL, 4000, RSS_REUSE_MS));
    const channel = rss?.rss?.channel;
    if (!channel) throw new Error("IMD RSS had no channel");
    const items = list<any>(channel.item).slice(0, MAX_ITEMS);
    const now = Date.now();
    const alerts = (await Promise.all(items.map(itemToAlert))).filter((a) => !a.expires || new Date(a.expires).getTime() > now);
    // Reachable-and-empty is a real answer ("no bulletins right now"), not an outage.
    return { ok: true, alerts };
  } catch (err) {
    console.error("[IMD] feed unavailable:", err);
    return { ok: false, alerts: [] };
  }
}
