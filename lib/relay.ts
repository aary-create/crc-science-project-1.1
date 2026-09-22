import type { CurrentAlert, Severity } from "./types";

// Phone-to-phone relay without a network: one phone shows the current alert
// as a QR code, another phone scans it with its camera. A web page can't
// form a Bluetooth mesh (browsers can't advertise as Bluetooth peripherals)
// and WebRTC needs an internet signalling server, so a QR code is the relay
// that works fully offline in a browser.
//
// When the server has RELAY_SIGNING_KEY set, every relay payload is signed
// (ECDSA P-256). A receiving phone that has opened the app online at least
// once has cached the public key, so it can check offline that the alert
// really came from this app's server and wasn't typed up by someone.

export const RELAY_PREFIX = "SSR1:";

export type Verdict = "verified" | "bad" | "unsigned" | "nokey";
// A relay this phone received and kept (lib/store.ts, key ss:relays).
export type SavedRelay = { payload: RelayPayload; verdict: Verdict; received: string };

export type RelayPayload = {
  v: 1;
  i: string;        // alert id
  h: string;        // hazard type
  s: Severity;
  a: string;        // agencies, comma-separated
  t: string;        // headline (trimmed)
  ar: string;       // area text (trimmed)
  ts: number;       // issued, unix seconds
  x: number;        // expires, unix seconds (0 = not given)
  sa: number;       // signed / generated at, unix seconds
  sig?: string;     // base64url ECDSA P-256 signature (IEEE P1363), when signed
};

const unix = (iso: string | null) => (iso ? Math.floor(new Date(iso).getTime() / 1000) : 0);
const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function relayFromCurrent(c: CurrentAlert, now = Date.now()): RelayPayload {
  return {
    v: 1,
    i: c.alert.id.slice(0, 64),
    h: c.alert.hazard_type,
    s: c.alert.severity,
    a: trim([...new Set(c.sources.map((s) => s.agency))].join(", "), 60),
    t: trim(c.alert.headline, 140),
    ar: trim(c.alert.area_text, 80),
    ts: unix(c.alert.timestamp),
    x: unix(c.alert.expires),
    sa: Math.floor(now / 1000),
  };
}

// The exact bytes that get signed — field order fixed, signature excluded.
export function canonical(p: RelayPayload): string {
  return [p.v, p.i, p.h, p.s, p.a, p.t, p.ar, p.ts, p.x, p.sa].join("\n");
}

export function encodeRelay(p: RelayPayload): string {
  return RELAY_PREFIX + JSON.stringify(p);
}

const SEVERITIES = ["Extreme", "Severe", "Moderate", "Minor"];
export function decodeRelay(text: string): RelayPayload | null {
  const raw = text.trim();
  if (!raw.startsWith(RELAY_PREFIX)) return null;
  try {
    const p = JSON.parse(raw.slice(RELAY_PREFIX.length));
    if (p?.v !== 1 || typeof p.i !== "string" || typeof p.h !== "string" || !SEVERITIES.includes(p.s)) return null;
    if (typeof p.t !== "string" || typeof p.ts !== "number" || typeof p.sa !== "number") return null;
    return { v: 1, i: p.i, h: p.h, s: p.s, a: String(p.a ?? ""), t: p.t, ar: String(p.ar ?? ""), ts: p.ts, x: Number(p.x) || 0, sa: p.sa, sig: typeof p.sig === "string" ? p.sig : undefined };
  } catch {
    return null;
  }
}

const b64urlToBytes = (s: string) => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

// Browser-side check with WebCrypto. Returns "verified", "bad" (signed but
// the signature doesn't match — treat as tampered) or "unsigned"/"nokey".
export async function verifyRelay(p: RelayPayload, publicKeyB64: string | null | undefined): Promise<"verified" | "bad" | "unsigned" | "nokey"> {
  if (!p.sig) return "unsigned";
  if (!publicKeyB64 || typeof crypto === "undefined" || !crypto.subtle) return "nokey";
  try {
    const key = await crypto.subtle.importKey("spki", b64urlToBytes(publicKeyB64), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64urlToBytes(p.sig), new TextEncoder().encode(canonical(p)));
    return ok ? "verified" : "bad";
  } catch {
    return "bad";
  }
}
