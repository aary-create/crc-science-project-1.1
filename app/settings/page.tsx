"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { type Key } from "@/lib/i18n";
import { useT } from "@/lib/useT";
import { REFRESH_CHOICES, loadProfile, loadSettings, saveSettings, type Settings } from "@/lib/options";
import { kvClearAll } from "@/lib/store";
import type { Severity } from "@/lib/types";

type Channel = "sms" | "whatsapp" | "email";
type SubState = { token: string; channel: Channel; address: string; status: "pending" | "active" } | null;
const SUB_KEY = "ss:subscription";
const SEVERITIES: Severity[] = ["Extreme", "Severe", "Moderate", "Minor"];

function loadSub(): SubState {
  try { return JSON.parse(localStorage.getItem(SUB_KEY) ?? "null"); } catch { return null; }
}
function saveSub(s: SubState) {
  try { s ? localStorage.setItem(SUB_KEY, JSON.stringify(s)) : localStorage.removeItem(SUB_KEY); } catch { /* ignore */ }
}

export default function SettingsPage() {
  const { t } = useT();
  const [s, setS] = useState<Settings | null>(null);
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">("default");
  const [avail, setAvail] = useState<{ channels: Channel[]; dbReady: boolean } | null>(null);
  const [sub, setSub] = useState<SubState>(null);
  const [channel, setChannel] = useState<Channel>("sms");
  const [address, setAddress] = useState("");
  const [minSev, setMinSev] = useState<Severity>("Severe");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>("");
  const [clearArmed, setClearArmed] = useState(false);
  const [cleared, setCleared] = useState(false);

  useEffect(() => {
    setS(loadSettings());
    setPerm("Notification" in window ? Notification.permission : "unsupported");
    const saved = loadSub();
    setSub(saved);
    fetch("/api/subscribe").then((r) => r.json()).then((d) => {
      setAvail({ channels: d.channels ?? [], dbReady: !!d.dbReady });
      if (d.channels?.length) setChannel(d.channels[0]);
    }).catch(() => setAvail({ channels: [], dbReady: false }));
    if (saved?.token) {
      fetch(`/api/subscribe?token=${encodeURIComponent(saved.token)}`).then((r) => r.json()).then((d) => {
        if (d.status === "missing") { saveSub(null); setSub(null); }
        else if (d.status !== saved.status) { const next = { ...saved, status: d.status }; saveSub(next); setSub(next); }
      }).catch(() => {});
    }
  }, []);

  function update(patch: Partial<Settings>) {
    setS(saveSettings(patch));
  }

  async function startSub(e: React.FormEvent) {
    e.preventDefault();
    const p = loadProfile();
    if (!p) return;
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/api/subscribe", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", channel, address, min_severity: minSev, ...p }),
      });
      const d = await r.json();
      if (!r.ok) { setMsg(d.error ?? t("subError")); return; }
      const next: SubState = { token: d.token, channel, address, status: "pending" };
      saveSub(next); setSub(next);
    } catch { setMsg(t("subError")); } finally { setBusy(false); }
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    if (!sub) return;
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/api/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "confirm", token: sub.token, code }) });
      const d = await r.json();
      if (d.result === "ok") { const next = { ...sub, status: "active" as const }; saveSub(next); setSub(next); }
      else if (d.result === "locked" || d.result === "missing") { setMsg(t("codeLocked")); saveSub(null); setSub(null); }
      else setMsg(t("codeWrong"));
    } catch { setMsg(t("subError")); } finally { setBusy(false); }
  }

  async function stop() {
    if (!sub) return;
    setBusy(true);
    await fetch("/api/subscribe", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: sub.token }) }).catch(() => {});
    saveSub(null); setSub(null); setBusy(false);
  }

  async function clearAll() {
    if (!clearArmed) return setClearArmed(true);
    await kvClearAll();
    try { localStorage.clear(); } catch { /* ignore */ }
    setClearArmed(false); setCleared(true); setSub(null); setS(loadSettings());
  }

  if (!s) return <main />;
  return (
    <main>
      <h1>{t("settingsTitle")}</h1>
      <p><Link href="/onboarding" className="link-btn">{t("editProfileLong")}</Link></p>

      <label className="field" htmlFor="refresh">{t("refreshLabel")}</label>
      <select id="refresh" value={s.refreshMinutes} onChange={(e) => update({ refreshMinutes: Number(e.target.value) })}>
        {REFRESH_CHOICES.map((n) => <option key={n} value={n}>{t("minutes", { n })}</option>)}
      </select>
      <p className="muted small">{t("refreshNote")}</p>

      <fieldset className="plain">
        <legend className="field">{t("themeLabel")}</legend>
        <div className="choices two">
          {(["standard", "command"] as const).map((th) => (
            <label key={th} className="choice">
              <input type="radio" name="theme" checked={s.theme === th} onChange={() => update({ theme: th })} />
              {t(th === "standard" ? "themeStandard" : "themeCommand")}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="choice" style={{ marginTop: 16 }}>
        <input type="checkbox" checked={!s.muteAutoRead} onChange={(e) => update({ muteAutoRead: !e.target.checked })} />
        {t("autoReadLabel")}
      </label>

      <h2>{t("notificationsLabel")}</h2>
      {perm === "default" && <button className="btn ghost block" onClick={async () => setPerm(await Notification.requestPermission())}>{t("notifyOn")}</button>}
      {perm === "granted" && <p className="note">{t("notifyEnabled")}</p>}
      {perm === "denied" && <p className="note">{t("notifyBlocked")}</p>}

      <h2>{t("outboundTitle")}</h2>
      {!avail ? (
        <p className="muted">{t("loading")}</p>
      ) : sub?.status === "active" ? (
        <div>
          <p className="note">{t("subActive", { address: sub.address })}</p>
          <button className="btn ghost" disabled={busy} onClick={stop}>{t("unsubscribe")}</button>
        </div>
      ) : sub?.status === "pending" ? (
        <form onSubmit={confirm}>
          <p className="note">{t("subPending", { address: sub.address })}</p>
          <label className="field" htmlFor="code">{t("enterCode")}</label>
          <input id="code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" disabled={busy || code.length !== 6}>{t("confirmCode")}</button>
            <button type="button" className="btn ghost" disabled={busy} onClick={stop}>{t("unsubscribe")}</button>
          </div>
        </form>
      ) : avail.channels.length === 0 ? (
        <p className="muted">{t("outboundOff")}</p>
      ) : !avail.dbReady ? (
        <p className="muted">{t("outboundNeedsDb")}</p>
      ) : (
        <form onSubmit={startSub}>
          <div className="choices two">
            {avail.channels.map((ch) => (
              <label key={ch} className="choice">
                <input type="radio" name="channel" checked={channel === ch} onChange={() => setChannel(ch)} />
                {t(`channel_${ch}` as Key)}
              </label>
            ))}
          </div>
          <label className="field" htmlFor="addr">{channel === "email" ? t("addressEmail") : t("addressPhone")}</label>
          <input id="addr" type={channel === "email" ? "email" : "tel"} value={address} onChange={(e) => setAddress(e.target.value)}
            placeholder={channel === "email" ? "name@example.com" : "+91 98xxxxxxxx"} autoComplete={channel === "email" ? "email" : "tel"} required />
          <label className="field" htmlFor="minsev">{t("minSeverityLabel")}</label>
          <select id="minsev" value={minSev} onChange={(e) => setMinSev(e.target.value as Severity)}>
            {SEVERITIES.map((sv) => <option key={sv} value={sv}>{t(`s_${sv}` as Key)}</option>)}
          </select>
          <button className="btn block" style={{ marginTop: 16 }} disabled={busy || !address}>{t("sendCode")}</button>
        </form>
      )}
      {msg && <p className="banner" role="alert">{msg}</p>}

      <h2>{t("dataTitle")}</h2>
      <button className="btn ghost block" onClick={clearAll}>{clearArmed ? t("clearConfirm") : t("clearData")}</button>
      {cleared && <p className="note">{t("cleared")}</p>}

      <p className="muted small" style={{ marginTop: 24 }}>{t("aboutData")}</p>
    </main>
  );
}
