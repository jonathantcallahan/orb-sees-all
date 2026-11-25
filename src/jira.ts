import { invoke } from "@tauri-apps/api/core";
import * as db from "./db";
import { setJiraDirect } from "./features";

export { useJiraDirect } from "./features";

/**
 * Demian's own connection to Jira Cloud: with a site, an email and an API token (kept in the Keychain,
 * see src-tauri/src/jira.rs), the Epics area reads sprints and issues through Jira's REST API, and the
 * chats' change cards are applied the same way, without a Claude run. Without one, both go through
 * Claude and its Jira connector, as before. The chats themselves always do.
 */

export const JIRA_SITE_SETTING = "jira_site";
export const JIRA_EMAIL_SETTING = "jira_email";

/** Where an Atlassian account's API tokens are made. */
export const API_TOKENS_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";

/** A connection to a Jira Cloud site: requests to its REST API, signed with the saved token. */
export interface Jira {
  /** The site's origin, "https://<site>.atlassian.net": issue links are made from it. */
  site: string;
  get<T = any>(path: string): Promise<T>;
  post<T = any>(path: string, body: unknown): Promise<T>;
  put<T = any>(path: string, body: unknown): Promise<T>;
}

/** A request Jira turned down: its message, in Jira's words where it gave some, and the HTTP status. */
export class JiraError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Method = "GET" | "POST" | "PUT";
type Response = { status: number; body: unknown; retry_after: number | null };
export type Send = (method: Method, path: string, body?: unknown) => Promise<Response>;

/** The site's origin from what was typed ("your-site.atlassian.net", a link into it), or null when it isn't a Jira Cloud site. */
export function siteOrigin(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  try {
    const url = new URL(t.includes("://") ? t : `https://${t}`);
    const host = url.hostname.toLowerCase();
    const label = host.endsWith(".atlassian.net") ? host.slice(0, -".atlassian.net".length) : "";
    if (url.protocol !== "https:" || url.port || url.username || url.password || !label || label.includes(".")) return null;
    return `https://${host}`;
  } catch {
    return null;
  }
}

/** What went wrong with a request, for the person reading it: Jira's own words where it gave some. */
export function jiraMessage(status: number, body: unknown): string {
  if (status === 401) return "Jira didn't accept the API token. Check it in Settings › Jira.";
  const b = body as { errorMessages?: unknown; errors?: unknown; message?: unknown } | string | null | undefined;
  const said =
    typeof b === "string"
      ? b.trim().startsWith("<")
        ? []
        : [b.trim().slice(0, 300)]
      : [
          ...(Array.isArray(b?.errorMessages) ? b.errorMessages.filter((m): m is string => typeof m === "string") : []),
          ...(b?.errors && typeof b.errors === "object" ? Object.entries(b.errors as Record<string, unknown>).map(([k, v]) => `${k}: ${String(v)}`) : []),
          ...(typeof b?.message === "string" ? [b.message] : []),
        ];
  const words = said.filter(Boolean).join(" ");
  if (status === 403) return `Jira refused (403)${words ? `: ${words}` : ": the account may not have access."}`;
  if (status === 404) return words || "Jira couldn't find it (404).";
  return words ? `${words} (${status})` : `Jira answered ${status}.`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A connection that sends its requests with `send` (to Jira through the app, unless a test gives another). */
export function jiraClient(
  site: string,
  email: string,
  send: Send = (method, path, body) =>
    invoke<Response>("jira_request", {
      site,
      email,
      method,
      path,
      body: body ?? null,
    }),
): Jira {
  const call = async (method: Method, path: string, body?: unknown) => {
    for (let attempt = 0; ; attempt++) {
      const r = await send(method, path, body);
      // Too busy: wait as long as Jira asks (a little, at most), twice.
      if (r.status === 429 && attempt < 2) {
        await sleep(Math.min(r.retry_after ?? 2, 10) * 1000);
        continue;
      }
      if (r.status >= 200 && r.status < 300) return r.body as any;
      throw new JiraError(jiraMessage(r.status, r.body), r.status);
    }
  };
  return {
    site: siteOrigin(site) ?? site,
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b),
    put: (p, b) => call("PUT", p, b),
  };
}

/** The site and email set in Settings, as typed ("" when not). */
export async function jiraSettings(): Promise<{ site: string; email: string }> {
  const [site, email] = await Promise.all([db.getSetting(JIRA_SITE_SETTING), db.getSetting(JIRA_EMAIL_SETTING)]).catch(() => [null, null]);
  return { site: site ?? "", email: email ?? "" };
}

/** Whether a token is saved for an email. */
export const hasJiraToken = (email: string) => (email.trim() ? invoke<boolean>("jira_has_token", { email }).catch(() => false) : Promise.resolve(false));

/** Demian's own connection to Jira, when a site, an email and a token are all set; null when not (Claude reads it then). */
export async function jiraConnection(): Promise<Jira | null> {
  const { site, email } = await jiraSettings();
  const origin = siteOrigin(site);
  const ok = !!origin && !!email.trim() && (await hasJiraToken(email));
  // Kept with the areas: Epics can be on with it alone, and its reads come round more often with it.
  setJiraDirect(ok);
  return ok ? jiraClient(origin!, email.trim()) : null;
}

/** Saves the site and email, and the token when one's given (to the Keychain), then checks again whether Demian reads Jira itself. */
export async function saveJiraSettings(s: { site: string; email: string; token?: string }): Promise<void> {
  await db.setSetting(JIRA_SITE_SETTING, s.site.trim());
  await db.setSetting(JIRA_EMAIL_SETTING, s.email.trim());
  if (s.token?.trim()) await invoke("jira_save_token", { email: s.email, token: s.token });
  await jiraConnection();
}

/** Forgets the token for an email; Claude reads Jira again. */
export async function forgetJiraToken(email: string): Promise<void> {
  await invoke("jira_forget_token", { email });
  await jiraConnection();
}

/** Who the token signs in as: a check that the connection works. Throws with Jira's reason when it doesn't. */
export async function jiraWhoAmI(jira: Jira): Promise<string> {
  const me = await jira.get<{ displayName?: string; emailAddress?: string }>("/rest/api/3/myself");
  return me.displayName || me.emailAddress || "your account";
}

/** An issue as Jira's search gives it. */
export interface RawIssue {
  key: string;
  fields: Record<string, any>;
}

/** Every issue a JQL search finds (up to `limit`), with only the fields named, page by page. */
export async function searchIssues(jira: Jira, jql: string, fields: string[], limit = 2000): Promise<RawIssue[]> {
  const out: RawIssue[] = [];
  let next: string | undefined;
  for (let page = 0; page < 50 && out.length < limit; page++) {
    const r = await jira.post<{
      issues?: RawIssue[];
      nextPageToken?: string;
      isLast?: boolean;
    }>("/rest/api/3/search/jql", {
      jql,
      fields,
      maxResults: Math.min(100, limit - out.length),
      ...(next ? { nextPageToken: next } : {}),
    });
    out.push(...(r.issues ?? []));
    next = r.nextPageToken;
    if (!next || r.isLast) break;
  }
  return out.slice(0, limit);
}

/** How many issues a JQL search finds. */
export async function countIssues(jira: Jira, jql: string): Promise<number> {
  const r = await jira.post<{ count?: number }>("/rest/api/3/search/approximate-count", { jql });
  return r.count ?? 0;
}

/** A field of the site's, as Jira lists them. */
export interface JiraField {
  id: string;
  name: string;
  custom?: boolean;
  schema?: { type?: string; custom?: string; items?: string };
}

// The site's fields, read once a session: they rarely change.
const fieldsRead = new Map<string, Promise<JiraField[]>>();

/** The site's fields. */
export function jiraFields(jira: Jira): Promise<JiraField[]> {
  let read = fieldsRead.get(jira.site);
  if (!read) {
    read = jira.get<JiraField[]>("/rest/api/3/field").then((f) => (Array.isArray(f) ? f : []));
    read.catch(() => fieldsRead.delete(jira.site));
    fieldsRead.set(jira.site, read);
  }
  return read;
}

/** The Sprint field's id (customfield_10020 on most sites). */
export const sprintFieldOf = (fields: JiraField[]) => fields.find((f) => f.schema?.custom === "com.pyxis.greenhopper.jira:gh-sprint")?.id ?? "customfield_10020";

/** The Epic Link field's id, where the site still has one. */
export const epicLinkFieldOf = (fields: JiraField[]) => fields.find((f) => f.schema?.custom === "com.pyxis.greenhopper.jira:gh-epic-link")?.id ?? null;

/** Fields that could hold T-shirt sizes: custom ones named for a T-shirt size or a size estimate, holding a choice or text. */
export const sizeFieldCandidates = (fields: JiraField[]) =>
  fields.filter((f) => f.id.startsWith("customfield_") && /t-?\s?shirt|\bsizes?\b|\bestimat/i.test(f.name) && ["option", "string"].includes(f.schema?.type ?? "")).map((f) => f.id);

/** A field's value as text: a choice's value, a person's name, text as it is; the first of a list. */
export function fieldText(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.length ? fieldText(v[0]) : null;
  if (typeof v === "object") {
    const o = v as { value?: unknown; name?: unknown; displayName?: unknown };
    for (const x of [o.value, o.name, o.displayName]) if (typeof x === "string") return x;
  }
  return null;
}

export type Category = "done" | "in_progress" | "todo";

/** Done, In progress or To do, from a status's category. */
export function categoryOf(status: any): Category {
  const k = status?.statusCategory?.key;
  return k === "done" ? "done" : k === "indeterminate" ? "in_progress" : "todo";
}

/** A person's 48x48 avatar, or null. */
export const avatarOf = (user: any): string | null => user?.avatarUrls?.["48x48"] ?? null;

/** An issue's page on the site. */
export const issueLink = (site: string, key: string) => `${site}/browse/${key}`;

/** The key of an issue's epic: its parent's, when the parent is an epic, else its Epic Link's; null for none. */
export function epicOf(fields: Record<string, any> | undefined, epicLinkField: string | null): string | null {
  const parent = fields?.parent;
  const type = parent?.fields?.issuetype;
  if (typeof parent?.key === "string" && (type?.hierarchyLevel === 1 || /epic/i.test(type?.name ?? ""))) return parent.key;
  const link = epicLinkField ? fields?.[epicLinkField] : null;
  return typeof link === "string" && link ? link : null;
}

/** A sprint as an issue's Sprint field gives it. */
export interface RawSprint {
  id: number;
  name: string;
  state?: string;
  startDate?: string | null;
  endDate?: string | null;
}

/** The sprints an issue is in, from its Sprint field. */
export const sprintsOf = (fields: Record<string, any> | undefined, sprintField: string): RawSprint[] =>
  (Array.isArray(fields?.[sprintField]) ? (fields![sprintField] as unknown[]) : []).filter(
    (s): s is RawSprint => !!s && typeof (s as RawSprint).id === "number" && typeof (s as RawSprint).name === "string",
  );

/** An issue key and a project key, as they can go in JQL. */
export const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
export const PROJECT_KEY = /^[A-Z][A-Z0-9_]*$/;

/** Text as a JQL string. */
export const jqlString = (s: string) => `"${s.replace(/["\\]/g, (c) => `\\${c}`)}"`;
