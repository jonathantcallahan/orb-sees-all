import { useState } from "react";
import type { NewsItem } from "../schema";
import { setTaskState, type Project, type StoredReading } from "../db";
import { stateOf, type TaskState } from "../tasks";
import { refreshReading } from "../jobs";
import { projectName } from "../projects";
import { localDate } from "../scheduler";
import { useJobStatus } from "../useAppData";
import { ExternalLink, RefreshButton } from "./common";

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

/** Stack of update cards, newest on top; marking one read reveals the next. */
function UpdateStack({ updates, onRead }: { updates: Update[]; onRead: (u: Update) => Promise<void> }) {
  const [leaving, setLeaving] = useState(false);
  const top = updates[0];
  // Up to two cards peek out behind the top one, as plain edges the same size as it.
  const behind = Math.min(updates.length - 1, 2);
  return (
    <div className="update-stack" style={{ marginBottom: behind * 8 }}>
      {Array.from({ length: behind }, (_, i) => behind - i).map((depth) => (
        <div
          key={depth}
          className="card update-card-behind"
          style={{ transform: `translateY(${depth * 8}px) scale(${1 - depth * 0.04})`, opacity: 1 - depth * 0.3 }}
          aria-hidden
        />
      ))}
      <div key={top.key} className={`card update-card${leaving ? " leaving" : ""}`}>
        <div className="update-meta small">
          <span className="update-label">{top.label}</span>
          {top.date && <span className="muted">{top.date}</span>}
        </div>
        <ExternalLink href={top.link} className="update-text">
          {top.text}
        </ExternalLink>
        <div className="update-actions small">
          <span className="muted">{updates.length > 1 ? `${updates.length - 1} more` : "Last one"}</span>
          <button
            className="link-button small"
            disabled={leaving}
            onClick={() => {
              setLeaving(true);
              // Let the card slide away before it's removed.
              setTimeout(() => onRead(top).finally(() => setLeaving(false)), 220);
            }}
          >
            Mark read
          </button>
        </div>
      </div>
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
  const status = useJobStatus("reading");
  const current = reading?.date === localDate(new Date()) ? reading : null;
  const updates = collectUpdates(projects, news).filter((u) => !stateOf(states, u.key).dismissed);

  return (
    <section className="reading">
      <header className="column-header">
        <h4 className="section-title">Daily reading</h4>
        <RefreshButton busy={busy} status={status} title="Write today's reading again" onClick={() => refreshReading().catch(() => {})} />
      </header>
      {current ? (
        <p className="reading-text">{current.text}</p>
      ) : (
        <p className="muted small">{busy ? "The Orb is reading your day…" : "No reading yet today. It's written after Refresh all."}</p>
      )}

      {updates.length > 0 && (
        <>
          <h4 className="section-title">Updates</h4>
          <UpdateStack
            updates={updates}
            onRead={async (u) => {
              await setTaskState(u.key, { dismissed: true });
              onChange();
            }}
          />
        </>
      )}
    </section>
  );
}
