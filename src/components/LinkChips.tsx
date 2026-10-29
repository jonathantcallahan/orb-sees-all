import type { ReactNode } from "react";
import type { LinkKind, TaskLink } from "../links";
import { ExternalLink } from "./common";

/** Small product marks, drawn on a 16×16 grid in each product's colors. */
const ICONS: Record<LinkKind, ReactNode> = {
  docs: (
    <>
      <path d="M3.5 1h6l3 3v10.5a.5.5 0 0 1-.5.5H3.5a.5.5 0 0 1-.5-.5v-13a.5.5 0 0 1 .5-.5Z" fill="#4285F4" />
      <path d="M9.5 1v3h3Z" fill="#A1C2FA" />
      <path d="M5 7.5h6M5 9.5h6M5 11.5h4" stroke="#fff" strokeWidth="1" />
    </>
  ),
  sheets: (
    <>
      <path d="M3.5 1h6l3 3v10.5a.5.5 0 0 1-.5.5H3.5a.5.5 0 0 1-.5-.5v-13a.5.5 0 0 1 .5-.5Z" fill="#0F9D58" />
      <path d="M9.5 1v3h3Z" fill="#87CEAC" />
      <path d="M5 7h6v5H5ZM5 9.5h6M8 7v5" stroke="#fff" strokeWidth="1" fill="none" />
    </>
  ),
  slides: (
    <>
      <path d="M3.5 1h6l3 3v10.5a.5.5 0 0 1-.5.5H3.5a.5.5 0 0 1-.5-.5v-13a.5.5 0 0 1 .5-.5Z" fill="#F4B400" />
      <path d="M9.5 1v3h3Z" fill="#FADA80" />
      <rect x="5" y="7.5" width="6" height="4" rx=".5" stroke="#fff" strokeWidth="1" fill="none" />
    </>
  ),
  drive: (
    <>
      <path d="M5.6 2h4.8l4.6 8h-4.8Z" fill="#FFBA00" />
      <path d="M5.6 2 1 10l2.4 4.2L8 6.2Z" fill="#0F9D58" />
      <path d="M3.4 14.2h9.2L15 10H5.8Z" fill="#4285F4" />
    </>
  ),
  gmail: (
    <>
      <rect x="1" y="3" width="14" height="10" rx="1.5" fill="#fff" />
      <path d="M1.5 4.5v8a.5.5 0 0 0 .5.5h2V7.5L8 10.5l4-3V13h2a.5.5 0 0 0 .5-.5v-8L8 9.2Z" fill="#EA4335" />
    </>
  ),
  calendar: (
    <>
      <rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="#fff" stroke="#4285F4" strokeWidth="1.2" />
      <path d="M1.5 5h13" stroke="#4285F4" strokeWidth="1.6" />
      <text x="8" y="12.6" textAnchor="middle" fontSize="7" fill="#4285F4" fontFamily="system-ui, sans-serif">31</text>
    </>
  ),
  slack: (
    <>
      <rect x="6" y="1" width="2.4" height="6" rx="1.2" fill="#36C5F0" />
      <rect x="9" y="6" width="6" height="2.4" rx="1.2" fill="#2EB67D" />
      <rect x="7.6" y="9" width="2.4" height="6" rx="1.2" fill="#ECB22E" />
      <rect x="1" y="7.6" width="6" height="2.4" rx="1.2" fill="#E01E5A" />
    </>
  ),
  jira: (
    <>
      <path d="M8 1.5 14.5 8 8 14.5 1.5 8Z" fill="#2684FF" />
      <path d="M8 5.2 10.8 8 8 10.8 5.2 8Z" fill="#fff" />
    </>
  ),
  confluence: (
    <>
      <path d="M2 11.5c2.5-4 6-4.5 12-1.5l-1.6 3c-4-2-6.5-2-8.6 1Z" fill="#2684FF" />
      <path d="M14 4.5c-2.5 4-6 4.5-12 1.5l1.6-3c4 2 6.5 2 8.6-1Z" fill="#0052CC" />
    </>
  ),
  github: (
    <path
      d="M8 1a7 7 0 0 0-2.2 13.6c.35.07.48-.15.48-.34v-1.2c-1.95.42-2.36-.94-2.36-.94-.32-.81-.78-1.03-.78-1.03-.64-.44.05-.43.05-.43.7.05 1.07.72 1.07.72.63 1.07 1.64.76 2.04.58.06-.45.24-.76.44-.94-1.55-.18-3.19-.78-3.19-3.46 0-.76.27-1.39.72-1.88-.07-.18-.31-.89.07-1.85 0 0 .59-.19 1.92.72a6.6 6.6 0 0 1 3.5 0c1.33-.91 1.92-.72 1.92-.72.38.96.14 1.67.07 1.85.45.49.72 1.12.72 1.88 0 2.69-1.64 3.28-3.2 3.45.25.22.48.65.48 1.3v1.93c0 .19.13.41.48.34A7 7 0 0 0 8 1Z"
      fill="currentColor"
    />
  ),
  figma: (
    <>
      <rect x="4.5" y="1" width="3.5" height="4.7" rx="1.75" fill="#F24E1E" />
      <rect x="8" y="1" width="3.5" height="4.7" rx="1.75" fill="#FF7262" />
      <rect x="4.5" y="5.7" width="3.5" height="4.7" rx="1.75" fill="#A259FF" />
      <circle cx="9.75" cy="8.05" r="1.75" fill="#1ABCFE" />
      <rect x="4.5" y="10.3" width="3.5" height="4.7" rx="1.75" fill="#0ACF83" />
    </>
  ),
  web: (
    <>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2 8h12M8 2c-2 2-2 10 0 12M8 2c2 2 2 10 0 12" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </>
  ),
};

/** Links as Google Docs–style smart chips: the product's icon, then the title. */
export function LinkChips({ links }: { links: TaskLink[] }) {
  if (links.length === 0) return null;
  return (
    <div className="link-chips">
      {links.map((l) => (
        <ExternalLink key={l.url} href={l.url} className={`link-chip ${l.kind}`} title={l.url}>
          <svg className="link-chip-icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden>
            {ICONS[l.kind]}
          </svg>
          <span className="link-chip-title">{l.title}</span>
        </ExternalLink>
      ))}
    </div>
  );
}
