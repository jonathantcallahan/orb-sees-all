import { useSyncExternalStore } from "react";

/**
 * The areas beside the calendar, each of which can be turned off in Settings. Kept in localStorage,
 * like the pomodoro timer, so they show from the first frame. What an area holds is kept while it's
 * off, and comes back when it's on again.
 *
 * - Updates: the daily briefing, news and the inbox. Off, there's no briefing or news to write, and a
 *   message waiting on a quick reply goes on the task list instead of the inbox.
 * - Tasks: the task list. Off, the list is hidden; while Updates is on, refreshes still read Slack and
 *   email for its inbox and news.
 * - Projects: needs Jira and GitHub (see projectConnectorsReady), so it can be turned on only once
 *   both are set up. Off, projects aren't found or refreshed, the chats leave out their changes, and
 *   refreshes find tasks in every channel, project channels too.
 * - Epics: a Jira project's current or upcoming sprint, by epic (see EpicsArea). Needs Jira, so until
 *   it's turned on or off it's on wherever Jira is set up. Off, its sprints aren't read.
 * - Watched topics: off until turned on. Off, its line in the Refresh menu, its checks in a refresh,
 *   and the chats' "watch a topic" change are left out.
 *
 * At least one area stays on: Settings won't turn off the last.
 */
export type Area = "updates" | "tasks" | "projects" | "epics" | "watched";

/** In the rail's order. */
export const AREAS: Area[] = ["updates", "tasks", "projects", "epics", "watched"];

/** Updates, Tasks and Projects are on until turned off; Watched topics is off until turned on. */
const KEYS: Record<Exclude<Area, "epics">, { key: string; onByDefault: boolean }> = {
  updates: { key: "feature:updates-off", onByDefault: true },
  tasks: { key: "feature:tasks-off", onByDefault: true },
  projects: { key: "feature:projects-off", onByDefault: true },
  watched: { key: "feature:watched-topics", onByDefault: false },
};

const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};

function stored(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function store(key: string, set: boolean) {
  try {
    if (set) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    // Storage refused: it stays as it was.
  }
}

/** Epics: "1" or "0" once turned on or off; until then it follows Jira (see projectConnectors and jiraDirect). */
const EPICS_KEY = "feature:epics";

function epicsChosen(): boolean {
  let v: string | null = null;
  try {
    v = localStorage.getItem(EPICS_KEY);
  } catch {
    // Storage refused: as if never set.
  }
  return v === null ? projectConnectors()?.jira === true || jiraDirect() : v === "1";
}

/**
 * Whether Demian has its own connection to Jira (a site, email and token in Settings › Jira; see
 * jira.ts), as last found: Epics needs no other. Kept, so it's known from the first frame.
 */
const JIRA_DIRECT_KEY = "jira:direct";
export const jiraDirect = () => stored(JIRA_DIRECT_KEY);

export function setJiraDirect(on: boolean) {
  if (on === jiraDirect()) return;
  store(JIRA_DIRECT_KEY, on);
  notify();
}

const chosen = (area: Area): boolean => {
  if (area === "epics") return epicsChosen();
  const { key, onByDefault } = KEYS[area];
  return onByDefault ? !stored(key) : stored(key);
};

/** Whether an area is on. If storage somehow has them all off, Tasks shows, so there's always one. */
export function areaOn(area: Area): boolean {
  if (AREAS.some(chosen)) return chosen(area);
  return area === "tasks";
}

export function setAreaOn(area: Area, on: boolean) {
  // The last area on stays on.
  if (!on && AREAS.every((a) => a === area || !areaOn(a))) return;
  if (area === "epics") {
    try {
      localStorage.setItem(EPICS_KEY, on ? "1" : "0");
    } catch {
      // Storage refused: it stays as it was.
    }
    notify();
    return;
  }
  const { key, onByDefault } = KEYS[area];
  store(key, onByDefault ? !on : on);
  notify();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Whether an area is on, kept current as Settings changes it. */
export const useAreaOn = (area: Area) => useSyncExternalStore(subscribe, () => areaOn(area));

/** Whether Demian reads Jira itself (see jiraDirect), kept current. */
export const useJiraDirect = () => useSyncExternalStore(subscribe, jiraDirect);

/** The areas that are on, in the rail's order. */
export const areasOn = (): Area[] => AREAS.filter(areaOn);

/** The areas that are on, kept current. (Read as one string, so the snapshot is stable.) */
export function useAreasOn(): Area[] {
  const key = useSyncExternalStore(subscribe, () => areasOn().join(","));
  return key ? (key.split(",") as Area[]) : [];
}

export const updatesOn = () => areaOn("updates");
export const tasksOn = () => areaOn("tasks");
export const projectsOn = () => areaOn("projects");
export const epicsOn = () => areaOn("epics");
export const watchedTopicsOn = () => areaOn("watched");

export const useUpdatesOn = () => useAreaOn("updates");
export const useProjectsOn = () => useAreaOn("projects");
export const useWatchedTopicsOn = () => useAreaOn("watched");

/** What Projects reads besides Slack: Jira (the Atlassian Rovo connector) and GitHub (the gh CLI). */
export interface ProjectConnectors {
  jira: boolean;
  github: boolean;
  /** When they were last checked. */
  at: string;
}

const CONNECTORS_KEY = "setup:project-connectors";

/** What the last setup check found of Projects' connectors, or null when they haven't been checked. */
export function projectConnectors(): ProjectConnectors | null {
  try {
    const v = JSON.parse(localStorage.getItem(CONNECTORS_KEY) ?? "null");
    return v && typeof v.jira === "boolean" && typeof v.github === "boolean" ? v : null;
  } catch {
    return null;
  }
}

/** Kept after each real setup check (not a simulated one), for Settings' Projects switch. */
export function saveProjectConnectors(c: { jira: boolean; github: boolean }) {
  try {
    localStorage.setItem(CONNECTORS_KEY, JSON.stringify({ ...c, at: new Date().toISOString() }));
  } catch {
    // Storage refused: Settings checks again.
  }
  notify();
}

/** Whether Projects can be turned on: Jira and GitHub are both set up. */
export const projectConnectorsReady = (c: ProjectConnectors | null = projectConnectors()) => !!c?.jira && !!c?.github;

/** How long a check of Projects' connectors stands before Settings checks again: a probe costs a turn. */
export const CONNECTORS_RECHECK_MS = 5 * 60_000;

/** Whether Projects' connectors were checked recently enough not to check again. */
export const projectConnectorsRecent = (c: ProjectConnectors | null, now = Date.now()) => !!c && now - Date.parse(c.at) < CONNECTORS_RECHECK_MS;

type GateInput = { on: boolean; connectors: ProjectConnectors | null; checking: boolean; checkFailed: boolean; direct?: boolean };

/**
 * What Settings' switch for an area that needs connectors shows: whether it's blocked (it can't be
 * turned on until they're set up; it can always be turned off), and the line saying why.
 */
function connectorsGate(o: GateInput, needs: ("jira" | "github")[]): { blocked: boolean; why: string | null } {
  if (o.on || needs.every((n) => o.connectors?.[n])) return { blocked: false, why: null };
  if (o.checking) return { blocked: true, why: needs.length > 1 ? "Checking them…" : "Checking it…" };
  // Not known: the check couldn't run (Claude Code unreachable, say), which isn't the same as missing.
  if (o.checkFailed || !o.connectors) return { blocked: true, why: needs.length > 1 ? "Couldn't check them just now." : "Couldn't check it just now." };
  const missing = needs.filter((n) => !o.connectors![n]).map((n) => (n === "jira" ? "Jira" : "GitHub")).join(" and ");
  return { blocked: true, why: `Set up ${missing} to turn it on.` };
}

/** Settings' Projects switch: it needs Jira and GitHub. */
export const projectsGate = (o: GateInput) => connectorsGate(o, ["jira", "github"]);

/** Settings' Epics switch: it needs Jira, through Claude's connector or Demian's own connection (`direct`). */
export const epicsGate = (o: GateInput) => (o.direct ? { blocked: false, why: null } : connectorsGate(o, ["jira"]));

/** Projects' connectors as last checked, kept current. */
export function useProjectConnectors(): ProjectConnectors | null {
  const raw = useSyncExternalStore(subscribe, () => {
    try {
      return localStorage.getItem(CONNECTORS_KEY);
    } catch {
      return null;
    }
  });
  return raw === null ? null : projectConnectors();
}
