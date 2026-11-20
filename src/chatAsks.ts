import type { AskAnswer, ChatAsk } from "./claude";

/**
 * What chats are asking the user right now, by chat key (a task's id, or a chat's own key): a tool
 * Claude Code wants to use that auto mode's check handed back, or every tool a chat wasn't given
 * where auto mode isn't available. Each waits in its chat window for an answer (see AskRow), and goes
 * once it's answered, Claude Code no longer needs it, or the turn ends or is stopped.
 */
interface Pending {
  ask: ChatAsk;
  resolve: (answer: AskAnswer) => void;
}

const pending = new Map<string, Pending[]>();
/** What each chat shows, kept as the same array until it changes (useSyncExternalStore needs that). */
const shown = new Map<string, ChatAsk[]>();
/** Chats whose turn asked for auto mode and got another (it isn't available), while the turn runs. */
const noAuto = new Set<string>();
const listeners = new Set<() => void>();
const NONE: ChatAsk[] = [];

function changed(key: string) {
  const list = pending.get(key) ?? [];
  if (list.length) shown.set(key, list.map((p) => p.ask));
  else {
    pending.delete(key);
    shown.delete(key);
  }
  for (const listener of listeners) listener();
}

export function subscribeAsks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The asks a chat is waiting on, oldest first. */
export function asksFor(key: string): ChatAsk[] {
  return shown.get(key) ?? NONE;
}

/** Puts an ask in its chat and waits for the user's answer. */
export function askInChat(key: string, ask: ChatAsk): Promise<AskAnswer> {
  return new Promise((resolve) => {
    pending.set(key, [...(pending.get(key) ?? []), { ask, resolve }]);
    changed(key);
  });
}

/**
 * The user's answer to one of a chat's asks. "Always" also allows the chat's other asks that its
 * rules cover: Claude often makes the same call more than once at a time, and each asked before the
 * first was answered.
 */
export function answerAsk(key: string, id: string, answer: AskAnswer) {
  const list = pending.get(key) ?? [];
  const hit = list.find((p) => p.ask.id === id);
  if (!hit) return;
  const covered =
    answer === "always" && hit.ask.rules.length ? list.filter((p) => p !== hit && p.ask.rules.length && p.ask.rules.every((r) => hit.ask.rules.includes(r))) : [];
  pending.set(
    key,
    list.filter((p) => p !== hit && !covered.includes(p)),
  );
  hit.resolve(answer);
  for (const p of covered) p.resolve("allow");
  changed(key);
}

/** An ask Claude Code no longer needs answered: it goes from the chat. */
export function dropAsk(key: string, id: string) {
  const list = pending.get(key) ?? [];
  const hit = list.find((p) => p.ask.id === id);
  if (!hit) return;
  pending.set(
    key,
    list.filter((p) => p !== hit),
  );
  hit.resolve("deny");
  changed(key);
}

/** Every ask a chat is waiting on is refused and goes: its turn ended or was stopped. */
export function clearAsks(key: string) {
  const list = pending.get(key) ?? [];
  pending.delete(key);
  for (const p of list) p.resolve("deny");
  if (list.length) changed(key);
}

/** Whether a chat's turn runs without the auto mode it asked for (false once the turn is done), for the note in the chat. */
export function setNoAutoMode(key: string, on: boolean) {
  if (noAuto.has(key) === on) return;
  if (on) noAuto.add(key);
  else noAuto.delete(key);
  for (const listener of listeners) listener();
}

export function noAutoMode(key: string): boolean {
  return noAuto.has(key);
}

/** How an ask reads in the chat: what Claude wants to do, what on, and the command itself for a shell command. */
export function askSummary(ask: ChatAsk): { eyebrow: string; title: string; code?: string; detail?: string } {
  const text = (name: string) => {
    const value = ask.input[name];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const json = () => {
    const shown = JSON.stringify(ask.input);
    return shown === "{}" ? undefined : shown.length > 300 ? `${shown.slice(0, 299)}…` : shown;
  };
  switch (ask.tool) {
    case "Bash":
      return { eyebrow: "Claude wants to run a command", title: ask.description ?? text("description") ?? "Run a command", code: text("command") };
    case "Edit":
    case "MultiEdit":
      return { eyebrow: "Claude wants to edit a file", title: text("file_path") ?? "A file" };
    case "Write":
      return { eyebrow: "Claude wants to write a file", title: text("file_path") ?? "A file" };
    case "NotebookEdit":
      return { eyebrow: "Claude wants to edit a notebook", title: text("notebook_path") ?? "A notebook" };
    case "Read":
      return { eyebrow: "Claude wants to read a file", title: text("file_path") ?? "A file" };
    case "Grep":
    case "Glob":
      return { eyebrow: "Claude wants to search files", title: text("pattern") ?? "Files", detail: text("path") };
    case "WebFetch":
      return { eyebrow: "Claude wants to open a page", title: text("url") ?? "A page", detail: text("prompt") };
    case "WebSearch":
      return { eyebrow: "Claude wants to search the web", title: text("query") ?? "The web" };
    case "Agent":
    case "Task":
      return { eyebrow: "Claude wants to start a subagent", title: text("description") ?? "A subagent", detail: text("prompt") };
  }
  if (ask.tool.startsWith("mcp__")) {
    const [, server = "", name = ""] = ask.tool.split("__");
    const source = ask.displayName ?? server.replace(/^claude_ai_/, "").replace(/_/g, " ");
    return { eyebrow: `Claude wants to use ${source}`, title: ask.title ?? ask.description ?? name.replace(/_/g, " "), detail: json() };
  }
  return { eyebrow: `Claude wants to use ${ask.tool}`, title: ask.description ?? ask.tool, detail: json() };
}
