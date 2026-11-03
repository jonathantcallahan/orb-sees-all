/**
 * Changes the global chat proposes to the planner itself (see GlobalAction), described for their
 * card and applied when the user clicks Apply. Each applies with the same db and job functions the
 * rest of the app uses, then starts the refresh that brings the board up to date; the refresh runs
 * on in the background.
 */
import * as db from "./db";
import { setStandingNotes } from "./claude";
import { assessPendingTasks, refreshAdhoc, refreshAll, refreshCalendar, refreshProject, refreshReading } from "./jobs";
import { setUserProfile } from "./prompts";
import type { GlobalAction } from "./schema";
import { localDate } from "./scheduler";

const quiet = (p: Promise<unknown>) => void p.catch(() => {});

/** A project's name for a card, by id; the id itself if it isn't known. */
type Names = (id: string) => string;

const channelList = (names: string[]) => names.map((n) => `#${n.replace(/^#/, "")}`).join(", ");

/** What a change will do, in a line, for its card. */
export function describeAction(a: GlobalAction, project: Names, channel: Names): string {
  switch (a.type) {
    case "create_project":
      return `Add the project "${a.name}", from ${channelList(a.channels.map((c) => c.name))}`;
    case "split_project":
      return `Split "${project(a.project_id)}": move ${channelList(a.channel_ids.map(channel))} into a new project, "${a.new_name}"`;
    case "merge_projects":
      return `Merge "${project(a.from_id)}" into "${project(a.into_id)}"`;
    case "rename_project":
      return `Rename "${project(a.project_id)}" to "${a.name}"`;
    case "set_project_tracking":
      return `${a.tracked ? "Track" : "Stop tracking"} "${project(a.project_id)}"`;
    case "add_project_context":
      return `Add to the context of "${project(a.project_id)}": ${a.entries.join(" · ")}`;
    case "add_project_repos":
      return `Read code for "${project(a.project_id)}" from ${[...a.github, ...a.local].join(", ")}`;
    case "add_note":
      return `Remember: ${a.text}`;
    case "update_profile":
      return `Update how Demian describes you: ${a.text}`;
    case "add_task":
      return `Add the task "${a.title}"${a.project_id ? ` to "${project(a.project_id)}"` : ""}`;
    case "plan_today":
      return a.today ? `Move "${a.title ?? "this task"}" into Today's tasks` : `Take "${a.title ?? "this task"}" off Today's tasks`;
    case "set_task_status":
      return `Mark "${a.title ?? "this task"}" ${{ todo: "to do", in_progress: "in progress", waiting: "waiting", done: "done" }[a.status]}`;
    case "set_task_priority":
      return `Set "${a.title ?? "this task"}" to ${a.priority} priority`;
    case "refresh":
      return a.what === "project" && a.project_id
        ? `Refresh "${project(a.project_id)}"`
        : { all: "Refresh everything", project: "Refresh the project", briefing: "Rebuild the daily briefing", calendar: "Refresh the calendar", tasks: "Refresh tasks and inbox" }[a.what];
  }
}

const KIND: Partial<Record<GlobalAction["type"], db.FeedbackKind>> = {
  create_project: "project_create",
  split_project: "project_split",
  merge_projects: "project_merge",
  rename_project: "project_rename",
  set_project_tracking: "project_track",
  add_project_context: "project_focus",
  add_note: "note",
};

/**
 * Applies a change and starts the refresh it needs, and records it as a correction with why (the
 * chat's stated reason, else what the user said). Returns what happened, in a line.
 */
export async function applyAction(a: GlobalAction, said?: string, summary?: string): Promise<string> {
  const result = await apply(a);
  const kind = KIND[a.type];
  if (kind) {
    const projectId = "project_id" in a ? a.project_id : a.type === "merge_projects" ? a.into_id : null;
    const reason = ("reason" in a && a.reason) || said;
    db.logFeedback({
      kind,
      subject: kind === "note" ? "briefing" : "project",
      subject_id: projectId ?? null,
      project_id: projectId ?? null,
      after: { ...a, summary },
      ...(reason ? { reason, reason_source: "chat" as const } : {}),
      source: "chat",
    }).catch(() => {});
  }
  return result;
}

async function apply(a: GlobalAction): Promise<string> {
  switch (a.type) {
    case "create_project": {
      const id = await db.createProject(a.name, a.channels, a.reason);
      quiet(refreshProject(id));
      return `Added "${a.name}" and started reading it.`;
    }
    case "split_project": {
      const id = await db.splitProject(a.project_id, a.new_name, a.channel_ids, a.reason);
      quiet(refreshProject(a.project_id));
      quiet(refreshProject(id));
      return `Split off "${a.new_name}" and started reading both projects.`;
    }
    case "merge_projects":
      await db.mergeProject(a.from_id, a.into_id);
      quiet(refreshProject(a.into_id));
      return "Merged them and started reading the combined project.";
    case "rename_project":
      await db.renameProject(a.project_id, a.name);
      return `Renamed it to "${a.name}".`;
    case "set_project_tracking":
      await db.setProjectState(a.project_id, a.tracked ? "tracked" : "ignored");
      if (a.tracked) quiet(refreshProject(a.project_id));
      return a.tracked ? "It's on the board and being read." : "It's off the board.";
    case "add_project_repos": {
      const p = await db.getProject(a.project_id);
      if (!p) throw new Error("Unknown project");
      const github = a.github.map((r) => r.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "")).filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r));
      await db.updateProjectConfig(a.project_id, {
        hidden: p.hidden,
        local_repos: [...new Set([...p.local_repos, ...a.local.map((d) => d.trim()).filter(Boolean)])],
        gh_repos: [...new Set([...p.gh_repos, ...github])],
      });
      return "Mapped. Plans and chats about this project can read its code now.";
    }
    case "add_project_context": {
      const current = (await db.listFocus()).get(a.project_id);
      const entries = a.entries.map((e) => e.trim()).filter(Boolean);
      await db.saveFocus(a.project_id, { context: [...(current?.context ?? []), ...entries] });
      quiet(refreshProject(a.project_id));
      return "Added to its context; it's being read again with it in mind.";
    }
    case "add_note": {
      const notes = [...(await db.getNotes()), a.text.trim()];
      await db.saveNotes(notes);
      setStandingNotes(notes);
      quiet(refreshReading());
      return "Saved. Every refresh will take it into account; the daily briefing is being rebuilt now.";
    }
    case "update_profile":
      await db.setSetting("user_profile", a.text.trim());
      setUserProfile(a.text);
      quiet(refreshReading());
      return "Updated how Demian describes you; the daily briefing is being rebuilt.";
    case "add_task":
      await db.addManualTask(a.title, a.project_id ?? null);
      quiet(assessPendingTasks());
      return `Added "${a.title}" to your tasks.`;
    case "plan_today":
      await db.setTaskState(a.task_id, { todayOn: a.today ? localDate(new Date()) : null });
      return a.today ? "It's in Today's tasks." : "It's off Today's tasks.";
    case "set_task_status":
      await db.setTaskState(a.task_id, { status: a.status });
      return "Done.";
    case "set_task_priority":
      await db.setPriorityOverride(a.task_id, a.priority);
      return "Priority set.";
    case "refresh": {
      const run = {
        all: refreshAll,
        project: () => (a.project_id ? refreshProject(a.project_id) : refreshAll()),
        briefing: refreshReading,
        calendar: refreshCalendar,
        tasks: refreshAdhoc,
      }[a.what];
      quiet(run());
      return "Started.";
    }
  }
}
