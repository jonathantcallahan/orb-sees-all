import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Project } from "../db";
import { initials, nameHue } from "../faces";
import { importanceOf, personName, roleParts } from "../projects";
import type { ProfilePerson, Raci } from "../schema";
import { HoverTip } from "./common";

/** Someone's face on the project: theirs as the project knows them, else from the people record. */
export function faceFinder(project: Pick<Project, "profile" | "avatars">): (name: string) => string | null {
  const own = new Map((project.profile?.people ?? []).filter((p) => p.avatar).map((p) => [personName(p.name), p.avatar!]));
  return (name) => own.get(personName(name)) ?? project.avatars?.[personName(name)] ?? null;
}

/**
 * A person's face: their avatar (from Jira), or their initials on a color of their own when there's
 * none or it doesn't load.
 */
export function Avatar({ name, src, size = 20, className = "" }: { name: string; src: string | null; size?: number | "fill"; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  // "fill": as big as what holds it (a face in the cloud, which scales with the column).
  const style = size === "fill" ? {} : { width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.4)) };
  if (src && failed !== src)
    return <img className={`avatar ${className}`} src={src} alt="" style={style} loading="lazy" referrerPolicy="no-referrer" draggable={false} onError={() => setFailed(src)} />;
  return (
    <span className={`avatar avatar-initials ${className}`} style={{ ...style, ["--hue" as string]: nameHue(name) }} aria-hidden>
      {initials(name)}
    </span>
  );
}

/** A card under (or over) something, while it's hovered or focused: the webview shows no native tooltips. */
function useHoverCard(width: number) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const show = (el: HTMLElement) => setAnchor(el.getBoundingClientRect());
  const hide = () => setAnchor(null);
  const card = (body: ReactNode) =>
    anchor &&
    createPortal(
      <div
        className="card meeting-card person-card"
        role="tooltip"
        style={{
          left: Math.max(8, Math.min(anchor.left + anchor.width / 2 - width / 2, window.innerWidth - width - 8)),
          width,
          // Over it when there's no room under it.
          ...(anchor.bottom + 140 > window.innerHeight ? { bottom: window.innerHeight - anchor.top + 6 } : { top: anchor.bottom + 6 }),
        }}
      >
        {body}
      </div>,
      document.body,
    );
  return { show, hide, card };
}

/**
 * The faces of the people on a piece of work, overlapping, in three places at most: three faces, or two
 * and a count of the rest, so the stack is never wider than three faces. Their names show on hover.
 */
export function FaceStack({ names, faceOf, size = 20 }: { names: string[]; faceOf: (name: string) => string | null; size?: number }) {
  const { show, hide, card } = useHoverCard(200);
  if (!names.length) return <span className="face-stack none" aria-label="Unassigned" />;
  const shown = names.length > 3 ? names.slice(0, 2) : names;
  const more = names.length - shown.length;
  return (
    <span
      className="face-stack"
      role="img"
      tabIndex={0}
      aria-label={names.join(", ")}
      onMouseEnter={(e) => show(e.currentTarget)}
      onMouseLeave={hide}
      onFocus={(e) => show(e.currentTarget)}
      onBlur={hide}
    >
      {shown.map((n) => (
        <Avatar key={n} name={n} src={faceOf(n)} size={size} />
      ))}
      {more > 0 && (
        <span className="avatar avatar-more" style={{ width: size, height: size }}>
          +{more}
        </span>
      )}
      {card(
        <ul className="face-stack-names small">
          {names.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>,
      )}
    </span>
  );
}

/** The RACI rows, in order, and what each means. */
const RACI_ROWS: { key: Raci; label: string; tip: string }[] = [
  { key: "accountable", label: "Accountable", tip: "Owns the outcome and makes the calls" },
  { key: "responsible", label: "Responsible", tip: "Does the work" },
  { key: "consulted", label: "Consulted", tip: "Asked for input before it's settled" },
  { key: "informed", label: "Informed", tip: "Kept up to date" },
];

/**
 * Someone on the project as a badge: their face and name. Hovering or focusing it shows how they're
 * involved: their title under their name, then anything more about their part and what they're
 * working on.
 */
export function PersonBadge({ person, face }: { person: ProfilePerson; face: string | null }) {
  const { show, hide, card } = useHoverCard(240);
  // Under their name only their title; anything else said about their part goes in the body.
  const role = roleParts(person.role ?? "");
  return (
    <span
      className="badge person-badge"
      tabIndex={0}
      onMouseEnter={(e) => show(e.currentTarget)}
      onMouseLeave={hide}
      onFocus={(e) => show(e.currentTarget)}
      onBlur={hide}
    >
      <Avatar name={person.name} src={face} size={14} />
      {person.name}
      {card(
        <>
          <div className="person-card-head">
            <Avatar name={person.name} src={face} size={28} />
            <div className="person-card-name">
              <div className="meeting-card-title">{person.name}</div>
              {role.title && <div className="small muted">{role.title}</div>}
            </div>
          </div>
          {role.detail && <p className="small">{role.detail}</p>}
          {person.working_on && <p className="small">{person.working_on}</p>}
        </>,
      )}
    </span>
  );
}

/**
 * Who's involved in the project, first in its details and untitled: badges in a row for each part of
 * RACI (accountable, responsible, consulted, informed). Each badge shows how that person is involved
 * on hover. People a refresh hasn't placed yet are listed last.
 */
export function People({ project }: { project: Project }) {
  const people = project.profile?.people ?? [];
  const faceOf = faceFinder(project);
  if (!people.length) return null;
  // The most central first in each row; ties keep the refresh's order.
  const ranked = people.map((person, i) => ({ person, weight: importanceOf(person, i), i })).sort((a, b) => b.weight - a.weight || a.i - b.i);
  const rows = [
    ...RACI_ROWS.map((r) => ({ ...r, people: ranked.filter((x) => x.person.raci === r.key).map((x) => x.person) })),
    { key: "unsorted" as const, label: "Not placed yet", tip: "The next refresh puts each of them in a row", people: ranked.filter((x) => !x.person.raci).map((x) => x.person) },
  ].filter((r) => r.people.length);
  return (
    <section className="record-section" aria-label="People">
      {/* One grid for every row: the badges from the left, each row's label at the right end. */}
      <div className="people-raci">
        {rows.map((row) => (
          <div key={row.key} className={`raci-row${row.key === "unsorted" ? " unsorted" : ""}`}>
            <span className="raci-people" role="list" aria-label={row.label}>
              {row.people.map((p) => (
                <span key={p.name} role="listitem">
                  <PersonBadge person={p} face={faceOf(p.name)} />
                </span>
              ))}
            </span>
            <HoverTip text={row.tip}>
              <span className="raci-label">{row.label}</span>
            </HoverTip>
          </div>
        ))}
      </div>
    </section>
  );
}
