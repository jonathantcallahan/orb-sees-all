import type { AdhocStore, ManualTask, Project } from "./db";
import type { Blocker, ManualAssessment, Priority } from "./schema";
import { projectName } from "./projects";
import { newsKey, projectUpdateKey } from "./inboxMoves";
import { blockerKey, myBlockingIds, PRIORITY_RANK, stateOf, taskPriority, type TaskState } from "./tasks";

export interface ReadingInput {
  projects: Project[];
  adhoc: AdhocStore;
  manual: ManualTask[];
  assessments: Map<string, ManualAssessment>;
  states: Map<string, TaskState>;
  today: string;
  /** Priorities the user set by hand, which outrank the assessed ones. */
  priorityOverrides?: Record<string, Priority>;
  /** Due dates you set by hand, by task id: they win over the ones refreshes found. */
  dueOverrides?: Record<string, { due: string | null }>;
}

/** The most key projects the briefing covers, and the most of each list it's given. */
const MAX_PROJECTS = 6;
const MAX_UPDATES = 4;
const MAX_TASKS = 10;
const MAX_PEOPLE = 25;
const MAX_REPLIES = 15;
const MAX_NEWS = 5;

const LEVEL: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };
/** A task's priority as a rank; unrated tasks come after every rated one. */
const rank = (p: keyof typeof PRIORITY_RANK | null) => (p ? PRIORITY_RANK[p] : Object.keys(PRIORITY_RANK).length);
const TROUBLE: Record<string, number> = { blocked: 0, at_risk: 1, on_track: 2, idle: 3 };

/**
 * What the daily briefing is written from: the key projects (P0 and P1, and a P2 that's blocked or
 * at risk), with what changed on each and when; the outstanding tasks that matter most; the people
 * behind those projects, whose new messages the briefing looks for; and replies waiting on the user.
 * Every update keeps its date, so the briefing can tell what's new from what isn't.
 */
export function readingContext(r: ReadingInput) {
  const open = (id: string) => {
    const st = stateOf(r.states, id);
    return !st.done && !st.dismissed;
  };
  const openBlockers = (list: Blocker[] = []) => list.filter((b) => !stateOf(r.states, blockerKey(b.id)).dismissed);
  // An update you moved to the inbox is in replies_waiting now, not an update as well.
  const inInbox = new Set(r.adhoc.replies.map((x) => x.id));

  const key = r.projects
    .filter((p) => !p.hidden && p.snapshot)
    .filter((p) => {
      const level = LEVEL[p.snapshot!.priority?.level ?? "P4"];
      return level <= 1 || (level === 2 && (p.snapshot!.status === "blocked" || p.snapshot!.status === "at_risk"));
    })
    .sort(
      (a, b) =>
        LEVEL[a.snapshot!.priority?.level ?? "P4"] - LEVEL[b.snapshot!.priority?.level ?? "P4"] ||
        (TROUBLE[a.snapshot!.status] ?? 9) - (TROUBLE[b.snapshot!.status] ?? 9),
    )
    .slice(0, MAX_PROJECTS);

  const projects = key.map((p) => {
    const s = { ...p.snapshot!, blockers: openBlockers(p.snapshot!.blockers) };
    return {
      name: projectName(p),
      priority: s.priority?.level,
      status: s.status,
      status_reason: s.status_reason,
      my_role: s.raci?.role,
      // When the project was last read: what it says is as of then.
      as_of: p.last_refreshed_at?.slice(0, 10) ?? null,
      blocked_on_me: (s.blockers ?? []).filter((b) => b.owners.some((o) => o.is_me)).map((b) => b.what),
      blocked_on_others: (s.blockers ?? []).filter((b) => !b.owners.some((o) => o.is_me)).map((b) => `${b.what} (${b.owners.map((o) => o.name).join(", ")})`),
      recent_updates: [...(s.recent_updates ?? [])]
        .filter((u) => !inInbox.has(projectUpdateKey(p.channel_id, u)))
        .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
        .slice(0, MAX_UPDATES)
        .map((u) => ({ what: u.summary, date: u.date ?? null })),
      next_milestones: (p.profile?.milestones ?? [])
        .filter((m) => m.status === "planned" || m.status === "at_risk")
        .slice(0, 3)
        .map((m) => ({ what: m.what, date: m.date ?? null, status: m.status })),
    };
  });

  // The people behind the key projects: whose new messages are worth the user's minute.
  const seen = new Set<string>();
  const people = key
    .flatMap((p) => (p.profile?.people ?? []).map((person) => ({ name: person.name, role: person.role, project: projectName(p) })))
    .filter((person) => {
      const k = person.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, MAX_PEOPLE);

  const tasks = [
    ...r.projects.flatMap((p) =>
      (p.snapshot?.my_tasks ?? []).map((t) => ({
        id: t.id,
        title: t.title,
        project: projectName(p),
        a: t.assessment,
        projectPriority: p.snapshot?.priority?.level,
        blocking: myBlockingIds(p.snapshot?.blockers, r.states).includes(t.id),
        due: t.due,
      })),
    ),
    ...r.adhoc.tasks.map((t) => ({ id: t.id, title: t.title, project: null, a: t.assessment, projectPriority: null, blocking: false, due: t.due })),
    ...r.manual.map((t) => ({ id: t.id, title: t.title, project: null, a: r.assessments.get(t.id), projectPriority: null, blocking: false, due: null })),
  ]
    .filter((t) => open(t.id))
    .map((t) => ({
      id: t.id,
      title: t.title,
      project: t.project,
      priority: taskPriority(t.a?.priority, t.projectPriority, t.blocking, r.priorityOverrides?.[t.id]),
      due: r.dueOverrides?.[t.id] ? r.dueOverrides[t.id].due : (t.due ?? null),
    }))
    // Most pressing first: by priority, then the nearest due date.
    .sort((a, b) => rank(a.priority) - rank(b.priority) || (a.due ?? "9999").localeCompare(b.due ?? "9999"))
    .slice(0, MAX_TASKS);

  return {
    today: r.today,
    projects,
    people,
    tasks,
    replies_waiting: r.adhoc.replies
      .filter((x) => open(x.id))
      .sort((a, b) => (b.received ?? "").localeCompare(a.received ?? ""))
      .slice(0, MAX_REPLIES)
      .map((x) => ({ from: x.from, about: x.summary, where: x.where ?? null, received: x.received?.slice(0, 10) ?? null })),
    news: r.adhoc.news.filter((n) => !inInbox.has(newsKey(n))).slice(0, MAX_NEWS).map((n) => ({ what: n.headline, date: n.date ?? null })),
  };
}

/** What mail clients put before a subject, and what calendar invites do. */
const REPLY_PREFIX = /^(?:re|fwd?|fw|aw)\s*:\s*/i;
const INVITE_PREFIX = /^(?:invitation|updated invitation|accepted|declined|tentatively accepted|canceled event|cancelled event)\s*:\s*/i;
/** An invite's "@ Mon Nov 17, 2026 10am - 11am (CST) (…)" tail. */
const INVITE_WHEN = /\s+@\s+(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\b.*$/is;

/**
 * An update's eyebrow from where it was posted: "#channel", or "Email: " and the subject without
 * what mail clients put around it (Re:, Fwd:, and a calendar invite's "Invitation:" and its "@ date"
 * tail), so it fits on one line. A long one is still cut short where it's shown. An "@" in the
 * subject itself ("Lunch @ the new office") stays.
 */
export function updateLabel(where: string | null | undefined): string {
  if (!where) return "News";
  const email = where.match(/^email:\s*(.*)$/is);
  if (!email) return where.trim();
  let subject = email[1].trim();
  let invite = false;
  for (;;) {
    if (REPLY_PREFIX.test(subject)) subject = subject.replace(REPLY_PREFIX, "");
    else if (INVITE_PREFIX.test(subject)) {
      subject = subject.replace(INVITE_PREFIX, "");
      invite = true;
    } else break;
  }
  subject = (invite ? subject.replace(/\s+@\s.*$/s, "") : subject.replace(INVITE_WHEN, "")).trim();
  return subject ? `Email: ${subject}` : "Email";
}
