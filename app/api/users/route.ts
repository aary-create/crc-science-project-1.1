import { NextResponse } from "next/server";
import { saveUser } from "@/lib/data";
import type { Profile } from "@/lib/types";

export async function POST(req: Request) {
  const p = (await req.json().catch(() => ({}))) as Partial<Profile>;
  if (!p.label || !Number.isFinite(p.lat) || !Number.isFinite(p.lng) || !p.dwelling_type || !p.occupation) {
    return NextResponse.json({ error: "location, dwelling_type and occupation are required" }, { status: 400 });
  }
  const profile: Profile = {
    label: String(p.label).slice(0, 300), lat: p.lat!, lng: p.lng!, district: p.district ?? "", state: p.state ?? "",
    dwelling_type: p.dwelling_type, occupation: p.occupation,
    vulnerabilities: Array.isArray(p.vulnerabilities) ? p.vulnerabilities.map(String).slice(0, 10) : [],
    language: p.language ?? "en",
    device_id: typeof p.device_id === "string" ? p.device_id.slice(0, 64) : undefined,
  };
  return NextResponse.json(await saveUser(profile));
}
