/*
  Suraksha Setu — ESP32 Local Node  (firmware v2)
  ================================================
  A small board that keeps the latest official disaster alert available on
  a local WiFi network and passes it to other nodes by radio, even when the
  internet is down.

  What it does
   - Every SYNC_INTERVAL_MS, if home WiFi is configured and reachable, it
     calls the app's /api/esp32-sync with this node's fixed lat/lng and gets
     the current official alert for this exact spot (live SACHET/IMD data),
     plus the plain-language action text, in the language set below.
   - Saves that alert to flash (LittleFS) so a reboot or power cut keeps it.
   - Keeps its own 5-day log of alert *changes* in /history.json (the same
     retention policy as the phone app).
   - ESP-NOW mesh: broadcasts the alert to other Suraksha Setu nodes in radio
     range and relays what it hears (hop-capped, de-duplicated by packet id,
     signed with a shared HMAC key so a stranger's board can't inject fake
     alerts). A chain of nodes with no internet still gets the warning as
     long as ONE node in the chain synced recently. Nodes adopt the copy the
     cloud produced most recently, so an all-clear also propagates.
   - Runs its own WiFi hotspot + web server with a captive portal: a phone
     with no internet joins LOCAL_AP_SSID and the alert page opens by itself
     (or browse to http://192.168.4.1). JSON at /api/alert, /api/history,
     /api/status.
   - Optional: an ultrasonic water-level sensor turns the node into a flood
     gauge. Crossing the warning/danger depth sounds a buzzer, is logged,
     is broadcast over the mesh, and is reported to the app, where it drives
     the floor-level flood triggers for people within 5 km.

  Hardware
   - Any ESP32 board (tested by compiling for ESP32 DevKit, ESP32-S3 and
     ESP32-C3 on Arduino-ESP32 core 3.3; also written to build on core 2.0.x).
   - Optional water sensor: JSN-SR04T (waterproof) or HC-SR04, mounted
     pointing straight down. Its ECHO pin outputs 5 V: put a voltage divider
     (e.g. 1 kΩ + 2 kΩ) between ECHO and the ESP32 pin.
   - Optional buzzer (active, 3.3 V) on BUZZER_PIN.

  Libraries (Arduino IDE → Library Manager)
   - ArduinoJson by Benoit Blanchon, version 7.x
   Everything else ships with the ESP32 Arduino core.

  Flashing
   1. Boards Manager: install "esp32 by Espressif Systems".
   2. Tools → Board → your ESP32 board.
   3. Tools → Partition Scheme → one with a SPIFFS/LittleFS partition
      (e.g. "Default 4MB with spiffs" — LittleFS uses that partition).
   4. Fill in the CONFIG block below for this node, then Upload.
   5. Serial Monitor at 115200 baud shows WiFi, sync and mesh activity.

  Every node in one mesh needs the same MESH_SECRET and MESH_CHANNEL.
  Best: set MESH_CHANNEL to your home router's WiFi channel. If they differ,
  a node that has internet hops to the router's channel only for the few
  seconds of each sync, then returns to the mesh channel.
*/

#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <LittleFS.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <esp_random.h>
#include <mbedtls/md.h>
#include <time.h>
#include <ArduinoJson.h>

#if !defined(ARDUINOJSON_VERSION_MAJOR) || ARDUINOJSON_VERSION_MAJOR < 7
#error "This sketch needs ArduinoJson 7.x (Library Manager: ArduinoJson by Benoit Blanchon)."
#endif

#ifndef ESP_ARDUINO_VERSION_MAJOR
#define ESP_ARDUINO_VERSION_MAJOR 2
#endif

// ================================ CONFIG ================================
// Edit these for each physical node before flashing.
const char* NODE_ID         = "node-01";        // unique per board, max 11 characters
const double NODE_LAT       = 24.1724;          // this board's fixed install location
const double NODE_LNG       = 72.4346;          // (Google Maps: long-press the spot, copy coordinates)
const char* NODE_LANG       = "gu";             // action text language: en, hi, gu, ta, as

const char* HOME_WIFI_SSID  = "YOUR_WIFI_SSID"; // "" for a relay-only node with no internet
const char* HOME_WIFI_PASS  = "YOUR_WIFI_PASSWORD";

const char* LOCAL_AP_SSID   = "SurakshaSetu-Node01"; // phones join this to read the alert offline
const char* LOCAL_AP_PASS   = "";               // "" = open hotspot (easiest in an emergency), or 8+ characters

const char* SYNC_URL        = "https://YOUR-APP.vercel.app/api/esp32-sync"; // your deployed app
const char* NODE_TOKEN      = "";               // same as ESP32_NODE_TOKEN in Vercel, if you set one

const char* MESH_SECRET     = "change-this-mesh-secret"; // identical on every node in your mesh
const uint8_t MESH_CHANNEL  = 1;                // identical on every node; ideally your router's channel

const unsigned long SYNC_INTERVAL_MS   = 10UL * 60UL * 1000UL; // internet check
const unsigned long REBROADCAST_MS     = 90UL * 1000UL;        // repeat current alert to the mesh
const unsigned long WIFI_CONNECT_MS    = 15000UL;              // give up joining home WiFi after this
const uint8_t       MAX_HOPS           = 5;
const uint32_t      RETAIN_SECONDS     = 5UL * 24UL * 3600UL;  // 5-day on-device history

// Optional water-level sensor. Set ENABLE_WATER_SENSOR to 1 to use it.
#define ENABLE_WATER_SENSOR 0
const int   TRIG_PIN         = 5;
const int   ECHO_PIN         = 18;     // through a voltage divider, see header
const float SENSOR_HEIGHT_CM = 150.0;  // sensor face to dry ground, measured at install
const float WATER_WARN_CM    = 15.0;   // water on the street
const float WATER_DANGER_CM  = 45.0;   // about plinth height: water entering ground floors
const int   BUZZER_PIN       = -1;     // pin for an active buzzer, -1 = none
const int   LED_PIN          = 2;      // status LED (onboard on most DevKits), -1 = none
// =========================================================================

#define FW_VERSION "2.0.0"

enum : uint8_t { SEV_NONE = 0, SEV_MINOR = 1, SEV_MODERATE = 2, SEV_SEVERE = 3, SEV_EXTREME = 4 };
enum : uint8_t { KIND_OFFICIAL = 0, KIND_WATER = 1 };
enum : uint8_t { WATER_DRY = 0, WATER_WARN = 1, WATER_DANGER = 2 };

static const char* SEV_NAME[]    = { "No alert", "Minor", "Moderate", "Severe", "Extreme" };
static const char* SEV_COLOR[]   = { "#35d48c", "#35d48c", "#e3b23c", "#ff9142", "#ff5a52" };
static const char* HAZARD_NAME[] = { "Weather alert", "Flood", "Cyclone", "Heavy rain", "Heatwave", "Thunderstorm", "Earthquake" };
static const char* WATER_NAME[]  = { "dry", "warn", "danger" };

// ---------------------------------------------------------------------------
// Radio packet. Fixed layout, 250 bytes = the ESP-NOW v1 payload limit.
// ---------------------------------------------------------------------------
struct __attribute__((packed)) MeshPacket {
  uint16_t magic;        // 'SS'
  uint8_t  version;      // 2
  uint8_t  hop;          // not covered by the HMAC (it changes at every relay)
  uint8_t  kind;         // KIND_OFFICIAL or KIND_WATER
  uint8_t  severity;     // SEV_*
  uint8_t  hazard;       // 0..6, see HAZARD_NAME
  uint8_t  flags;        // bit0 = an alert is active
  uint32_t packet_id;
  uint32_t synced_at;    // server time when the cloud produced this (newer wins)
  uint32_t issued_at;
  uint32_t expires_at;   // 0 = not given
  uint32_t sent_at;      // sender's clock, lets a node with no internet set its own
  int16_t  water_cm;     // -1 = n/a
  char     origin[12];
  char     agency[24];
  char     headline[64];
  char     action[112];
  uint8_t  mac[8];       // first 8 bytes of HMAC-SHA256(MESH_SECRET, packet with hop=0, mac=0)
};
static_assert(sizeof(MeshPacket) <= 250, "ESP-NOW payload limit is 250 bytes");
static const uint16_t MESH_MAGIC = 0x5353;
static const uint8_t  MESH_VERSION = 2;

// The node's current official alert (also what the local web page shows).
struct AlertRecord {
  bool     valid;        // have we ever had a real answer (cloud or mesh)?
  bool     active;
  uint8_t  severity;
  uint8_t  hazard;
  uint32_t synced_at;
  uint32_t issued_at;
  uint32_t expires_at;
  uint32_t packet_id;
  uint8_t  hops;         // 0 = this node synced it itself
  char     origin[12];
  char     agency[24];
  char     headline[64];
  char     action[112];
  char     message[304]; // agency's full text — only on the node that synced it
};

struct WaterReport { bool used; char origin[12]; int16_t cm; uint8_t state; uint32_t at; };

AlertRecord current = {};
WaterReport neighbourWater[4] = {};

WebServer server(80);
DNSServer dns;
QueueHandle_t rxQueue;

uint32_t seenIds[32] = {0};
uint8_t  seenHead = 0;

unsigned long lastSync = 0, lastRebroadcast = 0, lastWaterRead = 0, lastLedToggle = 0;
bool     firstSyncDone = false;
bool     staConnected = false;
uint8_t  routerChannel = 0;
String   lastSyncResult = "not yet";
uint32_t clockBase = 0;          // unix seconds at clockBaseMs (from server/NTP/mesh)
unsigned long clockBaseMs = 0;
uint32_t statRx = 0, statRelayed = 0, statRejected = 0, statAdopted = 0;

int16_t  waterCm = -1;
uint8_t  waterState = WATER_DRY;

// ---------------------------------------------------------------------------
// Time: NTP when online, otherwise the server's clock from the last sync, or
// a neighbour's clock from the mesh. 0 means "don't know yet".
// ---------------------------------------------------------------------------
uint32_t nowUnix() {
  time_t t = time(nullptr);
  if (t > 1700000000) return (uint32_t)t;
  if (clockBase) return clockBase + (millis() - clockBaseMs) / 1000UL;
  return 0;
}
void setClock(uint32_t unixNow) {
  if (unixNow < 1700000000UL) return;
  clockBase = unixNow;
  clockBaseMs = millis();
}

void copyStr(char* dst, size_t n, const char* src) { strlcpy(dst, src ? src : "", n); }

// ---------------------------------------------------------------------------
// HMAC over the packet (hop and mac zeroed) with the shared mesh secret.
// ---------------------------------------------------------------------------
void computeMac(const MeshPacket& p, uint8_t out[8]) {
  MeshPacket tmp = p;
  tmp.hop = 0;
  memset(tmp.mac, 0, sizeof(tmp.mac));
  uint8_t full[32];
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 1);
  mbedtls_md_hmac_starts(&ctx, (const unsigned char*)MESH_SECRET, strlen(MESH_SECRET));
  mbedtls_md_hmac_update(&ctx, (const unsigned char*)&tmp, sizeof(tmp));
  mbedtls_md_hmac_finish(&ctx, full);
  mbedtls_md_free(&ctx);
  memcpy(out, full, 8);
}

bool macOk(const MeshPacket& p) {
  uint8_t m[8];
  computeMac(p, m);
  uint8_t diff = 0;
  for (int i = 0; i < 8; i++) diff |= m[i] ^ p.mac[i];
  return diff == 0;
}

// ---------------------------------------------------------------------------
// FLASH PERSISTENCE (LittleFS)
// ---------------------------------------------------------------------------
const char* ALERT_FILE   = "/alert.json";
const char* HISTORY_FILE = "/history.json";

void saveAlert() {
  JsonDocument doc;
  doc["valid"] = current.valid;
  doc["active"] = current.active;
  doc["severity"] = current.severity;
  doc["hazard"] = current.hazard;
  doc["synced_at"] = current.synced_at;
  doc["issued_at"] = current.issued_at;
  doc["expires_at"] = current.expires_at;
  doc["packet_id"] = current.packet_id;
  doc["hops"] = current.hops;
  doc["origin"] = current.origin;
  doc["agency"] = current.agency;
  doc["headline"] = current.headline;
  doc["action"] = current.action;
  doc["message"] = current.message;
  File f = LittleFS.open(ALERT_FILE, "w");
  if (!f) { Serial.println("[FLASH] can't write alert.json"); return; }
  serializeJson(doc, f);
  f.close();
}

void loadAlert() {
  File f = LittleFS.open(ALERT_FILE, "r");
  if (!f) { Serial.println("[FLASH] no saved alert yet"); return; }
  JsonDocument doc;
  if (deserializeJson(doc, f) == DeserializationError::Ok) {
    current.valid = doc["valid"] | false;
    current.active = doc["active"] | false;
    current.severity = doc["severity"] | 0;
    current.hazard = doc["hazard"] | 0;
    current.synced_at = doc["synced_at"] | 0UL;
    current.issued_at = doc["issued_at"] | 0UL;
    current.expires_at = doc["expires_at"] | 0UL;
    current.packet_id = doc["packet_id"] | 0UL;
    current.hops = doc["hops"] | 0;
    copyStr(current.origin, sizeof(current.origin), doc["origin"] | "");
    copyStr(current.agency, sizeof(current.agency), doc["agency"] | "");
    copyStr(current.headline, sizeof(current.headline), doc["headline"] | "");
    copyStr(current.action, sizeof(current.action), doc["action"] | "");
    copyStr(current.message, sizeof(current.message), doc["message"] | "");
    Serial.println("[FLASH] restored the alert saved before reboot");
  }
  f.close();
}

// 5-day log of *changes*, newest last. Pruned by age once the clock is
// known, and hard-capped so flash use stays small.
void appendHistory(uint8_t kind, uint8_t severity, uint8_t hazard, const char* text, int16_t cm) {
  JsonDocument doc;
  File rf = LittleFS.open(HISTORY_FILE, "r");
  if (rf) { deserializeJson(doc, rf); rf.close(); }
  JsonArray old = doc.is<JsonArray>() ? doc.as<JsonArray>() : JsonArray();

  uint32_t now = nowUnix();
  uint32_t cutoff = (now > RETAIN_SECONDS) ? now - RETAIN_SECONDS : 0;

  JsonDocument out;
  JsonArray arr = out.to<JsonArray>();
  if (!old.isNull()) {
    for (JsonObject e : old) {
      uint32_t ts = e["ts"] | 0UL;
      if (ts == 0 || ts >= cutoff) arr.add(e);
    }
  }
  JsonObject e = arr.add<JsonObject>();
  e["ts"] = now;
  e["kind"] = kind == KIND_WATER ? "water" : "official";
  e["severity"] = SEV_NAME[severity > 4 ? 0 : severity];
  e["hazard"] = HAZARD_NAME[hazard > 6 ? 0 : hazard];
  e["text"] = text;
  if (cm >= 0) e["water_cm"] = cm;
  while (arr.size() > 40) arr.remove(0);

  File wf = LittleFS.open(HISTORY_FILE, "w");
  if (wf) { serializeJson(arr, wf); wf.close(); }
}

// ---------------------------------------------------------------------------
// ESP-NOW MESH
// The receive callback runs inside the WiFi driver's task: it only copies
// the packet into a queue. Checking, saving and relaying happen in loop().
// ---------------------------------------------------------------------------
#if ESP_ARDUINO_VERSION_MAJOR >= 3
void onMeshRecv(const esp_now_recv_info_t* info, const uint8_t* data, int len) {
#else
void onMeshRecv(const uint8_t* mac, const uint8_t* data, int len) {
#endif
  if (len != (int)sizeof(MeshPacket)) return;
  MeshPacket p;
  memcpy(&p, data, sizeof(p));
  xQueueSend(rxQueue, &p, 0); // drop if full rather than block the radio
}

bool seen(uint32_t id) {
  for (uint32_t s : seenIds) if (s == id) return true;
  return false;
}
void remember(uint32_t id) {
  seenIds[seenHead] = id;
  seenHead = (seenHead + 1) % 32;
}

void sendPacket(MeshPacket& p) {
  p.sent_at = nowUnix();
  computeMac(p, p.mac);
  static const uint8_t BROADCAST[6] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };
  esp_now_send(BROADCAST, (const uint8_t*)&p, sizeof(p));
}

MeshPacket packetFromCurrent() {
  MeshPacket p = {};
  p.magic = MESH_MAGIC;
  p.version = MESH_VERSION;
  p.hop = current.hops;
  p.kind = KIND_OFFICIAL;
  p.severity = current.severity;
  p.hazard = current.hazard;
  p.flags = current.active ? 1 : 0;
  p.packet_id = current.packet_id;
  p.synced_at = current.synced_at;
  p.issued_at = current.issued_at;
  p.expires_at = current.expires_at;
  p.water_cm = -1;
  copyStr(p.origin, sizeof(p.origin), current.origin);
  copyStr(p.agency, sizeof(p.agency), current.agency);
  copyStr(p.headline, sizeof(p.headline), current.headline);
  copyStr(p.action, sizeof(p.action), current.action);
  return p;
}

void broadcastCurrent() {
  if (!current.valid || current.synced_at == 0) return; // nothing real to share yet
  MeshPacket p = packetFromCurrent();
  sendPacket(p);
}

void broadcastWater() {
  MeshPacket p = {};
  p.magic = MESH_MAGIC;
  p.version = MESH_VERSION;
  p.kind = KIND_WATER;
  p.severity = waterState == WATER_DANGER ? SEV_SEVERE : waterState == WATER_WARN ? SEV_MODERATE : SEV_NONE;
  p.hazard = 1; // flood
  p.flags = waterState != WATER_DRY ? 1 : 0;
  p.packet_id = esp_random();
  p.synced_at = nowUnix();
  p.water_cm = waterCm;
  copyStr(p.origin, sizeof(p.origin), NODE_ID);
  snprintf(p.headline, sizeof(p.headline), "Water %d cm at %s", (int)waterCm, NODE_ID);
  copyStr(p.action, sizeof(p.action), waterState == WATER_DANGER
      ? "Water is at ground-floor level here. Move people and valuables up now."
      : "Water is collecting in the street here. Get ready to move valuables up.");
  remember(p.packet_id);
  sendPacket(p);
}

void storeNeighbourWater(const MeshPacket& p) {
  int slot = -1;
  for (int i = 0; i < 4; i++) if (neighbourWater[i].used && strncmp(neighbourWater[i].origin, p.origin, sizeof(p.origin)) == 0) slot = i;
  if (slot < 0) for (int i = 0; i < 4; i++) if (!neighbourWater[i].used) { slot = i; break; }
  if (slot < 0) slot = 0;
  WaterReport& w = neighbourWater[slot];
  w.used = true;
  copyStr(w.origin, sizeof(w.origin), p.origin);
  w.cm = p.water_cm;
  w.state = p.severity >= SEV_SEVERE ? WATER_DANGER : p.severity >= SEV_MODERATE ? WATER_WARN : WATER_DRY;
  w.at = nowUnix();
}

void processMesh() {
  MeshPacket p;
  while (xQueueReceive(rxQueue, &p, 0) == pdTRUE) {
    statRx++;
    if (p.magic != MESH_MAGIC || p.version != MESH_VERSION || !macOk(p)) { statRejected++; continue; }
    if (seen(p.packet_id)) continue; // already handled — this is what stops relay loops
    remember(p.packet_id);
    p.origin[sizeof(p.origin) - 1] = 0; p.agency[sizeof(p.agency) - 1] = 0;
    p.headline[sizeof(p.headline) - 1] = 0; p.action[sizeof(p.action) - 1] = 0;

    if (nowUnix() == 0 && p.sent_at) setClock(p.sent_at); // borrow a neighbour's clock

    if (p.kind == KIND_WATER) {
      storeNeighbourWater(p);
      Serial.printf("[MESH] water report from %s: %d cm\n", p.origin, p.water_cm);
    } else if (p.synced_at > current.synced_at) {
      // A far-future timestamp would lock every node onto one copy; ignore it.
      uint32_t now = nowUnix();
      if (now && p.synced_at > now + 3600) { statRejected++; continue; }
      bool changed = !current.valid || current.active != (p.flags & 1) || current.severity != p.severity ||
                     current.issued_at != p.issued_at || strcmp(current.headline, p.headline) != 0;
      current.valid = true;
      current.active = p.flags & 1;
      current.severity = p.severity;
      current.hazard = p.hazard;
      current.synced_at = p.synced_at;
      current.issued_at = p.issued_at;
      current.expires_at = p.expires_at;
      current.packet_id = p.packet_id;
      current.hops = p.hop + 1;
      copyStr(current.origin, sizeof(current.origin), p.origin);
      copyStr(current.agency, sizeof(current.agency), p.agency);
      copyStr(current.headline, sizeof(current.headline), p.headline);
      copyStr(current.action, sizeof(current.action), p.action);
      current.message[0] = 0; // full text only lives on the node that synced it
      saveAlert();
      if (changed) appendHistory(KIND_OFFICIAL, current.active ? current.severity : (uint8_t)SEV_NONE, current.hazard, current.headline, -1);
      statAdopted++;
      Serial.printf("[MESH] adopted newer alert from %s (%u hops): %s\n", p.origin, current.hops, current.headline);
    }

    if (p.hop + 1 < MAX_HOPS) {
      delay(random(5, 60)); // jitter so neighbours don't all transmit at once
      p.hop++;
      sendPacket(p);
      statRelayed++;
    }
  }
}

// ---------------------------------------------------------------------------
// WIFI + CLOUD SYNC
// ---------------------------------------------------------------------------
const char* apPass() { return strlen(LOCAL_AP_PASS) >= 8 ? LOCAL_AP_PASS : nullptr; }

void restoreMeshChannel() {
  esp_wifi_set_channel(MESH_CHANNEL, WIFI_SECOND_CHAN_NONE);
  WiFi.softAP(LOCAL_AP_SSID, apPass(), MESH_CHANNEL, 0, 4);
}

void serviceWhileWaiting(unsigned long ms) {
  unsigned long start = millis();
  while (millis() - start < ms) {
    dns.processNextRequest();
    server.handleClient();
    processMesh();
    delay(10);
  }
}

void httpSync() {
  WiFiClientSecure client;
  // Skips certificate checking to stay compatible when the host's
  // certificate authority changes. The alert itself can't be forged into
  // the mesh without MESH_SECRET; for full transport security, load your
  // host's root CA with client.setCACert(...) instead.
  client.setInsecure();

  HTTPClient http;
  http.setTimeout(12000);
  if (!http.begin(client, SYNC_URL)) { lastSyncResult = "bad SYNC_URL"; return; }
  http.addHeader("Content-Type", "application/json");
  if (strlen(NODE_TOKEN)) http.addHeader("X-Node-Token", NODE_TOKEN);

  JsonDocument req;
  req["node_id"] = NODE_ID;
  req["lat"] = NODE_LAT;
  req["lng"] = NODE_LNG;
  req["lang"] = NODE_LANG;
  req["fw"] = FW_VERSION;
  req["last_cached_timestamp"] = current.synced_at;
  if (ENABLE_WATER_SENSOR && waterCm >= 0) {
    req["water_cm"] = waterCm;
    req["water_state"] = WATER_NAME[waterState];
  }
  String body;
  serializeJson(req, body);

  int code = http.POST(body);
  if (code != 200) {
    lastSyncResult = "HTTP " + String(code);
    Serial.printf("[CLOUD] sync failed, HTTP %d\n", code);
    http.end();
    return;
  }
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, http.getString());
  http.end();
  if (err) { lastSyncResult = "bad JSON"; return; }

  uint32_t serverTime = doc["server_time"] | 0UL;
  setClock(serverTime);
  if (!(doc["feeds_ok"] | true)) {
    // The app couldn't reach SACHET or IMD. Keep the last known alert
    // rather than replacing it with a false "no alert".
    lastSyncResult = "alert feeds unreachable, kept last alert";
    Serial.println("[CLOUD] app says both alert feeds are unreachable — keeping last alert");
    return;
  }

  JsonObject a = doc["alert"];
  bool active = a["active"] | false;
  uint8_t sev = a["sev"] | 0;
  uint8_t hz = a["hazard_code"] | 0;
  uint32_t issued = a["issued"] | 0UL;
  const char* headline = a["headline"] | "No active alert";

  bool changed = !current.valid || current.active != active || current.severity != sev ||
                 current.issued_at != issued || strcmp(current.headline, headline) != 0;

  current.valid = true;
  current.active = active;
  current.severity = active ? sev : (uint8_t)SEV_NONE;
  current.hazard = hz;
  current.synced_at = serverTime ? serverTime : nowUnix();
  current.issued_at = issued;
  current.expires_at = a["expires"] | 0UL;
  current.packet_id = esp_random();
  current.hops = 0;
  copyStr(current.origin, sizeof(current.origin), NODE_ID);
  copyStr(current.agency, sizeof(current.agency), a["agency"] | "");
  copyStr(current.headline, sizeof(current.headline), headline);
  copyStr(current.action, sizeof(current.action), a["action"] | "");
  copyStr(current.message, sizeof(current.message), a["message"] | "");
  remember(current.packet_id);
  saveAlert();
  if (changed) appendHistory(KIND_OFFICIAL, current.severity, current.hazard, current.headline, -1);
  lastSyncResult = "ok";
  Serial.printf("[CLOUD] %s: %s\n", active ? SEV_NAME[current.severity] : "no alert", current.headline);
}

void syncCycle() {
  if (strlen(HOME_WIFI_SSID) == 0) { lastSyncResult = "relay-only node (no home WiFi set)"; return; }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.printf("[WIFI] joining %s…\n", HOME_WIFI_SSID);
    WiFi.begin(HOME_WIFI_SSID, HOME_WIFI_PASS);
    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_CONNECT_MS) serviceWhileWaiting(100);
  }

  if (WiFi.status() == WL_CONNECTED) {
    staConnected = true;
    routerChannel = WiFi.channel();
    if (time(nullptr) < 1700000000) {
      configTime(0, 0, "pool.ntp.org", "time.google.com");
      unsigned long start = millis();
      while (time(nullptr) < 1700000000 && millis() - start < 3000) serviceWhileWaiting(100);
    }
    httpSync();
    if (routerChannel != MESH_CHANNEL) {
      Serial.printf("[WIFI] router is on channel %u, mesh on %u — tip: set MESH_CHANNEL = %u to avoid hopping\n",
                    routerChannel, MESH_CHANNEL, routerChannel);
      WiFi.disconnect(false);
      staConnected = false;
      restoreMeshChannel();
    }
  } else {
    lastSyncResult = "home WiFi not reachable";
    Serial.println("[WIFI] no home WiFi this cycle — relying on the mesh");
    WiFi.disconnect(false); // stop scanning channels, which would deafen the mesh
    staConnected = false;
    restoreMeshChannel();
  }
  broadcastCurrent();
  lastRebroadcast = millis();
}

// ---------------------------------------------------------------------------
// WATER-LEVEL SENSOR (optional)
// ---------------------------------------------------------------------------
float readDistanceCm() {
  float v[5];
  for (int i = 0; i < 5; i++) {
    digitalWrite(TRIG_PIN, LOW); delayMicroseconds(3);
    digitalWrite(TRIG_PIN, HIGH); delayMicroseconds(12);
    digitalWrite(TRIG_PIN, LOW);
    unsigned long us = pulseIn(ECHO_PIN, HIGH, 30000UL);
    v[i] = us ? us * 0.0343f / 2.0f : -1;
    delay(30);
  }
  // median of 5, ignoring timeouts
  for (int i = 0; i < 5; i++) for (int j = i + 1; j < 5; j++) if (v[j] < v[i]) { float t = v[i]; v[i] = v[j]; v[j] = t; }
  int firstGood = 0;
  while (firstGood < 5 && v[firstGood] < 0) firstGood++;
  if (firstGood >= 5) return -1;
  return v[firstGood + (5 - firstGood) / 2];
}

void checkWater() {
  float d = readDistanceCm();
  if (d < 0) return;
  float depth = SENSOR_HEIGHT_CM - d;
  if (depth < 0) depth = 0;
  waterCm = (int16_t)(depth + 0.5f);
  // 3 cm of hysteresis so ripples don't flap the state
  uint8_t next = waterState;
  if (depth >= WATER_DANGER_CM) next = WATER_DANGER;
  else if (depth >= WATER_WARN_CM && (waterState != WATER_DANGER || depth < WATER_DANGER_CM - 3)) next = WATER_WARN;
  else if (depth < WATER_WARN_CM - 3) next = WATER_DRY;
  if (next != waterState) {
    waterState = next;
    char text[64];
    snprintf(text, sizeof(text), "Water %d cm (%s)", (int)waterCm, WATER_NAME[waterState]);
    appendHistory(KIND_WATER, waterState == WATER_DANGER ? SEV_SEVERE : waterState == WATER_WARN ? SEV_MODERATE : SEV_NONE, 1, text, waterCm);
    broadcastWater();
    Serial.printf("[WATER] %s\n", text);
  }
}

// ---------------------------------------------------------------------------
// LOCAL WEB SERVER + CAPTIVE PORTAL
// ---------------------------------------------------------------------------
String esc(const char* s) {
  String o;
  for (const char* c = s; *c; c++) {
    switch (*c) {
      case '&': o += "&amp;"; break;
      case '<': o += "&lt;"; break;
      case '>': o += "&gt;"; break;
      case '"': o += "&quot;"; break;
      case '\'': o += "&#39;"; break;
      default: o += *c;
    }
  }
  return o;
}

bool expiredNow() {
  uint32_t now = nowUnix();
  return current.active && current.expires_at && now && now > current.expires_at;
}

void handleRoot() {
  bool active = current.active && !expiredNow();
  uint8_t sev = active ? current.severity : (uint8_t)SEV_NONE;
  String h;
  h.reserve(4096);
  h += F("<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
         "<meta http-equiv='refresh' content='60'><title>Suraksha Setu node</title><style>"
         "body{font-family:system-ui,sans-serif;background:#0a1220;color:#f3f0e6;max-width:520px;margin:0 auto;padding:18px}"
         ".card{border-radius:16px;padding:18px;background:#131b2e;border:1px solid #2a3a56;border-left:8px solid var(--c)}"
         ".badge{display:inline-block;background:var(--c);color:#111;font-weight:700;padding:4px 12px;border-radius:8px}"
         "h1{font-size:20px;margin:0 0 6px}h2{font-size:30px;margin:12px 0 4px}.m{color:#93a1bd;font-size:14px}"
         ".act{font-size:19px;font-weight:700;margin:14px 0 0}.box{background:#1b2740;border-radius:10px;padding:10px 12px;margin-top:12px}"
         "a{color:#7cc4ff}</style></head><body>");
  h += "<h1>Suraksha Setu &middot; " + esc(NODE_ID) + "</h1>";
  h += "<p class='m'>This page comes from a local node, not the internet.</p>";
  h += "<div class='card' style='--c:" + String(SEV_COLOR[sev]) + "'>";
  if (!current.valid) {
    h += "<h2>No alert received yet</h2><p class='m'>This node hasn't synced or heard from another node since it was switched on. That is not an all-clear.</p>";
  } else {
    h += "<span class='badge'>" + String(active ? SEV_NAME[sev] : "No active alert") + "</span>";
    if (active) h += "<h2>" + String(HAZARD_NAME[current.hazard > 6 ? 0 : current.hazard]) + "</h2>";
    else if (current.active && expiredNow()) h += "<h2>Last alert has expired</h2>";
    h += "<p>" + esc(current.headline) + "</p>";
    if (current.message[0]) h += "<div class='box'><span class='m'>Official message</span><p style='margin:4px 0 0'>" + esc(current.message) + "</p></div>";
    if (current.action[0]) h += "<p class='act'>" + esc(current.action) + "</p>";
    if (current.agency[0]) h += "<p class='m'>Source: " + esc(current.agency) + "</p>";
    h += "<p class='m'>Updated <span data-t='" + String(current.synced_at) + "'></span>";
    if (current.hops) h += " &middot; via the mesh from " + esc(current.origin) + ", " + String(current.hops) + " hop" + (current.hops > 1 ? "s" : "");
    h += "</p>";
    if (current.expires_at) h += "<p class='m'>Valid until <span data-d='" + String(current.expires_at) + "'></span></p>";
  }
  h += "</div>";

  if (ENABLE_WATER_SENSOR && waterCm >= 0) {
    h += "<div class='box'><b>Water level here: " + String(waterCm) + " cm</b> (" + String(WATER_NAME[waterState]) + ")</div>";
  }
  for (const WaterReport& w : neighbourWater) {
    if (!w.used) continue;
    h += "<div class='box'>Water at " + esc(w.origin) + ": <b>" + String(w.cm) + " cm</b> (" + String(WATER_NAME[w.state]) + ") <span class='m'><span data-t='" + String(w.at) + "'></span></span></div>";
  }
  h += "<p class='m'>Emergency: call <a href='tel:112'>112</a> &middot; Ambulance <a href='tel:108'>108</a> &middot; Disaster helpline <a href='tel:1078'>1078</a></p>";
  h += "<p class='m'><a href='/api/alert'>/api/alert</a> &middot; <a href='/api/history'>/api/history</a> &middot; <a href='/api/status'>/api/status</a></p>";
  // Times are formatted by the phone, which knows the local time even offline.
  h += F("<script>document.querySelectorAll('[data-t]').forEach(function(e){var t=+e.dataset.t;if(!t){e.textContent='(time unknown)';return}"
         "var m=Math.round((Date.now()/1000-t)/60);e.textContent=m<1?'just now':m<60?m+' min ago':m<1440?Math.round(m/60)+' h ago':new Date(t*1000).toLocaleString()});"
         "document.querySelectorAll('[data-d]').forEach(function(e){e.textContent=new Date(+e.dataset.d*1000).toLocaleString()});</script></body></html>");
  server.send(200, "text/html; charset=utf-8", h);
}

void handleApiAlert() {
  JsonDocument doc;
  doc["node_id"] = NODE_ID;
  doc["valid"] = current.valid;
  doc["active"] = current.active && !expiredNow();
  doc["expired"] = expiredNow();
  doc["severity"] = SEV_NAME[current.active ? current.severity : 0];
  doc["hazard"] = HAZARD_NAME[current.hazard > 6 ? 0 : current.hazard];
  doc["headline"] = current.headline;
  doc["message"] = current.message;
  doc["action"] = current.action;
  doc["agency"] = current.agency;
  doc["issued_at"] = current.issued_at;
  doc["expires_at"] = current.expires_at;
  doc["synced_at"] = current.synced_at;
  doc["origin"] = current.origin;
  doc["hops"] = current.hops;
  doc["online"] = staConnected;
  // Kept for compatibility with the original firmware's JSON.
  doc["payload"] = current.headline;
  doc["timestamp"] = current.synced_at;
  if (ENABLE_WATER_SENSOR && waterCm >= 0) { doc["water_cm"] = waterCm; doc["water_state"] = WATER_NAME[waterState]; }
  String out;
  serializeJson(doc, out);
  server.send(200, "application/json; charset=utf-8", out);
}

void handleApiHistory() {
  File f = LittleFS.open(HISTORY_FILE, "r");
  if (!f) { server.send(200, "application/json", "[]"); return; }
  server.streamFile(f, "application/json");
  f.close();
}

void handleApiStatus() {
  JsonDocument doc;
  doc["node_id"] = NODE_ID;
  doc["fw"] = FW_VERSION;
  doc["uptime_s"] = millis() / 1000UL;
  doc["free_heap"] = ESP.getFreeHeap();
  doc["clock"] = nowUnix();
  doc["home_wifi"] = staConnected;
  doc["router_channel"] = routerChannel;
  doc["mesh_channel"] = MESH_CHANNEL;
  doc["last_sync"] = lastSyncResult;
  doc["mesh_rx"] = statRx;
  doc["mesh_relayed"] = statRelayed;
  doc["mesh_rejected"] = statRejected;
  doc["mesh_adopted"] = statAdopted;
  doc["ap_clients"] = WiFi.softAPgetStationNum();
  String out;
  serializeJson(doc, out);
  server.send(200, "application/json", out);
}

// Any other address (including phones' captive-portal checks) → the alert page.
void handleRedirect() {
  server.sendHeader("Location", "http://" + WiFi.softAPIP().toString() + "/", true);
  server.send(302, "text/plain", "");
}

// ---------------------------------------------------------------------------
// LED / BUZZER
// ---------------------------------------------------------------------------
void updateIndicators() {
  bool active = current.active && !expiredNow();
  unsigned long period = !active ? 0 : current.severity >= SEV_SEVERE ? 250 : current.severity == SEV_MODERATE ? 1000 : 0;
  if (LED_PIN >= 0) {
    if (period == 0) digitalWrite(LED_PIN, active ? HIGH : LOW);
    else if (millis() - lastLedToggle > period) { lastLedToggle = millis(); digitalWrite(LED_PIN, !digitalRead(LED_PIN)); }
  }
  if (BUZZER_PIN >= 0) {
    bool beep = ENABLE_WATER_SENSOR && waterState == WATER_DANGER && (millis() / 500) % 4 == 0;
    digitalWrite(BUZZER_PIN, beep ? HIGH : LOW);
  }
}

// ---------------------------------------------------------------------------
// SETUP / LOOP
// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.printf("\nSuraksha Setu node %s, firmware %s\n", NODE_ID, FW_VERSION);
  randomSeed(esp_random());
  if (LED_PIN >= 0) pinMode(LED_PIN, OUTPUT);
  if (BUZZER_PIN >= 0) pinMode(BUZZER_PIN, OUTPUT);
#if ENABLE_WATER_SENSOR
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
#endif

  if (!LittleFS.begin(true)) Serial.println("[FLASH] LittleFS mount failed — check the partition scheme");
  loadAlert();

  rxQueue = xQueueCreate(12, sizeof(MeshPacket));

  WiFi.persistent(false);
  WiFi.mode(WIFI_AP_STA);
  WiFi.setAutoReconnect(false);
  WiFi.softAP(LOCAL_AP_SSID, apPass(), MESH_CHANNEL, 0, 4);
  esp_wifi_set_channel(MESH_CHANNEL, WIFI_SECOND_CHAN_NONE);
  Serial.printf("[AP] hotspot \"%s\" at %s, channel %u\n", LOCAL_AP_SSID, WiFi.softAPIP().toString().c_str(), MESH_CHANNEL);

  if (esp_now_init() != ESP_OK) {
    Serial.println("[MESH] ESP-NOW init failed");
  } else {
    esp_now_register_recv_cb(onMeshRecv);
    esp_now_peer_info_t peer = {};
    memset(peer.peer_addr, 0xFF, 6);
    peer.channel = 0;          // whatever channel the radio is on (the mesh channel)
    peer.ifidx = WIFI_IF_AP;
    peer.encrypt = false;      // broadcast can't be encrypted; packets are HMAC-signed instead
    esp_now_add_peer(&peer);
  }

  dns.start(53, "*", WiFi.softAPIP());
  server.on("/", handleRoot);
  server.on("/api/alert", handleApiAlert);
  server.on("/api/history", handleApiHistory);
  server.on("/api/status", handleApiStatus);
  server.onNotFound(handleRedirect);
  server.begin();
  Serial.println("[WEB] local server on port 80 (captive portal on)");

  lastSync = millis() - SYNC_INTERVAL_MS + 5000; // first sync ~5 s after boot
}

void loop() {
  dns.processNextRequest();
  server.handleClient();
  processMesh();

  if (millis() - lastSync >= SYNC_INTERVAL_MS) {
    lastSync = millis();
    syncCycle();
  }
  if (millis() - lastRebroadcast >= REBROADCAST_MS + (unsigned long)random(0, 5000)) {
    lastRebroadcast = millis();
    broadcastCurrent(); // late joiners and nodes that just rebooted catch up
  }
#if ENABLE_WATER_SENSOR
  if (millis() - lastWaterRead >= 5000) {
    lastWaterRead = millis();
    checkWater();
  }
#endif
  updateIndicators();
  delay(2);
}
