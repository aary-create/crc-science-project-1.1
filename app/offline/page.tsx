"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import HazardIcon from "@/components/HazardIcon";
import PersonalStats from "@/components/PersonalStats";
import SeverityBadge from "@/components/SeverityBadge";
import SeverityTimeline from "@/components/SeverityTimeline";
import { readHistory, type HistoryEntry } from "@/lib/history";
import { timeAgo, type Key } from "@/lib/i18n";
import { useT } from "@/lib/useT";
import { CACHE_KEY, RELAYS_KEY } from "@/lib/options";
import type { SavedRelay } from "@/lib/relay";
import { kvGet } from "@/lib/store";

export default function Offline() {
  const { t } = useT();
  const [cached, setCached] = useState<any>(undefined);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [relays, setRelays] = useState<SavedRelay[]>([]);

  useEffect(() => {
    kvGet(CACHE_KEY).then((c) => setCached(c ?? null)).catch(() => setCached(null));
    readHistory().then(setHistory).catch(() => {});
    kvGet<SavedRelay[]>(RELAYS_KEY).then((r) => setRelays((r ?? []).filter((x) => Date.now() - new Date(x.received).getTime() < 5 * 24 * 3600_000))).catch(() => {});
  }, []);

  if (cached === undefined) return <main />;
  return (
    <main>
      <h1>{t("offlineTitle")}</h1>
      <p className="banner">{t("offlineNote")}</p>
      {!cached ? (
        <p className="muted">{t("nothingSaved")}</p>
      ) : (
        <>
          <p className="muted">{t("lastSynced", { time: new Date(cached.fetchedAt).toLocaleString() })}</p>
          {cached.feedsDown && <p className="note">{t("feedsDownTitle")}</p>}
          {cached.current && (
            <section className="alert">
              <SeverityBadge severity={cached.current.alert.severity} t={t} />
              <div className="alert-head">
                <span className="icon-wrap"><HazardIcon hazard={cached.current.alert.hazard_type} /></span>
                <p className="hazard">{t(`h_${cached.current.alert.hazard_type}` as Key)}</p>
              </div>
              <p style={{ margin: 0 }}>{cached.current.alert.headline}</p>
              {cached.current.alert.message && <p lang={cached.current.alert.message_lang ?? undefined}>{cached.current.alert.message}</p>}
              <p className="muted">{t("from", { agency: cached.current.alert.source_agency })}</p>
            </section>
          )}
          {cached.action && (
            <section className="action">
              <span className="muted">{t("whatToDo")}</span>
              <p>{cached.action}</p>
            </section>
          )}
          {cached.occupationTip && (
            <section className="action secondary"><p>{cached.occupationTip}</p></section>
          )}
          {cached.vulnerabilityTips?.length > 0 && (
            <section className="action secondary"><ul style={{ margin: 0, paddingLeft: 20 }}>{cached.vulnerabilityTips.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul></section>
          )}
        </>
      )}

      <h2>{t("relaysTitle")}</h2>
      <Link href="/relay" className="btn ghost block">{t("relayScanCta")}</Link>
      {relays.length > 0 && (
        <ul className="list" style={{ marginTop: 12 }}>
          {relays.map((r, i) => (
            <li key={i}>
              <div className="row">
                <SeverityBadge severity={r.payload.s} t={t} />
                <HazardIcon hazard={r.payload.h} size={18} />
                <span className="title">{t(`h_${r.payload.h}` as Key)}</span>
              </div>
              <div style={{ marginTop: 6 }}>{r.payload.t}</div>
              <div className="muted">
                {r.payload.a}, {t("relayAt", { ago: timeAgo(r.received, t) })} · {r.verdict === "verified" ? `✔ ${t("qrSigned")}` : t("relayReceivedFrom")}
              </div>
            </li>
          ))}
        </ul>
      )}

      <h2>{t("historyTitle")}</h2>
      <p className="muted">{t("historyNote")}</p>
      {history.length > 0 && <SeverityTimeline history={history} t={t} />}
      {history.length === 0 ? (
        <p className="muted">{t("noHistory")}</p>
      ) : (
        <ul className="list stagger">
          {history.map((h, i) => (
            <li key={i}>
              {h.hazard_type ? (
                <>
                  <div className="row">
                    <SeverityBadge severity={h.severity!} t={t} />
                    <HazardIcon hazard={h.hazard_type} size={18} />
                    <span className="title">{t(`h_${h.hazard_type}` as Key)}</span>
                  </div>
                  <div style={{ marginTop: 6 }}>{h.headline}</div>
                  <div className="muted">{h.source_agency}, {timeAgo(h.timestamp, t)}</div>
                </>
              ) : (
                <>
                  <div className="title">{t("noAlert")}</div>
                  <div className="muted">{h.label}, {timeAgo(h.timestamp, t)}</div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {history.some((h) => h.hazard_type) && (
        <>
          <h2>{t("statsTitle")}</h2>
          <PersonalStats history={history} t={t} />
        </>
      )}

      <p className="muted" style={{ marginTop: 20 }}>{t("nodeHint")}</p>
    </main>
  );
}
