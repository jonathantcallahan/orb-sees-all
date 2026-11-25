import { useCallback, useEffect, useState } from "react";
import * as db from "../db";
import type { Project } from "../db";
import { actionNames, describeAction } from "../globalActions";
import { startSprintChat } from "../jobs";
import { unsentMessages, useSessionProgress, type PendingAction, type SessionLink } from "../sessions";
import { useJobStatus } from "../useAppData";
import type { SprintChatAbout } from "../sprintChat";
import { ActionRow } from "./ActionRow";
import { SessionChat } from "./TaskCard";

export type { SprintChatAbout };

/** Example messages for the empty reply box: the kinds of things the chat is for. */
function examplePrompts(about: SprintChatAbout): string[] {
  if (about.kind === "sprints") return ["How's the sprint going?", "Which epics are at risk?", "Does anyone have too much on?", "What's blocked, and on whom?"];
  if (about.kind === "epic") return ["What's left on this epic?", "Who's working on what here?", "What's blocked, and on whom?", "Will it make its due date?"];
  if (!about.name) return ["What are these issues?", "Which of these matter most?", "Who could take them?"];
  const first = about.name.split(" ")[0];
  return [`What is ${first} working on?`, `What's ${first} blocked on?`, `What has ${first} finished this sprint?`, `Does ${first} have too much on?`];
}

/**
 * A chat from the Epics area: the area's own, filling the right column, about the project's sprints;
 * or, under the issues there, one about an epic or a person's work in the sprint. Ask, and have Demian
 * change what it knows, each change a card to apply (see sprintChat.ts). One ongoing conversation each,
 * kept across restarts. As a project's chat is.
 */
export function SprintChat({ chatKey, about, onClose }: { chatKey: string; about: SprintChatAbout; onClose: () => void }) {
  const [link, setLink] = useState<SessionLink | undefined>();
  const [projects, setProjects] = useState<Project[]>([]);
  const reload = useCallback(() => {
    db.getSessionLinks().then((links) => setLink(links[chatKey]), () => {});
  }, [chatKey]);
  useEffect(reload, [reload]);
  // The projects' names, so a change's card can name what it touches.
  useEffect(() => {
    db.listProjects().then(setProjects, () => {});
  }, []);
  const progress = useSessionProgress(chatKey, link, reload);
  const working = useJobStatus(`session:${chatKey}`);
  const names = actionNames(projects);
  const describe = (item: PendingAction) => (item.action ? describeAction(item.action, names.project, names.channel, names.item) : (item.error ?? "Couldn't read this change"));
  const started = !!link;
  const subject = about.kind === "sprints" ? `${about.project} · current and upcoming sprints` : about.kind === "epic" ? `${about.epic} · ${about.title}` : (about.name ?? "Unassigned");
  const asking = about.kind === "sprints" ? "Ask about the sprints…" : about.kind === "epic" ? "Ask about this epic…" : `Ask about ${about.name ?? "these issues"}…`;
  return (
    <SessionChat
      taskId={chatKey}
      title={about.kind === "sprints" ? "Epics chat" : about.kind === "epic" ? "Epic chat" : "Chat"}
      subtitle={subject}
      ask={null}
      plain
      messages={progress?.messages ?? []}
      working={working ?? (link && !link.sessionId ? "Starting" : undefined)}
      toSend={progress ? unsentMessages(progress.sends, link) : []}
      canReply
      placeholder={started ? asking : examplePrompts(about)}
      extra={(progress?.actions ?? []).map((item) => (
        <ActionRow
          key={item.key}
          chatKey={chatKey}
          item={item}
          link={link}
          describe={describe}
          said={[...(progress?.messages ?? [])].reverse().find((m) => m.role === "user")?.text}
          onChange={reload}
        />
      ))}
      onSend={started ? undefined : (message) => startSprintChat(chatKey, about, message, reload).then(reload, reload)}
      onClose={onClose}
      onChange={reload}
    />
  );
}
