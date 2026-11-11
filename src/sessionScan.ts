/**
 * Finding the tasks in your Claude Code sessions, on each full refresh (see scanClaudeSessions): a
 * session that's an open task's work is connected to it (see connectSession), and one that's
 * unfinished work no task covers becomes a task of your own, connected to it. Anything else (a
 * question that was answered, work that's finished) is left alone. The card says what the scan did,
 * with Disconnect to undo it, and a session you disconnect is never connected again by the scan.
 */
import type { SessionScan } from "./schema";
import { SKIP_ALWAYS, type RecentSession, type SessionLink } from "./sessions";

export interface SessionScanDecision {
  decision: "connected" | "created" | "skipped" | "declined";
  taskId?: string;
  /**
   * When it was decided (ms). For a skipped session, its last activity as the scan saw it, so it's
   * looked at again once it carries on.
   */
  at: number;
}

/**
 * The sessions for list_sessions to leave out, before it reads them: those the scan has settled
 * (connected, made a task of, or you disconnected) and those a task follows, for good; skipped ones
 * until they carry on.
 */
export function scanSkips(decisions: Record<string, SessionScanDecision>, links: Record<string, SessionLink>): Record<string, number> {
  const skip: Record<string, number> = {};
  for (const [id, d] of Object.entries(decisions)) skip[id] = d.decision === "skipped" ? d.at : SKIP_ALWAYS;
  for (const l of Object.values(links)) if (l.sessionId) skip[l.sessionId] = SKIP_ALWAYS;
  return skip;
}

/**
 * Where the next scan looks from (ms). When more sessions were waiting than one scan takes, from
 * where this one did: those it settled are left out next time, so it gets to the rest. Otherwise
 * from the oldest session it left for next time (not answered for, or past the cap on new tasks),
 * or from now; less a margin for clocks.
 */
export function nextScanSince(p: { now: number; since: number; more: boolean; waiting: RecentSession[]; decided: Set<string>; marginMs: number }): number {
  if (p.more) return p.since;
  const left = p.waiting.filter((s) => !p.decided.has(s.sessionId)).map((s) => s.modifiedMs);
  return Math.min(p.now, ...left) - p.marginMs;
}

/** The sessions worth looking at: new to the scan, or skipped before and active since. */
export function scanCandidates(sessions: RecentSession[], decisions: Record<string, SessionScanDecision>): RecentSession[] {
  return sessions.filter((s) => {
    const d = decisions[s.sessionId];
    return !d || (d.decision === "skipped" && s.modifiedMs > d.at);
  });
}

export type SessionMatch =
  | { action: "connect"; session: RecentSession; taskId: string; why: string }
  | { action: "new"; session: RecentSession; title: string; description: string | null; projectId: string | null; why: string }
  | { action: "skip"; session: RecentSession; why: string };

/**
 * The scan's answers that hold up, for the sessions it was shown (newest first):
 * - a connection only to an open task that follows no session yet, and one session per task (the
 *   newest that's its work);
 * - a new task only with a title, filed under a project only if it's one of yours; past `maxNew`
 *   of them, the rest are left for the next scan.
 * Anything else becomes a skip. A session the scan didn't answer for is left out too, to look at
 * next time (see nextScanSince).
 */
export function acceptedSessionMatches(
  answers: SessionScan["sessions"],
  ctx: { sessions: RecentSession[]; open: Set<string>; linked: Set<string>; projects: Set<string>; maxNew: number },
): SessionMatch[] {
  const answerFor = new Map<string, SessionScan["sessions"][number]>();
  for (const a of answers) if (!answerFor.has(a.id)) answerFor.set(a.id, a);
  const taken = new Set<string>();
  let added = 0;
  const out: SessionMatch[] = [];
  for (const session of ctx.sessions) {
    const a = answerFor.get(session.sessionId);
    if (!a) continue;
    const why = a.why?.trim() ?? "";
    const taskId = a.task_id?.trim();
    const title = a.title?.trim();
    if (a.action === "connect" && taskId && ctx.open.has(taskId) && !ctx.linked.has(taskId) && !taken.has(taskId)) {
      taken.add(taskId);
      out.push({ action: "connect", session, taskId, why });
    } else if (a.action === "new" && title) {
      // Over the cap: not decided, so the next scan considers it again.
      if (added >= ctx.maxNew) continue;
      added++;
      const projectId = a.project_id && ctx.projects.has(a.project_id) ? a.project_id : null;
      out.push({ action: "new", session, title, description: a.description?.trim() || null, projectId, why });
    } else {
      out.push({ action: "skip", session, why });
    }
  }
  return out;
}

const clip = (text: string | null | undefined, max: number) => {
  const t = (text ?? "").trim().replace(/\s+\n/g, "\n");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** A session as the scan's prompt lists it: what it is, where, when, and where it got to. */
export function scanEntry(s: RecentSession, lastActive: string) {
  const latest = s.lastAsk && s.lastAsk !== s.prompt ? clip(s.lastAsk, 400) : undefined;
  return {
    id: s.sessionId,
    title: s.title,
    folder: s.cwd ?? undefined,
    last_active: lastActive,
    first_ask: clip(s.prompt, 700),
    ...(latest ? { latest_ask: latest } : {}),
    ...(s.lastReply ? { latest_reply: clip(s.lastReply, 700) } : {}),
  };
}
