/**
 * Changes the global chat proposes to the planner itself (see GlobalAction), described for their
 * card and applied when the user clicks Apply. Each applies with the same db and job functions the
 * rest of the app uses, then starts the refresh that brings the board up to date; the refresh runs
 * on in the background.
 */
import * as db from "./db";
import { setStandingNotes } from "./claude";
import { assessPendingTasks, checkBlocker, continueTaskSession, refreshAdhoc, refreshAll, refreshCalendar, refreshProject, refreshReading, watchFromText } from "./jobs";
import { projectContext, projectName } from "./projects";
import { blockerKey } from "./tasks";
import { setUserProfile } from "./prompts";
import type { GlobalAction } from "./schema";
import { localDate } from "./scheduler";

const quiet = (p: Promise<unknown>) => void p.catch(() => {});

/** A project's name for a card, by id; the id itself if it isn't known. */
type Names = (id: string) => string;
/** A project's blocker or active item, by project and item id, as the project shows it; null if it isn't there. */
type Items = (projectId: string, itemId: string) => string | null;

/** Names for describing changes: projects, channels, and a project's open items, from the projects as they are now. */
export function actionNames(projects: db.Project[]): { project: Names; channel: Names; item: Items } {
  return {
    project: (id) => {
      const p = projects.find((x) => x.channel_id === id);
      return p ? projectName(p) : id;
    },
    channel: (id) => projects.flatMap((p) => p.channels).find((c) => c.channel_id === id)?.name ?? id,
    item: (projectId, itemId) => {
      const s = projects.find((x) => x.channel_id === projectId)?.snapshot;
      return [...(s?.blockers ?? []), ...(s?.active ?? [])].find((b) => b.id === itemId)?.what ?? null;
    },
  };
}

const channelList = (names: string[]) => names.map((n) => `#${n.replace(/^#/, "")}`).join(", ");

/** A task a change can name: its id, its title, and whether it's still open. */
export interface KnownTask {
  id: string;
  title: string;
  open: boolean;
}

const sameTitle = (s: string | null | undefined) =>
  (s ?? "")
    .toLowerCase()
    .replace(/["'“”‘’`]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The task a change means: the one its id names (or the task that id was merged into), else the one
 * open task with that title, since the chat sometimes loses an id it was given. Null when neither
 * finds exactly one, so the change fails rather than landing on a task that isn't there.
 */
export function findTask(tasks: KnownTask[], aliases: Map<string, string>, id: string | null | undefined, title: string | null | undefined): string | null {
  if (id?.trim()) {
    const canonical = aliases.get(id.trim()) ?? id.trim();
    if (tasks.some((t) => t.id === canonical)) return canonical;
  }
  const want = sameTitle(title);
  if (!want) return null;
  const matches = tasks.filter((t) => t.open && sameTitle(t.title) === want);
  return matches.length === 1 ? (aliases.get(matches[0].id) ?? matches[0].id) : null;
}

/** Every task on the board now (the user's own, Slack and email, projects', meeting prep), for findTask. */
async function knownTasks(): Promise<KnownTask[]> {
  const [projects, adhoc, manual, states, calendar] = await Promise.all([
    db.listProjects(),
    db.getAdhoc(),
    db.listManualTasks(),
    db.getTaskStates(),
    db.getCalendarDay(localDate(new Date())),
  ]);
  const aliases = await db.getTaskAliases();
  // A task merged into another is open only if that one is.
  const open = (id: string) => {
    const st = states.get(aliases.get(id) ?? id);
    return st?.status !== "done" && !st?.dismissed;
  };
  return [
    ...manual,
    ...adhoc.tasks,
    ...projects.flatMap((p) => p.snapshot?.my_tasks ?? []),
    ...(calendar?.day.events ?? []).flatMap((ev) => ev.prep),
  ].map((t) => ({ id: t.id, title: t.title, open: open(t.id) }));
}

/** The id of the task a change means (see findTask), or an error the card shows. */
async function taskFor(a: { task_id?: string | null; title?: string | null }): Promise<string> {
  const [tasks, aliases] = await Promise.all([knownTasks(), db.getTaskAliases()]);
  const id = findTask(tasks, aliases, a.task_id, a.title);
  if (!id) throw new Error(`Couldn't find ${a.title ? `"${a.title}"` : "that task"} on your list`);
  return id;
}

/**
 * The changes a task's chat proposed that it may make: moving its own task to another project, and
 * changing its title or description (update_task), and nothing else. Each is made about this task,
 * whatever task the chat named.
 */
export function taskChatChanges<T extends { action: GlobalAction | null }>(actions: T[], taskId: string, title: string): T[] {
  return actions.flatMap((item) =>
    item.action?.type === "set_task_project" || item.action?.type === "update_task" ? [{ ...item, action: { ...item.action, task_id: taskId, title } }] : [],
  );
}

/** A plan's steps in a line, for its card and for the task's chat. */
const stepList = (steps: { title: string; by: "claude" | "you" }[]) => steps.map((st, i) => `${i + 1}. ${st.by === "you" ? "[Me] " : ""}${st.title}`);

/** What a change will do, in a line, for its card. */
export function describeAction(a: GlobalAction, project: Names, channel: Names, item: Items): string {
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
    case "remove_project_context":
      return `Remove from the context of "${project(a.project_id)}": ${a.entries.join(" · ")}`;
    case "set_project_status":
      return a.status === "auto"
        ? `Let refreshes set the status of "${project(a.project_id)}" again`
        : `Set "${project(a.project_id)}" to ${STATUS_WORDS[a.status]}${a.reason ? `: ${a.reason}` : ""}`;
    case "resolve_project_item":
    case "check_project_item": {
      // Named from the item the id points to, not the chat's words for it, so the card says what Apply does.
      const what = item(a.project_id, a.item_id);
      if (!what) return `An item that isn't on "${project(a.project_id)}" any more (Apply will do nothing)`;
      return a.type === "resolve_project_item" ? `Mark "${what}" done in "${project(a.project_id)}"` : `Double check "${what}" in "${project(a.project_id)}"`;
    }
    case "unlink_channel":
      return `Unlink ${channel(a.channel_id)} from "${project(a.project_id)}"`;
    case "add_note":
      return `Remember: ${a.text}`;
    case "update_profile":
      return `Update how Demian describes you: ${a.text}`;
    case "add_task":
      return [
        `Add the task "${a.title}"${a.project_id ? ` to "${project(a.project_id)}"` : ""}`,
        a.today ? "in Today's tasks" : "",
        a.status && a.status !== "todo" ? { in_progress: "in progress", waiting: "waiting", blocked: "blocked" }[a.status] : "",
        a.priority ? `${a.priority} priority` : "",
      ]
        .filter(Boolean)
        .join(", ");
    case "add_task_context":
      return `Add to "${a.title ?? "this task"}": ${a.text}`;
    case "update_task":
      return [
        a.new_title ? `Rename "${a.title ?? "this task"}" to "${a.new_title}"` : `Change "${a.title ?? "this task"}"`,
        a.description != null ? `with the description: ${a.description}` : "",
      ]
        .filter(Boolean)
        .join(", ");
    case "set_task_plan":
      return `New plan for "${a.title ?? "this task"}": ${stepList(a.steps).join(" · ")}`;
    case "set_task_project":
      return a.project_id ? `Move "${a.title ?? "this task"}" to "${project(a.project_id)}"` : `Take "${a.title ?? "this task"}" out of its project`;
    case "watch_topic":
      return `Watch: ${a.text}`;
    case "plan_today":
      return a.today ? `Move "${a.title ?? "this task"}" into Today's tasks` : `Take "${a.title ?? "this task"}" off Today's tasks`;
    case "set_task_status":
      return `Mark "${a.title ?? "this task"}" ${{ todo: "to do", in_progress: "in progress", waiting: "waiting", blocked: "blocked", done: "done" }[a.status]}`;
    case "set_task_priority":
      return `Set "${a.title ?? "this task"}" to ${a.priority} priority`;
    case "refresh":
      return a.what === "project" && a.project_id
        ? `Refresh "${project(a.project_id)}"`
        : { all: "Refresh everything", project: "Refresh the project", briefing: "Rebuild the daily briefing", calendar: "Refresh the calendar", tasks: "Refresh tasks and inbox" }[a.what];
  }
}

/**
 * A Slack, email, project or meeting-prep task's own description, by id: null when it has none,
 * undefined when no such task is on the board now.
 */
async function taskDescription(taskId: string): Promise<string | null | undefined> {
  const [projects, adhoc, calendar] = await Promise.all([db.listProjects(), db.getAdhoc(), db.getCalendarDay(localDate(new Date()))]);
  const found =
    projects.flatMap((p) => p.snapshot?.my_tasks ?? []).find((t) => t.id === taskId) ??
    adhoc.tasks.find((t) => t.id === taskId) ??
    (calendar?.day.events ?? []).flatMap((ev) => ev.prep).find((p) => p.id === taskId);
  if (!found) return undefined;
  // Meeting prep has no description of its own.
  return (found as { description?: string | null }).description ?? null;
}

const STATUS_WORDS = { blocked: "blocked", at_risk: "at risk", on_track: "on track", idle: "idle" } as const;

const KIND: Partial<Record<GlobalAction["type"], db.FeedbackKind>> = {
  create_project: "project_create",
  split_project: "project_split",
  merge_projects: "project_merge",
  rename_project: "project_rename",
  set_project_tracking: "project_track",
  add_project_context: "project_focus",
  remove_project_context: "project_focus",
  unlink_channel: "channel_unlink",
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
    case "remove_project_context": {
      const focus = (await db.listFocus()).get(a.project_id);
      const p = await db.getProject(a.project_id);
      if (!p) throw new Error("Unknown project");
      const drop = new Set(a.entries.map((e) => e.trim().toLowerCase()));
      const gone = (t: string) => drop.has(t.trim().toLowerCase());
      // The user's own entries just go; Demian's are remembered as removed, so refreshes leave them out.
      const theirs = projectContext(p).filter((c) => c.by === "demian" && gone(c.text)).map((c) => c.text);
      await db.saveFocus(a.project_id, { context: (focus?.context ?? []).filter((t) => !gone(t)), removed: [...(focus?.removed ?? []), ...theirs] });
      return "Removed from its context.";
    }
    case "set_project_status":
      await db.setProjectStatus(a.project_id, a.status === "auto" ? null : a.status, a.reason ?? null);
      return a.status === "auto" ? "Its status comes from refreshes again." : `It's ${STATUS_WORDS[a.status]} now; refreshes keep to that unless something clearly changes.`;
    case "resolve_project_item": {
      const p = await db.getProject(a.project_id);
      const item = [...(p?.snapshot?.blockers ?? []), ...(p?.snapshot?.active ?? [])].find((b) => b.id === a.item_id);
      if (!item) throw new Error("That item isn't on the project any more");
      await db.setTaskState(blockerKey(item.id), { dismissed: true });
      if (item.owners.some((o) => o.is_me)) await db.setTaskState(item.id, { status: "done" });
      return "Marked done.";
    }
    case "check_project_item": {
      const p = await db.getProject(a.project_id);
      const blocker = p?.snapshot?.blockers.find((b) => b.id === a.item_id);
      const active = p?.snapshot?.active?.find((b) => b.id === a.item_id);
      const item = blocker ?? active;
      if (!p || !item) throw new Error("That item isn't on the project any more");
      const reminders = await db.getReminders();
      quiet(checkBlocker(projectName(p), p.channel_id, item, reminders[item.id], blocker ? "blocker" : "active"));
      return "Checking it; the result shows on the project.";
    }
    case "unlink_channel":
      if (!(await db.unlinkChannel(a.channel_id, a.project_id))) throw new Error("That channel isn't one of the project's related channels");
      quiet(refreshProject(a.project_id));
      return "Unlinked; the project is being read again without it.";
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
    case "add_task": {
      const id = await db.addManualTask(a.title, a.project_id ?? null, a.description?.trim() || null);
      if (a.today || a.status) await db.setTaskState(id, { ...(a.today ? { todayOn: localDate(new Date()) } : {}), ...(a.status ? { status: a.status } : {}) });
      if (a.priority) await db.setPriorityOverride(id, a.priority);
      quiet(assessPendingTasks());
      // Its id, so the chat can change it in later cards without waiting for the task list.
      return `Added "${a.title}" to your tasks${a.today ? ", in Today's tasks" : ""} (id ${id}).`;
    }
    case "add_task_context": {
      const id = await taskFor(a);
      const text = a.text.trim();
      const add = (current: string | null | undefined) => (current?.trim() ? `${current.trim()}\n\n${text}` : text);
      const mine = (await db.listManualTasks()).find((t) => t.id === id);
      if (mine) {
        // As the card's description edit does: the old assessment was of the old text, so it's done again.
        await db.updateManualTask(mine.id, { title: mine.title, description: add(mine.description) });
        await db.clearAssessment(mine.id);
        quiet(assessPendingTasks());
        return "Added to its description; it's being looked at again with it.";
      }
      // Other tasks are rewritten by each refresh, so the description goes in as the user's edit of
      // the one the card shows (their earlier edit, else the refreshed one, else the original).
      const original = await taskDescription(id);
      if (original === undefined) throw new Error("That task isn't on your list any more");
      const [overrides, refined] = await Promise.all([db.getDescriptionOverrides(), db.getRefinedDescriptions()]);
      await db.saveDescriptionOverride(id, add(overrides[id] ?? refined[id] ?? original));
      return "Added to its description.";
    }
    case "update_task": {
      const id = await taskFor(a);
      const mine = (await db.listManualTasks()).find((t) => t.id === id);
      // Tasks from Slack, email and projects get their titles from each refresh, so only their
      // description can change: it's kept over what the refresh found, as the card's own edit was.
      if (!mine) {
        if (a.description == null) throw new Error("Only a task you added yourself can be renamed; its description can be changed instead");
        await db.saveDescriptionOverride(id, a.description.trim() || null);
        return "Updated its description.";
      }
      const title = a.new_title?.trim() || mine.title;
      const description = a.description != null ? a.description.trim() || null : mine.description;
      await db.updateManualTask(id, { title, description });
      // As the card's own edit does: before work starts, Claude looks at it again; once a chat has it, its plan stays.
      if (!(await db.getSessionLinks())[id]?.sessionId) {
        await db.clearAssessment(id);
        quiet(assessPendingTasks());
      }
      return a.new_title ? `Renamed it to "${title}".` : "Updated it.";
    }
    case "set_task_project": {
      const id = await taskFor(a);
      const to = a.project_id ? await db.getProject(a.project_id) : null;
      if (a.project_id && !to) throw new Error("That project isn't on your board");
      // Moved back to where it was found: nothing to remember.
      const aliases = await db.getTaskAliases();
      const foundIn = (await db.listProjects()).find((p) => (p.snapshot?.my_tasks ?? []).some((t) => (aliases.get(t.id) ?? t.id) === id));
      await db.setTaskProject(id, foundIn && foundIn.channel_id === a.project_id ? null : a.project_id);
      return to ? `It's under "${projectName(to)}" now.` : "It's out of its project now.";
    }
    case "set_task_plan": {
      const id = await taskFor(a);
      const steps = a.steps.map((st) => ({ title: st.title.trim(), by: st.by })).filter((st) => st.title);
      // A task with a chat shows the chat's steps: the chat takes the new plan and restates it, so its
      // step numbers and reports follow it.
      if ((await db.getSessionLinks())[id]?.sessionId) {
        quiet(
          continueTaskSession(
            id,
            ["From my planner's chat: I've changed this task's plan. Restate it exactly as below as an [orb] plan block, keeping each step's state where it's the same work, then carry on as before (if we were still talking the plan through, keep talking it through).", ...stepList(steps)].join("\n"),
          ),
        );
        return "Sent to the task's chat; its steps update as Claude restates the plan.";
      }
      const current = (await db.getTaskPlans()).get(id)?.plan;
      await db.saveTaskPlan(id, { approach: current?.approach ?? "", steps, open_questions: current?.open_questions ?? [], sources: current?.sources ?? [] }, 0);
      return "The task's plan is updated.";
    }
    case "watch_topic": {
      // As the Watched topics box does: added at once, then filled in (title, project, conditional actions) and checked.
      await watchFromText(a.text.trim());
      return "Watching it; it's in Watched topics, being filled in and checked.";
    }
    case "plan_today":
      await db.setTaskState(await taskFor(a), { todayOn: a.today ? localDate(new Date()) : null });
      return a.today ? "It's in Today's tasks." : "It's off Today's tasks.";
    case "set_task_status":
      await db.setTaskState(await taskFor(a), { status: a.status });
      return "Done.";
    case "set_task_priority":
      await db.setPriorityOverride(await taskFor(a), a.priority);
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
