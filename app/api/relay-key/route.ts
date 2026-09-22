import { NextResponse } from "next/server";
import { relayPublicKey } from "@/lib/relay-server";

// The public half of the QR-relay signing key. Phones cache it on their first
// online visit so they can verify a relayed alert later with no network.
export async function GET() {
  return NextResponse.json({ publicKey: relayPublicKey() }, { headers: { "Cache-Control": "public, max-age=3600" } });
}
