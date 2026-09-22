"use client";
import { useState } from "react";
import { useWidth } from "@/components/useWidth";
import { type DailyPoint, weatherKey } from "@/lib/conditions";
import type { Key, T } from "@/lib/i18n";

// 7-day outlook from Open-Meteo: temperature (three lines on one °C axis),
// rain (bars) and gusts (bars). One measure per axis — rain probability is
// shown as a text row under the rain bars rather than on a second scale.
// Every value is also in the table view.

const LOCALE: Record<string, string> = { en: "en-IN", hi: "hi-IN", gu: "gu-IN", ta: "ta-IN", as: "as-IN" };

function dayLabels(days: DailyPoint[], t: T, lang: string) {
  return days.map((d, i) => (i === 0 ? t("today") : new Date(`${d.date}T12:00:00+05:30`).toLocaleDateString(LOCALE[lang] ?? "en-IN", { weekday: "short" })));
}

function niceStep(raw: number) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

function ticks(lo: number, hi: number, count = 4) {
  const step = niceStep((hi - lo) / count || 1);
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const out: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

type TipRow = { color?: string; value: string; name: string };
type Tip = { x: number; y: number; title: string; rows: TipRow[] } | null;

function Tooltip({ tip, width }: { tip: Tip; width: number }) {
  if (!tip) return null;
  const left = Math.min(Math.max(tip.x - 70, 0), width - 150);
  return (
    <div className="chart-tip" style={{ left, top: Math.max(0, tip.y - 8) }} role="status">
      <div className="chart-tip-title">{tip.title}</div>
      {tip.rows.map((r, i) => (
        <div key={i} className="chart-tip-row">
          {r.color && <span className="line-key" style={{ background: r.color }} />}
          <b>{r.value}</b> <span className="muted">{r.name}</span>
        </div>
      ))}
    </div>
  );
}

const M = { l: 34, r: 34, t: 12, b: 24 };

// ---------------------------------------------------------------- lines
function TempChart({ days, labels, t }: { days: DailyPoint[]; labels: string[]; t: T }) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = 170;
  const plotW = width - M.l - M.r;
  const plotH = H - M.t - M.b;
  const series = [
    { key: "tmin" as const, name: t("fc_min"), color: "var(--series-1)" },
    { key: "tmax" as const, name: t("fc_max"), color: "var(--series-2)" },
    { key: "feels_max" as const, name: t("fc_feels"), color: "var(--series-3)" },
  ];
  const vals = days.flatMap((d) => series.map((s) => d[s.key])).filter((v): v is number => v != null);
  if (!vals.length) return null;
  const yt = ticks(Math.min(...vals) - 1, Math.max(...vals) + 1, 4);
  const [y0, y1] = [yt[0], yt[yt.length - 1]];
  const band = plotW / days.length;
  const x = (i: number) => M.l + band * (i + 0.5);
  const y = (v: number) => M.t + plotH - ((v - y0) / (y1 - y0)) * plotH;

  const paths = series.map((s) => {
    let d = "";
    days.forEach((p, i) => {
      const v = p[s.key];
      if (v == null) return;
      d += `${d && days[i - 1]?.[s.key] != null ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    });
    return d;
  });

  // End labels only when they don't collide; otherwise legend + tooltip carry it.
  const last = days.length - 1;
  const ends = series.map((s) => ({ s, v: days[last][s.key] })).filter((e) => e.v != null) as { s: (typeof series)[number]; v: number }[];
  const ys = ends.map((e) => y(e.v)).sort((a, b) => a - b);
  const endLabels = ys.every((v, i) => i === 0 || v - ys[i - 1] >= 13);

  const tip: Tip = hover == null ? null : {
    x: x(hover), y: M.t, title: `${labels[hover]} · ${t(weatherKey(days[hover].code) as Key)}`,
    rows: series.map((s) => ({ color: s.color, value: days[hover][s.key] == null ? "–" : `${Math.round(days[hover][s.key]!)}°C`, name: s.name })),
  };

  function onMove(e: React.PointerEvent<SVGRectElement>) {
    const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const i = Math.floor((e.clientX - box.left - M.l) / band);
    setHover(Math.min(days.length - 1, Math.max(0, i)));
  }
  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowRight") setHover((h) => Math.min(days.length - 1, (h ?? -1) + 1));
    if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? 1) - 1));
  }

  return (
    <figure className="chart">
      <figcaption className="chart-title">{t("fc_temp")}</figcaption>
      <div className="legend">
        {series.map((s) => <span key={s.key}><span className="line-key" style={{ background: s.color }} />{s.name}</span>)}
      </div>
      <div ref={ref} className="chart-box">
        <svg width={width} height={H} tabIndex={0} onKeyDown={onKey} onFocus={() => setHover((h) => h ?? 0)} onBlur={() => setHover(null)}
          aria-label={`${t("fc_temp")}. ${t("fc_table_show")}.`} role="img">
          {yt.map((v) => (
            <g key={v}>
              <line x1={M.l} x2={width - M.r} y1={y(v)} y2={y(v)} className="grid" />
              <text x={M.l - 6} y={y(v) + 4} textAnchor="end" className="tick">{v}</text>
            </g>
          ))}
          {labels.map((l, i) => <text key={i} x={x(i)} y={H - 6} textAnchor="middle" className="tick">{l}</text>)}
          {hover != null && <line x1={x(hover)} x2={x(hover)} y1={M.t} y2={M.t + plotH} className="crosshair" />}
          {paths.map((d, i) => <path key={i} d={d} fill="none" stroke={series[i].color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />)}
          {ends.map((e) => <circle key={e.s.key} cx={x(last)} cy={y(e.v)} r="4" fill={e.s.color} stroke="var(--surface)" strokeWidth="2" />)}
          {hover != null && series.map((s) => days[hover][s.key] != null && (
            <circle key={s.key} cx={x(hover)} cy={y(days[hover][s.key]!)} r="4" fill={s.color} stroke="var(--surface)" strokeWidth="2" />
          ))}
          {endLabels && ends.map((e) => <text key={e.s.key} x={x(last) + 8} y={y(e.v) + 4} className="end-label">{Math.round(e.v)}°</text>)}
          <rect x={M.l} y={M.t} width={plotW} height={plotH} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
        </svg>
        <Tooltip tip={tip} width={width} />
      </div>
    </figure>
  );
}

// ---------------------------------------------------------------- bars
function BarChart({ title, values, labels, unit, extra, extraName, extraNote, threshold }: {
  title: string; values: (number | null)[]; labels: string[]; unit: string;
  extra?: (string | null)[]; extraName?: string; extraNote?: string; threshold?: { value: number; label: string };
}) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = extra ? 168 : 150;
  const bottom = extra ? M.b + 18 : M.b;
  const plotW = width - M.l - M.r;
  const plotH = H - M.t - bottom;
  const max = Math.max(0, ...values.map((v) => v ?? 0));
  const showThreshold = threshold && max >= threshold.value * 0.6;
  const yt = ticks(0, Math.max(showThreshold ? threshold!.value * 1.1 : 0, max, 1), 3);
  const top = yt[yt.length - 1];
  const band = plotW / values.length;
  const bw = Math.min(24, band * 0.6);
  const x = (i: number) => M.l + band * (i + 0.5);
  const y = (v: number) => M.t + plotH - (v / top) * plotH;
  const peak = values.reduce<number>((best, v, i) => ((v ?? 0) > (values[best] ?? 0) ? i : best), 0);

  function bar(i: number, v: number) {
    const h = Math.max(0, y(0) - y(v));
    const r = Math.min(4, h, bw / 2);
    const x0 = x(i) - bw / 2, x1 = x(i) + bw / 2, yb = y(0), yt0 = yb - h;
    return `M${x0},${yb} L${x0},${yt0 + r} Q${x0},${yt0} ${x0 + r},${yt0} L${x1 - r},${yt0} Q${x1},${yt0} ${x1},${yt0 + r} L${x1},${yb} Z`;
  }

  const tip: Tip = hover == null ? null : {
    x: x(hover), y: M.t, title: labels[hover],
    rows: [
      { value: values[hover] == null ? "–" : `${Math.round(values[hover]! * 10) / 10} ${unit}`, name: title },
      ...(extra && extra[hover] ? [{ value: extra[hover]!, name: extraName ?? "" }] : []),
    ],
  };

  return (
    <figure className="chart">
      <figcaption className="chart-title">{title}</figcaption>
      {extraNote && <div className="legend">{extraNote}</div>}
      <div ref={ref} className="chart-box">
        <svg width={width} height={H} role="img" aria-label={title}>
          {yt.map((v) => (
            <g key={v}>
              <line x1={M.l} x2={width - M.r} y1={y(v)} y2={y(v)} className="grid" />
              <text x={M.l - 6} y={y(v) + 4} textAnchor="end" className="tick">{v}</text>
            </g>
          ))}
          {showThreshold && (
            <g>
              <line x1={M.l} x2={width - M.r} y1={y(threshold!.value)} y2={y(threshold!.value)} className="threshold" />
              <text x={width - M.r} y={y(threshold!.value) - 4} textAnchor="end" className="tick">{threshold!.label}</text>
            </g>
          )}
          {values.map((v, i) => (v != null && v > 0 ? (
            <path key={i} d={bar(i, v)} fill="var(--series-1)" opacity={hover == null || hover === i ? 1 : 0.55} />
          ) : null))}
          {(values[peak] ?? 0) > 0 && <text x={x(peak)} y={y(values[peak]!) - 5} textAnchor="middle" className="end-label">{Math.round(values[peak]!)}</text>}
          {labels.map((l, i) => <text key={i} x={x(i)} y={H - (extra ? 24 : 6)} textAnchor="middle" className="tick">{l}</text>)}
          {extra && extra.map((e, i) => <text key={i} x={x(i)} y={H - 6} textAnchor="middle" className="tick muted-tick">{e ?? ""}</text>)}
          {values.map((_, i) => (
            <rect key={i} x={M.l + band * i} y={M.t} width={band} height={plotH} fill="transparent" tabIndex={0}
              aria-label={`${labels[i]}: ${values[i] ?? "–"} ${unit}${extra?.[i] ? `, ${extra[i]}` : ""}`}
              onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} />
          ))}
        </svg>
        <Tooltip tip={tip} width={width} />
      </div>
    </figure>
  );
}

export default function ForecastCharts({ days, t, lang }: { days: DailyPoint[]; t: T; lang: string }) {
  const [table, setTable] = useState(false);
  if (!days.length) return null;
  const labels = dayLabels(days, t, lang);
  const r = (v: number | null, d = 0) => (v == null ? "–" : (Math.round(v * 10 ** d) / 10 ** d).toString());
  return (
    <div>
      <TempChart days={days} labels={labels} t={t} />
      <BarChart title={t("fc_rain")} unit="mm" labels={labels} values={days.map((d) => d.rain)}
        extra={days.map((d) => (d.rain_prob == null ? null : `${Math.round(d.rain_prob)}%`))} extraName={t("fc_prob")} extraNote={t("fc_prob_row")}
        threshold={{ value: 64.5, label: t("fc_heavy_line") }} />
      <BarChart title={t("fc_wind")} unit="km/h" labels={labels} values={days.map((d) => d.gust_max)}
        threshold={{ value: 50, label: t("fc_strong_line") }} />
      <button type="button" className="link-btn" onClick={() => setTable((v) => !v)}>{table ? t("fc_table_hide") : t("fc_table_show")}</button>
      {table && (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>{t("fc_day")}</th><th>{t("fc_weather")}</th><th>{t("fc_min")}</th><th>{t("fc_max")}</th><th>{t("fc_feels")}</th><th>mm</th><th>%</th><th>km/h</th><th>{t("fc_uv")}</th></tr>
            </thead>
            <tbody>
              {days.map((d, i) => (
                <tr key={d.date}>
                  <td>{labels[i]}</td><td>{t(weatherKey(d.code) as Key)}</td><td>{r(d.tmin)}</td><td>{r(d.tmax)}</td><td>{r(d.feels_max)}</td>
                  <td>{r(d.rain, 1)}</td><td>{r(d.rain_prob)}</td><td>{r(d.gust_max)}</td><td>{r(d.uv)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
