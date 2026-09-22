import type { Profile } from "./types";

// Labels for these ids live in lib/i18n.ts (d_*, o_*, v_*, h_*)
export const DWELLINGS = ["flood_prone_lane", "ground_floor", "mid_floor", "high_rise", "kutcha_house", "higher_ground"] as const;
export const OCCUPATIONS = ["farmer", "fisherman", "daily_wage_worker", "healthcare_worker", "school_parent", "general_resident"] as const;
// The first five are the original care needs; "respiratory" (asthma/COPD)
// drives the air-quality cross-referencing.
export const VULNERABILITIES = ["elderly", "infant_or_pregnant", "disability", "chronic_illness", "livestock", "respiratory"] as const;
export const HAZARDS = ["flood", "cyclone", "heavy_rain", "heatwave", "thunderstorm", "earthquake", "other"] as const;

const PROFILE_KEY = "ss:profile";
export const CACHE_KEY = "ss:lastDashboard";       // IndexedDB (lib/store.ts)
export const CONDITIONS_KEY = "ss:lastConditions"; // IndexedDB (lib/store.ts)
export const RELAYS_KEY = "ss:relays";             // IndexedDB (lib/store.ts)
export const RELAY_PUBKEY_KEY = "ss:relayPubKey";  // IndexedDB (lib/store.ts)

// The profile and small settings stay in localStorage: they're tiny and
// several screens need them synchronously on first render.
export function loadProfile(): Profile | null {
  try {
    return JSON.parse(localStorage.getItem(PROFILE_KEY) ?? "null");
  } catch {
    return null;
  }
}
export function saveProfile(p: Profile) {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

// A random per-device id so the server can update one profile row instead
// of adding a new one on every edit. Not linked to any personal identity.
export function deviceId(): string {
  try {
    let id = localStorage.getItem("ss:deviceId");
    if (!id) {
      id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem("ss:deviceId", id);
    }
    return id;
  } catch {
    return "";
  }
}

export type Settings = {
  refreshMinutes: number;       // dashboard auto-refresh interval
  theme: "standard" | "command";
  muteAutoRead: boolean;
};
export const REFRESH_CHOICES = [2, 5, 10, 15, 30] as const;
const DEFAULTS: Settings = { refreshMinutes: 5, theme: "standard", muteAutoRead: false };
const SETTINGS_KEY = "ss:settings";

export function loadSettings(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    // Carry over the mute toggle from versions that stored it on its own.
    if (s.muteAutoRead === undefined && localStorage.getItem("ss:muteAutoRead") === "1") s.muteAutoRead = true;
    const merged = { ...DEFAULTS, ...s };
    if (!REFRESH_CHOICES.includes(merged.refreshMinutes)) merged.refreshMinutes = DEFAULTS.refreshMinutes;
    return merged;
  } catch {
    return DEFAULTS;
  }
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...loadSettings(), ...patch };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  if (typeof document !== "undefined") document.documentElement.dataset.theme = next.theme;
  return next;
}
