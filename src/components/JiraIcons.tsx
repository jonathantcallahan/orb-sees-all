import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import * as db from "../db";
import { dataVersion } from "../jobs";
import { issueTypesFrom, jiraIssueKey } from "../jiraTypes";
import { ExternalLink, HoverTip } from "./common";

/**
 * Jira's issue type marks, drawn as Jira draws them (the colors are --initiative, --epic and the item
 * types' in styles.css): the Plan view's rows, and every Jira key the app links to, which shows its
 * type's mark before it (see JiraKey).
 */

/** An initiative's mark: Jira's orange stack, outlined for one Demian proposes. */
export function InitiativeIcon({ proposed = false, size = 14 }: { proposed?: boolean; size?: number }) {
  return (
    <svg className={`plan-icon initiative${proposed ? " proposed" : ""}`} width={size} height={size} viewBox="0 0 14 14" aria-hidden>
      <rect x="0.75" y="0.75" width="12.5" height="12.5" rx="2.5" />
      <path d="M4 4.5h6M4 7h6M4 9.5h6" />
    </svg>
  );
}

/** An epic's mark: Jira's purple lightning bolt, outlined for one Demian proposes. */
export function EpicIcon({ proposed = false, size = 14 }: { proposed?: boolean; size?: number }) {
  return (
    <svg className={`plan-icon epic${proposed ? " proposed" : ""}`} width={size} height={size} viewBox="0 0 14 14" aria-hidden>
      <rect x="0.75" y="0.75" width="12.5" height="12.5" rx="2.5" />
      <path d="M7.9 2.6 4.4 7.6h2.5l-.8 3.8 3.5-5H7.1z" />
    </svg>
  );
}

/** The standard issue types' marks, as Jira draws them; any other type gets its first letter. */
const TYPE_MARK: Record<string, string> = { story: "story", task: "task", bug: "bug", spike: "spike", "sub-task": "task", subtask: "task" };

/**
 * A story or task's mark, by its issue type: Jira's green bookmark for a story, blue check for a task,
 * red dot for a bug, and a letter for the project's own types (Collaboration, Design…). Dashed for work
 * no ticket covers yet; its type shows on hover.
 */
export function ItemIcon({ type, ticket = true, size = 14 }: { type: string | null | undefined; ticket?: boolean; size?: number }) {
  const name = type?.trim() || "Task";
  const mark = TYPE_MARK[name.toLowerCase()] ?? "other";
  return (
    <HoverTip text={ticket ? name : `${name} (proposed, not in Jira yet)`}>
      <svg className={`plan-icon item ${mark}${ticket ? "" : " untracked"}`} width={size} height={size} viewBox="0 0 14 14" role="img" aria-label={name}>
        <rect x="1.25" y="1.25" width="11.5" height="11.5" rx="2.5" />
        {mark === "task" && <path d="m4.3 7.2 1.9 1.9 3.6-4" />}
        {mark === "story" && <path className="fill" d="M4.6 3.6h4.8v7l-2.4-1.7-2.4 1.7z" />}
        {mark === "bug" && <circle className="fill" cx="7" cy="7" r="2.6" />}
        {mark === "spike" && <path d="M5.2 3.8h3.6M6 3.8v2.5L4 10.2h6L8 6.3V3.8" />}
        {mark === "other" && (
          <text x="7" y="10" textAnchor="middle">
            {name[0].toUpperCase()}
          </text>
        )}
      </svg>
    </HoverTip>
  );
}

/**
 * An issue type's mark, by its name: an initiative's, an epic's, or a story's, task's, bug's… (see
 * ItemIcon). Nothing while the type isn't known (an issue read before types were kept).
 */
export function IssueTypeIcon({ type, size = 14 }: { type: string | null | undefined; size?: number }) {
  if (type === undefined) return null;
  const name = type?.trim().toLowerCase();
  if (name === "epic") return <EpicIcon size={size} />;
  if (name === "initiative") return <InitiativeIcon size={size} />;
  return <ItemIcon type={type} size={size} />;
}

/** A Jira key after its issue type's mark: linked to the issue when there's a link. */
export function JiraKey({
  type,
  href,
  className,
  label,
  size = 14,
  children,
}: {
  type: string | null | undefined;
  href: string | null | undefined;
  className?: string;
  label?: string;
  size?: number;
  children: ReactNode;
}) {
  return (
    <span className="jira-key">
      <IssueTypeIcon type={type} size={size} />
      {href ? (
        <ExternalLink href={href} className={className} label={label}>
          {children}
        </ExternalLink>
      ) : (
        <span className={className}>{children}</span>
      )}
    </span>
  );
}

/**
 * Every issue type the planner knows, by key (see issueTypesFrom), read again as what it's read changes:
 * at most every few seconds, however often the data changes (a refresh changes it after each of its
 * jobs), one read at a time, and once more after the last change.
 */
let known = new Map<string, string>();
let knownAt = -1;
let wanted = -1;
let reading = false;
let lastRead = 0;
const TYPES_EVERY_MS = 3000;
const listeners = new Set<() => void>();
function readTypes(version: number) {
  wanted = version;
  if (reading || knownAt === wanted) return;
  reading = true;
  const wait = Math.max(0, lastRead + TYPES_EVERY_MS - Date.now());
  setTimeout(() => {
    const at = wanted;
    Promise.all([db.getSprintEpics(), db.getEpicChildren(), db.listProjects()])
      .then(([sprints, children, projects]) => {
        known = issueTypesFrom({ sprints, children, projects });
        knownAt = at;
        listeners.forEach((l) => l());
      })
      .catch(() => {
        // Tried again with the next change.
        knownAt = at;
      })
      .finally(() => {
        lastRead = Date.now();
        reading = false;
        if (wanted !== knownAt) readTypes(wanted);
      });
  }, wait);
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The type of the Jira issue a link opens, when the planner knows it; undefined for another link, or an issue it hasn't read. */
export function useIssueType(href: string | null | undefined): string | undefined {
  const version = useSyncExternalStore(dataVersion.subscribe, dataVersion.get);
  useEffect(() => readTypes(version), [version]);
  const types = useSyncExternalStore(subscribe, () => known);
  const key = jiraIssueKey(href);
  return key ? types.get(key) : undefined;
}

/** The mark before a link to a Jira issue, in running text (a chat's, a project's): its type's, once the planner knows it. */
export function JiraLinkMark({ href, size = 13 }: { href: string | null | undefined; size?: number }) {
  const type = useIssueType(href);
  if (type === undefined) return null;
  return (
    <span className="jira-link-mark">
      <IssueTypeIcon type={type} size={size} />
    </span>
  );
}

