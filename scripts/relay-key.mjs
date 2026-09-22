// Prints a fresh P-256 key pair for signing QR relays.
// Put the PRIVATE key into Vercel → Settings → Environment Variables as
// RELAY_SIGNING_KEY (paste the whole block, newlines included). Never commit it.
import { generateKeyPairSync } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
console.log("RELAY_SIGNING_KEY (private — goes in Vercel env only):\n");
console.log(privateKey.export({ type: "pkcs8", format: "pem" }));
console.log("Public key (served automatically at /api/relay-key, shown here for reference):\n");
console.log(publicKey.export({ type: "spki", format: "der" }).toString("base64url"));
