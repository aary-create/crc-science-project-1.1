export type Severity = "Extreme" | "Severe" | "Moderate" | "Minor";

export type Location = {
  label: string;   // what the person searched or the reverse-geocoded address
  lat: number;
  lng: number;
  district: string; // best-effort, from geocoding — used as a text fallback match
  state: string;
};

export type LiveAlert = {
  id: string;
  hazard_type: string;
  severity: Severity;
  source_agency: string;
  area_text: string;
  headline: string;
  message: string | null;      // the agency's own full warning text, if the feed carries one
  message_lang: string | null; // language code of `message` (SACHET's actual_lang, CAP's language)
  instruction: string | null;  // CAP <instruction>, when the agency gives one
  timestamp: string;           // ISO — when it was issued / takes effect
  expires: string | null;      // ISO — when the agency says it ends, if given
  lat: number | null;
  lng: number | null;
  radius_km: number | null;    // derived from the source's reported area, null if unknown
  polygons: [number, number][][] | null; // CAP polygons as [lat, lng] rings, when given
};

// Why an alert was ranked lower than its raw severity would put it.
export type Deprioritised = "night_heat" | "upcoming" | null;

export type CurrentAlert = {
  alert: LiveAlert;
  sources: { agency: string; severity: Severity; headline: string }[];
  conflict: boolean;
  deprioritised: Deprioritised;
  // Other hazards also in effect at this spot, newest per agency — so a
  // de-prioritised heat advisory is still visible, never silently dropped.
  others: { id: string; hazard_type: string; severity: Severity; source_agency: string; headline: string; deprioritised: Deprioritised }[];
};

export type Profile = Location & {
  dwelling_type: string;
  occupation: string;
  vulnerabilities: string[];
  language: string;
  device_id?: string;
};

export type HelpPlace = {
  name: string;
  lat: number;
  lng: number;
  place_id: string;
  phone?: string;
  distance_km: number;
};

export type NodeInfo = {
  node_id: string;
  lat: number;
  lng: number;
  last_cached_ts: number | null;
  last_seen: string;
  distance_km: number;
  water_cm: number | null;       // measured water depth, if the node has a level sensor
  water_state: string | null;    // "dry" | "warn" | "danger", computed on the node
};
