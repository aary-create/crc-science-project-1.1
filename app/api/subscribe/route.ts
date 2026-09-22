import { NextResponse } from "next/server";
import { appUrl, configuredChannels, normaliseAddress, sendMessage, type Channel } from "@/lib/outbound";
import { confirmSubscription, createSubscription, dbReady, deleteSubscription, getSubscription } from "@/lib/subscriptions";
import type { Severity } from "@/lib/types";

export const dynamic = "force-dynamic";

// GET  /api/subscribe                  → which channels this deployment can send on
// GET  /api/subscribe?token=...        → that subscription's status
// GET  /api/subscribe?unsubscribe=...  → one-click unsubscribe (link in every message)
// POST { action:"start", channel, address, profile..., min_severity } → sends a 6-digit code
// POST { action:"confirm", token, code }                             → activates
// DELETE { token }                                                    → unsubscribes

const SEVERITIES: Severity[] = ["Extreme", "Severe", "Moderate", "Minor"];
const hits = new Map<string, number[]>();
function rateLimited(ip: string) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 10 * 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > 5;
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const unsub = q.get("unsubscribe");
  if (unsub) {
    const done = await deleteSubscription(unsub).catch(() => false);
    const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Suraksha Setu</title>
      <body style="font-family:system-ui,sans-serif;background:#0a1220;color:#f3f0e6;max-width:520px;margin:40px auto;padding:0 16px">
      <h1>Suraksha Setu</h1><p>${done ? "You're unsubscribed. No more alerts will be sent to this address." : "This subscription was already removed."}</p></body>`;
    return new NextResponse(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  const token = q.get("token");
  if (token) {
    const s = await getSubscription(token).catch(() => null);
    return NextResponse.json(s ? { status: s.status, channel: s.channel, address: s.address, min_severity: s.min_severity } : { status: "missing" });
  }
  return NextResponse.json({ channels: configuredChannels(), dbReady: dbReady() });
}

export async function POST(req: Request) {
  const b = await req.json().catch(() => ({}));
  if (b?.action === "confirm") {
    const r = await confirmSubscription(String(b.token ?? ""), String(b.code ?? "")).catch(() => "missing" as const);
    return NextResponse.json({ result: r }, { status: r === "ok" ? 200 : 400 });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (rateLimited(ip)) return NextResponse.json({ error: "Too many attempts. Try again in a few minutes." }, { status: 429 });
  if (!dbReady()) return NextResponse.json({ error: "Alert subscriptions need a database (DATABASE_URL)." }, { status: 501 });

  const channel = b?.channel as Channel;
  if (!configuredChannels().includes(channel)) return NextResponse.json({ error: "That channel isn't set up on this deployment." }, { status: 400 });
  const address = normaliseAddress(channel, String(b.address ?? ""));
  if (!address) return NextResponse.json({ error: channel === "email" ? "That email address doesn't look right." : "Enter a mobile number like +91 98xxxxxxxx." }, { status: 400 });
  const lat = Number(b.lat), lng = Number(b.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return NextResponse.json({ error: "Set your location first." }, { status: 400 });

  const { token, code } = await createSubscription({
    channel, address, label: String(b.label ?? "").slice(0, 200), lat, lng,
    district: String(b.district ?? ""), state: String(b.state ?? ""),
    dwelling_type: String(b.dwelling_type ?? "ground_floor"), occupation: String(b.occupation ?? "general_resident"),
    vulnerabilities: Array.isArray(b.vulnerabilities) ? b.vulnerabilities.map(String).slice(0, 10) : [],
    language: String(b.language ?? "en"),
    min_severity: SEVERITIES.includes(b.min_severity) ? b.min_severity : "Severe",
  });

  const origin = new URL(req.url).origin;
  const stop = `${appUrl(origin)}/api/subscribe?unsubscribe=${token}`;
  try {
    await sendMessage(channel, address, "Your Suraksha Setu code",
      `Suraksha Setu: your confirmation code is ${code}. Enter it in the app to start alerts for ${String(b.label ?? "your location").slice(0, 60)}. Didn't ask for this? Ignore it, or stop here: ${stop}`);
  } catch (err) {
    console.error("[subscribe] couldn't send the code:", err);
    await deleteSubscription(token).catch(() => {});
    return NextResponse.json({ error: "Couldn't send the confirmation message. Check the number/address and try again." }, { status: 502 });
  }
  return NextResponse.json({ token, status: "pending" });
}

export async function DELETE(req: Request) {
  const b = await req.json().catch(() => ({}));
  const ok = await deleteSubscription(String(b?.token ?? "")).catch(() => false);
  return NextResponse.json({ removed: ok });
}
