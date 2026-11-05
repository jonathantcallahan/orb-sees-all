import { useCallback, useEffect, useState } from "react";
import * as db from "../db";
import { actionNames, describeAction } from "../globalActions";
import { globalChatKey, startGlobalChat } from "../jobs";
import { projectName } from "../projects";
import type { Project } from "../db";
import { unsentMessages, useSessionProgress, type PendingAction, type SessionLink } from "../sessions";
import { useJobStatus } from "../useAppData";
import { ActionRow } from "./ActionRow";
import { SessionChat } from "./TaskCard";

/**
 * Example messages for the empty reply box, made from what's on the board: the kinds of things the
 * chat is for, with real project and people names where there are some.
 */
function examplePrompts(projects: Project[]): string[] {
  const tracked = projects.filter((p) => p.state === "tracked").map(projectName);
  // Other people on the projects, not the user (who's in the snapshots' owner lists as "is_me").
  const me = new Set(projects.flatMap((p) => [...(p.snapshot?.blockers ?? []), ...(p.snapshot?.active ?? [])].flatMap((b) => b.owners.filter((o) => o.is_me).map((o) => o.name))));
  const people = [
    ...new Set(
      projects
        .flatMap((p) => p.profile?.people ?? [])
        .filter((x) => !me.has(x.name))
        .map((x) => x.name.split(" ")[0]),
    ),
  ];
  const [a, b, c] = tracked;
  const [x, y] = people;
  return [
    a ? `"${a}" is really two separate projects that should be split` : "One of my projects is really two separate projects",
    x && y ? `The daily briefing is missing the context from my DM with ${x} and ${y}` : "The daily briefing is missing context from one of my DMs",
    "I have an ongoing project that isn't on the board",
    b ? `"${b}" is paused until next quarter, so it isn't at risk` : "One of my projects is paused, so it isn't at risk",
    c ? `I'm only consulted on "${c}", so stop giving me its tasks` : "I'm only consulted on one project, so stop giving me its tasks",
  ];
}

/**
 * The global chat, opened from the corner beside Refresh all: tell Demian what it has wrong or
 * missing, and it proposes changes (split or add a project, a standing correction, a refresh) to
 * apply one by one. One ongoing conversation, kept across restarts. View learnings opens what it has
 * learned, in Settings.
 */
export function GlobalChat({
  projects,
  onClose,
  onApplied,
  onViewLearnings,
}: {
  projects: Project[];
  onClose: () => void;
  onApplied: () => void;
  onViewLearnings: () => void;
}) {
  const [key, setKey] = useState<string | null>(null);
  const [link, setLink] = useState<SessionLink | undefined>();
  useEffect(() => {
    globalChatKey().then(setKey, () => {});
  }, []);
  const reload = useCallback(() => {
    if (key) db.getSessionLinks().then((links) => setLink(links[key]), () => {});
  }, [key]);
  useEffect(reload, [key]);
  const progress = useSessionProgress(key ?? "", key ? link : undefined, reload);
  const working = useJobStatus(`session:${key}`);
  // How many things Demian has learned (what it knows plus its lessons), beside View learnings.
  const [learnings, setLearnings] = useState(0);
  useEffect(() => {
    Promise.all([db.getNotes(), db.listLessons()]).then(([notes, lessons]) => setLearnings(notes.length + lessons.length), () => {});
  }, [link?.applied]);

  // Names for the cards: projects by id, channels by id.
  const names = actionNames(projects);
  const describe = (item: PendingAction) => (item.action ? describeAction(item.action, names.project, names.channel, names.item) : (item.error ?? "Couldn't read this change"));

  if (!key) return null;
  const hints = examplePrompts(projects);
  const started = !!link;
  return (
    <SessionChat
      taskId={key}
      title="Demian"
      subtitle="Ask Demian to adjust your workspace"
      ask={null}
      plain
      messages={progress?.messages ?? []}
      working={working ?? (link && !link.sessionId ? "Starting" : undefined)}
      toSend={progress ? unsentMessages(progress.sends, link) : []}
      canReply
      // Example prompts only until the conversation starts; then an ordinary reply box.
      placeholder={started ? "Reply to Demian…" : hints}
      headAction={
        <button className="link-button more-link learnings-link" onClick={onViewLearnings}>
          View learnings{learnings > 0 && <span className="timestamp"> {learnings}</span>}
        </button>
      }
      extra={(progress?.actions ?? []).map((item) => (
        <ActionRow
          key={item.key}
          chatKey={key}
          item={item}
          link={link}
          describe={describe}
          said={[...(progress?.messages ?? [])].reverse().find((m) => m.role === "user")?.text}
          onChange={() => {
            reload();
            onApplied();
          }}
        />
      ))}
      onSend={started ? undefined : (message) => startGlobalChat(key, message, reload).then(reload, reload)}
      onClose={onClose}
      onChange={reload}
    />
  );
}
