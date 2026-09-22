import { NextResponse } from "next/server";
import { actionFor, alertsNear, currentAlert, fetchLiveAlerts, recordPing } from "@/lib/data";
import { HAZARD_LABEL, SEVERITY_RANK } from "@/lib/severity";

export const dynamic = "force-dynamic";

// ESP32 nodes have a fixed physical install location, set once in the
// firmware as NODE_LAT/NODE_LNG.
// Body: { node_id, lat, lng, last_cached_timestamp, lang?, water_cm?, water_state?, fw? }
// If ESP32_NODE_TOKEN is set in the environment, nodes must send the same
// value in an X-Node-Token header (NODE_TOKEN in the firmware config).
//
// Response fields are pre-trimmed to the byte sizes the firmware's radio
// packet holds, on whole UTF-8 characters, so Gujarati/Hindi text is never
// cut mid-letter on the node.

const HAZARD_CODE: Record<string, number> = { other: 0, flood: 1, cyclone: 2, heavy_rain: 3, heatwave: 4, thunderstorm: 5, earthquake: 6 };

function utf8Trim(s: string, maxBytes: number) {
  const enc = new TextEncoder();
  if (enc.encode(s).length <= maxBytes) return s;
  let out = "";
  for (const ch of s) {
    if (enc.encode(out + ch + "…").length > maxBytes) break;
    out += ch;
  }
  return out + "…";
}

const unix = (iso: string | null | undefined) => (iso ? Math.floor(new Date(iso).getTime() / 1000) : 0);

async function sync(req: Request, b: Record<string, unknown>) {
  const token = process.env.ESP32_NODE_TOKEN;
  if (token && req.headers.get("x-node-token") !== token) return NextResponse.json({ error: "bad node token" }, { status: 401 });

  const nodeId = String(b.node_id ?? "").slice(0, 32);
  const lat = Number(b.lat);
  const lng = Number(b.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || b.lat == null || b.lng == null) {
    return NextResponse.json({ error: "lat and lng are required" }, { status: 400 });
  }
  const waterCm = b.water_cm == null || b.water_cm === "" ? null : Number(b.water_cm);
  const waterState = typeof b.water_state === "string" && ["dry", "warn", "danger"].includes(b.water_state) ? b.water_state : null;
  if (nodeId) {
    await recordPing({
      node_id: nodeId, lat, lng,
      last_cached_ts: Number(b.last_cached_timestamp) || null,
      water_cm: Number.isFinite(waterCm) ? waterCm : null,
      water_state: waterState,
    });
  }

  const lang = typeof b.lang === "string" ? b.lang : "en";
  const { sachetOk, imdOk, alerts } = await fetchLiveAlerts();
  const feedsOk = sachetOk || imdOk;
  const current = feedsOk ? currentAlert(alertsNear(alerts, lat, lng, "", "")) : null;
  const a = current?.alert;
  const action = actionFor({ dwelling_type: "*", occupation: "general_resident", vulnerabilities: [], language: lang }, a?.hazard_type ?? "*").action;
  const agency = current ? [...new Set(current.sources.map((s) => s.agency))].join(", ") : "";
  const hazardLabel = a ? HAZARD_LABEL[a.hazard_type] ?? "Alert" : "";

  const payload = !feedsOk
    ? "Alert feeds unreachable"
    : a ? `${a.severity.toUpperCase()} ${hazardLabel} (${agency}): ${a.headline}` : "No active alert";

  return NextResponse.json({
    // Kept for nodes still running the older firmware.
    payload: utf8Trim(payload, 120),
    timestamp: a ? unix(a.timestamp) : Math.floor(Date.now() / 1000),
    online: true,
    // Current firmware reads these.
    feeds_ok: feedsOk,
    server_time: Math.floor(Date.now() / 1000),
    alert: {
      active: !!a,
      id: a?.id ?? "",
      severity: a?.severity ?? "None",
      sev: a ? SEVERITY_RANK[a.severity] : 0,
      hazard: a?.hazard_type ?? "none",
      hazard_code: a ? HAZARD_CODE[a.hazard_type] ?? 0 : 0,
      hazard_label: hazardLabel,
      agency: utf8Trim(agency, 23),
      headline: utf8Trim(a ? a.headline : "No active alert", 63),
      // The agency's own full text — stored and shown by the node that
      // synced it; too long for the mesh radio packet, so relayed nodes get
      // the headline and action only.
      message: utf8Trim(a?.message ?? a?.instruction ?? "", 300),
      action: utf8Trim(action, 111),
      issued: a ? unix(a.timestamp) : 0,
      expires: a ? unix(a.expires) : 0,
    },
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  return sync(req, body ?? {});
}

// Handy for testing in a browser: /api/esp32-sync?lat=23.03&lng=72.58
export async function GET(req: Request) {
  return sync(req, Object.fromEntries(new URL(req.url).searchParams));
}
