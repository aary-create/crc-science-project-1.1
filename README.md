# Suraksha Setu — Gujarat

Personalised disaster alerts for India, built on free public data, with deep
Gujarat coverage: all 33 districts, 270 talukas and 18,651 inhabited villages
from India's Local Government Directory (Ministry of Panchayati Raj). Official
alerts come live from SACHET (NDMA) and IMD. Nothing in the alert pipeline is
sample or invented data.

Pages: `/onboarding`, `/dashboard`, `/help`, `/offline`, `/relay`, `/settings`
APIs: `/api/dashboard`, `/api/conditions`, `/api/users`, `/api/gujarat`,
`/api/geocode/search`, `/api/geocode/reverse`, `/api/hospitals`, `/api/explain`,
`/api/esp32-sync`, `/api/relay-key`, `/api/subscribe`, `/api/dispatch`

Firmware: `firmware/suraksha_setu_node/suraksha_setu_node.ino`

---

## What's built

### 1. Alert sources (no API key)

| Source | URL |
|---|---|
| SACHET (NDMA) | `https://sachet.ndma.gov.in/cap_public_website/FetchAllAlertDetails` (falls back to the `http://` address) |
| IMD CAP bulletins | `https://cap-sources.s3.amazonaws.com/in-imd-en/rss.xml` |

- If both are unreachable, the dashboard says so in a clear card ("This is NOT
  an all-clear") and shows no alert. It never shows "No active alert" for a
  check that couldn't happen, and never logs that to history.
- If only one is down, a note says alerts from it may be missing.
- Alerts past their own end time (`effective_end_time` / CAP `<expires>`) are
  dropped even if the feed still lists them.
- SACHET's full warning text (`warning_message`, often in Gujarati for Gujarat
  SDMA alerts) is shown as the "Official message". IMD's CAP `<instruction>` is
  shown when given.
- A successful feed response is reused for 1–2 minutes per server. A failed
  refresh is reported as a failure, never masked by a stale cached copy.

### 2. Location, search, hospitals, map (no API key)

| Need | Service | Notes |
|---|---|---|
| Search as you type | Nominatim (OpenStreetMap) | Proxied via `/api/geocode/search` (Nominatim wants a real User-Agent) |
| Use my location | `navigator.geolocation` | Asked on open, like SACHET's app; search if declined |
| Reverse geocoding | Nominatim | Proxied via `/api/geocode/reverse` |
| Nearby hospitals | Overpass API | `amenity` and `healthcare` = hospital/clinic, 15 km, one query. `/api/hospitals` |
| Map | Leaflet + OSM tiles | From a CDN, tinted for the dark theme |

### 3. Gujarat coverage

`data/gujarat-places.json` (33 / 270 / 18,651, from LGD) powers a district →
taluka → village browser in onboarding, served in slices by `/api/gujarat`.
A picked village is resolved to coordinates through Nominatim, searched only
inside Gujarat's bounding box so a same-named village in another state can't
be picked. If the village isn't on the map, it steps down to the taluka, then
the district, and tells the person which place it used.

District names are matched across spellings (LGD "Banas Kantha", OSM
"Banaskantha", "Kachchh"/"Kutch", "Dohad"/"Dahod" and so on), on whole words
("Dang" never matches "danger"), and a text-only alert that names other states
but not Gujarat doesn't match a Gujarat district of the same name.

### 4. Dashboard

- Current alert for the exact location. Matching uses CAP polygons when IMD
  gives them, SACHET's centre + warned area (+20 km buffer), or district/state
  names for text-only bulletins.
- Every agency reporting the hazard is listed; one agency's older and newer
  alerts are de-duplicated, so a real disagreement between agencies is flagged
  and an agency never "disagrees" with its own update. The most cautious
  severity is shown.
- Other hazards in effect at the same spot are listed under "Also in effect".
- Personalised action text by home type (6), occupation (6) and care needs
  (6: elderly, infant/pregnant, disability, ongoing condition, livestock, and
  asthma/lung condition).
- Full before/after precautions per hazard, plain-language glossary (offline,
  rule-based), optional AI rewrite of the official wording (Groq free tier by
  default, Anthropic if only that key is set), cached on the phone for 5 days
  per alert and language.
- Read aloud on demand, automatic read-aloud for new Extreme/Severe alerts
  (mute in Settings), notifications.
- Skeleton loading, severity pulse, staggered animations, all off under
  `prefers-reduced-motion`. Offline vs server-error distinction via
  `navigator.onLine`.

### 5. Offline / History tab

- 5-day on-device history of alert *changes*, auto-pruned.
- 5-day severity timeline (inline SVG, proportional by time) and personal
  stats by hazard.
- Last dashboard snapshot when offline.
- Alerts received from other phones by QR relay.
- Stored in IndexedDB, with localStorage as the fallback; anything an older
  version stored in localStorage is migrated on first read. Nothing leaves the
  phone.
- The service worker pre-caches every page *and the scripts they need*, so the
  Offline tab and the QR scanner work even if they were never opened online.

### 6. ESP32 firmware

`firmware/suraksha_setu_node/suraksha_setu_node.ino`. Compiled (not just
reviewed) with arduino-cli against Arduino-ESP32 core 3.3.12 for ESP32,
ESP32-S3 and ESP32-C3, and against core 2.0.17 for ESP32, with `-Wall -Wextra`
and no warnings from the sketch. It has not been run on a physical board in
this build; flash one node and watch Serial Monitor before deploying several.

- WiFi hotspot + home WiFi. Captive portal: a phone that joins the hotspot
  gets the alert page automatically (or opens `192.168.4.1`).
- ESP-NOW mesh relay: hop-capped (5), de-duplicated by packet id, and every
  packet is signed with HMAC-SHA256 using a shared `MESH_SECRET`, so a stranger
  can't inject a fake alert. Nodes adopt whichever copy the cloud produced most
  recently, so an all-clear spreads as well as an alert. Nodes repeat the
  current alert every ~90 s so a node that just powered on catches up.
- Channel handling: ESP-NOW only works between radios on the same channel.
  Nodes sit on `MESH_CHANNEL`; a node with internet hops to the router's
  channel only for the seconds of each sync, then returns.
- LittleFS alert cache (survives reboot), its own 5-day `/history.json`.
- Local web server: `/`, `/api/alert`, `/api/history`, `/api/status`.
- Clock: NTP when online, otherwise the server's time from the last sync, or a
  neighbour's clock from the mesh; expired alerts are shown as expired.
- If the app reports both alert feeds unreachable, the node keeps its last
  alert instead of replacing it with "no alert".
- Optional water-level sensor (JSN-SR04T/HC-SR04): warning/danger depths,
  buzzer, logged, broadcast over the mesh, and reported to the app.

What changed from the first version, and why: the original sketch didn't
compile on the current ESP32 core (the ESP-NOW receive callback signature
changed in core 3.x); it did flash writes and radio sends inside the radio
callback; it compared alerts by issue time, so a late-published alert could
be rejected as "older" than a later "no alert"; nodes on different channels
couldn't hear each other; and alert text was put into the web page unescaped.

### 7. Database (optional)

`DATABASE_URL` (Neon Postgres via Vercel Storage) keeps profiles (one row per
device, updated on edit), ESP32 node pings (including water level) and alert
subscriptions. Tables are created and upgraded automatically. Without it,
everything except subscriptions works; profiles and node pings just don't
survive a redeploy.

---

## Roadmap items, now built

| Roadmap item | What's built | Data |
|---|---|---|
| Command-style look, live telemetry gauges | Settings → Look → Command view. Gauges for temperature, humidity, air quality, wind (with gusts) and pressure | Open-Meteo (keyless) |
| 7-day forecast graphs | Temperature (min, max, feels-like max), rain per day with chance of rain, strongest gusts; hover/keyboard tooltips; table view | Open-Meteo |
| Time-of-day-aware prioritisation | A non-extreme heat advisory ranks below other hazards 8pm–7am IST, notifies silently and isn't read aloud at night. It is never hidden. Alerts not yet in effect rank below ones in effect | Alert feeds + IST clock |
| Configurable auto-refresh | Settings: every 2, 5, 10, 15 or 30 min; also refreshes on reconnect and when the tab is reopened | — |
| Compound risk | Heat index (NWS formula) from temperature + humidity with peak time; heat + poor air; wind + rain; lightning (stronger wording for outdoor work); unsafe sea for fishers; strong UV for outdoor work. Each card lists the numbers behind it | Open-Meteo + alerts |
| Phone-to-phone relay | QR code relay that works with no network: one phone shows it, another scans it (Offline tab → Scan). Signed with ECDSA P-256 when `RELAY_SIGNING_KEY` is set; the receiving phone verifies offline using a key it saved on its last online visit, and rejects edited codes. Also WhatsApp/SMS/email/system-share buttons | Server signature |
| Floor-level flood triggers | "For your floor" card by home type, from flood/heavy-rain/cyclone alerts, forecast rain against IMD's 24-hour categories (64.5 / 115.6 / 204.5 mm), and measured water depth from an ESP32 node within 5 km | Alerts, Open-Meteo, ESP32 sensor |
| Asthma/respiratory AQI | New care need. Air quality on India's NAQI scale (CPCB breakpoints, estimated from modelled PM2.5/PM10), advice per band, thunderstorm-asthma and dust warnings; a sensitive-group card for elderly/infant/ongoing-condition households | Open-Meteo / CAMS |
| Post-flood disease advisory | Water-borne, dengue/malaria, leptospirosis guidance and when to see a doctor, shown when a flood/heavy-rain alert is in effect, one was logged on the phone in the last 5 days, or a day in the last 14 had 64.5 mm+ of rain | Alerts, history, Open-Meteo |
| SMS, WhatsApp, email alerts | Opt-in in Settings with a 6-digit confirmation code and one-click unsubscribe. Sent by `/api/dispatch` when the alert at the subscriber's spot changes and meets their minimum severity | Resend (email), Twilio (SMS, WhatsApp) |
| IndexedDB storage | History, snapshots, AI cache and relays in IndexedDB, localStorage fallback and migration | — |

### Honest limits of the roadmap features

- **Phone-to-phone relay is QR, not Bluetooth.** A web page can't advertise as
  a Bluetooth device and WebRTC needs an internet signalling server, so a true
  Bluetooth/WebRTC mesh isn't possible from a browser app. QR works offline on
  any phone with a camera. The ESP32 mesh is still the radio relay.
- **Air quality is an estimate.** NAQI officially needs station readings of at
  least three pollutants; this uses modelled PM2.5 and PM10 and says so.
- **Floor triggers are not a measured depth at your home** unless a sensor
  node within 5 km reports one. The card says what it's based on.
- **Weather is model data**, labelled as such, and never replaces an official
  warning.
- **Outbound messages cost money and need accounts.** There is no free,
  keyless SMS/WhatsApp. Twilio SMS to Indian numbers needs TRAI DLT
  registration of the sender and message template; WhatsApp business-initiated
  messages need an approved template (the Twilio sandbox works for testing).
  Resend's free tier sends from a domain you verify.
- **Scheduling.** Vercel's free cron runs once a day, which is too slow for
  alerts, so `.github/workflows/dispatch-alerts.yml` calls `/api/dispatch`
  every 10 minutes (free on public repos; GitHub may start runs a few minutes
  late and pauses schedules in repos with no activity for 60 days). Any
  external cron that can send a header works too.

---

## Run on your laptop

Needs Node 20 or newer.

```bash
npm install
cp .env.example .env.local     # optional
npm run dev                    # http://localhost:3000
```

## Deploy to Vercel

1. Push to GitHub, then vercel.com → Add New → Project → import → Deploy.
   Alerts, location, hospitals, weather, air quality and the Gujarat browser
   work immediately with no keys.
2. Optional: Storage → Create Database → Neon → Connect to project.
3. Optional: add any of the variables below under Settings → Environment
   Variables, then redeploy.
4. Check the live feeds:
   `https://YOUR-APP.vercel.app/api/dashboard?lat=24.17&lng=72.43&district=Banaskantha&state=Gujarat`
   → `sachetOk` and `imdOk` should be `true`.
   `https://YOUR-APP.vercel.app/api/conditions?lat=24.17&lng=72.43` → `ok: true`.

## Environment variables

Names and where to get them; values go only in Vercel.

| Variable | Needed for | Where | Cost |
|---|---|---|---|
| `DATABASE_URL` | Persistence, subscriptions | Vercel → Storage → Neon (auto-fills) | Free tier |
| `GROQ_API_KEY` | AI explanation | console.groq.com → API Keys | Free |
| `ANTHROPIC_API_KEY` | AI explanation (if no Groq key) | console.anthropic.com → API Keys | Paid |
| `RELAY_SIGNING_KEY` | Verified QR relays | `npm run relay-key` | Free |
| `ESP32_NODE_TOKEN` | Only accept your own nodes | Any random string, same as `NODE_TOKEN` in firmware | Free |
| `CRON_SECRET` | Protects `/api/dispatch` | Any long random string; same value as the GitHub secret | Free |
| `APP_URL` | Links in messages | Your public URL | Free |
| `RESEND_API_KEY`, `ALERT_FROM_EMAIL` | Email alerts | resend.com | Free tier |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_FROM`, `TWILIO_WHATSAPP_FROM` | SMS / WhatsApp alerts | twilio.com | Paid |

To turn on outbound alerts: set `DATABASE_URL`, `CRON_SECRET` and at least one
provider in Vercel; then in GitHub → Settings → Secrets and variables →
Actions add the variable `APP_URL` and the secret `CRON_SECRET`. The Settings
page shows only the channels that are configured.

## ESP32

Open `firmware/suraksha_setu_node/suraksha_setu_node.ino` in Arduino IDE,
install **ArduinoJson 7.x** from Library Manager, fill in the CONFIG block
(node id, coordinates, language, WiFi, `SYNC_URL` = your Vercel URL +
`/api/esp32-sync`, the same `MESH_SECRET` and `MESH_CHANNEL` on every node),
pick a partition scheme with SPIFFS/LittleFS and upload. The header of the
sketch has wiring for the optional water sensor.

Test the endpoint in a browser: `/api/esp32-sync?lat=24.17&lng=72.43`.

## Tests

```bash
npm test              # unit tests: matching, ranking, parsing, NAQI, heat index, risk rules, relay signing
npm run typecheck
```

End to end, with every upstream mocked (`tests/mock-upstream.mjs` serves
SACHET, IMD CAP, Open-Meteo, Nominatim and Overpass in their real formats):

```bash
node tests/mock-upstream.mjs &
SACHET_URL=http://localhost:4010/sachet IMD_RSS_URL=http://localhost:4010/imd/rss.xml \
OPEN_METEO_URL=http://localhost:4010/om/forecast OPEN_METEO_AIR_URL=http://localhost:4010/om/air \
NOMINATIM_URL=http://localhost:4010/nominatim OVERPASS_URL=http://localhost:4010/overpass \
npm run build && npm start -- -p 3100 &
APP=http://localhost:3100 node tests/e2e.mjs      # needs Playwright; writes ./screenshots
```

## Editing content

- Safety steps, before/after precautions, care-need tips, helplines: `data/seed.json`
- Translations of those: `data/translations.json`
- Interface text: `lib/i18n.ts` (original) and `lib/i18n-extra.ts` (v2 additions)
- Risk rules: `lib/risk.ts`; air/heat maths: `lib/conditions.ts`
- Gujarat places: `data/gujarat-places.json`; spelling aliases: `lib/places.ts`

## Known limits

- **Translations.** Onboarding, the alert screen and core steps are in Hindi,
  Gujarati, Tamil and Assamese. The v2 interface is fully in Hindi and
  Gujarati; Tamil and Assamese have the safety-critical lines and fall back to
  English for the rest. Occupation tips and before/after precautions are
  English. None of it has had native-speaker review yet; get it checked before
  real use.
- **Villages have no coordinates in LGD**, so they're geocoded through
  Nominatim, which rate-limits to 1 request a second and doesn't know every
  village (the app falls back to the taluka and says so).
- **OpenStreetMap tiles** shouldn't be hotlinked at large scale; a bigger
  deployment should use a tile provider. Open-Meteo's free API is for
  non-commercial use.
- **Notifications** fire only while the app is open or in a background tab;
  alerts to a fully closed app need Web Push, which isn't built. The SMS /
  WhatsApp / email channel covers that case when configured.
- **ESP32 node status** lives in server memory without a database.
