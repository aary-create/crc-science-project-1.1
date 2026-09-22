// Gujarat district names are spelled differently by different agencies:
// LGD (the government registry this app's village list comes from) says
// "Banas Kantha", OpenStreetMap says "Banaskantha", IMD bulletins may say
// either. Matching an alert's area text against the person's district has to
// see through that, or a real warning silently fails to match.
const GUJARAT_DISTRICT_ALIASES: string[][] = [
  ["ahmedabad", "ahmadabad", "amdavad"],
  ["amreli"],
  ["anand"],
  ["aravalli", "arvalli"],
  ["banaskantha", "banas kantha"],
  ["bharuch", "broach"],
  ["bhavnagar"],
  ["botad"],
  ["chhota udaipur", "chhotaudepur", "chhota udepur", "chhotaudaipur"],
  ["dahod", "dohad"],
  ["dang", "dangs", "the dangs"],
  ["devbhumi dwarka", "devbhoomi dwarka"],
  ["gandhinagar"],
  ["gir somnath", "girsomnath"],
  ["jamnagar"],
  ["junagadh"],
  ["kutch", "kachchh", "kachh", "kachchha"],
  ["kheda"],
  ["mehsana", "mahesana"],
  ["mahisagar"],
  ["morbi", "morvi"],
  ["narmada"],
  ["navsari"],
  ["panchmahal", "panch mahals", "panchmahals", "panch mahal"],
  ["patan"],
  ["porbandar"],
  ["rajkot"],
  ["sabarkantha", "sabar kantha"],
  ["surat"],
  ["surendranagar"],
  ["tapi"],
  ["vadodara", "baroda"],
  ["valsad"],
];

// The name OpenStreetMap/Nominatim knows each LGD district by — used when a
// picked village has to be resolved to coordinates.
const LGD_TO_COMMON: Record<string, string> = {
  "Ahmadabad": "Ahmedabad",
  "Arvalli": "Aravalli",
  "Banas Kantha": "Banaskantha",
  "Chhotaudepur": "Chhota Udaipur",
  "Dang": "Dang",
  "Dohad": "Dahod",
  "GIR Somnath": "Gir Somnath",
  "Kachchh": "Kutch",
  "Mahesana": "Mehsana",
  "Panch Mahals": "Panchmahal",
  "Sabar Kantha": "Sabarkantha",
};

export function commonDistrictName(lgd: string) {
  return LGD_TO_COMMON[lgd] ?? lgd;
}

export function cleanDistrict(name: string) {
  return name.replace(/\s+district$/i, "").trim();
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function aliasesFor(district: string): string[] {
  const d = norm(cleanDistrict(district));
  if (!d) return [];
  const group = GUJARAT_DISTRICT_ALIASES.find((g) => g.includes(d) || g.includes(d.replace(/\s/g, "")));
  return group ?? [d];
}

const STATES = [
  "andhra pradesh", "arunachal pradesh", "assam", "bihar", "chhattisgarh", "goa", "gujarat", "haryana",
  "himachal pradesh", "jharkhand", "karnataka", "kerala", "madhya pradesh", "maharashtra", "manipur",
  "meghalaya", "mizoram", "nagaland", "odisha", "punjab", "rajasthan", "sikkim", "tamil nadu", "telangana",
  "tripura", "uttar pradesh", "uttarakhand", "west bengal", "delhi", "jammu and kashmir", "ladakh",
  "puducherry", "chandigarh", "lakshadweep", "andaman and nicobar",
];
const has = (hay: string, phrase: string) => new RegExp(`\\s${escape(phrase)}\\s`).test(hay);

export function mentionsState(areaText: string, state: string): boolean {
  const s = norm(state);
  return !!s && has(` ${norm(areaText)} `, s);
}

// Whole-word match so a short name ("Dang") never matches inside another
// word ("danger"). If the text names states and the person's state isn't one
// of them, a same-named place elsewhere in India is the likelier meaning
// ("Anand" district vs "Anand Vihar" in Delhi), so it doesn't count.
export function mentionsDistrict(areaText: string, district: string, state = ""): boolean {
  const hay = ` ${norm(areaText)} `;
  if (!aliasesFor(district).some((a) => has(hay, a))) return false;
  const named = STATES.filter((s) => has(hay, s));
  return named.length === 0 || !state || named.includes(norm(state));
}
