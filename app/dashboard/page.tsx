"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import ConditionsPanel from "@/components/ConditionsPanel";
import DiseaseModule from "@/components/DiseaseModule";
import ForecastCharts from "@/components/ForecastCharts";
import HazardIcon from "@/components/HazardIcon";
import RiskCard from "@/components/RiskCard";
import SeverityBadge from "@/components/SeverityBadge";
import ShareRow from "@/components/ShareRow";
import { cacheExplanation, getCachedExplanation } from "@/lib/ai-cache";
import type { Conditions } from "@/lib/conditions";
import { explainTerms } from "@/lib/glossary";
import { recordHistory, readHistory, type HistoryEntry } from "@/lib/history";
import { makeT, shortTime, speechLang, timeAgo, type Key, type T } from "@/lib/i18n";
import { useT } from "@/lib/useT";
import { CACHE_KEY, CONDITIONS_KEY, RELAY_PUBKEY_KEY, loadProfile, loadSettings, saveSettings } from "@/lib/options";
import type { RelayPayload } from "@/lib/relay";
import { airAdvice, compoundRisks, diseaseTriggers, floorTrigger } from "@/lib/risk";
import { kvGet, kvSet } from "@/lib/store";
import type { CurrentAlert, NodeInfo, Profile, Severity } from "@/lib/types";

type Data = {
  sachetOk: boolean; imdOk: boolean; feedsDown?: boolean;
  current: CurrentAlert | null;
  action: string;
  guide: { before: string[]; after: string[] } | null;
  occupationTip: string | null;
  vulnerabilityTips: string[];
  node: NodeInfo | null;
  relay?: RelayPayload | null;
  fetchedAt: string;
};

const EDGE: Record<Severity, string> = { Extreme: "var(--extreme)", Severe: "var(--severe)", Moderate: "var(--moderate)", Minor: "var(--minor)" };
const LOUD: Severity[] = ["Extreme", "Severe"];
const hazardKey = (h: string) => (`h_${h}` as Key);

function alertTitle(d: Data, t: T) {
  if (d.feedsDown) return t("feedsDownTitle");
  if (!d.current) return t("noAlert");
  return `${t(`s_${d.current.alert.severity}`)} ${t(hazardKey(d.current.alert.hazard_type))}`;
}

function speakText(d: Data, t: T, lang: string, extra: string[] = []) {
  if (!("speechSynthesis" in window)) return;
  const c = d.current;
  const text = [alertTitle(d, t), d.feedsDown ? t("feedsDownBody") : c?.alert.headline, t("whatToDo"), d.action, ...extra, d.occupationTip, ...d.vulnerabilityTips].filter(Boolean).join(". ");
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = speechLang(lang);
  speechSynthesis.speak(u);
}

async function notify(d: Data, t: T, quiet: boolean) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const reg = await navigator.serviceWorker?.ready;
  const title = alertTitle(d, t);
  const opts: NotificationOptions = { body: d.action, tag: "suraksha-alert", data: { url: "/dashboard" }, silent: quiet };
  if (reg) reg.showNotification(title, opts);
  else new Notification(title, opts);
}

function Skeleton() {
  return (
    <main aria-busy="true">
      <div className="skeleton line" style={{ width: "60%", height: 26 }} />
      <div className="skeleton line" style={{ width: "40%" }} />
      <div className="skeleton line" style={{ width: "45%" }} />
      <div className="skeleton block" />
      <div className="skeleton block" style={{ height: 60 }} />
    </main>
  );
}

export default function Dashboard() {
  const router = useRouter();
  const { lang, t } = useT();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [data, setData] = useState<Data | null>(null);
  const [cond, setCond] = useState<Conditions | null>(null);
  const [condTried, setCondTried] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [offline, setOffline] = useState(false);
  const [serverError, setServerError] = useState(false);
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">("default");
  const [muted, setMuted] = useState(false);
  const [explainOpen, setExplainOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [aiText, setAiText] = useState<string | null>(null);
  const [aiState, setAiState] = useState<"" | "loading" | "unavailable">("");
  const lastLoad = useRef(0);

  useEffect(() => setPerm("Notification" in window ? Notification.permission : "unsupported"), []);
  useEffect(() => setMuted(loadSettings().muteAutoRead), []);
  useEffect(() => { setAiText(null); setAiState(""); setExplainOpen(false); setGuideOpen(false); }, [data?.current?.alert.id]);

  const load = useCallback(async (p: Profile) => {
    lastLoad.current = Date.now();
    const tr = makeT(p.language);
    const qs = new URLSearchParams({
      lat: String(p.lat), lng: String(p.lng), district: p.district, state: p.state, label: p.label,
      occupation: p.occupation, dwelling: p.dwelling_type, vulns: p.vulnerabilities.join(","), lang: p.language,
    });

    const alerts = (async () => {
      try {
        const r = await fetch(`/api/dashboard?${qs}`, { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const d = (await r.json()) as Data;
        const prev = await kvGet<Data>(CACHE_KEY);
        const isNew = !!(prev && d.current && d.current.alert.id !== prev.current?.alert.id);
        if (isNew) {
          // Time-of-day aware: a non-extreme heat advisory arriving at night
          // notifies silently and isn't read aloud.
          const quietNight = d.current!.deprioritised === "night_heat";
          notify(d, tr, quietNight);
          if (LOUD.includes(d.current!.alert.severity) && !quietNight && !loadSettings().muteAutoRead) speakText(d, tr, p.language);
        }
        // "Couldn't check" is never logged as "no alert".
        if (!d.feedsDown) {
          setHistory(await recordHistory({
            label: p.label,
            hazard_type: d.current?.alert.hazard_type ?? null,
            severity: d.current?.alert.severity ?? null,
            headline: d.current?.alert.headline ?? null,
            source_agency: d.current?.alert.source_agency ?? null,
            action: d.action,
          }));
        }
        setData(d);
        setOffline(false);
        setServerError(false);
        await kvSet(CACHE_KEY, d);
      } catch {
        const cached = await kvGet<Data>(CACHE_KEY);
        if (cached) setData(cached);
        else setData((cur) => cur ?? { sachetOk: false, imdOk: false, feedsDown: true, current: null, action: "", guide: null, occupationTip: null, vulnerabilityTips: [], node: null, fetchedAt: new Date(0).toISOString() });
        // navigator.onLine tells us whether the device itself has no network —
        // if it does, the failure is on the server's end, not "you're offline".
        if (navigator.onLine) setServerError(true); else setOffline(true);
      }
    })();

    const weather = (async () => {
      try {
        const r = await fetch(`/api/conditions?lat=${p.lat}&lng=${p.lng}`, { cache: "no-store" });
        const c = (await r.json()) as Conditions;
        if (!c.ok && !c.airOk) throw new Error("no conditions");
        setCond(c);
        await kvSet(CONDITIONS_KEY, c);
      } catch {
        const cached = await kvGet<Conditions>(CONDITIONS_KEY);
        if (cached) setCond(cached);
      } finally {
        setCondTried(true);
      }
    })();

    await Promise.all([alerts, weather]);
  }, []);

  useEffect(() => {
    const p = loadProfile();
    if (!p || !Number.isFinite(p.lat)) { router.replace("/onboarding"); return; }
    setProfile(p);
    readHistory().then(setHistory).catch(() => {});
    // Save the relay-verification key while online, for checking QR relays offline later.
    fetch("/api/relay-key").then((r) => r.json()).then((d) => d?.publicKey && kvSet(RELAY_PUBKEY_KEY, d.publicKey)).catch(() => {});
    load(p);

    const every = loadSettings().refreshMinutes * 60_000;
    const id = setInterval(() => load(p), every);
    // Catch up straight away when the phone comes back online or the tab is reopened.
    const onOnline = () => load(p);
    const onVisible = () => { if (document.visibilityState === "visible" && Date.now() - lastLoad.current > every) load(p); };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(id); window.removeEventListener("online", onOnline); document.removeEventListener("visibilitychange", onVisible); };
  }, [router, load]);

  async function enableNotifications() {
    setPerm(await Notification.requestPermission());
  }

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    saveSettings({ muteAutoRead: next });
  }

  if (!data || !profile) return <Skeleton />;
  const c = data.current;
  const edge = data.feedsDown ? "var(--moderate)" : c ? EDGE[c.alert.severity] : "var(--minor)";
  const loud = c ? LOUD.includes(c.alert.severity) && c.deprioritised !== "night_heat" : false;
  const explained = c ? explainTerms(`${c.alert.headline} ${c.alert.message ?? ""} ${c.sources.map((s) => s.agency).join(" ")}`) : [];
  const floor = floorTrigger(profile, c, cond, data.node);
  const risks = compoundRisks(profile, c, cond);
  const air = airAdvice(profile, c, cond);
  const disease = diseaseTriggers(c, history, cond);
  const agencies = c ? [...new Set(c.sources.map((s) => s.agency))].join(", ") : "";

  async function toggleExplain() {
    if (explainOpen) return setExplainOpen(false);
    setExplainOpen(true);
    if (!c || aiText || aiState === "loading") return;
    const cached = await getCachedExplanation(c.alert.id, lang);
    if (cached) return setAiText(cached);
    setAiState("loading");
    try {
      const res = await fetch("/api/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          headline: c.alert.headline, message: c.alert.message ?? "", hazard: c.alert.hazard_type, severity: c.alert.severity,
          agencies: c.sources.map((s) => s.agency), language: lang,
        }),
      });
      const d = await res.json().catch(() => null);
      if (res.ok && d?.text) { await cacheExplanation(c.alert.id, lang, d.text); setAiText(d.text); setAiState(""); }
      else setAiState("unavailable");
    } catch {
      setAiState("unavailable");
    }
  }

  const feedLine = (ok: boolean) => (offline ? t("noConnection") : ok ? t("connected") : t("unreachable"));

  return (
    <main>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <h1 className="place">{profile.label}</h1>
        <Link href="/onboarding" className="muted">{t("editProfile")}</Link>
      </div>
      <div className="status"><span className={`dot ${data.sachetOk && !offline ? "on" : "off"}`} />{t("sachetFeed")}: {feedLine(data.sachetOk)}</div>
      <div className="status"><span className={`dot ${data.imdOk && !offline ? "on" : "off"}`} />{t("imdFeed")}: {feedLine(data.imdOk)}</div>
      {data.node && (
        <>
          <div className="status"><span className="dot on" />{t("nodeSynced", { id: data.node.node_id, ago: timeAgo(data.node.last_seen, t) })}</div>
          {data.node.water_cm != null && (
            <div className="status"><span className={`dot ${data.node.water_state === "danger" ? "bad" : data.node.water_state === "warn" ? "off" : "on"}`} />
              {t("nodeWater", { id: data.node.node_id, cm: Math.round(data.node.water_cm), state: `water_${data.node.water_state ?? "dry"}`, km: data.node.distance_km.toFixed(1) })}
            </div>
          )}
        </>
      )}

      {offline && <p className="banner">{t("offlineBanner", { ago: timeAgo(data.fetchedAt, t) })}</p>}
      {serverError && <p className="banner">{t("serverErrorBanner")}</p>}
      {!data.feedsDown && !offline && data.sachetOk !== data.imdOk && (
        <p className="note">{t("oneFeedDown", { feed: data.sachetOk ? t("imdFeed") : t("sachetFeed") })}</p>
      )}

      {data.feedsDown ? (
        <section className="alert feeds-down" role="alert">
          <div className="alert-head">
            <span className="icon-wrap" style={{ ["--edge" as any]: "var(--moderate)" }}><HazardIcon hazard="other" /></span>
            <p className="hazard" style={{ fontSize: 24 }}>{t("feedsDownTitle")}</p>
          </div>
          <p>{t("feedsDownBody")}</p>
          <a href="tel:112" className="btn">{t("call", { n: 112 })}</a>
        </section>
      ) : c ? (
        <section className={`alert ${loud ? "pulse" : ""}`} style={{ ["--edge" as any]: edge }}>
          <SeverityBadge severity={c.alert.severity} t={t} />
          <div className="alert-head">
            <span className="icon-wrap"><HazardIcon hazard={c.alert.hazard_type} /></span>
            <p className="hazard">{t(hazardKey(c.alert.hazard_type))}</p>
          </div>
          <p style={{ margin: 0 }}>{c.alert.headline}</p>
          {c.alert.message && (
            <div className="official">
              <span className="muted small">{t("officialMessage")}</span>
              <p lang={c.alert.message_lang ?? undefined}>{c.alert.message}</p>
            </div>
          )}
          {c.alert.instruction && (
            <div className="official">
              <span className="muted small">{t("officialInstruction")}</span>
              <p>{c.alert.instruction}</p>
            </div>
          )}
          <ul className="sources">
            {c.sources.map((s, i) => <li key={i}>{t("says", { agency: s.agency, severity: t(`s_${s.severity}`) })}</li>)}
          </ul>
          {c.conflict && <p className="conflict">{t("conflict")}</p>}
          {c.deprioritised === "night_heat" && <p className="conflict">{t("nightHeatNote")}</p>}
          <p className="muted" style={{ marginTop: 10 }}>
            {t("issued", { ago: timeAgo(c.alert.timestamp, t) })}
            {c.alert.expires && <> · {t("validUntil", { time: shortTime(c.alert.expires) })}</>}
          </p>
          <div style={{ marginTop: 12 }}>
            <button type="button" className="link-btn" onClick={toggleExplain}>
              {explainOpen ? t("hideExplain") : t("explainSimply")}
            </button>
            {explainOpen && (
              <div className="glossary-list">
                {aiState === "loading" && <p className="muted skeleton line" style={{ width: "80%" }} />}
                {aiText && <p style={{ margin: "0 0 10px" }}>{aiText}</p>}
                {aiState === "unavailable" && !aiText && explained.length === 0 && (
                  <p className="muted" style={{ margin: "0 0 10px" }}>{t("explainUnavailable")}</p>
                )}
                {explained.length > 0 && (
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {explained.map(([term, def], i) => <li key={i}><b>{term}:</b> {def}</li>)}
                  </ul>
                )}
              </div>
            )}
          </div>
          {c.others.length > 0 && (
            <div className="others">
              <span className="muted small">{t("alsoInEffect")}</span>
              <ul className="list compact">
                {c.others.map((o) => (
                  <li key={o.id} className="row">
                    <SeverityBadge severity={o.severity} t={t} />
                    <HazardIcon hazard={o.hazard_type} size={18} />
                    <span className="title">{t(hazardKey(o.hazard_type))}</span>
                    <span className="muted small">{o.source_agency}{o.deprioritised === "night_heat" ? ` · ${t("nightHeatShort")}` : o.deprioritised === "upcoming" ? ` · ${t("upcomingShort")}` : ""}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <ShareRow title={alertTitle(data, t)} headline={c.alert.headline} agency={agencies} relay={data.relay ?? null} t={t} />
        </section>
      ) : (
        <section className="alert">
          <div className="alert-head">
            <span className="icon-wrap" style={{ ["--edge" as any]: "var(--minor)" }}><HazardIcon hazard="other" /></span>
            <p className="hazard" style={{ fontSize: 28 }}>{t("noAlert")}</p>
          </div>
          <p className="muted">{t("noAlertSub")}</p>
        </section>
      )}

      {data.action && (
        <section className="action" style={{ ["--edge" as any]: edge }}>
          <span className="muted">{t("whatToDo")}</span>
          <p>{data.action}</p>
        </section>
      )}

      {floor && (
        <>
          <RiskCard item={floor} t={t} />
          <p className="muted small">{t("floorNote")}</p>
        </>
      )}

      {data.occupationTip && (
        <section className="action secondary">
          <span className="muted">{t("yourOccupation")}</span>
          <p>{data.occupationTip}</p>
        </section>
      )}
      {data.vulnerabilityTips.length > 0 && (
        <section className="action secondary">
          <ul style={{ margin: 0, paddingLeft: 20 }}>{data.vulnerabilityTips.map((x, i) => <li key={i}>{x}</li>)}</ul>
        </section>
      )}

      {risks.length > 0 && (
        <>
          <h2>{t("riskTitle")}</h2>
          <div className="stagger">{risks.map((r) => <RiskCard key={r.id} item={r} t={t} />)}</div>
        </>
      )}

      {air.length > 0 && (
        <>
          <h2>{t("airTitle")}</h2>
          <div className="stagger">{air.map((r) => <RiskCard key={r.id} item={r} t={t} />)}</div>
        </>
      )}

      {disease.length > 0 && <DiseaseModule reasons={disease} t={t} />}

      {data.guide && (
        <section style={{ marginTop: 16 }}>
          <button type="button" className="link-btn" onClick={() => setGuideOpen((v) => !v)}>
            {guideOpen ? t("hideFullGuide") : t("fullPrecautions")}
          </button>
          {guideOpen && (
            <div className="guide-panel">
              <h3 className="guide-h">{t("guideBefore")}</h3>
              <ul>{data.guide.before.map((x, i) => <li key={i}>{x}</li>)}</ul>
              <h3 className="guide-h">{t("guideAfter")}</h3>
              <ul>{data.guide.after.map((x, i) => <li key={i}>{x}</li>)}</ul>
            </div>
          )}
        </section>
      )}

      <div className="row" style={{ marginTop: 20 }}>
        <Link href="/help" className="btn">{t("findNearestHospital")}</Link>
        <a href="tel:112" className="btn ghost">{t("call", { n: 112 })}</a>
        <button className="btn ghost" onClick={() => speakText(data, t, lang, floor ? [t(floor.body)] : [])}>{t("readAloud")}</button>
      </div>
      <div style={{ marginTop: 10 }}>
        <button type="button" className="link-btn" onClick={toggleMute}>{muted ? t("unmuteAutoRead") : t("muteAutoRead")}</button>
      </div>

      {perm !== "unsupported" && (
        <div style={{ marginTop: 12 }}>
          {perm === "default" && <button className="btn ghost block" onClick={enableNotifications}>{t("notifyOn")}</button>}
          {perm === "granted" && <p className="note">{t("notifyEnabled")}</p>}
          {perm === "denied" && <p className="note">{t("notifyBlocked")}</p>}
        </div>
      )}

      <h2>{t("condTitle")}</h2>
      {cond || condTried ? <ConditionsPanel c={cond} t={t} /> : <div className="skeleton block" aria-busy="true" />}

      {cond?.daily?.length ? (
        <>
          <h2>{t("forecastTitle")}</h2>
          <ForecastCharts days={cond.daily} t={t} lang={lang} />
        </>
      ) : null}
    </main>
  );
}
