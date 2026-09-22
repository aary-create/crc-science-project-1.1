"use client";
import { useEffect, useRef, useState } from "react";
import HazardIcon from "@/components/HazardIcon";
import SeverityBadge from "@/components/SeverityBadge";
import { actionFor } from "@/lib/actions";
import { timeAgo, shortTime, type Key } from "@/lib/i18n";
import { useT } from "@/lib/useT";
import { RELAYS_KEY, RELAY_PUBKEY_KEY, loadProfile } from "@/lib/options";
import { decodeRelay, verifyRelay, type SavedRelay, type Verdict } from "@/lib/relay";
import { kvGet, kvSet } from "@/lib/store";

const RETAIN_MS = 5 * 24 * 60 * 60 * 1000;

// Receives an alert relayed phone-to-phone as a QR code — no network needed.
// Decoding happens on this phone (BarcodeDetector where the browser has it,
// otherwise the bundled jsQR decoder), and the signature is checked with the
// key this phone saved on its last online visit.
export default function RelayPage() {
  const { t, lang } = useT();
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [scanning, setScanning] = useState(false);
  const [camError, setCamError] = useState(false);
  const [paste, setPaste] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [result, setResult] = useState<SavedRelay | null>(null);

  function stopCamera() {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((tr) => tr.stop());
    stream.current = null;
    setScanning(false);
  }
  useEffect(() => stopCamera, []);

  async function handle(text: string) {
    const p = decodeRelay(text);
    if (!p) { setInvalid(true); return; }
    setInvalid(false);
    stopCamera();
    const verdict = await verifyRelay(p, await kvGet<string>(RELAY_PUBKEY_KEY));
    const saved: SavedRelay = { payload: p, verdict, received: new Date().toISOString() };
    setResult(saved);
    if (verdict === "bad") return; // never keep a tampered alert
    const list = ((await kvGet<SavedRelay[]>(RELAYS_KEY)) ?? []).filter((r) => Date.now() - new Date(r.received).getTime() < RETAIN_MS && !(r.payload.i === p.i && r.payload.sa === p.sa));
    await kvSet(RELAYS_KEY, [saved, ...list].slice(0, 20));
  }

  async function startCamera() {
    setCamError(false);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      stream.current = s;
      setScanning(true);
      const v = video.current!;
      v.srcObject = s;
      await v.play();
      const Detector = (window as any).BarcodeDetector;
      const detector = Detector ? new Detector({ formats: ["qr_code"] }) : null;
      const jsQR = detector ? null : (await import("jsqr")).default;
      timer.current = setInterval(async () => {
        if (!v.videoWidth) return;
        try {
          if (detector) {
            const codes = await detector.detect(v);
            if (codes[0]?.rawValue) handle(codes[0].rawValue);
          } else if (jsQR && canvas.current) {
            const c = canvas.current;
            c.width = v.videoWidth; c.height = v.videoHeight;
            const ctx = c.getContext("2d", { willReadFrequently: true })!;
            ctx.drawImage(v, 0, 0);
            const img = ctx.getImageData(0, 0, c.width, c.height);
            const code = jsQR(img.data, img.width, img.height);
            if (code?.data) handle(code.data);
          }
        } catch { /* keep scanning */ }
      }, 300);
    } catch {
      stopCamera();
      setCamError(true);
    }
  }

  const profile = typeof window !== "undefined" ? loadProfile() : null;
  const p = result?.payload;
  const steps = p ? actionFor({ dwelling_type: profile?.dwelling_type ?? "*", occupation: profile?.occupation ?? "general_resident", vulnerabilities: profile?.vulnerabilities ?? [], language: lang }, p.h) : null;
  const expired = p && p.x > 0 && p.x * 1000 < Date.now();
  const verdictKey: Record<Verdict, Key> = { verified: "relayVerified", bad: "relayBad", unsigned: "relayUnsigned", nokey: "relayNoKey" };

  return (
    <main>
      <h1>{t("relayTitle")}</h1>
      <p className="muted">{t("relayIntro")}</p>

      {!result && (
        <>
          <div className="scan-box" hidden={!scanning}>
            <video ref={video} playsInline muted />
            <span className="scan-frame" aria-hidden="true" />
          </div>
          <canvas ref={canvas} hidden />
          <div className="row" style={{ marginTop: 12 }}>
            {scanning
              ? <button className="btn ghost" onClick={stopCamera}>{t("relayStop")}</button>
              : <button className="btn" onClick={startCamera}>{t("relayStart")}</button>}
          </div>
          {camError && <p className="banner">{t("relayNoCamera")}</p>}
          <label className="field" htmlFor="paste">{t("relayPasteLabel")}</label>
          <textarea id="paste" value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="SSR1:{…}" />
          <button className="btn ghost" style={{ marginTop: 8 }} disabled={!paste.trim()} onClick={() => handle(paste)}>{t("relayCheck")}</button>
          {invalid && <p className="banner" role="alert">{t("relayInvalid")}</p>}
        </>
      )}

      {result && p && (
        <>
          <p className={`verdict verdict-${result.verdict}`} role="status">{t(verdictKey[result.verdict])}</p>
          {result.verdict !== "bad" && (
            <>
              <section className="alert" style={{ ["--edge" as any]: `var(--${p.s.toLowerCase()})` }}>
                <SeverityBadge severity={p.s} t={t} />
                <div className="alert-head">
                  <span className="icon-wrap"><HazardIcon hazard={p.h} /></span>
                  <p className="hazard">{t(`h_${p.h}` as Key)}</p>
                </div>
                <p style={{ margin: 0 }}>{p.t}</p>
                {p.ar && <p className="muted">{p.ar}</p>}
                <p className="muted">{p.a} · {t("relayIssued", { time: shortTime(new Date(p.ts * 1000).toISOString()) })}</p>
                <p className="muted small">{t("relayReceivedFrom")}</p>
                {expired && <p className="conflict">{t("relayExpired", { ago: timeAgo(new Date(p.x * 1000).toISOString(), t) })}</p>}
              </section>
              {steps && (
                <section className="action" style={{ ["--edge" as any]: `var(--${p.s.toLowerCase()})` }}>
                  <span className="muted">{t("relayYourSteps")}</span>
                  <p>{steps.action}</p>
                  {steps.occupationTip && <p style={{ fontSize: 17, fontWeight: 400 }}>{steps.occupationTip}</p>}
                  {steps.vulnerabilityTips.length > 0 && <ul>{steps.vulnerabilityTips.map((x, i) => <li key={i}>{x}</li>)}</ul>}
                </section>
              )}
              <p className="note">{t("relaySaved")}</p>
            </>
          )}
          <button className="btn ghost" style={{ marginTop: 12 }} onClick={() => { setResult(null); setPaste(""); }}>{t("relayScanCta")}</button>
        </>
      )}
    </main>
  );
}
