import { useState } from "react";
import type { NewsItem } from "../schema";
import type { Project, StoredReading } from "../db";
import { refreshReading } from "../jobs";
import { projectName } from "../projects";
import { localDate } from "../scheduler";
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
      (p.snapshot?.recent_updates ?? []).map((u, i) => ({
        key: `${p.channel_id}:${i}`,
        label: projectName(p),
        text: u.summary,
        link: u.link,
        date: u.date,
      })),
    );
  const fromNews = news.map((n) => ({ key: n.id, label: n.where ?? "News", text: n.headline, link: n.link, date: n.date }));
  return [...fromProjects, ...fromNews].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
}

/** The Orb's reading for today: a proposed focus, then what's new. */
export function DailyReading({
  reading,
  projects,
  news,
  busy,
}: {
  reading: StoredReading | null;
  projects: Project[];
  news: NewsItem[];
  busy: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const current = reading?.date === localDate(new Date()) ? reading : null;
  const updates = collectUpdates(projects, news);
  const shown = showAll ? updates : updates.slice(0, 4);

  return (
    <section className="reading">
      <header className="column-header">
        <h4 className="reading-title">Daily reading</h4>
        <RefreshButton busy={busy} title="Write today's reading again" onClick={() => refreshReading().catch(() => {})} />
      </header>
      {current ? (
        <p className="reading-text">{current.text}</p>
      ) : (
        <p className="muted small">{busy ? "The Orb is reading your day…" : "No reading yet today. It's written after Refresh all."}</p>
      )}

      {updates.length > 0 && (
        <>
          <h4>Updates</h4>
          <ul className="updates small">
            {shown.map((u) => (
              <li key={u.key} title={u.date ?? undefined}>
                <span className="update-label">{u.label}</span>
                <ExternalLink href={u.link}>{u.text}</ExternalLink>
              </li>
            ))}
          </ul>
          {updates.length > 4 && (
            <button className="link-button small" onClick={() => setShowAll((s) => !s)}>
              {showAll ? "Fewer" : `${updates.length - 4} more`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
