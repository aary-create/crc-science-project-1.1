import { randomBytes, randomInt } from "node:crypto";
import { sql } from "./db";
import type { Channel } from "./outbound";
import type { Severity } from "./types";

// Opt-in alert subscriptions. Needs DATABASE_URL: a subscription that
// vanished on the next server restart would silently stop warning someone,
// which is worse than not offering it.

export type Subscription = {
  id: number; token: string; channel: Channel; address: string; label: string;
  lat: number; lng: number; district: string; state: string;
  dwelling_type: string; occupation: string; vulnerabilities: string[]; language: string;
  min_severity: Severity; status: "pending" | "active"; confirm_code: string | null; confirm_attempts: number;
  last_alert_key: string | null; last_sent_at: string | null;
};

export const dbReady = () => !!sql;

export async function createSubscription(s: Omit<Subscription, "id" | "token" | "status" | "confirm_code" | "confirm_attempts" | "last_alert_key" | "last_sent_at">) {
  if (!sql) throw new Error("no database");
  const token = randomBytes(18).toString("base64url");
  const code = String(randomInt(100000, 1000000));
  // Re-subscribing the same address replaces its old settings and asks for
  // a fresh confirmation.
  await sql`insert into subscriptions (token, channel, address, label, lat, lng, district, state, dwelling_type, occupation, vulnerabilities, language, min_severity, status, confirm_code)
    values (${token}, ${s.channel}, ${s.address}, ${s.label}, ${s.lat}, ${s.lng}, ${s.district}, ${s.state}, ${s.dwelling_type}, ${s.occupation}, ${s.vulnerabilities}, ${s.language}, ${s.min_severity}, 'pending', ${code})
    on conflict (channel, address) do update set token = excluded.token, label = excluded.label, lat = excluded.lat, lng = excluded.lng,
      district = excluded.district, state = excluded.state, dwelling_type = excluded.dwelling_type, occupation = excluded.occupation,
      vulnerabilities = excluded.vulnerabilities, language = excluded.language, min_severity = excluded.min_severity,
      status = 'pending', confirm_code = excluded.confirm_code, confirm_attempts = 0, last_alert_key = null`;
  return { token, code };
}

export async function confirmSubscription(token: string, code: string): Promise<"ok" | "bad" | "locked" | "missing"> {
  if (!sql) return "missing";
  const rows = (await sql`select * from subscriptions where token = ${token}`) as Subscription[];
  const s = rows[0];
  if (!s) return "missing";
  if (s.status === "active") return "ok";
  if (s.confirm_attempts >= 5) return "locked";
  if (s.confirm_code !== code.trim()) {
    await sql`update subscriptions set confirm_attempts = confirm_attempts + 1 where id = ${s.id}`;
    return "bad";
  }
  await sql`update subscriptions set status = 'active', confirm_code = null where id = ${s.id}`;
  return "ok";
}

export async function deleteSubscription(token: string) {
  if (!sql) return false;
  const rows = (await sql`delete from subscriptions where token = ${token} returning id`) as unknown[];
  return rows.length > 0;
}

export async function getSubscription(token: string): Promise<Subscription | null> {
  if (!sql) return null;
  const rows = (await sql`select * from subscriptions where token = ${token}`) as Subscription[];
  return rows[0] ?? null;
}

export async function activeSubscriptions(limit = 500): Promise<Subscription[]> {
  if (!sql) return [];
  return (await sql`select * from subscriptions where status = 'active' order by id limit ${limit}`) as Subscription[];
}

export async function markSent(id: number, key: string | null) {
  if (!sql) return;
  await sql`update subscriptions set last_alert_key = ${key}, last_sent_at = now() where id = ${id}`;
}
