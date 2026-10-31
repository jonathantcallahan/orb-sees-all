import { shockOrb } from "../orbEvents";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { NewsItem } from "../schema";
import { setTaskState, type Project, type StoredReading } from "../db";
import { stateOf, type TaskState } from "../tasks";
import { refreshReading } from "../jobs";
import { projectName } from "../projects";
import { formatWhen, localDate } from "../scheduler";
import { useJobStatus } from "../useAppData";
import { ExternalLink, RefreshButton, Reveal } from "./common";
import { ExplainChat } from "./ExplainChat";

interface Update {
  key: string;
  label: string;
  text: string;
  link?: string | null;
  date?: string | null;
}

/** Project updates and news, newest first. */
function collectUpdates(projects: Project[], news: NewsItem[]): Update[] {
  const fromProjects = projects
    .filter((p) => !p.hidden)
    .flatMap((p) =>
      (p.snapshot?.recent_updates ?? []).map((u) => ({
        // Keyed by permalink (or text) so read state survives refreshes.
        key: `update:${u.link ?? `${p.channel_id}:${u.summary}`}`,
        label: projectName(p),
        text: u.summary,
        link: u.link,
        date: u.date,
      })),
    );
  const fromNews = news.map((n) => ({ key: `update:${n.id}`, label: n.where ?? "News", text: n.headline, link: n.link, date: n.date }));
  return [...fromProjects, ...fromNews].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
}

/** "Open thread" for Slack, "Open email" for Gmail, "Open" for anything else. */
function sourceLabel(link: string): string {
  if (link.includes("slack.com")) return "Open thread";
  if (link.includes("mail.google.com") || link.startsWith("gmail:")) return "Open email";
  return "Open";
}

/** Stack of update cards, newest on top; marking one read reveals the next. */
/** How long marking an update read takes: the top card leaving and the stack moving up. */
const ADVANCE_MS = 230;

/**
 * Updates as a stack of cards, the newest on top. Marking one read slides it off to the right,
 * fading, its button turning to "✓ Read"; the cards behind glide forward into place, one a hair
 * after the other, and the new update's text fades in on the card that rose.
 */
function UpdateStack({ updates, onRead }: { updates: Update[]; onRead: (u: Update) => Promise<void> }) {
  const [leaving, setLeaving] = useState(false);
  /** The update whose Explain this chat is open. */
  const [explaining, setExplaining] = useState<Update | null>(null);
  /** The top card arrived by the stack moving up, so it doesn't also slide in. */
  const [advanced, setAdvanced] = useState(false);
  const top = updates[0];
  // Up to two cards peek out behind the top one, as plain edges the same size as it.
  const behind = Math.min(updates.length - 1, 2);
  // While the top card leaves, each card behind moves a step forward.
  const place = (depth: number) => (leaving ? depth - 1 : depth);
  // The stack holds one height while there are updates, so the page below never jumps: the tallest
  // of the updates, measured off-screen at the stack's width, and never shrinking until they're all read.
  const measure = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const keys = updates.map((u) => u.key).join("|");
  useLayoutEffect(() => {
    const el = measure.current;
    if (!el) return;
    const read = () => {
      const tallest = Math.max(0, ...[...el.children].map((c) => (c as HTMLElement).offsetHeight));
      setHeight((h) => Math.max(h, tallest));
    };
    read();
    const observer = new ResizeObserver(() => {
      // A new width can make every update taller or shorter: measure afresh.
      setHeight(0);
      read();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [keys]);
  return (
    // The gap the cards behind peek into stays as long as there are updates, even once fewer are left.
    <div className={`update-stack${leaving ? " advancing" : ""}`} style={{ marginBottom: 16, height: height || undefined }}>
      <div ref={measure} className="update-measure" aria-hidden>
        {updates.map((u) => (
          <div key={u.key} className="card update-card">
            <div className="update-meta small">
              <span className="update-label">{u.label}</span>
              {u.date && <span className="timestamp">{formatWhen(u.date)}</span>}
            </div>
            <p className="update-text">{u.text}</p>
            <div className="update-actions small">
              <span>&nbsp;</span>
            </div>
          </div>
        ))}
      </div>
      {Array.from({ length: behind }, (_, i) => behind - i).map((depth) => (
        <div
          key={depth}
          className="card update-card-behind"
          style={{
            transform: `translateY(${place(depth) * 8}px) scale(${1 - place(depth) * 0.04})`,
            opacity: 1 - place(depth) * 0.3,
            // The nearer card springs forward first, the one behind it a beat later.
            transitionDelay: leaving ? `${30 + (depth - 1) * 30}ms` : "0ms",
          }}
          aria-hidden
        />
      ))}
      <div key={top.key} className={`card update-card${leaving ? " leaving" : ""}${advanced ? " advanced" : ""}`}>
        <div className="update-meta small">
          <span className="update-label">{top.label}</span>
          {top.date && <span className="timestamp">{formatWhen(top.date)}</span>}
        </div>
        <p className="update-text">{top.text}</p>
        <div className="update-actions small">
          <span className="muted">{updates.length > 1 ? `${updates.length - 1} more` : "Last one"}</span>
          <span className="update-links">
            {top.link && (
              <ExternalLink href={top.link} className="link-button small source-link">
                {sourceLabel(top.link)}
              </ExternalLink>
            )}
            <button className="link-button small source-link" onClick={() => setExplaining(top)}>
              Explain
            </button>
            <button
              className="link-button small mark-read"
              disabled={leaving}
              onClick={() => {
                setLeaving(true);
                shockOrb();
                // The stack moves up before the read update is removed; the card that rose is the next one.
                setTimeout(
                  () =>
                    onRead(top).finally(() => {
                      setAdvanced(true);
                      setLeaving(false);
                    }),
                  ADVANCE_MS,
                );
              }}
            >
              {leaving ? <span className="read-tick">✓ Read</span> : "Mark read"}
            </button>
          </span>
        </div>
      </div>
      {explaining && <ExplainChat update={explaining} onClose={() => setExplaining(null)} />}
    </div>
  );
}

/** The Orb's reading for today: a proposed focus, then what's new. */
export function DailyReading({
  reading,
  projects,
  news,
  states,
  busy,
  onChange,
}: {
  reading: StoredReading | null;
  projects: Project[];
  news: NewsItem[];
  states: Map<string, TaskState>;
  busy: boolean;
  onChange: () => void;
}) {
  // Open or folded away, remembered between launches.
  const [open, setOpen] = useState(() => localStorage.getItem("briefing-open") !== "0");
  useEffect(() => localStorage.setItem("briefing-open", open ? "1" : "0"), [open]);
  const [updatesOpen, setUpdatesOpen] = useState(() => localStorage.getItem("updates-open") !== "0");
  useEffect(() => localStorage.setItem("updates-open", updatesOpen ? "1" : "0"), [updatesOpen]);
  const status = useJobStatus("reading");
  const current = reading?.date === localDate(new Date()) ? reading : null;
  const updates = collectUpdates(projects, news).filter((u) => !stateOf(states, u.key).dismissed);

  return (
    <>
      <section className="reading">
        <header className="column-header">
          <h4 className="section-title">Daily briefing</h4>
          <div className="row reading-header-actions">
            <RefreshButton busy={busy} status={status} title="Write today's briefing again" onClick={() => refreshReading().catch(() => {})} />
            <Disclosure open={open} what="the briefing" onToggle={() => setOpen(!open)} />
          </div>
        </header>
        <Reveal open={open} className="reading-body">
          {current ? (
            <p className="reading-text">{current.text}</p>
          ) : (
            <p className="muted small">{busy ? "The Orb is preparing your briefing…" : "No briefing yet today. It's written after Refresh all."}</p>
          )}
        </Reveal>
      </section>

      {/* Updates are their own section, folded away on their own. */}
      {updates.length > 0 && (
        <section className="reading">
          <header className="column-header">
            <h4 className="section-title">Updates</h4>
            <div className="row reading-header-actions">
              <Disclosure open={updatesOpen} what="updates" onToggle={() => setUpdatesOpen(!updatesOpen)} />
            </div>
          </header>
          <Reveal open={updatesOpen} className="reading-body">
            <UpdateStack
              updates={updates}
              onRead={async (u) => {
                await setTaskState(u.key, { dismissed: true });
                onChange();
              }}
            />
          </Reveal>
        </section>
      )}
    </>
  );
}

/** The arrow that folds a section away and opens it again. */
function Disclosure({ open, what, onToggle }: { open: boolean; what: string; onToggle: () => void }) {
  return (
    <button className="task-toggle" aria-expanded={open} aria-label={open ? `Hide ${what}` : `Show ${what}`} onClick={onToggle}>
      <svg className={`disclosure${open ? " open" : ""}`} width="10" height="10" viewBox="0 0 10 10" aria-hidden>
        <path d="M3.5 2 6.5 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}
