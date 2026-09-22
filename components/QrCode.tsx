"use client";
import { useEffect, useState } from "react";
import QRCode from "qrcode";

// Renders text as a QR code SVG, generated on the phone (no network).
// Dark modules on a white quiet zone — the contrast phone cameras need.
export default function QrCode({ text, label }: { text: string; label: string }) {
  const [svg, setSvg] = useState<string>("");
  useEffect(() => {
    QRCode.toString(text, { type: "svg", errorCorrectionLevel: "M", margin: 3, color: { dark: "#000000", light: "#ffffff" } })
      .then(setSvg)
      .catch(() => setSvg(""));
  }, [text]);
  if (!svg) return null;
  // The SVG string comes from the qrcode library, built only from our own text.
  return <div className="qr" role="img" aria-label={label} dangerouslySetInnerHTML={{ __html: svg }} />;
}
