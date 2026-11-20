import { useCallback, useEffect, useState } from "react";
import * as db from "../db";
import type { Project } from "../db";
import { actionNames, describeAction } from "../globalActions";
import { startProjectChat } from "../jobs";
import { projectChatKey } from "../projectChat";
import { pathToShip, projectName } from "../projects";
import { unsentMessages, useSessionProgress, type PendingAction, type SessionLink } from "../sessions";
import { useJobStatus } from "../useAppData";
import { ActionRow } from "./ActionRow";
import { SessionChat } from "./TaskCard";

/** Example messages for the empty reply box: the kinds of things a project's chat is for. */
function examplePrompts(project: Project): string[] {
  const person = (project.profile?.people ?? []).find((p) => p.raci === "responsible")?.name.split(" ")[0];
  return [
    pathToShip(project)?.steps.length ? "What's left before this ships?" : "What's happening on this lately?",
    person ? `What is ${person} working on for this?` : "Who's working on what?",
    "What's blocked, and on whom?",
    "Add a channel or epic I forgot to link",
  ];
}

/**
 * A project's chat, under its details: ask about the project (its record, people, plan and the work
 * itself) and have Demian change what it knows, with each change as a card to apply. One ongoing
 * conversation per project, kept across restarts.
 */
export function ProjectChat({ project, projects, onClose, onApplied }: { project: Project; projects: Project[]; onClose: () => void; onApplied: () => void }) {
  const key = projectChatKey(project.channel_id);
  const [link, setLink] = useState<SessionLink | undefined>();
  const reload = useCallback(() => {
    db.getSessionLinks().then((links) => setLink(links[key]), () => {});
  }, [key]);
  useEffect(reload, [reload]);
  const progress = useSessionProgress(key, link, reload);
  const working = useJobStatus(`session:${key}`);
  const names = actionNames(projects);
  const describe = (item: PendingAction) => (item.action ? describeAction(item.action, names.project, names.channel, names.item) : (item.error ?? "Couldn't read this change"));
  const started = !!link;
  return (
    <SessionChat
      taskId={key}
      title="Project chat"
      subtitle={projectName(project)}
      ask={null}
      plain
      messages={progress?.messages ?? []}
      working={working ?? (link && !link.sessionId ? "Starting" : undefined)}
      toSend={progress ? unsentMessages(progress.sends, link) : []}
      canReply
      placeholder={started ? "Ask about this project…" : examplePrompts(project)}
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
      onSend={started ? undefined : (message) => startProjectChat(project, message, reload).then(reload, reload)}
      onClose={onClose}
      onChange={reload}
    />
  );
}
