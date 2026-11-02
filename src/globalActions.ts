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
    case "add_note":
      return `Remember: ${a.text}`;
    case "update_profile":
      return `Update About you: ${a.text}`;
    case "add_task":
      return `Add the task "${a.title}"${a.project_id ? ` to "${project(a.project_id)}"` : ""}`;
    case "refresh":
      return a.what === "project" && a.project_id
        ? `Refresh "${project(a.project_id)}"`
        : { all: "Refresh everything", project: "Refresh the project", briefing: "Rebuild the daily briefing", calendar: "Refresh the calendar", tasks: "Refresh tasks and inbox" }[a.what];
  }
}

/** Applies a change and starts the refresh it needs. Returns what happened, in a line. */
export async function applyAction(a: GlobalAction): Promise<string> {
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
      return "About you is updated; the daily briefing is being rebuilt.";
    case "add_task":
      await db.addManualTask(a.title, a.project_id ?? null);
      quiet(assessPendingTasks());
      return `Added "${a.title}" to your tasks.`;
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
