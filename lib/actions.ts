import seed from "@/data/seed.json";
import translations from "@/data/translations.json";
import type { Profile } from "./types";

// Pure lookups over the bundled safety content (data/seed.json). No network,
// no database — so the same code runs on the server for the dashboard and in
// the browser for an alert relayed phone-to-phone while offline.

type DwellingRule = { dwelling_type: string; hazard_type: string; language: string; action_text: string };
type OccupationTip = { occupation: string; hazard_type: string; language: string; tip_text: string };

function seedDwellingRules(): DwellingRule[] {
  const tr = translations.dwelling_rules as Record<string, Record<string, string>>;
  return seed.dwelling_rules.flatMap((r) => [
    { ...r, language: "en" },
    ...Object.entries(tr[`${r.dwelling_type}|${r.hazard_type}`] ?? {}).map(([language, action_text]) => ({ ...r, language, action_text })),
  ]);
}
const DWELLING_RULES = seedDwellingRules(); // static reference data, computed once
const OCCUPATION_TIPS = seed.occupation_tips.map((t) => ({ ...t, language: "en" })) as OccupationTip[];

export function actionFor(profile: Pick<Profile, "dwelling_type" | "occupation" | "language" | "vulnerabilities">, hazard: string) {
  const { dwelling_type: d, occupation: o, language } = profile;

  let action = "";
  outer: for (const dd of [d, "*"]) {
    for (const lang of [language, "en"]) {
      const hit = DWELLING_RULES.find((r) => r.dwelling_type === dd && r.hazard_type === hazard && r.language === lang)
        ?? (dd === "*" && lang === "en" ? DWELLING_RULES.find((r) => r.dwelling_type === "*" && r.hazard_type === "*" && r.language === language) ?? DWELLING_RULES.find((r) => r.dwelling_type === "*" && r.hazard_type === "*") : undefined);
      if (hit) { action = hit.action_text; break outer; }
    }
  }

  const occupationTip = OCCUPATION_TIPS.find((t) => t.occupation === o && t.hazard_type === hazard)
    ?? OCCUPATION_TIPS.find((t) => t.occupation === o && t.hazard_type === "*");

  const vulnTr = translations.vulnerability_tips as Record<string, Record<string, string>>;
  const vulnEn = seed.vulnerability_tips as Record<string, Record<string, string>>;
  const vulnerabilityTips = (profile.vulnerabilities ?? [])
    .map((v) => {
      const h = vulnEn[v]?.[hazard] ? hazard : "*";
      return vulnTr[`${v}|${h}`]?.[language] ?? vulnEn[v]?.[h];
    })
    .filter(Boolean) as string[];

  return { action, occupationTip: occupationTip?.tip_text ?? null, vulnerabilityTips };
}

export const helplines = seed.helplines;

const HAZARD_GUIDE = seed.hazard_guide as Record<string, { before: string[]; after: string[] }>;
export function hazardGuide(hazard: string) {
  return HAZARD_GUIDE[hazard] ?? null;
}
