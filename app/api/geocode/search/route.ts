import { NextResponse } from "next/server";
import { searchPlace } from "@/lib/geocode";

export const dynamic = "force-dynamic";

// /api/geocode/search?q=...            anywhere in India
// /api/geocode/search?q=...&scope=gujarat   bounded to Gujarat (used by the district browser)
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const q = params.get("q") ?? "";
  if (q.trim().length < 2) return NextResponse.json({ results: [] });
  try {
    return NextResponse.json({ results: await searchPlace(q, { gujaratOnly: params.get("scope") === "gujarat" }) });
  } catch (err) {
    console.error("[geocode/search] failed:", err);
    return NextResponse.json({ results: [], error: "search unavailable" }, { status: 502 });
  }
}
