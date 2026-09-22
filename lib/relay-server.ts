import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { canonical, type RelayPayload } from "./relay";

// Server-only half of the QR relay: signs payloads with RELAY_SIGNING_KEY
// (a P-256 private key in PKCS#8 PEM — generate one with `npm run relay-key`).
// Without the key, relays still work, they're just marked "unverified".

let cached: { priv: KeyObject; pubB64: string } | null | undefined;

function keys() {
  if (cached !== undefined) return cached;
  const pem = process.env.RELAY_SIGNING_KEY?.replace(/\\n/g, "\n").trim();
  if (!pem) return (cached = null);
  try {
    const priv = createPrivateKey(pem);
    const pubB64 = createPublicKey(priv).export({ type: "spki", format: "der" }).toString("base64url");
    return (cached = { priv, pubB64 });
  } catch (err) {
    console.error("[relay] RELAY_SIGNING_KEY is set but couldn't be read:", err);
    return (cached = null);
  }
}

export function relayPublicKey(): string | null {
  return keys()?.pubB64 ?? null;
}

export function signRelay(p: RelayPayload): RelayPayload {
  const k = keys();
  if (!k) return p;
  const sig = sign("sha256", Buffer.from(canonical(p)), { key: k.priv, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return { ...p, sig };
}
