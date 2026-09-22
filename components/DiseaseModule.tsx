import { Reasons } from "@/components/RiskCard";
import type { Key, T } from "@/lib/i18n";
import type { Reason } from "@/lib/risk";

// Post-flood public-health guidance: water-borne, mosquito-borne and
// leptospirosis risk, plus when to see a doctor. Shown only when a real
// trigger fired (a flood/heavy-rain alert now or on this phone in the last
// 5 days, or 64.5 mm+ of rain on a day in the last two weeks).
const SECTIONS: { h: Key; items: Key[] }[] = [
  { h: "dz_water_h", items: ["dz_water_1", "dz_water_2", "dz_water_3"] },
  { h: "dz_mosq_h", items: ["dz_mosq_1", "dz_mosq_2"] },
  { h: "dz_lepto_h", items: ["dz_lepto_1"] },
  { h: "dz_seek_h", items: ["dz_seek_1", "dz_seek_2", "dz_seek_3", "dz_seek_4"] },
];

export default function DiseaseModule({ reasons, t }: { reasons: Reason[]; t: T }) {
  if (!reasons.length) return null;
  return (
    <section className="risk risk-watch" style={{ ["--edge" as any]: "var(--moderate)" }}>
      <h3 className="risk-title"><span aria-hidden="true" className="risk-icon">✚</span>{t("dzTitle")}</h3>
      <p className="risk-body" style={{ fontWeight: 400 }}>{t("dzIntro")}</p>
      {SECTIONS.map((s) => (
        <div key={s.h} className="dz-section">
          <h4>{t(s.h)}</h4>
          <ul>{s.items.map((k) => <li key={k}>{t(k)}</li>)}</ul>
        </div>
      ))}
      <p className="dz-warn">{t("dz_nsaid")}</p>
      <p className="row" style={{ gap: 8 }}>
        <a className="btn ghost" href="tel:104">104</a>
        <a className="btn ghost" href="tel:108">108</a>
        <span className="muted small">{t("dz_helplines")}</span>
      </p>
      <Reasons reasons={reasons} t={t} />
    </section>
  );
}
