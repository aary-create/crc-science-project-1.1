import type { NeonQueryFunction } from "@neondatabase/serverless";

type Db = NeonQueryFunction<false, false>;

// Idempotent: safe on a fresh database and on one created by an older
// version of this app (the "add column if not exists" lines upgrade it).
const STATEMENTS = [
  `create table if not exists users (
    id serial primary key, label text not null, lat double precision not null, lng double precision not null,
    district text not null default '', state text not null default '',
    dwelling_type text not null, occupation text not null, vulnerabilities text[] not null default '{}',
    language text not null default 'en', created_at timestamptz not null default now())`,
  `alter table users add column if not exists device_id text`,
  `alter table users add column if not exists updated_at timestamptz not null default now()`,
  `create unique index if not exists users_device_id_key on users (device_id)`,

  `create table if not exists esp32_nodes (
    node_id text primary key, lat double precision not null, lng double precision not null,
    last_cached_ts bigint, last_seen timestamptz not null default now())`,
  `alter table esp32_nodes add column if not exists water_cm double precision`,
  `alter table esp32_nodes add column if not exists water_state text`,

  // Opt-in SMS / WhatsApp / email alert subscriptions (only used when a
  // sending provider is configured — see lib/outbound.ts).
  `create table if not exists subscriptions (
    id serial primary key, token text not null unique, channel text not null, address text not null,
    label text not null default '', lat double precision not null, lng double precision not null,
    district text not null default '', state text not null default '',
    dwelling_type text not null default 'ground_floor', occupation text not null default 'general_resident',
    vulnerabilities text[] not null default '{}', language text not null default 'en',
    min_severity text not null default 'Severe', status text not null default 'pending',
    confirm_code text, confirm_attempts int not null default 0,
    last_alert_key text, last_sent_at timestamptz, created_at timestamptz not null default now(),
    unique (channel, address))`,
];

// Creates tables on first use. No sample data to seed — alerts are always
// live (SACHET/IMD), never fabricated.
let ready: Promise<void> | null = null;
export async function setupDatabase(db: Db) {
  ready ??= (async () => {
    for (const s of STATEMENTS) await db.query(s);
  })().catch((err) => {
    ready = null;
    throw err;
  });
  return ready;
}
