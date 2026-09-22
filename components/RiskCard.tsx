import type { T } from "@/lib/i18n";
import type { Level, Reason, RiskItem } from "@/lib/risk";

const EDGE: Record<Level, string> = { info: "var(--focus)", watch: "var(--moderate)", warning: "var(--severe)", danger: "var(--extreme)" };
const ICON: Record<Level, string> = { info: "ℹ", watch: "●", warning: "▲", danger: "■" };

export function Reasons({ reasons, t }: { reasons: Reason[]; t: T }) {
  if (!reasons.length) return null;
  return (
    <div className="reasons">
      <span className="muted small">{t("basedOn")}:</span>
      <ul>{reasons.map((r, i) => <li key={i}>{t(r.key, r.vars)}</li>)}</ul>
    </div>
  );
}

// One rule-based card. The level shows as a shape and word-weight as well as
// colour, so it never relies on colour alone.
export default function RiskCard({ item, t }: { item: RiskItem; t: T }) {
  return (
    <section className={`risk risk-${item.level}`} style={{ ["--edge" as any]: EDGE[item.level] }}>
      <h3 className="risk-title"><span aria-hidden="true" className="risk-icon">{ICON[item.level]}</span>{t(item.title, item.vars)}</h3>
      <p className="risk-body">{t(item.body, item.vars)}</p>
      <Reasons reasons={item.reasons} t={t} />
    </section>
  );
}
