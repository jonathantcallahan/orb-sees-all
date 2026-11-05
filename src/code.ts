/**
 * Code Claude can read, for questions only the codebase answers. A project's code is its local
 * checkouts (mapped in Settings > Projects) and its GitHub repos (mapped there, or linked from its
 * channels), each read from a shallow, read-only mirror the app keeps (mirror_repo in lib.rs).
 * Claude reads them with its own Read, Grep and Glob tools; nothing can change them.
 */
import { invoke } from "@tauri-apps/api/core";
import * as db from "./db";
import type { Project } from "./db";
import { projectRepos } from "./jobs/tracking";
import { projectName } from "./projects";

export interface CodeSource {
  /** What it is, e.g. "local checkout of payments-api" or "GitHub acme/payments-api (default branch)". */
  label: string;
  dir: string;
}

/** A project's GitHub repos: the ones mapped in Settings plus those linked from its profile and updates. */
export function githubReposOf(p: Project): string[] {
  const links = [
    ...(p.profile?.resources ?? []).map((r) => r.link),
    ...(p.snapshot?.recent_updates ?? []).map((u) => u.link),
    ...(p.snapshot?.my_tasks ?? []).map((t) => t.link),
  ];
  return projectRepos(p.gh_repos, links);
}

/**
 * The code a project's questions can be answered from: the checkouts mapped in Settings, then
 * for each of its GitHub repos your own clone of it if you have one (found by its origin remote,
 * see find_checkouts), else Demian's mirror if that's on disk. Nothing waits on GitHub: a repo with
 * neither is cloned in the background (see fetchMirrors), for the next run. With `cloneNew` false
 * it isn't fetched at all.
 */
export async function codeFor(projects: Project[], cloneNew = true, maxRepos = 4): Promise<CodeSource[]> {
  const sources: CodeSource[] = [];
  const mapped = await invoke<string[]>("existing_dirs", { paths: projects.flatMap((p) => p.local_repos) }).catch(() => []);
  for (const dir of mapped) sources.push({ label: `local checkout ${dir.split(/[\\/]/).filter(Boolean).pop()}`, dir });
  const repos = [...new Set(projects.flatMap(githubReposOf))].slice(0, maxRepos);
  const yours = new Map(await invoke<[string, string][]>("find_checkouts", { repos }).catch(() => []));
  const root = await mirrorsRoot();
  const toMirror: string[] = [];
  for (const repo of repos) {
    const own = yours.get(repo);
    if (own) {
      if (!sources.some((s) => s.dir === own)) sources.push({ label: `your local checkout of GitHub ${repo} (on whatever branch you have out)`, dir: own });
      continue;
    }
    toMirror.push(repo);
    const dir = await invoke<string[]>("existing_dirs", { paths: [`${root}/${repo}`] }).then((d) => d[0] ?? null, () => null);
    if (dir) sources.push({ label: `GitHub ${repo} (default branch)`, dir });
  }
  // Mirrors on disk are refreshed (and new ones cloned) in the background too.
  if (cloneNew) fetchMirrors(toMirror);
  return sources;
}

/** Home folders macOS guards: a run never reads code there (see RUN_SETTINGS), even when asked. */
const GUARDED = ["Desktop", "Documents", "Downloads", "Library", "Pictures", "Music", "Movies", "Public"];

/**
 * A checkout a session asked to read ("[orb] code …"): a GitHub repo ("owner/name", or a link to
 * it) or a bare repo name, as your own checkout when you have one, else the repo's GitHub copy; or a
 * folder, when it's a git checkout outside the folders macOS guards. Null when it's none of those.
 */
export async function resolveCheckout(ask: string): Promise<CodeSource | null> {
  const want = ask
    .trim()
    .replace(/^[`"']+|[`"'.]+$/g, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  if (!want) return null;
  if (/^(\/|~\/)/.test(want)) {
    const { homeDir } = await import("@tauri-apps/api/path");
    const home = (await homeDir()).replace(/\/$/, "");
    const full = want.startsWith("~/") ? `${home}/${want.slice(2)}` : want;
    const inside = full.startsWith(`${home}/`) ? full.slice(home.length + 1).split("/")[0] : null;
    if (inside && GUARDED.includes(inside)) return null;
    const [dir] = await invoke<string[]>("existing_dirs", { paths: [full] }).catch(() => []);
    const [git] = dir ? await invoke<string[]>("existing_dirs", { paths: [`${dir}/.git`] }).catch(() => []) : [];
    return dir && git ? { label: `local checkout ${dir.split("/").filter(Boolean).pop()}`, dir } : null;
  }
  if (!/^[\w.-]+(\/[\w.-]+)?$/.test(want)) return null;
  const [found] = await invoke<[string, string][]>("find_checkouts", { repos: [want] }).catch(() => []);
  if (found) return { label: `your local checkout of ${want} (on whatever branch you have out)`, dir: found[1] };
  if (!want.includes("/")) return null;
  const dir = await invoke<string>("mirror_repo", { repo: want }).catch(() => null);
  return dir ? { label: `GitHub ${want} (default branch)`, dir } : null;
}

/** Repos being cloned or refreshed now, so a run doesn't start a second copy of the same one. */
const fetching = new Set<string>();

/** Clones or refreshes these repos' mirrors in the background, one at a time; nothing waits on it. */
export function fetchMirrors(repos: string[]) {
  const todo = repos.filter((r) => !fetching.has(r));
  todo.forEach((r) => fetching.add(r));
  (async () => {
    for (const repo of todo) {
      await invoke<string>("mirror_repo", { repo }).catch(() => null);
      fetching.delete(repo);
    }
  })();
}

let root: string | null = null;
async function mirrorsRoot(): Promise<string> {
  if (!root) {
    const { appDataDir } = await import("@tauri-apps/api/path");
    root = `${(await appDataDir()).replace(/\/$/, "")}/repos`;
  }
  return root;
}

/** The project a task belongs to, from any source: its own list (filed under one), or a project's tasks. */
export async function projectOfTask(taskId: string): Promise<Project | null> {
  const [projects, manual, moved] = await Promise.all([db.listProjects(), db.listManualTasks(), db.getProjectOverrides()]);
  // Moved to another project (see setTaskProject): that one's.
  const to = moved[taskId] ? projects.find((p) => p.channel_id === moved[taskId]) : undefined;
  if (to) return to;
  const filed = manual.find((t) => t.id === taskId)?.project_id;
  if (filed) return projects.find((p) => p.channel_id === filed) ?? null;
  return projects.find((p) => (p.snapshot?.my_tasks ?? []).some((t) => t.id === taskId)) ?? null;
}

/** What to tell Claude about the code it can read, for a prompt or system prompt. */
export function codeNote(sources: CodeSource[], projects: Project[] = []): string {
  if (!sources.length) return "";
  const forWhat = projects.length === 1 ? ` for "${projectName(projects[0])}"` : "";
  return [
    `You can read code${forWhat}, read-only, with the Read, Grep and Glob tools:`,
    ...sources.map((s) => `- ${s.label}: ${s.dir}`),
    "When a question depends on how something is built or behaves (an API, a config value, whether a change is in, what a function does), look in the code rather than guessing, and say which file you found it in. GitHub copies are the default branch as of the last few hours; a local checkout can be on another branch or have uncommitted work.",
    "These folders are the only code you can read: don't search my home folder or anywhere else for other checkouts. If you need code that isn't here, ask my planner for it with an `[orb] code` line (see above).",
  ].join("\n");
}
