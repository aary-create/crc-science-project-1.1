// Optional outbound alerts by SMS, WhatsApp or email. Off unless a provider
// is configured in Vercel's environment variables — there is no free,
// keyless way to send SMS/WhatsApp/email, so each channel needs an account:
//   email    → Resend (free tier)           RESEND_API_KEY, ALERT_FROM_EMAIL
//   sms      → Twilio (paid, trial credit)   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_SMS_FROM
//   whatsapp → Twilio (paid, sandbox free)   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM
// Sending runs from /api/dispatch, which a scheduler calls every few minutes
// (see .github/workflows/dispatch-alerts.yml).

export type Channel = "sms" | "whatsapp" | "email";

export function configuredChannels(): Channel[] {
  const out: Channel[] = [];
  const twilio = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
  if (twilio && process.env.TWILIO_SMS_FROM) out.push("sms");
  if (twilio && process.env.TWILIO_WHATSAPP_FROM) out.push("whatsapp");
  if (process.env.RESEND_API_KEY && process.env.ALERT_FROM_EMAIL) out.push("email");
  return out;
}

// E.164 for phones (a bare 10-digit Indian mobile gets +91), lower-case
// for email. Returns null if the address isn't valid for the channel.
export function normaliseAddress(channel: Channel, raw: string): string | null {
  const s = raw.trim();
  if (channel === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? s.toLowerCase() : null;
  const digits = s.replace(/[^\d+]/g, "");
  if (/^[6-9]\d{9}$/.test(digits)) return `+91${digits}`;
  if (/^0[6-9]\d{9}$/.test(digits)) return `+91${digits.slice(1)}`;
  if (/^\+\d{10,15}$/.test(digits)) return digits;
  return null;
}

export function appUrl(fallbackOrigin?: string) {
  const u = process.env.APP_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "") || fallbackOrigin || "";
  return u.replace(/\/$/, "");
}

async function sendEmail(to: string, subject: string, text: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.ALERT_FROM_EMAIL, to: [to], subject, text }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text().catch(() => "")}`);
}

async function sendTwilio(to: string, from: string, body: string) {
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${await res.text().catch(() => "")}`);
}

export async function sendMessage(channel: Channel, address: string, subject: string, text: string) {
  if (channel === "email") return sendEmail(address, subject, text);
  if (channel === "sms") return sendTwilio(address, process.env.TWILIO_SMS_FROM!, text.slice(0, 600));
  const from = process.env.TWILIO_WHATSAPP_FROM!;
  return sendTwilio(`whatsapp:${address}`, from.startsWith("whatsapp:") ? from : `whatsapp:${from}`, text.slice(0, 1500));
}
