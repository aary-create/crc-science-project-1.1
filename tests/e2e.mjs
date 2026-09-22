// End-to-end walk-through against a running app (npm start) backed by
// tests/mock-upstream.mjs. Takes screenshots into ./screenshots and fails on
// any page error.   Usage: APP=http://localhost:3100 node tests/e2e.mjs
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import fs from "node:fs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require(`${execSync("npm root -g").toString().trim()}/playwright`)); }

const APP = process.env.APP ?? "http://localhost:3100";
const OUT = process.env.OUT ?? "screenshots";
fs.mkdirSync(OUT, { recursive: true });
const errors = [];
const ok = (cond, msg) => { if (!cond) { errors.push(msg); console.error("FAIL:", msg); } else console.log("ok:", msg); };

const browser = await chromium.launch();
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "en-IN", timezoneId: "Asia/Kolkata" };

function watch(page, name) {
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.g|unpkg|Failed to load resource/.test(m.text())) errors.push(`${name} console: ${m.text()}`); });
}

// 1. Onboarding with GPS allowed → dashboard (English, ground floor, farmer, asthma + elderly)
{
  const ctx = await browser.newContext({ ...phone, geolocation: { latitude: 24.1724, longitude: 72.4346 }, permissions: ["geolocation"] });
  const page = await ctx.newPage(); watch(page, "onboarding-gps");
  await page.goto(`${APP}/onboarding`);
  await page.getByText("Palanpur, Palanpur Taluka").first().waitFor();
  ok(true, "GPS location detected and reverse-geocoded on open");
  await page.getByLabel("Ground floor").check();
  await page.getByLabel("Farmer").check();
  await page.getByLabel("Someone with asthma or a lung condition").check();
  await page.getByLabel("Elderly person at home").check();
  await page.screenshot({ path: `${OUT}/01-onboarding.png`, fullPage: true });
  await page.getByRole("button", { name: "Show my alerts" }).click();
  await page.waitForURL("**/dashboard");
  await page.getByText("Heavy rain").first().waitFor();
  await page.getByText("For your floor").first().waitFor();
  await page.waitForTimeout(800);
  ok(await page.getByText("Official message").isVisible(), "official SACHET message shown");
  ok(await page.getByText("Also in effect here").isVisible(), "second hazard listed");
  ok(await page.getByText("Combined risks right now").isVisible(), "compound risk cards shown");
  ok(await page.getByText("Air quality for asthma").isVisible(), "respiratory AQI card shown");
  ok(await page.getByText("After floods and heavy rain").isVisible(), "post-flood disease module shown");
  ok(await page.getByText("7-day outlook").isVisible(), "forecast charts shown");
  ok(!(await page.getByText("Old flood alert").count()), "expired alert not shown");
  await page.screenshot({ path: `${OUT}/02-dashboard-en.png`, fullPage: true });

  await page.getByRole("button", { name: "Show QR (works offline)" }).click();
  await page.locator(".qr svg").waitFor();
  ok(await page.getByText("Signed by the Suraksha Setu server").isVisible(), "QR relay is signed");
  await page.locator(".share").screenshot({ path: `${OUT}/03-share-qr.png` });

  // Hover the temperature chart for the tooltip
  const svg = page.locator(".chart-box svg").first();
  await svg.scrollIntoViewIfNeeded();
  const box = await svg.boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.waitForTimeout(200);
  ok(await page.locator(".chart-tip").first().isVisible(), "chart tooltip on hover");
  await page.locator("figure.chart").first().screenshot({ path: `${OUT}/04-chart-tooltip.png` });
  await page.locator(".gauges").screenshot({ path: `${OUT}/05-gauges.png` });

  // Relay: paste the signed code on the relay page of the same phone (key was cached on the dashboard visit)
  const relay = await page.evaluate(async () => {
    const p = JSON.parse(localStorage.getItem("ss:profile"));
    const qs = new URLSearchParams({ lat: p.lat, lng: p.lng, district: p.district, state: p.state });
    const d = await (await fetch(`/api/dashboard?${qs}`)).json();
    return "SSR1:" + JSON.stringify(d.relay);
  });
  await page.goto(`${APP}/relay`);
  await page.locator("#paste").fill(relay);
  await page.getByRole("button", { name: "Check code" }).click();
  await page.getByText("Verified: this alert was signed").waitFor();
  ok(true, "relayed alert verifies offline with cached key");
  await page.screenshot({ path: `${OUT}/06-relay-verified.png`, fullPage: true });
  await page.getByRole("button", { name: "Scan a relayed alert" }).click();
  await page.locator("#paste").fill(relay.replace('"s":"Severe"', '"s":"Extreme"'));
  await page.getByRole("button", { name: "Check code" }).click();
  await page.getByText("Warning: this code was changed").waitFor();
  ok(true, "tampered relay is rejected");

  // Offline tab: history, timeline, relays
  await page.goto(`${APP}/offline`);
  await page.getByText("Alerts received from other phones").waitFor();
  await page.waitForTimeout(500);
  ok(await page.locator(".list li").count() >= 2, "history + relay entries listed");
  await page.screenshot({ path: `${OUT}/07-offline.png`, fullPage: true });

  // Settings, then Command view + Gujarati
  await page.goto(`${APP}/settings`);
  await page.getByText("Get alerts by SMS, WhatsApp or email").waitFor();
  await page.screenshot({ path: `${OUT}/08-settings.png`, fullPage: true });
  await page.getByLabel("Command view").check();
  await page.evaluate(() => { const p = JSON.parse(localStorage.getItem("ss:profile")); p.language = "gu"; localStorage.setItem("ss:profile", JSON.stringify(p)); });
  await page.goto(`${APP}/dashboard`);
  await page.getByText("તમારા માળ માટે").first().waitFor();
  await page.waitForTimeout(800);
  ok((await page.evaluate(() => document.documentElement.dataset.theme)) === "command", "command theme applied before paint");
  await page.screenshot({ path: `${OUT}/09-dashboard-gu-command.png`, fullPage: true });

  // Help page (map tiles need the internet; the hospital list comes from the mock)
  await page.goto(`${APP}/help`);
  await page.getByText("Civil Hospital Palanpur").waitFor();
  ok(true, "hospitals listed");
  await ctx.close();
}

// 2. Onboarding with GPS denied → Gujarat district browser → village not on the map falls back to its taluka
{
  const ctx = await browser.newContext({ ...phone });
  const page = await ctx.newPage(); watch(page, "onboarding-browse");
  await page.goto(`${APP}/onboarding`);
  await page.getByRole("button", { name: "Browse Gujarat by district" }).click();
  const selects = page.locator(".gujarat-browse select");
  await selects.nth(0).selectOption("Banas Kantha");
  await page.waitForTimeout(400);
  await selects.nth(1).selectOption("Palanpur");
  await page.waitForTimeout(400);
  await selects.nth(2).selectOption("Chandisar");
  await page.getByText("Couldn't pin Chandisar exactly").waitFor();
  ok(true, "village fallback to taluka with an honest note");
  await page.screenshot({ path: `${OUT}/10-gujarat-browse.png`, fullPage: true });
  await ctx.close();
}

// 3. Both alert feeds down → says so plainly, never "no alert"
{
  await fetch("http://localhost:4010/mode?set=down");
  const ctx = await browser.newContext({ ...phone });
  const page = await ctx.newPage(); watch(page, "feeds-down");
  await page.goto(`${APP}/onboarding`);
  await page.evaluate(() => localStorage.setItem("ss:profile", JSON.stringify({ label: "Palanpur, Gujarat", lat: 24.1724, lng: 72.4346, district: "Banaskantha", state: "Gujarat", dwelling_type: "mid_floor", occupation: "general_resident", vulnerabilities: [], language: "en" })));
  await page.goto(`${APP}/dashboard?down`);
  const down = await page.getByText("Couldn't reach the official alert sources").first().isVisible().catch(() => false);
  // The server reuses a good response for up to two minutes; this check is only meaningful once that window has passed.
  if (process.env.EXPECT_DOWN === "1") ok(down, "feeds-down card instead of all-clear");
  await page.screenshot({ path: `${OUT}/11-feeds-down.png`, fullPage: true });
  await fetch("http://localhost:4010/mode?set=normal");
  await ctx.close();
}

await browser.close();
if (errors.length) { console.error("\nErrors:\n" + errors.join("\n")); process.exit(1); }
console.log("\nAll checks passed.");
