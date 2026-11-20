import type { Project } from "./db";
import { itemKey, placeCode, placeRequirements, planGroups, proposedMove, type PlacedMark } from "./plan";
import { guideTitle, pathToShip, projectKind, projectName, projectStatus, requirementRows } from "./projects";

/** A pull request or branch, as much of it as the chat needs. */
interface Code {
  kind: string;
  title: string;
  url: string;
  state: string;
  detail?: string | null;
}

/**
 * A project's chat: one ongoing conversation per project, a Demian chat (it proposes the same changes)
 * that centers on that project. Its key starts like the Demian chat's, so it's treated as one.
 */
export const PROJECT_CHAT = "global:project:";
export const projectChatKey = (projectId: string) => `${PROJECT_CHAT}${projectId}`;
/** The project a chat is about, from its key; null for any other chat. */
export const projectOfChat = (key: string) => (key.startsWith(PROJECT_CHAT) ? key.slice(PROJECT_CHAT.length) : null);

/** How a pull request or branch is tied to the work it's under, for the chat. */
const TIE_NOTE: Record<PlacedMark<unknown>["tie"], string> = {
  linked: " (the ticket links it)",
  named: " (its name has the key; the ticket doesn't link it)",
  found: " (Demian reads it as this work; nothing links it)",
};

/**
 * The project a chat centers on, as the planner shows it now: what it's for, where it stands, its
 * people, its plan of work (the requirements and the pull requests and branches under what they're
 * for), its milestones, decisions and links. Told to the project's chat each turn.
 */
export function projectRecordText(p: Project, code: Code[] = []): string {
  const out: string[] = [];
  const kind = projectKind(p);
  out.push(`This chat is about ${projectName(p)} [id ${p.channel_id}]${kind ? `, a ${kind}` : ""}. Its record, as my planner shows it now:`);
  const goal = p.profile?.goal || p.snapshot?.description;
  if (goal) out.push(`Purpose: ${goal}`);
  const status = projectStatus(p);
  if (status) out.push(`Status: ${status}${p.snapshot?.status_reason ? `: ${p.snapshot.status_reason}` : ""}`);
  const path = pathToShip(p);
  if (path?.now) out.push(`Where it stands: ${path.now}`);
  if (path?.ship) out.push(`Ships: ${path.ship.what || "?"}${path.ship.date ? ` on ${path.ship.date}` : ", no date named"}`);

  const people = p.profile?.people ?? [];
  if (people.length)
    out.push(`People:\n${people.map((x) => `- ${x.name}${x.raci ? ` (${x.raci})` : ""}: ${x.role}${x.working_on ? `; working on ${x.working_on}` : ""}`).join("\n")}`);

  // The plan, with each requirement and pull request under what it's for.
  const rows = requirementRows(p);
  const byId = new Map(rows.map((r) => [r.requirement.id, r]));
  const req = (ids: string[] | undefined, pad: string) =>
    (ids ?? []).flatMap((id) => {
      const r = byId.get(id);
      return r ? [`${pad}requirement ${id} [${r.progress?.status ?? "not read yet"}]${r.requirement.priority === "must" ? " (must)" : ""}: ${r.requirement.text}`] : [];
    });
  const line = (c: Code, pad: string, how = "") => `${pad}${c.kind === "pr" ? "pull request" : "branch"} ${c.title} [${c.kind === "pr" ? c.state : "open"}]${how} ${c.url}`;
  const pr = (list: Code[] | undefined, pad: string) => (list ?? []).map((c) => line(c, pad));
  // Under a ticket: linked when the ticket links it itself, else only matched by the key in its name.
  const marks = (list: PlacedMark<Code>[] | undefined, pad: string) =>
    (list ?? []).map((m) => line(m.code, pad, TIE_NOTE[m.tie]));
  if (path?.steps.length) {
    const placed = placeRequirements(path.steps, rows.map((r) => r.requirement.id), path.initiatives ?? []);
    const placedCode = placeCode(path, code);
    const lines: string[] = [];
    for (const g of planGroups(path)) {
      let pad = "- ";
      if (g.initiative) {
        const i = g.initiative;
        lines.push(`- Initiative ${i.jira ? i.jira.key : "(proposed, not in Jira)"}${i.realign ? " (an epic in Jira, read as an initiative)" : ""}: ${i.what}`);
        lines.push(...req(placed.byInitiative.get(i.id), "    "), ...marks(placedCode.byInitiative.get(i.id), "    "));
        pad = "  - ";
      }
      for (const { step, index } of g.steps) {
        const owners = step.owners?.length ? `, ${step.owners.join(", ")}` : "";
        lines.push(`${pad}Epic ${step.epic ? step.epic.key : "(proposed, not in Jira)"}: ${step.what} [${step.status}${owners}]`);
        const inner = " ".repeat(pad.length + 2);
        (step.items ?? []).forEach((it, j) => {
          const key = itemKey(it);
          const from = proposedMove(it, step);
          const note = it.realign ? " (an epic in Jira, read as a story)" : from !== undefined ? ` (in Jira it's ${from ? `in ${from}` : "in no epic"})` : "";
          lines.push(`${inner}- ${key ?? "(no ticket yet)"} ${it.type ?? "Task"}: ${it.title} [${it.status}${it.assignee ? `, ${it.assignee}` : ""}${it.date ? `, due ${it.date}` : ""}]${note}`);
          lines.push(...req(placed.byItem.get(`${index}:${j}`), `${inner}    `), ...marks(placedCode.byItem.get(`${index}:${j}`), `${inner}    `));
        });
        lines.push(...req(placed.byStep.get(index), `${inner}`), ...marks(placedCode.byStep.get(index), `${inner}`));
      }
    }
    // Code tied to none of the plan's work isn't this project's: left out.
    lines.push(...req(placed.rest, "- "));
    out.push(`Its plan of work${p.docs?.doc ? `, with the requirements of ${guideTitle(p) ?? p.docs.doc.title} (${p.docs.doc.link})` : ""}:\n${lines.join("\n")}`);
  } else if (rows.length) {
    out.push(`Requirements, from ${guideTitle(p) ?? "its doc"}:\n${req(rows.map((r) => r.requirement.id), "- ").join("\n")}`);
  }
  if (!path?.steps.length && code.length) out.push(`Pull requests and branches:\n${pr(code, "- ").join("\n")}`);

  const profile = p.profile;
  if (profile?.milestones.length) out.push(`Milestones:\n${profile.milestones.map((m) => `- ${m.date ?? "no date"}: ${m.what} [${m.status}]`).join("\n")}`);
  if (profile?.decisions.length) out.push(`Decisions:\n${profile.decisions.slice(0, 8).map((d) => `- ${d.date ?? "no date"}: ${d.what}${d.link ? ` (${d.link})` : ""}`).join("\n")}`);
  if (profile?.resources.length) out.push(`Links:\n${profile.resources.map((r) => `- ${r.title}: ${r.link}`).join("\n")}`);
  return out.join("\n\n");
}
