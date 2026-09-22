// An arc meter. The fill carries the state (accent → warning → danger) and
// the track is a faint step of the same colour; the value and a text status
// sit below, so the state never depends on colour alone.

type Props = {
  label: string;
  value: number | null;
  unit: string;
  min: number;
  max: number;
  color: string;       // fill colour for the current state
  status?: string;     // text state, e.g. "Poor", "Low"
  sub?: string;        // secondary line, e.g. "Feels like 41°C"
  decimals?: number;
};

const START = 150; // degrees, 0 = 3 o'clock, clockwise
const SWEEP = 240;
const R = 34;
const CX = 44;
const CY = 42;

function point(deg: number) {
  const a = (deg * Math.PI) / 180;
  return [CX + R * Math.cos(a), CY + R * Math.sin(a)];
}

function arc(fromDeg: number, toDeg: number) {
  const [x1, y1] = point(fromDeg);
  const [x2, y2] = point(toDeg);
  const large = toDeg - fromDeg > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

export default function Gauge({ label, value, unit, min, max, color, status, sub, decimals = 0 }: Props) {
  const frac = value == null ? 0 : Math.min(1, Math.max(0, (value - min) / (max - min)));
  const shown = value == null ? "–" : value.toFixed(decimals);
  return (
    <div className="gauge" role="img" aria-label={`${label}: ${shown}${unit}${status ? `, ${status}` : ""}${sub ? `. ${sub}` : ""}`}>
      <span className="gauge-label">{label}</span>
      <svg viewBox="0 0 88 70" width="100%" height="70" aria-hidden="true">
        <path d={arc(START, START + SWEEP)} fill="none" stroke={`color-mix(in srgb, ${color} 22%, var(--surface))`} strokeWidth="7" strokeLinecap="round" />
        {frac > 0.005 && <path className="gauge-fill" d={arc(START, START + SWEEP * frac)} fill="none" stroke={color} strokeWidth="7" strokeLinecap="round" />}
        <text x={CX} y={CY + 6} textAnchor="middle" className="gauge-value">{shown}</text>
        <text x={CX} y={CY + 20} textAnchor="middle" className="gauge-unit">{unit}</text>
      </svg>
      {status && <span className="gauge-status">{status}</span>}
      {sub && <span className="gauge-sub">{sub}</span>}
    </div>
  );
}
