import { useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getProjectTracking, type Project } from "../db";
import { applyInitiative, applyStory, createProposedEpic, createProposedItem, dataVersion, moveIntoEpic, planApplyKey } from "../jobs";
import type { ProjectTracking, TrackedItem } from "../jobs/tracking";
import { activeEpics, guideTitle, requirementRows, type RequirementRow } from "../projects";
import {
  at,
  codeLink,
  dayOf,
  epicDescription,
  epicPeople,
  epicProjectKeys,
  epicSpan,
  initiativeSpan,
  initiativeStatus,
  itemDescription,
  itemKey,
  openAtFirst,
  placeCode,
  placeRequirements,
  planGroups,
  planTimeline,
  proposedMove,
  type PlacedMark,
  type PlanGroup,
  type Timeline,
} from "../plan";
import type { ItemCreated, PathInitiative, PathItem, PathStep, PathToShip } from "../schema";
import { formatWhen } from "../scheduler";
import { sinceWhen } from "../tasks";
import { useJobStatus, useRunningJobs } from "../useAppData";
import { ExternalLink, HoverTip, Spinner } from "./common";
import { FaceStack, faceFinder } from "./People";
import { RequirementDetail, STATUS_LABEL } from "./ProjectRequirements";

/** Jira's words for a status, on its lozenge. */
const STATUS_TEXT: Record<PathStep["status"], string> = {
  done: "Done",
  in_progress: "In progress",
  next: "To do",
  blocked: "Blocked",
};

function StatusLozenge({ status }: { status: PathStep["status"] }) {
  return <span className={`badge plan-status ${status}`}>{STATUS_TEXT[status]}</span>;
}

/** An initiative's mark: Jira's orange stack, outlined for one Demian proposes. */
function InitiativeIcon({ proposed }: { proposed: boolean }) {
  return (
    <svg className={`plan-icon initiative${proposed ? " proposed" : ""}`} width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <rect x="0.75" y="0.75" width="12.5" height="12.5" rx="2.5" />
      <path d="M4 4.5h6M4 7h6M4 9.5h6" />
    </svg>
  );
}

/** An epic's mark: Jira's purple lightning bolt, outlined for one Demian proposes. */
function EpicIcon({ proposed }: { proposed: boolean }) {
  return (
    <svg className={`plan-icon epic${proposed ? " proposed" : ""}`} width="14" height="14" viewBox="0 0 14 14" aria-hidden>
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
function ItemIcon({ type, ticket }: { type: string | null | undefined; ticket: boolean }) {
  const name = type?.trim() || "Task";
  const mark = TYPE_MARK[name.toLowerCase()] ?? "other";
  return (
    <HoverTip text={ticket ? name : `${name} (proposed, not in Jira yet)`}>
      <svg className={`plan-icon item ${mark}${ticket ? "" : " untracked"}`} width="14" height="14" viewBox="0 0 14 14" role="img" aria-label={name}>
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

/** A key or title, linked when it has a link. */
function Linked({ href, className, children }: { href: string | null | undefined; className: string; children: ReactNode }) {
  return href ? (
    <ExternalLink href={href} className={className}>
      {children}
    </ExternalLink>
  ) : (
    <span className={className}>{children}</span>
  );
}

/** Open and close a row's children. */
function Toggle({ open, label, onClick }: { open: boolean; label: string; onClick?: () => void }) {
  if (!onClick) return <span className="plan-toggle" aria-hidden />;
  return (
    <button className="plan-toggle" onClick={onClick} aria-label={`${open ? "Close" : "Open"} ${label}`}>
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
        <path d="M3.5 2 6.5 5l-3 3" />
      </svg>
    </button>
  );
}

/**
 * A change Demian proposes to Jira's records, marked where it would happen: a label (its hover says
 * what and why) and, where it can be made from here, a button that opens its review card.
 */
function Proposal({ label, tip, action, onAction }: { label: string; tip: string; action?: string; onAction?: () => void }) {
  return (
    <>
      <HoverTip text={tip}>
        <span className="badge plan-proposal">{label}</span>
      </HoverTip>
      {action && onAction && (
        <button className="link-button small plan-action" onClick={onAction}>
          {action}
        </button>
      )}
    </>
  );
}

/** The timeline cell's guides: today, and the ship date. */
function Guides({ t }: { t: Timeline }) {
  return (
    <>
      <span className="plan-today" style={{ left: `${at(t, t.today + 0.5)}%` }} aria-hidden />
      {t.ship !== null && <span className="plan-ship" style={{ left: `${at(t, t.ship + 0.5)}%` }} aria-hidden />}
    </>
  );
}

/** A row's timeline cell, with a bar from start to end (lighter where assumed) or a mark on a day. */
function TimelineCell({ t, bar, mark, className = "" }: { t: Timeline | null; bar?: { start: number; end: number; assumed: boolean } | null; mark?: number | null; className?: string }) {
  if (!t) return null;
  return (
    <span className="plan-timeline-cell">
      <Guides t={t} />
      {bar && bar.end >= t.from && bar.start <= t.to && (
        <span
          className={`plan-bar ${className}${bar.assumed ? " assumed" : ""}`}
          style={{ left: `${at(t, bar.start)}%`, width: `${Math.max(1.5, at(t, bar.end + 1) - at(t, bar.start))}%` }}
          aria-hidden
        />
      )}
      {mark != null && mark >= t.from && mark <= t.to && <span className={`plan-due ${className}`} style={{ left: `${at(t, mark + 0.5)}%` }} aria-hidden />}
    </span>
  );
}

/** Which part of a progress bar a status fills: done, moving, at risk or blocked, else not started. */
const BAR_PART: Record<string, string> = { done: "done", in_progress: "in_progress", at_risk: "at_risk", blocked: "blocked" };
const BAR_ORDER = ["done", "in_progress", "at_risk", "blocked", "not_started"];

/**
 * The compact plan's Progress cell: a bar split by the statuses of what's under the row, how many are
 * done on hover. Empty for a row with nothing under it.
 */
function ProgressCell({ statuses = [], noun = "" }: { statuses?: string[]; noun?: string }) {
  if (!statuses.length) return <span className="plan-progress" role="cell" />;
  const counts = new Map<string, number>();
  for (const st of statuses) {
    const part = BAR_PART[st] ?? "not_started";
    counts.set(part, (counts.get(part) ?? 0) + 1);
  }
  const text = `${counts.get("done") ?? 0} of ${statuses.length} ${noun} done`;
  return (
    <span className="plan-progress" role="cell">
      <HoverTip text={text}>
        <span className="requirements-bar plan-progress-bar" role="img" aria-label={text}>
          {BAR_ORDER.filter((part) => counts.get(part)).map((part) => (
            <span key={part} className={`requirements-bar-part ${part}`} style={{ flexGrow: counts.get(part) }} />
          ))}
        </span>
      </HoverTip>
    </span>
  );
}

/** A date for the Due column: "Nov 30", or nothing. */
const due = (date: string | null | undefined) => (date && dayOf(date) !== null ? formatWhen(date.slice(0, 10)) : "");
const latest = (dates: (string | null | undefined)[]) => dates.filter((d): d is string => !!d && dayOf(d) !== null).sort().at(-1) ?? null;

/** One row of the plan, `depth` levels in. */
function Row({ depth, className, expanded, children }: { depth: number; className: string; expanded?: boolean; children: ReactNode }) {
  return (
    <div className={`plan-row ${className}`} role="row" aria-expanded={expanded} style={{ "--depth": depth } as CSSProperties}>
      {children}
    </div>
  );
}

/**
 * Requirements of the guiding doc that no issue delivers yet, each shown as the story Demian proposes
 * for it: a dashed story with the requirement as its title (opening to what's done and left, and what
 * shows it), how far along it is, and in full screen "Create in Jira". Descoped ones aren't work.
 * `at` is where it would go: in an epic (by its index), under an initiative, or in no epic. In no
 * epic, `loose` says why: the plan has no epics yet, or the last refresh didn't place it.
 */
function ProposedForRequirements({
  rows,
  depth,
  ctx,
  at,
  loose,
}: {
  rows: RequirementRow[];
  depth: number;
  ctx: PlanContext;
  at: { step: number | null; initiative: string | null };
  loose?: "unplanned" | "unplaced";
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      {rows
        .filter((row) => row.progress?.status !== "descoped")
        .map((row) => {
          const { requirement: r, progress } = row;
          const status = progress?.status ?? "pending";
          const isOpen = open === r.id;
          const review: Review = { kind: "requirement", step: at.step, initiative: at.initiative, id: r.id };
          // Created in Jira from here, with no epic on the plan to put it in: the ticket, until a refresh places it.
          const made = ctx.createdFor(r.id);
          if (made)
            return (
              <div key={r.id} className="plan-group" role="rowgroup">
                <Row depth={depth} className="item next">
                  <span className="plan-work" role="cell">
                    <Toggle open={false} label="" />
                    <ItemIcon type={made.type} ticket />
                    <Linked href={made.link} className="plan-key">
                      {made.key}
                    </Linked>
                    <HoverTip text={`${made.title}. Delivers: ${r.text}`}>
                      <Linked href={made.link} className="plan-title clip-text">
                        {made.title}
                      </Linked>
                    </HoverTip>
                  </span>
                  <span className="plan-who" role="cell" />
                  <span className="plan-state" role="cell">
                    <StatusLozenge status="next" />
                  </span>
                  <span className="plan-due-date" role="cell" />
                  <TimelineCell t={ctx.t} />
                  {ctx.compact && <ProgressCell />}
                </Row>
              </div>
            );
          return (
            <div key={r.id} className="plan-group" role="rowgroup">
              <Row depth={depth} className={`item ${status}`}>
                <span className="plan-work" role="cell">
                  <Toggle open={false} label="" />
                  <ItemIcon type="Story" ticket={false} />
                  {!ctx.compact && (
                    <HoverTip text={looseTip[loose ?? ""] ?? "No issue delivers this requirement yet: a story Demian proposes for it."}>
                      <span className="plan-key untracked">{loose ? "No epic" : "Proposed"}</span>
                    </HoverTip>
                  )}
                  <HoverTip text={r.text} whenClipped>
                    {/* The title is a span in the button: WebKit won't clamp a button's own text to two lines. */}
                    <button className="plan-requirement-text" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : r.id)}>
                      <span className="plan-title clip-text">{r.text}</span>
                    </button>
                  </HoverTip>
                  {!ctx.compact && r.priority === "must" && <span className="badge requirement-must">Must</span>}
                  {/* Work that's done needs no ticket now. */}
                  {!ctx.compact && ctx.review && status !== "done" && (
                    <button className="link-button small plan-action" onClick={() => ctx.review?.(review)}>
                      Create in Jira
                    </button>
                  )}
                  <Applying ctx={ctx} on={review} />
                </span>
                <span className="plan-who" role="cell" />
                <span className="plan-state" role="cell">
                  <span className={`badge requirement-status ${status}`}>{STATUS_LABEL[status]}</span>
                </span>
                <span className="plan-due-date" role="cell" />
                <TimelineCell t={ctx.t} />
                {ctx.compact && <ProgressCell />}
              </Row>
              {isOpen && (
                <Row depth={depth} className="plan-requirement-detail">
                  <RequirementDetail row={row} />
                </Row>
              )}
            </div>
          );
        })}
    </>
  );
}

/** A pull request or branch a ticket links that the last refresh didn't read on GitHub: what its link says. */
function fromLink(url: string): TrackedItem {
  const l = codeLink(url)!;
  return { id: l.id, kind: l.kind, title: l.name, url, repo: l.repo, state: "unknown", detail: null, updatedAt: null, checkedAt: "" };
}

/** At most this many marks on a row; past it, the last one is a count of the rest. */
const MARKS_SHOWN = 4;

/**
 * The pull requests and branches of a ticket on its row, after its icon: one mark each, in its
 * state's look (see codeLook), with a solid border when the ticket links it itself and a dotted one
 * when Demian only matched it by the ticket's key. Each opens on GitHub, and its hover says more.
 */
function CodeMarks({ marks, owner }: { marks: PlacedMark<TrackedItem>[]; owner: string | null }) {
  if (!marks.length) return null;
  // The ones the ticket links first.
  const sorted = [...marks.filter((m) => m.tie === "linked"), ...marks.filter((m) => m.tie !== "linked")];
  const shown = sorted.length > MARKS_SHOWN ? sorted.slice(0, MARKS_SHOWN - 1) : sorted;
  const more = sorted.slice(shown.length);
  return (
    <span className="code-marks">
      {shown.map((m) => (
        <HoverTip key={m.code.id} text={<CodeCard mark={m} owner={owner} />}>
          <ExternalLink href={m.code.url} className={`code-mark ${m.tie === "linked" ? "linked" : "suggested"} ${codeLook(m.code).tone}`} label={codeName(m.code)}>
            <CodeIcon look={codeLook(m.code)} />
          </ExternalLink>
        </HoverTip>
      ))}
      {more.length > 0 && (
        <HoverTip
          text={
            <div className="code-card">
              {more.map((m) => (
                <div key={m.code.id} className="code-card-head">
                  <CodeIcon look={codeLook(m.code)} />
                  <span className="clip-text">{codeName(m.code)}</span>
                  <span className={`code-state ${codeLook(m.code).tone}`}>{codeLook(m.code).label}</span>
                </div>
              ))}
            </div>
          }
        >
          <span className="code-mark more">+{more.length}</span>
        </HoverTip>
      )}
    </span>
  );
}

/** How a pull request or branch is tied to its work, for its hover. */
function codeTie(tie: PlacedMark<TrackedItem>["tie"], owner: string | null, pr: boolean): string {
  if (tie === "linked") return `Linked from ${owner ?? "the ticket"}.`;
  if (tie === "named") return `Suggested: its ${pr ? "title or branch" : "name"} has ${owner ?? "the ticket's key"}, but the ticket doesn't link it.`;
  return owner
    ? `Suggested: Demian reads it as ${owner}'s work from where the project talks about it, but the ticket doesn't link it.`
    : "Suggested: Demian reads it as this work, which has no ticket yet. Creating it in Jira links it.";
}

/** A pull request's number and title, or a branch's name. */
const codeName = (c: TrackedItem) => (c.kind === "pr" ? c.title : `Branch ${c.title}`);

/**
 * A pull request's or branch's hover: its state, title and branch, its repo, checks, review and last
 * change, and how it's tied to the ticket.
 */
function CodeCard({ mark, owner }: { mark: PlacedMark<TrackedItem>; owner: string | null }) {
  const c = mark.code;
  const look = codeLook(c);
  const pr = c.kind === "pr";
  const number = pr ? (c.title.match(/^#\d+/)?.[0] ?? "") : "";
  const title = pr ? c.title.slice(number.length).trim() : "";
  // A pull request's detail is its branch; a branch's is how far it is from main.
  const branch = pr ? c.detail : c.title;
  // A branch's "no PR" is in its state already.
  const about = [c.repo, pr ? null : (c.detail?.replace(/\s*·\s*no PR$/i, "") ?? null), c.checks ? CHECKS_TEXT[c.checks] : null, c.review ? REVIEW_TEXT[c.review] : null, c.updatedAt ? `updated ${sinceWhen(c.updatedAt)}` : null].filter(Boolean);
  return (
    <div className="code-card">
      <div className="code-card-head">
        <CodeIcon look={look} />
        <span>{pr ? `Pull request ${number}` : "Branch"}</span>
        <span className={`code-state ${look.tone}`}>{look.label}</span>
      </div>
      {title && <div className="code-card-title">{title}</div>}
      {branch && <code className="code-card-branch">{branch}</code>}
      {about.length > 0 && <div className="code-card-about">{about.join(" · ")}</div>}
      {look.tone === "unknown" && <div className="code-card-about">Not read on GitHub yet: the next refresh reads its repo.</div>}
      <div className="code-card-tie">{codeTie(mark.tie, owner, pr)}</div>
    </div>
  );
}

/** Why a requirement in no epic is there (see ProposedForRequirements). */
const looseTip: Record<string, string> = {
  unplanned: "In no epic yet: a refresh puts each requirement on the issue that delivers it, in its epic.",
  unplaced: "In no epic: the last refresh didn't place this requirement, and no epic has the rest of its section of the doc. Refresh to place it, or Create in Jira to make its story.",
};

/** The requirements that are work still to show: all but the descoped ones. */
const asWork = (rows: RequirementRow[]) => rows.filter((r) => r.progress?.status !== "descoped");

/**
 * How a pull request or branch looks, the way GitHub shows it: open green, draft gray, merged purple,
 * closed red, each with its icon, and a branch with no pull request in gray. One read only from a
 * ticket's link (not on GitHub yet) is gray too.
 */
type CodeLook = { icon: "branch" | "pr" | "draft" | "merged" | "closed"; tone: "open" | "draft" | "merged" | "closed" | "branch" | "unknown"; label: string };

function codeLook(c: Pick<TrackedItem, "kind" | "state">): CodeLook {
  if (c.kind === "branch") return c.state === "unknown" ? { icon: "branch", tone: "unknown", label: "Not read yet" } : { icon: "branch", tone: "branch", label: "No pull request" };
  switch (c.state) {
    case "open":
      return { icon: "pr", tone: "open", label: "Open" };
    case "draft":
      return { icon: "draft", tone: "draft", label: "Draft" };
    case "merged":
      return { icon: "merged", tone: "merged", label: "Merged" };
    case "closed":
      return { icon: "closed", tone: "closed", label: "Closed" };
    default:
      return { icon: "pr", tone: "unknown", label: "Not read yet" };
  }
}

/** A pull request's or branch's icon, GitHub's for its state, in its state's color (see codeLook). */
function CodeIcon({ look }: { look: CodeLook }) {
  const label = look.icon === "branch" ? "Branch" : `${look.label} pull request`;
  const right = look.icon === "branch" ? { cx: 10, cy: 4.2 } : look.icon === "merged" ? { cx: 10, cy: 7.6 } : { cx: 10, cy: 10.8 };
  return (
    <svg className={`plan-icon code ${look.tone}`} width="14" height="14" viewBox="0 0 14 14" role="img" aria-label={label}>
      <circle cx="4" cy="3.2" r="1.5" />
      <circle cx="4" cy="10.8" r="1.5" />
      <circle {...right} r="1.5" />
      <path d="M4 4.7v4.6" />
      {look.icon === "branch" && <path d="M10 5.7c0 2.4-6 1.6-6 3.4" />}
      {look.icon === "pr" && <path d="M10 9.3V6.2a1.8 1.8 0 0 0-1.8-1.8H6.6m1.2-1.3-1.3 1.3 1.3 1.3" />}
      {look.icon === "merged" && <path d="M4 4.7c0 2 1.6 2.9 4.5 2.9" />}
      {look.icon === "closed" && <path d="M10 9.3V6.6M8.6 2.2l2.8 2.8M11.4 2.2 8.6 5" />}
      {look.icon === "draft" && (
        <>
          <circle className="dot" cx="10" cy="7.3" r="0.8" />
          <circle className="dot" cx="10" cy="4.3" r="0.8" />
        </>
      )}
    </svg>
  );
}

const CODE_STATE: Record<string, { text: string; status: string }> = {
  open: { text: "Open", status: "in_progress" },
  draft: { text: "Draft", status: "next" },
  merged: { text: "Merged", status: "done" },
  closed: { text: "Closed", status: "next" },
};
const CHECKS_TEXT = { passing: "Checks passing", failing: "Checks failing", pending: "Checks running" };
const REVIEW_TEXT = { approved: "Approved", changes: "Changes requested", needed: "Review needed" };

/** A pull request's or branch's state, as a lozenge's text and color. */
const codeState = (c: TrackedItem) => (c.kind === "branch" ? { text: "Branch", status: "next" } : (CODE_STATE[c.state] ?? { text: c.state, status: "next" }));
/** Its repo, checks, review and branch, for its state's hover. */
const codeAbout = (c: TrackedItem) => [c.repo, c.checks ? CHECKS_TEXT[c.checks] : null, c.review ? REVIEW_TEXT[c.review] : null, c.detail].filter(Boolean).join(" · ");

/** A pull request or branch on one line, for a workstream's Work: its mark, its title linking to GitHub, and its state. */
export function CodeLine({ code: c }: { code: TrackedItem }) {
  const state = codeState(c);
  return (
    <span className="code-line">
      <CodeIcon look={codeLook(c)} />
      <HoverTip text={c.title} whenClipped>
        <ExternalLink href={c.url} className="code-line-title clip-text">
          {c.title}
        </ExternalLink>
      </HoverTip>
      <HoverTip text={codeAbout(c) || null}>
        <span className={`badge plan-status ${state.status}`}>{state.text}</span>
      </HoverTip>
    </span>
  );
}

/** What a review card opens for: which change, on which part of the plan. */
type Review =
  | { kind: "epic"; index: number }
  | { kind: "initiative"; id: string }
  | { kind: "story"; index: number; item: number }
  | { kind: "create"; index: number; item: number }
  /** A story for a requirement no issue delivers: in the epic at `step`, or in no epic (under `initiative`, or at the top). */
  | { kind: "requirement"; step: number | null; initiative: string | null; id: string }
  | { kind: "move"; index: number; item: number };

/** What the plan's rows need from it. */
interface PlanContext {
  t: Timeline | null;
  /**
   * In the project's details rather than full screen: no timeline but a Progress column, and none of
   * the proposed changes' labels or actions (dashed icons show what's proposed), counts or Must badges.
   */
  compact: boolean;
  faceOf: (name: string) => string | null;
  open: Set<string>;
  toggle: (key: string) => void;
  /** Opens a change's review card; none while a change is being made. */
  review: ((r: Review) => void) | null;
  /** What's being made in Jira right now, and on what. */
  applying: { review: Review; status: string } | null;
  requirementsOf: { step: (i: number) => RequirementRow[]; item: (i: number, j: number) => RequirementRow[]; initiative: (id: string) => RequirementRow[] };
  /** The ticket created from the plan for a requirement outside any epic, until a refresh places it. */
  createdFor: (requirement: string) => PathToShip["created"][number] | undefined;
  /** The pull requests and branches for each part of the plan, by the Jira key they name. */
  codeOf: { step: (i: number) => PlacedMark<TrackedItem>[]; item: (i: number, j: number) => PlacedMark<TrackedItem>[]; initiative: (id: string) => PlacedMark<TrackedItem>[] };
}

const sameReview = (a: Review | null | undefined, b: Review) => !!a && JSON.stringify(a) === JSON.stringify(b);

/** "Making the change", with a spinner, on the row it's for. */
function Applying({ ctx, on }: { ctx: PlanContext; on: Review }) {
  return sameReview(ctx.applying?.review, on) ? (
    <span className="plan-action busy timestamp">
      <Spinner /> {ctx.applying!.status}
    </span>
  ) : null;
}

/** A story or task under its epic: its pull requests and branches after its icon, the requirements it delivers named in its title's hover. */
function ItemRows({ step, index, item, j, depth, ctx }: { step: PathStep; index: number; item: PathItem; j: number; depth: number; ctx: PlanContext }) {
  const key = itemKey(item);
  const from = proposedMove(item, step);
  const inJira = !!step.epic;
  const storyReview: Review = { kind: "story", index, item: j };
  const moveReview: Review = { kind: "move", index, item: j };
  const createReview: Review = { kind: "create", index, item: j };
  // Closed at first, like Jira: opening an epic shows its stories, and each opens to its pull requests.
  // The requirements it delivers are part of it, named in its title's hover.
  const delivers = ctx.requirementsOf.item(index, j).map((r) => r.requirement.text);
  return (
    <div className="plan-group" role="rowgroup">
      <Row depth={depth} className={`item ${item.status}`}>
        <span className="plan-work" role="cell">
          <Toggle open={false} label={item.title} />
          <ItemIcon type={item.type} ticket={!!key} />
          <CodeMarks marks={ctx.codeOf.item(index, j)} owner={key} />
          {key ? (
            <Linked href={item.link} className="plan-key">
              {key}
            </Linked>
          ) : (
            !ctx.compact && (
              <HoverTip text={`No ticket covers this work yet: a ${(item.type || "task").toLowerCase()} Demian proposes.`}>
                <span className="plan-key untracked">Proposed</span>
              </HoverTip>
            )
          )}
          <HoverTip text={delivers.length ? `${item.title}. Delivers: ${delivers.join("; ")}` : item.title} whenClipped={!delivers.length}>
            <Linked href={item.link} className="plan-title clip-text">
              {item.title}
            </Linked>
          </HoverTip>
          {!key && !ctx.compact && ctx.review && (
            <button className="link-button small plan-action" onClick={() => ctx.review?.(createReview)}>
              Create in Jira
            </button>
          )}
          {!ctx.compact &&
            (item.realign ? (
              <Proposal
                label="Epic in Jira"
                tip={`In Jira, ${key} is an epic. Demian reads it as a single issue's worth of work${item.realign.reason ? `: ${item.realign.reason}` : ""}. ${inJira ? `Apply makes it a story in ${step.epic!.key}.` : `Create "${step.what}" in Jira first, then apply.`}`}
                action={inJira && ctx.review ? "Apply in Jira" : undefined}
                onAction={() => ctx.review?.(storyReview)}
              />
            ) : (
              from !== undefined && (
                <Proposal
                  label={from ? `From ${from}` : "Not in an epic"}
                  tip={`In Jira, ${key} is ${from ? `in ${from}` : "in no epic"}. Demian puts it in ${inJira ? step.epic!.key : `"${step.what}"`}. ${inJira ? "Move puts it there in Jira." : "Creating that epic in Jira can move it there."}`}
                  action={inJira && ctx.review ? "Move" : undefined}
                  onAction={() => ctx.review?.(moveReview)}
                />
              )
            ))}
          <Applying ctx={ctx} on={storyReview} />
          <Applying ctx={ctx} on={moveReview} />
          <Applying ctx={ctx} on={createReview} />
        </span>
        <span className="plan-who" role="cell">
          <FaceStack names={item.assignee ? [item.assignee] : []} faceOf={ctx.faceOf} />
        </span>
        <span className="plan-state" role="cell">
          <StatusLozenge status={item.status} />
        </span>
        <span className="plan-due-date timestamp" role="cell">
          {due(item.date)}
        </span>
        <TimelineCell t={ctx.t} mark={dayOf(item.date)} className={item.status} />
        {ctx.compact && <ProgressCell />}
      </Row>
    </div>
  );
}

/** One epic's row, and its stories, tasks and requirements under it while it's open. */
function EpicRows({ step, index, depth, ctx }: { step: PathStep; index: number; depth: number; ctx: PlanContext }) {
  // Its work: its stories and tasks, and the stories proposed for the requirements none of them delivers.
  const proposedWork = asWork(ctx.requirementsOf.step(index));
  const statuses = [...(step.items ?? []).map((i) => i.status), ...proposedWork.map((r) => r.progress?.status ?? "pending")];
  const done = statuses.filter((st) => st === "done").length;
  const total = statuses.length;
  const items = step.items ?? [];
  const openKey = `s:${index}`;
  const open = ctx.open.has(openKey);
  const openable = items.length > 0 || proposedWork.length > 0;
  // A path saved before paths were epics has stages, with no epic at all (not even null): no label.
  const stage = step.epic === undefined;
  const proposed = !step.epic;
  const href = step.epic?.link ?? step.link;
  const review: Review = { kind: "epic", index };
  return (
    <>
      <Row depth={depth} className={`epic ${step.status}`} expanded={openable ? open : undefined}>
        <span className="plan-work" role="cell">
          <Toggle open={open} label={step.what} onClick={openable ? () => ctx.toggle(openKey) : undefined} />
          <EpicIcon proposed={proposed} />
          <CodeMarks marks={ctx.codeOf.step(index)} owner={step.epic?.key ?? null} />
          {stage ? null : proposed ? (
            !ctx.compact && <Proposal label="Proposed" tip="Not in Jira yet: an epic Demian proposes for work no epic covers." action={ctx.review ? "Create in Jira" : undefined} onAction={() => ctx.review?.(review)} />
          ) : (
            <Linked href={href} className="plan-key">
              {step.epic!.key}
            </Linked>
          )}
          <HoverTip text={step.summary ? `${step.what}: ${step.summary}` : step.what} whenClipped={!step.summary}>
            <Linked href={proposed ? step.link : href} className="plan-title clip-text">
              {step.what}
            </Linked>
          </HoverTip>
          <Applying ctx={ctx} on={review} />
          {!ctx.compact && total > 0 && (
            <span className="plan-count timestamp">
              {done}/{total}
            </span>
          )}
        </span>
        <span className="plan-who" role="cell">
          <FaceStack names={epicPeople(step)} faceOf={ctx.faceOf} />
        </span>
        <span className="plan-state" role="cell">
          <StatusLozenge status={step.status} />
        </span>
        <span className="plan-due-date timestamp" role="cell">
          {due(step.date)}
        </span>
        <TimelineCell t={ctx.t} bar={epicSpan(step)} className={`${step.status}${proposed ? " proposed" : ""}`} />
        {ctx.compact && <ProgressCell statuses={statuses} noun="issues" />}
      </Row>
      {open && items.map((item, j) => <ItemRows key={`${j}:${itemKey(item) ?? item.title}`} step={step} index={index} item={item} j={j} depth={depth + 1} ctx={ctx} />)}
      {open && <ProposedForRequirements rows={proposedWork} depth={depth + 1} ctx={ctx} at={{ step: index, initiative: null }} />}
    </>
  );
}

/** An initiative's row, then its epics and the requirements it delivers across them. */
function InitiativeRows({ group, ctx }: { group: PlanGroup & { initiative: PathInitiative }; ctx: PlanContext }) {
  const { initiative: init, steps } = group;
  const openKey = `i:${init.id}`;
  const open = ctx.open.has(openKey);
  const status = initiativeStatus(steps.map((s) => s.step));
  const done = steps.filter((s) => s.step.status === "done").length;
  const people = [...new Set(steps.flatMap((s) => epicPeople(s.step)))];
  const requirements = ctx.requirementsOf.initiative(init.id);
  const review: Review = { kind: "initiative", id: init.id };
  const proposed = !init.jira;
  return (
    <>
      <Row depth={0} className={`initiative ${status}`} expanded={open}>
        <span className="plan-work" role="cell">
          <Toggle open={open} label={init.what} onClick={() => ctx.toggle(openKey)} />
          <InitiativeIcon proposed={proposed || !!init.realign} />
          <CodeMarks marks={ctx.codeOf.initiative(init.id)} owner={init.jira?.key ?? null} />
          {init.jira && (
            <Linked href={init.jira.link} className="plan-key">
              {init.jira.key}
            </Linked>
          )}
          {!ctx.compact &&
            (proposed ? (
              <Proposal label="Proposed" tip="Not in Jira yet: an initiative Demian proposes for epics that share a goal." action={ctx.review ? "Create in Jira" : undefined} onAction={() => ctx.review?.(review)} />
            ) : (
              init.realign && (
                <Proposal
                  label="Epic in Jira"
                  tip={`In Jira, ${init.jira!.key} is an epic. Demian reads it as an initiative's worth of work${init.realign.reason ? `: ${init.realign.reason}` : ""}, split into the epics under it. Apply makes Jira match.`}
                  action={ctx.review ? "Apply in Jira" : undefined}
                  onAction={() => ctx.review?.(review)}
                />
              )
            ))}
          <HoverTip text={init.summary ? `${init.what}: ${init.summary}` : init.what} whenClipped={!init.summary}>
            <span className="plan-title clip-text">{init.what}</span>
          </HoverTip>
          <Applying ctx={ctx} on={review} />
          {!ctx.compact && (
            <span className="plan-count timestamp">
              {done}/{steps.length}
            </span>
          )}
        </span>
        <span className="plan-who" role="cell">
          <FaceStack names={people} faceOf={ctx.faceOf} />
        </span>
        <span className="plan-state" role="cell">
          <StatusLozenge status={status} />
        </span>
        <span className="plan-due-date timestamp" role="cell">
          {due(latest(steps.map((s) => s.step.date)))}
        </span>
        <TimelineCell t={ctx.t} bar={initiativeSpan(steps.map((s) => s.step))} className={`initiative${proposed || init.realign ? " proposed" : ""}`} />
        {ctx.compact && <ProgressCell statuses={steps.map((s) => s.step.status)} noun="epics" />}
      </Row>
      {open && steps.map(({ step, index }) => <EpicRows key={`${index}:${step.what}`} step={step} index={index} depth={1} ctx={ctx} />)}
      {open && <ProposedForRequirements rows={requirements} depth={1} ctx={ctx} at={{ step: null, initiative: init.id }} />}
    </>
  );
}

/**
 * A project's tracking as its last refresh found it (its epics' counts, its pull requests and branches,
 * and the repos it couldn't read), read again when the data changes. Null until it's read, and never
 * another project's while this one's loads.
 */
export function useTracking(projectId: string): ProjectTracking | null {
  const version = useSyncExternalStore(dataVersion.subscribe, dataVersion.get);
  const [got, setGot] = useState<{ id: string; tracking: ProjectTracking | null } | null>(null);
  useEffect(() => {
    let live = true;
    getProjectTracking().then(
      (t) => live && setGot({ id: projectId, tracking: t[projectId] ?? null }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [projectId, version]);
  return got?.id === projectId ? got.tracking : null;
}

/** A project's pull requests and branches, as its last refresh found them. */
export function useTrackedCode(projectId: string): TrackedItem[] {
  const tracking = useTracking(projectId);
  return useMemo(() => (tracking?.items ?? []).filter((i) => i.kind !== "epic"), [tracking]);
}

/**
 * The project's work as a plan, the way Jira's plan view shows it: initiatives, their epics, and the
 * epics' stories and tasks, each placed by the level of work it effectively is, with the guiding doc's
 * requirements under what delivers them. Who's on each, how it stands, when it's due, and a timeline
 * of when each epic runs (today and the ship date marked). Wherever the plan differs from Jira (an
 * epic or initiative Demian proposes, an epic it reads as an initiative or a story, a story it puts
 * in another epic) it's marked as proposed, and nothing changes in Jira until you review the change
 * and apply it.
 */
export function PlanView({ project, path, shipDate, full = false }: { project: Project; path: PathToShip; shipDate: string | null | undefined; full?: boolean }) {
  const steps = path.steps;
  const groups = planGroups(path);
  // The timeline is full screen's; the project's details show a Progress column instead.
  const t = full ? planTimeline(steps, shipDate) : null;
  const [open, setOpen] = useState(() => {
    const first = openAtFirst(steps);
    const keys = [...first].map((i) => `s:${i}`);
    for (const g of groups) if (g.initiative && g.steps.some((s) => first.has(s.index))) keys.push(`i:${g.initiative.id}`);
    return new Set(keys);
  });
  const toggle = (key: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  // The guiding doc's requirements, each under what delivers it.
  const rows = requirementRows(project);
  const rowById = new Map(rows.map((r) => [r.requirement.id, r]));
  const placed = placeRequirements(steps, rows.map((r) => r.requirement.id), path.initiatives ?? []);
  const rowsOf = (ids: string[] | undefined) => (ids ?? []).flatMap((id) => (rowById.has(id) ? [rowById.get(id)!] : []));
  const leftover = rowsOf(placed.rest);

  // The project's pull requests and branches (from its last refresh), each under the work it names.
  const code = useTrackedCode(project.channel_id);
  const placedCode = placeCode(path, code, fromLink);

  const [review, setReview] = useState<Review | null>(null);
  const [lastReview, setLastReview] = useState<Review | null>(null);
  const applying = useRunningJobs().includes(planApplyKey(project.channel_id));
  const status = useJobStatus(planApplyKey(project.channel_id));
  const ctx: PlanContext = {
    t,
    compact: !full,
    faceOf: faceFinder(project),
    open,
    toggle,
    review: applying
      ? null
      : (r) => {
          setReview(r);
          setLastReview(r);
        },
    applying: applying && lastReview ? { review: lastReview, status: status && status !== "Working" ? status : "Making the change" } : null,
    requirementsOf: {
      step: (i) => rowsOf(placed.byStep.get(i)),
      item: (i, j) => rowsOf(placed.byItem.get(`${i}:${j}`)),
      initiative: (id) => rowsOf(placed.byInitiative.get(id)),
    },
    createdFor: (requirement) => (path.created ?? []).find((c) => c.requirement === requirement),
    codeOf: {
      step: (i) => placedCode.byStep.get(i) ?? [],
      item: (i, j) => placedCode.byItem.get(`${i}:${j}`) ?? [],
      initiative: (id) => placedCode.byInitiative.get(id) ?? [],
    },
  };
  const openable = [
    ...groups.flatMap((g) => (g.initiative ? [`i:${g.initiative.id}`] : [])),
    ...steps.flatMap((s, i) => (s.items?.length || asWork(rowsOf(placed.byStep.get(i))).length ? [`s:${i}`] : [])),
  ];
  const allOpen = openable.length > 0 && openable.every((k) => open.has(k));
  return (
    <div className="plan-wrap">
      <div className={`plan${t ? " with-timeline" : ""}${full ? "" : " with-progress"}`} role="table" aria-label="Plan">
        <div className="plan-row plan-head" role="row">
          <span className="plan-work" role="columnheader">
            Work
            {full && openable.length > 0 && (
              <button className="link-button small plan-all" onClick={() => setOpen(allOpen ? new Set() : new Set(openable))}>
                {allOpen ? "Close all" : "Open all"}
              </button>
            )}
          </span>
          <span className="plan-who" role="columnheader">
            Who
          </span>
          <span className="plan-state" role="columnheader">
            Status
          </span>
          <span className="plan-due-date" role="columnheader">
            Due
          </span>
          {!full && (
            <span className="plan-progress" role="columnheader">
              Progress
            </span>
          )}
          {t && (
            <span className="plan-timeline-cell plan-scale" role="columnheader" aria-label="Timeline">
              {/* Labels too near the right edge to fit are left out. */}
              {t.ticks
                .filter((tick) => at(t, tick.day) <= 80)
                .map((tick) => (
                  <span key={tick.day} className="plan-tick" style={{ left: `${at(t, tick.day)}%` }}>
                    {tick.label}
                  </span>
                ))}
              {t.ship !== null && <span className="plan-ship-mark" style={{ left: `${at(t, t.ship + 0.5)}%` }} aria-hidden />}
            </span>
          )}
        </div>
        {groups.map((g) =>
          g.initiative ? (
            <InitiativeRows key={`i:${g.initiative.id}`} group={g as PlanGroup & { initiative: PathInitiative }} ctx={ctx} />
          ) : (
            <EpicRows key={`s:${g.steps[0].index}:${g.steps[0].step.what}`} step={g.steps[0].step} index={g.steps[0].index} depth={0} ctx={ctx} />
          ),
        )}
        {/* Requirements nothing on the plan delivers (before a refresh has placed them, all of them): proposed stories in no epic. */}
        <ProposedForRequirements rows={leftover} depth={0} ctx={ctx} at={{ step: null, initiative: null }} loose={steps.length ? "unplaced" : "unplanned"} />
      </div>
      {review && <ReviewFor project={project} path={path} review={review} requirements={ctx.requirementsOf} onClose={() => setReview(null)} />}
    </div>
  );
}

// ---- review cards: each change Demian proposes, to look over (and adjust) before it's made in Jira

/**
 * A change to review before it's made in Jira: what it does, its fields, and Apply. Nothing changes
 * in Jira until Apply; while it runs the card stays, and says what went wrong if Jira refuses.
 */
function ReviewCard({
  title,
  applyLabel,
  canApply,
  onApply,
  onClose,
  children,
}: {
  title: string;
  applyLabel: string;
  canApply: boolean;
  /** Makes the change; resolves to a warning to show (the card stays open), or null when it's done. */
  onApply: () => Promise<string | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);
  const apply = () => {
    setBusy(true);
    setError(null);
    onApply().then(
      (warning) => {
        setBusy(false);
        if (warning) setError(warning);
        else onClose();
      },
      (e: Error) => {
        setBusy(false);
        setError(e.message);
      },
    );
  };
  return createPortal(
    <div className="modal-backdrop plan-modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal plan-modal plan-review" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header className="column-header">
          <h2>{title}</h2>
        </header>
        {children}
        {error && <p className="error small">{error}</p>}
        <footer className="plan-modal-actions edit-actions">
          <button className="cta-ghost" onClick={onClose} disabled={busy}>
            {error && !busy ? "Close" : "Cancel"}
          </button>
          <button className="cta-primary" onClick={apply} disabled={!canApply || busy}>
            {busy ? (
              <>
                <Spinner /> Working
              </>
            ) : (
              applyLabel
            )}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/** A labeled field on a review card. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="plan-review-field">
      <span className="small muted">{label}</span>
      {children}
    </label>
  );
}

/** The Jira project to create in: a key, with the likely ones offered. */
function ProjectKeyField({ value, keys, onChange }: { value: string; keys: string[]; onChange: (v: string) => void }) {
  return (
    <Field label="Jira project">
      <input className="lesson-edit plan-review-key" list="plan-project-keys" value={value} placeholder="ABC" aria-label="Jira project key" onChange={(e) => onChange(e.target.value)} />
      <datalist id="plan-project-keys">
        {keys.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
    </Field>
  );
}

const validKey = (key: string) => /^[A-Z][A-Z0-9_]+$/.test(key);

/** The tickets a proposed epic gathers, and where each is in Jira now. */
const ticketsOf = (step: PathStep) => (step.items ?? []).flatMap((i) => (itemKey(i) && !i.realign ? [{ key: itemKey(i)!, from: i.jira_parent ?? null }] : []));
const ticketText = (t: { key: string; from: string | null }) => (t.from ? `${t.key} (from ${t.from})` : t.key);

/** Whichever card the change calls for. */
function ReviewFor({
  project,
  path,
  review,
  requirements,
  onClose,
}: {
  project: Project;
  path: PathToShip;
  review: Review;
  requirements: PlanContext["requirementsOf"];
  onClose: () => void;
}) {
  const id = project.channel_id;
  const others = [...path.steps.flatMap((s) => (s.epic ? [s.epic.key] : [])), ...activeEpics(project).map((e) => e.epic_key)];
  const doc = guideTitle(project) ?? project.docs?.doc?.title ?? null;
  if (review.kind === "epic") {
    const step = path.steps[review.index];
    if (!step) return null;
    const init = (path.initiatives ?? []).find((i) => i.id === step.initiative);
    // Under its initiative when that's an Initiative in Jira (not an epic Demian reads as one).
    const parent = init?.jira && !init.realign ? init.jira.key : null;
    // The requirements it delivers: its stories' and tasks', and any left on the epic itself.
    const delivers = [...(step.items ?? []).flatMap((_, j) => requirements.item(review.index, j)), ...requirements.step(review.index)].map((r) => r.requirement.text);
    return <EpicCard step={step} keys={epicProjectKeys(step, others)} parent={parent} requirements={delivers} doc={doc} onClose={onClose} onApply={(e) => createProposedEpic(id, step.what, e)} />;
  }
  if (review.kind === "initiative") {
    const init = (path.initiatives ?? []).find((i) => i.id === review.id);
    if (!init) return null;
    const children = path.steps.map((step, index) => ({ step, index })).filter((s) => s.step.initiative === init.id);
    const keys = [...new Set(children.flatMap((c) => epicProjectKeys(c.step, others)))];
    // The requirements it delivers: its epics' stories' and tasks', its epics', and its own.
    const delivers = [
      ...children.flatMap((c) => [...(c.step.items ?? []).flatMap((_, j) => requirements.item(c.index, j)), ...requirements.step(c.index)]),
      ...requirements.initiative(init.id),
    ].map((r) => r.requirement.text);
    return <InitiativeCard init={init} children={children.map((c) => c.step)} keys={keys} requirements={delivers} doc={doc} onClose={onClose} onApply={(change) => applyInitiative(id, init.id, change)} />;
  }
  if (review.kind === "requirement") {
    const row = requirementRows(project).find((r) => r.requirement.id === review.id);
    if (!row) return null;
    const step = review.step === null ? null : (path.steps[review.step] ?? null);
    const text = row.requirement.text.trim();
    return (
      <ItemCard
        title={text.length > 120 ? `${text.slice(0, 119).trimEnd()}…` : text}
        type="Story"
        epic={step?.epic?.key ?? null}
        epicName={step?.what ?? null}
        keys={epicProjectKeys(step ?? { items: [] }, others)}
        description={itemDescription(step, [text], doc)}
        onClose={onClose}
        onApply={(change) => createProposedItem(id, { requirement: row.requirement.id, step: step?.what ?? null }, change)}
      />
    );
  }
  const step = path.steps[review.index];
  const item = step?.items?.[review.item];
  if (review.kind === "create") {
    if (!step || !item || itemKey(item)) return null;
    return (
      <ItemCard
        title={item.title}
        type={item.type?.trim() || "Task"}
        epic={step.epic?.key ?? null}
        epicName={step.what}
        keys={epicProjectKeys(step, others)}
        description={itemDescription(
          step,
          requirements.item(review.index, review.item).map((r) => r.requirement.text),
          doc,
          // The code it was proposed for, so the new ticket links it.
          [...(item.code ?? []), ...(item.suggested_code ?? [])],
        )}
        onClose={onClose}
        onApply={(change) => createProposedItem(id, { id: item.id, title: item.title }, change)}
      />
    );
  }
  if (!step?.epic || !item?.key) return null;
  if (review.kind === "story") return <StoryCard item={item} into={step.epic.key} onClose={onClose} onApply={(replace) => applyStory(id, { key: item.key!, into: step.epic!.key, replace })} />;
  return (
    <ReviewCard title="Move it in Jira" applyLabel="Move" canApply onClose={onClose} onApply={() => moveIntoEpic(id, item.key!, step.epic!.key).then(() => null)}>
      <p className="small">
        Put {item.key} ({item.title}) in {step.epic.key}, {step.what}. In Jira it's {item.jira_parent ? `in ${item.jira_parent}` : "in no epic"} now.
      </p>
    </ReviewCard>
  );
}

/** Creating an epic Demian proposed: where, its name and description, and which of its tickets move into it. */
function EpicCard({
  step,
  keys,
  parent,
  requirements,
  doc,
  onApply,
  onClose,
}: {
  step: PathStep;
  keys: string[];
  parent: string | null;
  requirements: string[];
  doc: string | null;
  onApply: (e: { projectKey: string; summary: string; description: string; move: string[]; parent: string | null }) => Promise<{ key?: string | null; not_moved: string[] }>;
  onClose: () => void;
}) {
  const [projectKey, setProjectKey] = useState(keys[0] ?? "");
  const [summary, setSummary] = useState(step.what);
  const [description, setDescription] = useState(() => epicDescription(step, requirements, doc));
  const tickets = ticketsOf(step);
  // Moving its tickets in is part of the proposal; untick to create the epic alone.
  const [move, setMove] = useState(true);
  const key = projectKey.trim().toUpperCase();
  return (
    <ReviewCard
      title="Create the epic in Jira"
      applyLabel="Create"
      canApply={validKey(key) && !!summary.trim()}
      onClose={onClose}
      onApply={() =>
        onApply({ projectKey: key, summary: summary.trim(), description: description.trim(), move: move ? tickets.map((t) => t.key) : [], parent }).then((done) =>
          done.not_moved.length ? `Created ${done.key}, but Jira didn't move ${done.not_moved.join(", ")} into it.` : null,
        )
      }
    >
      <ProjectKeyField value={projectKey} keys={keys} onChange={setProjectKey} />
      <Field label="Name">
        <input className="lesson-edit" value={summary} aria-label="Epic name" onChange={(e) => setSummary(e.target.value)} />
      </Field>
      <Field label="Description">
        <textarea className="description-editor" rows={8} value={description} aria-label="Epic description" onChange={(e) => setDescription(e.target.value)} />
      </Field>
      {parent && <p className="small muted">It goes under its initiative, {parent}.</p>}
      {tickets.length > 0 && (
        <label className="plan-review-check small">
          <input type="checkbox" checked={move} onChange={(e) => setMove(e.target.checked)} />
          Move its {tickets.length === 1 ? "ticket" : `${tickets.length} tickets`} into the new epic: {tickets.map(ticketText).join(", ")}
        </label>
      )}
    </ReviewCard>
  );
}

/**
 * Putting an initiative in Jira: a proposed one, or a Jira epic Demian reads as an initiative's worth
 * of work. Lists everything it does: the initiative, the epics created under it (and the tickets that
 * move into them), and the epics already in Jira that go under it.
 */
function InitiativeCard({
  init,
  children,
  keys,
  requirements,
  doc,
  onApply,
  onClose,
}: {
  init: PathInitiative;
  children: PathStep[];
  keys: string[];
  requirements: string[];
  doc: string | null;
  onApply: (change: Parameters<typeof applyInitiative>[2]) => Promise<{ key?: string | null; not_moved: string[] }>;
  onClose: () => void;
}) {
  // Already an Initiative in Jira: only its epics change.
  const existing = init.jira && !init.realign ? init.jira.key : null;
  const [projectKey, setProjectKey] = useState(init.jira?.key.split("-")[0] ?? keys[0] ?? "");
  const [summary, setSummary] = useState(init.what);
  const [description, setDescription] = useState(() =>
    [init.summary ?? "", `Epics:\n${children.map((s) => `- ${s.epic ? `${s.epic.key} ` : ""}${s.what}`).join("\n")}`, requirements.length ? `Requirements it delivers${doc ? ` (from ${doc})` : ""}:\n${requirements.map((r) => `- ${r}`).join("\n")}` : ""]
      .filter(Boolean)
      .join("\n\n"),
  );
  const newEpics = children.filter((s) => !s.epic);
  const jiraEpics = children.filter((s) => s.epic).map((s) => s.epic!.key);
  const key = projectKey.trim().toUpperCase();
  const [moveTickets, setMoveTickets] = useState(true);
  const title = existing ? `Put ${existing}'s epics in Jira` : init.realign ? "Apply Demian's change in Jira" : "Create the initiative in Jira";
  return (
    <ReviewCard
      title={title}
      applyLabel={existing ? "Apply" : init.realign ? "Apply" : "Create"}
      canApply={validKey(key) && !!summary.trim() && (!existing || newEpics.length + jiraEpics.length > 0)}
      onClose={onClose}
      onApply={() =>
        onApply({
          projectKey: key,
          key: existing,
          summary: summary.trim(),
          description: description.trim(),
          newEpics: newEpics.map((s) => ({ name: s.what, description: s.summary ?? "", move: moveTickets ? ticketsOf(s).map((t) => t.key) : [] })),
          epics: jiraEpics,
        }).then((done) => (done.not_moved.length ? `Made the change, but Jira refused to move ${done.not_moved.join(", ")}.` : null))
      }
    >
      {init.realign && (
        <p className="small">
          In Jira, {init.jira!.key} is an epic. Demian reads it as an initiative's worth of work{init.realign.reason ? `: ${init.realign.reason}` : "."} Applying creates an initiative and
          puts {init.jira!.key} under it, with the epics below for the rest of its work.
        </p>
      )}
      {!existing && (
        <>
          <ProjectKeyField value={projectKey} keys={keys} onChange={setProjectKey} />
          <Field label="Initiative name">
            <input className="lesson-edit" value={summary} aria-label="Initiative name" onChange={(e) => setSummary(e.target.value)} />
          </Field>
          <Field label="Description">
            <textarea className="description-editor" rows={7} value={description} aria-label="Initiative description" onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </>
      )}
      {newEpics.length > 0 && (
        <div className="plan-review-list small">
          <span className="muted">Epics it creates under {existing ?? "the initiative"}</span>
          <ul>
            {newEpics.map((s) => {
              const tickets = ticketsOf(s);
              return (
                <li key={s.what}>
                  {s.what}
                  {tickets.length > 0 && <span className="muted">, with {tickets.map(ticketText).join(", ")}</span>}
                </li>
              );
            })}
          </ul>
          {newEpics.some((s) => ticketsOf(s).length) && (
            <label className="plan-review-check">
              <input type="checkbox" checked={moveTickets} onChange={(e) => setMoveTickets(e.target.checked)} />
              Move those tickets into their new epics
            </label>
          )}
        </div>
      )}
      {jiraEpics.length > 0 && (
        <div className="plan-review-list small">
          <span className="muted">Epics already in Jira that go under {existing ?? "it"}</span>
          <ul>
            {jiraEpics.map((k) => (
              <li key={k}>{k}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="small muted">Tasks with no ticket stay proposals: nothing else is created.</p>
    </ReviewCard>
  );
}

/** The standard issue types, offered when creating a story or task (any of the project's own can be typed). */
const STANDARD_TYPES = ["Story", "Task", "Bug", "Spike"];

/**
 * Creating a story or task Demian proposed (for work in no ticket, or for a requirement no issue
 * delivers): where, its type, name and description, in its epic when that's in Jira.
 */
function ItemCard({
  title,
  type,
  epic,
  epicName,
  keys,
  description: start,
  onApply,
  onClose,
}: {
  title: string;
  type: string;
  /** Its epic's key when that's in Jira. */
  epic: string | null;
  /** Its epic's name, when it has one (in Jira or proposed). */
  epicName: string | null;
  keys: string[];
  description: string;
  onApply: (change: { projectKey: string; issueType: string; summary: string; description: string; parent: string | null }) => Promise<ItemCreated>;
  onClose: () => void;
}) {
  const parent = epic;
  const [projectKey, setProjectKey] = useState(parent?.split("-")[0] ?? keys[0] ?? "");
  const [issueType, setIssueType] = useState(type);
  const [summary, setSummary] = useState(title);
  const [description, setDescription] = useState(start);
  const key = projectKey.trim().toUpperCase();
  const types = [...new Set([type, ...STANDARD_TYPES])];
  return (
    <ReviewCard
      title={`Create the ${issueType.trim().toLowerCase() || "issue"} in Jira`}
      applyLabel="Create"
      canApply={validKey(key) && !!issueType.trim() && !!summary.trim()}
      onClose={onClose}
      onApply={() =>
        onApply({ projectKey: key, issueType: issueType.trim(), summary: summary.trim(), description: description.trim(), parent }).then((done) =>
          parent && !done.parent ? `Created ${done.key}, but Jira didn't put it in ${parent}.` : null,
        )
      }
    >
      <ProjectKeyField value={projectKey} keys={keys} onChange={setProjectKey} />
      <Field label="Issue type">
        <input className="lesson-edit plan-review-type" list="plan-issue-types" value={issueType} aria-label="Issue type" onChange={(e) => setIssueType(e.target.value)} />
        <datalist id="plan-issue-types">
          {types.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </Field>
      <Field label="Name">
        <input className="lesson-edit" value={summary} aria-label="Name" onChange={(e) => setSummary(e.target.value)} />
      </Field>
      <Field label="Description">
        <textarea className="description-editor" rows={6} value={description} aria-label="Description" onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <p className="small muted">
        {parent
          ? `It goes in its epic, ${parent}.`
          : epicName
            ? `Its epic, "${epicName}", isn't in Jira yet, so it's created in no epic. Creating that epic can move it in.`
            : "It's created in no epic."}
      </p>
    </ReviewCard>
  );
}

/** Making a story-sized Jira epic a story in the epic the plan puts it in. */
function StoryCard({ item, into, onApply, onClose }: { item: PathItem; into: string; onApply: (replace: boolean) => Promise<unknown>; onClose: () => void }) {
  const [replace, setReplace] = useState(false);
  return (
    <ReviewCard title="Apply Demian's change in Jira" applyLabel="Apply" canApply onClose={onClose} onApply={() => onApply(replace).then(() => null)}>
      <p className="small">
        In Jira, {item.key} ({item.title}) is an epic. Demian reads it as a single issue's worth of work{item.realign?.reason ? `: ${item.realign.reason}` : "."} Applying makes it a story
        in {into}.
      </p>
      <label className="plan-review-check small">
        <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
        If Jira won't change an epic's type, create a story in its place in {into}, move its issues there, and link the two ({item.key} stays open for you to close)
      </label>
    </ReviewCard>
  );
}
