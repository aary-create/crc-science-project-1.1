"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type Key } from "@/lib/i18n";
import { useT } from "@/lib/useT";

const TABS: { href: string; label: Key }[] = [
  { href: "/dashboard", label: "nav_alert" },
  { href: "/help", label: "nav_help" },
  { href: "/offline", label: "nav_offline" },
  { href: "/settings", label: "nav_settings" },
];

export default function Nav() {
  const path = usePathname();
  const { t } = useT();
  if (path === "/onboarding" || path === "/") return null;
  return (
    <nav className="tabs" style={{ gridTemplateColumns: `repeat(${TABS.length}, 1fr)` }}>
      {TABS.map((tab) => (
        <Link key={tab.href} href={tab.href} aria-current={path === tab.href || (tab.href === "/offline" && path === "/relay") ? "page" : undefined}>
          {t(tab.label)}
        </Link>
      ))}
    </nav>
  );
}
