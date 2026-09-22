import { NextResponse } from "next/server";
import { fetchConditions } from "@/lib/weather";

export const dynamic = "force-dynamic";

// Live weather + air quality for a point, from Open-Meteo (keyless).
// /api/conditions?lat=23.03&lng=72.58
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const lat = Number(q.get("lat"));
  const lng = Number(q.get("lng"));
  if (!q.get("lat") || !q.get("lng") || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "lat and lng are required" }, { status: 400 });
  }
  const c = await fetchConditions(lat, lng);
  return NextResponse.json(c, { status: c.ok || c.airOk ? 200 : 502 });
}
