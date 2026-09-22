"use client";
import { useEffect, useState } from "react";
import QrCode from "@/components/QrCode";
import type { T } from "@/lib/i18n";
import { encodeRelay, type RelayPayload } from "@/lib/relay";

// Pass an alert on: WhatsApp / SMS / email links (free, the person sends
// them from their own phone), the system share sheet (which on Android also
// offers Bluetooth and Nearby Share), and an offline QR relay.
export default function ShareRow({ title, headline, agency, relay, t }: { title: string; headline: string; agency: string; relay: RelayPayload | null; t: T }) {
  const [qr, setQr] = useState(false);
  const [url, setUrl] = useState("");
  const [canShare, setCanShare] = useState(false);
  useEffect(() => {
    setUrl(`${window.location.origin}/dashboard`);
    setCanShare("share" in navigator);
  }, []);
  const text = t("shareText", { title, headline, agency, url });
  const enc = encodeURIComponent(text);

  return (
    <section className="share">
      <span className="muted">{t("shareTitle")}</span>
      <div className="row" style={{ marginTop: 8 }}>
        <a className="btn ghost small-btn" href={`https://wa.me/?text=${enc}`} target="_blank" rel="noreferrer">{t("shareWhatsApp")}</a>
        <a className="btn ghost small-btn" href={`sms:?&body=${enc}`}>{t("shareSms")}</a>
        <a className="btn ghost small-btn" href={`mailto:?subject=${encodeURIComponent(title)}&body=${enc}`}>{t("shareEmail")}</a>
        {canShare && (
          <button type="button" className="btn ghost small-btn" onClick={() => navigator.share({ title, text }).catch(() => {})}>{t("shareMore")}</button>
        )}
        {relay && <button type="button" className="btn ghost small-btn" onClick={() => setQr((v) => !v)}>{qr ? t("hideQr") : t("shareQr")}</button>}
      </div>
      {qr && relay && (
        <div className="qr-wrap">
          <QrCode text={encodeRelay(relay)} label={title} />
          <p className="muted small">{relay.sig ? `✔ ${t("qrSigned")}` : t("qrUnsigned")}</p>
          <p className="muted small">{t("qrNote")}</p>
        </div>
      )}
    </section>
  );
}
