// Unit tests for the pure logic: alert matching and ranking, feed parsing,
// air-quality and heat maths, the rule-based risk cards, relay signing, and
// outbound address handling. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { alertsNear, currentAlert } from "../lib/data";
import { parseIst, sachetRowToAlert } from "../lib/sachet";
import { parsePolygon } from "../lib/cap";
import { heatIndexC, heatCategory, naqiFromPm } from "../lib/conditions";
import { mentionsDistrict, commonDistrictName } from "../lib/places";
import { isNightIST } from "../lib/geo";
import { airAdvice, compoundRisks, diseaseTriggers, floorTrigger } from "../lib/risk";
import { canonical, decodeRelay, encodeRelay, relayFromCurrent, verifyRelay } from "../lib/relay";
import { normaliseAddress } from "../lib/outbound";
import { actionFor } from "../lib/actions";
import { makeT } from "../lib/i18n";
import type { Conditions } from "../lib/conditions";
import type { LiveAlert } from "../lib/types";

const base: LiveAlert = {
  id: "x", hazard_type: "heavy_rain", severity: "Moderate", source_agency: "IMD", area_text: "", headline: "h",
  message: null, message_lang: null, instruction: null, timestamp: "2026-09-22T04:00:00.000Z", expires: null,
  lat: null, lng: null, radius_km: null, polygons: null,
};
const A = (o: Partial<LiveAlert>): LiveAlert => ({ ...base, ...o });
const PALANPUR = { lat: 24.1724, lng: 72.4346 };
const NOON_IST = new Date("2026-09-22T06:30:00Z"); // 12:00 IST
const MIDNIGHT_IST = new Date("2026-09-22T18:30:00Z"); // 00:00 IST

test("SACHET time parsing applies the +05:30 offset", () => {
  assert.equal(parseIst("Tue Sep 22 09:45:00 IST 2026"), "2026-09-22T04:15:00.000Z");
  assert.equal(parseIst("garbage"), null);
});

test("SACHET rows keep the full message, validity and lng,lat centroid", () => {
  const a = sachetRowToAlert({
    identifier: 1, effective_start_time: "Tue Sep 22 09:45:00 IST 2026", effective_end_time: "Tue Sep 22 13:00:00 IST 2026",
    disaster_type: "Moderate Rain", area_description: "4 districts of Maharashtra", actual_lang: "mr", warning_message: "पुढील ३ तासात",
    severity_color: "yellow", centroid: "72.838,18.986", alert_source: "Maharashtra SDMA", area_covered: "9931.7",
  });
  assert.equal(a.lat, 18.986);
  assert.equal(a.lng, 72.838);
  assert.equal(a.expires, "2026-09-22T07:30:00.000Z");
  assert.equal(a.message_lang, "mr");
  assert.equal(a.severity, "Moderate");
  assert.ok(Math.abs(a.radius_km! - 56.2) < 0.2);
});

test("matching: polygon, radius and district text (with spelling variants)", () => {
  const poly = A({ id: "p", polygons: [parsePolygon("23.8,71.9 24.9,71.9 24.9,73.0 23.8,73.0 23.8,71.9")!] });
  const polyFar = A({ id: "pf", polygons: [parsePolygon("21,70 21.5,70 21.5,70.5 21,70.5 21,70")!] });
  const near = A({ id: "n", lat: 24.1, lng: 72.3, radius_km: 10 });
  const far = A({ id: "f", lat: 18.98, lng: 72.83, radius_km: 56 });
  const text = A({ id: "t", area_text: "Heavy rain likely in Banas Kantha and Patan" });
  const got = alertsNear([poly, polyFar, near, far, text], PALANPUR.lat, PALANPUR.lng, "Banaskantha", "Gujarat").map((a) => a.id);
  assert.deepEqual(got.sort(), ["n", "p", "t"]);
});

test("district text matching is whole-word and state-aware", () => {
  assert.equal(mentionsDistrict("Danger level at Surat", "Dang", "Gujarat"), false);
  assert.equal(mentionsDistrict("Rain in The Dangs and Tapi", "Dang", "Gujarat"), true);
  assert.equal(mentionsDistrict("Waterlogging near Anand Vihar, Delhi", "Anand", "Gujarat"), false);
  assert.equal(mentionsDistrict("Anand, Kheda districts of Gujarat", "Anand", "Gujarat"), true);
  assert.equal(mentionsDistrict("Kachchh and Morbi", "Kutch", "Gujarat"), true);
  assert.equal(commonDistrictName("Banas Kantha"), "Banaskantha");
});

test("ranking: newest per agency, most cautious severity, real disagreement flagged", () => {
  const older = A({ id: "o", source_agency: "Gujarat SDMA", severity: "Moderate", timestamp: "2026-09-22T01:00:00Z" });
  const newer = A({ id: "n", source_agency: "Gujarat SDMA", severity: "Severe", timestamp: "2026-09-22T05:00:00Z" });
  const imd = A({ id: "i", source_agency: "IMD", severity: "Moderate", timestamp: "2026-09-22T04:00:00Z" });
  const c = currentAlert([older, newer, imd], NOON_IST)!;
  assert.equal(c.alert.id, "n");
  assert.equal(c.sources.length, 2); // the stale SDMA alert is gone
  assert.equal(c.conflict, true);    // SDMA Severe vs IMD Moderate is a real disagreement
  const same = currentAlert([older, newer], NOON_IST)!;
  assert.equal(same.conflict, false); // an agency never "disagrees" with its own update
});

test("time of day: a non-extreme heat advisory ranks below other hazards at night, never hidden", () => {
  const heat = A({ id: "heat", hazard_type: "heatwave", severity: "Severe" });
  const storm = A({ id: "storm", hazard_type: "thunderstorm", severity: "Moderate" });
  assert.equal(currentAlert([heat, storm], NOON_IST)!.alert.id, "heat");
  const night = currentAlert([heat, storm], MIDNIGHT_IST)!;
  assert.equal(night.alert.id, "storm");
  assert.equal(night.others[0].id, "heat");
  assert.equal(night.others[0].deprioritised, "night_heat");
  const alone = currentAlert([heat], MIDNIGHT_IST)!;
  assert.equal(alone.alert.id, "heat");
  assert.equal(alone.deprioritised, "night_heat");
  const extreme = currentAlert([A({ id: "x", hazard_type: "heatwave", severity: "Extreme" }), storm], MIDNIGHT_IST)!;
  assert.equal(extreme.alert.id, "x");
  assert.equal(isNightIST(new Date("2026-09-22T15:00:00Z")), true); // 20:30 IST
});

test("heat index matches the NWS table", () => {
  // NWS chart: 95°F at 60% RH → ~114°F (45.6°C)
  assert.ok(Math.abs(heatIndexC(35, 60) - 45.3) < 0.8);
  assert.equal(heatCategory(45.3), "danger");
  assert.equal(heatCategory(25), "none");
});

test("NAQI from PM uses CPCB breakpoints", () => {
  assert.deepEqual(naqiFromPm(25, 40), { naqi: 42, category: "good", dominant: "PM2.5" });
  assert.equal(naqiFromPm(75, 120)!.category, "moderate");
  assert.equal(naqiFromPm(100, 300)!.naqi, 251); // PM10 300 → (300-250)×(99/100)+201
  assert.equal(naqiFromPm(null, null), null);
});

const cond = (o: Partial<Conditions> = {}): Conditions => ({
  ok: true, airOk: true, fetchedAt: "", current: { time: "2026-09-22T12:00", temp: 31, humidity: 80, apparent: 38, precip: 0, weather_code: 63, pressure: 999, wind: 20, wind_dir: 200, gusts: 40, is_day: true },
  heat: { index_c: 37, category: "extreme_caution", peak_index_c: 41, peak_category: "danger", peak_time: "2026-09-22T14:00" },
  air: { naqi: 150, category: "moderate", dominant: "PM2.5", pm25_24h: 70, pm10_24h: 120, dust: 20, us_aqi: 150 },
  daily: [{ date: "2026-09-22", code: 95, tmax: 33, tmin: 25, feels_max: 40, rain: 120, rain_prob: 90, wind_max: 30, gust_max: 60, uv: 9 }],
  next24: { rain_mm: 120, max_gust: 62, thunder: true, thunder_at: "2026-09-22T17:00" },
  past: { days: 14, max_daily_rain: 91, max_rain_date: "2026-09-13", rain_3d_total: 40 },
  ...o,
});
const profile = { dwelling_type: "ground_floor", occupation: "farmer", vulnerabilities: ["respiratory", "elderly"] };

test("floor triggers follow dwelling, alerts, forecast rain and measured water", () => {
  const f = floorTrigger(profile, null, cond(), null)!;
  assert.equal(f.level, "warning"); // 120 mm ≥ IMD very heavy, ground floor
  assert.equal(f.body, "floor_ground_prepare");
  const high = floorTrigger({ ...profile, dwelling_type: "high_rise" }, null, cond(), null)!;
  assert.equal(high.level, "watch");
  const node = { node_id: "n1", lat: 0, lng: 0, last_cached_ts: null, last_seen: "", distance_km: 1.2, water_cm: 52, water_state: "danger" };
  assert.equal(floorTrigger(profile, null, cond({ next24: null }), node)!.level, "danger");
  assert.equal(floorTrigger(profile, null, cond({ next24: { rain_mm: 5, max_gust: 10, thunder: false, thunder_at: null } }), null), null);
});

test("compound risks: heat+humidity, storm, lightning for outdoor work, UV", () => {
  const ids = compoundRisks(profile, null, cond()).map((r) => r.id);
  assert.ok(ids.includes("heat_humidity"));
  assert.ok(ids.includes("storm"));
  assert.ok(ids.includes("lightning"));
  assert.ok(ids.includes("uv"));
  const lightning = compoundRisks(profile, null, cond()).find((r) => r.id === "lightning")!;
  assert.equal(lightning.level, "warning"); // farmer = outdoor
  assert.equal(compoundRisks(profile, null, cond({ ok: false })).length, 0);
});

test("respiratory care need gets AQI + thunderstorm-asthma cards", () => {
  const ids = airAdvice(profile, null, cond()).map((r) => r.id);
  assert.deepEqual(ids, ["air_resp", "air_thunder", "air_heat"]);
  const other = airAdvice({ ...profile, vulnerabilities: ["elderly"] }, null, cond({ air: { ...cond().air!, naqi: 240, category: "poor" } }));
  assert.equal(other[0].id, "air_sensitive");
});

test("disease advisory triggers from recent heavy rain or local history", () => {
  assert.equal(diseaseTriggers(null, [], cond())[0].key, "dz_reason_rain");
  assert.equal(diseaseTriggers(null, [], cond({ past: { days: 14, max_daily_rain: 20, max_rain_date: "", rain_3d_total: 0 } })).length, 0);
  const hist = [{ timestamp: "2026-09-20T00:00:00Z", label: "", hazard_type: "flood", severity: "Severe" as const, headline: "", source_agency: "CWC", action: "" }];
  assert.equal(diseaseTriggers(null, hist, null)[0].key, "dz_reason_history");
});

test("relay: signed payload verifies offline; any edit breaks it", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  process.env.RELAY_SIGNING_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const { signRelay } = await import("../lib/relay-server");
  const c = currentAlert([A({ id: "sachet-1", severity: "Severe", headline: "Heavy Rain", source_agency: "Gujarat SDMA" })], NOON_IST)!;
  const signed = signRelay(relayFromCurrent(c));
  const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const decoded = decodeRelay(encodeRelay(signed))!;
  assert.equal(await verifyRelay(decoded, pub), "verified");
  assert.equal(await verifyRelay({ ...decoded, s: "Minor" }, pub), "bad");
  assert.equal(await verifyRelay({ ...decoded, sig: undefined }, pub), "unsigned");
  assert.equal(await verifyRelay(decoded, null), "nokey");
  assert.equal(decodeRelay("hello"), null);
  assert.ok(canonical(decoded).includes("Heavy Rain"));
});

test("outbound: Indian mobiles normalise to E.164; bad input is rejected", () => {
  assert.equal(normaliseAddress("sms", "98765 43210"), "+919876543210");
  assert.equal(normaliseAddress("whatsapp", "09876543210"), "+919876543210");
  assert.equal(normaliseAddress("sms", "12345"), null);
  assert.equal(normaliseAddress("email", "A@B.in"), "a@b.in");
  assert.equal(normaliseAddress("email", "nope"), null);
});

test("actions and translations: respiratory tips and nested-key variables", () => {
  const a = actionFor({ dwelling_type: "ground_floor", occupation: "farmer", vulnerabilities: ["respiratory"], language: "gu" }, "thunderstorm");
  assert.ok(a.vulnerabilityTips[0].includes("asthma"));
  const t = makeT("gu");
  assert.equal(t("reason_flood_alert", { severity: "s_Severe", hazard: "h_flood", agency: "CWC" }), "CWC ની ગંભીર પૂર ચેતવણી");
  assert.equal(makeT("ta")("dz_mosq_h"), "Mosquito-borne: dengue and malaria"); // falls back to English
});
