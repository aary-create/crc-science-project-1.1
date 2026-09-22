import type { Metadata, Viewport } from "next";
import Nav from "@/components/Nav";
import RegisterSW from "@/components/RegisterSW";
import "./globals.css";

export const metadata: Metadata = {
  title: "Suraksha Setu",
  description: "Disaster alerts turned into instructions for your home, work and family.",
  manifest: "/manifest.json",
};
export const viewport: Viewport = { themeColor: "#0a1220", width: "device-width", initialScale: 1 };

// Applies the saved look (Standard / Command view) before first paint, so
// the page never flashes the wrong theme.
const THEME_SCRIPT = `try{var s=JSON.parse(localStorage.getItem("ss:settings")||"{}");if(s.theme)document.documentElement.dataset.theme=s.theme}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Atkinson+Hyperlegible:wght@400;700&family=JetBrains+Mono:wght@500;700&family=Noto+Sans+Devanagari:wght@400;700&family=Noto+Sans+Gujarati:wght@400;700&family=Noto+Sans+Tamil:wght@400;700&family=Noto+Sans+Bengali:wght@400;700&display=swap" rel="stylesheet" />
      </head>
      <body>
        {children}
        <Nav />
        <RegisterSW />
      </body>
    </html>
  );
}
