"use client";
import { useEffect, useState } from "react";
import { makeT, type Lang } from "./i18n";
import { loadProfile } from "./options";

// The active language comes from the saved profile. Kept apart from
// lib/i18n.ts so server routes can use the translations without React.
export function useT() {
  const [lang, setLang] = useState<Lang>("en");
  useEffect(() => {
    const l = (loadProfile()?.language ?? "en") as Lang;
    setLang(l);
    document.documentElement.lang = l;
  }, []);
  return { lang, t: makeT(lang) };
}
