"use client";

/**
 * Destiny-style top bar: split-emblem avatar, title/subtitle, and nav tabs with
 * an active underline — echoes the in-game Character/Inventory header.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Home" },
  { href: "/editor", label: "Editor" },
  { href: "/poc", label: "POC" },
];

export default function AppHeader({
  title = "Guardian",
  subtitle,
}: {
  title?: string;
  subtitle?: string;
}) {
  const path = usePathname();
  return (
    <header className="d2-topbar">
      <div className="d2-avatar" aria-hidden />
      <div style={{ lineHeight: 1.1 }}>
        <div
          style={{
            fontFamily: "var(--font-condensed)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            fontSize: 18,
          }}
        >
          {title}
        </div>
        {subtitle && (
          <div className="d2-eyebrow" style={{ fontSize: 10 }}>
            {subtitle}
          </div>
        )}
      </div>
      <nav className="d2-tabs">
        {TABS.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className="d2-tab"
            data-active={path === t.href}
          >
            {t.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
