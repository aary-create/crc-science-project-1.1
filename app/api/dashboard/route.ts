import { NextResponse } from "next/server";
import { actionFor, alertsNear, currentAlert, fetchLiveAlerts, hazardGuide, nearestNode } from "@/lib/data";
import { relayFromCurrent } from "@/lib/relay";
import { signRelay } from "@/lib/relay-server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const lat = Number(q.get("lat"));
  const lng = Number(q.get("lng"));
  if (!q.get("lat") || !q.get("lng") || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "lat and lng are required" }, { status: 400 });
  }
  const district = q.get("district") ?? "";
  const state = q.get("state") ?? "";
  const profile = {
    occupation: q.get("occupation") ?? "general_resident",
    dwelling_type: q.get("dwelling") ?? "ground_floor",
    vulnerabilities: (q.get("vulns") ?? "").split(",").filter(Boolean),
    language: q.get("lang") ?? "en",
  };

  const { sachetOk, imdOk, alerts } = await fetchLiveAlerts();
  // Both official sources unreachable: say so. The client must show this as
  // "couldn't check", never as "no alert".
  const feedsDown = !sachetOk && !imdOk;
  const current = feedsDown ? null : currentAlert(alertsNear(alerts, lat, lng, district, state));
  const { action, occupationTip, vulnerabilityTips } = actionFor(profile, current?.alert.hazard_type ?? "*");

  return NextResponse.json({
    sachetOk, imdOk, feedsDown, current, action, occupationTip, vulnerabilityTips,
    guide: hazardGuide(current?.alert.hazard_type ?? ""),
    node: await nearestNode(lat, lng),
    relay: current ? signRelay(relayFromCurrent(current)) : null,
    fetchedAt: new Date().toISOString(),
  });
}
