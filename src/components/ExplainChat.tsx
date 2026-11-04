import { useCallback, useEffect, useState } from "react";
import { setTaskState } from "../db";
import * as db from "../db";
import { startChatSession } from "../jobs";
import { explainPrompt, replyPrompt, watchChatPrompt, type ExplainedUpdate, type ReplyTopic } from "../openInClaude";
import { WATCH_CHAT, type WatchedTopic } from "../watched";
import { unsentMessages, useSessionProgress, type SessionLink } from "../sessions";
import { useJobStatus } from "../useAppData";
import { SessionChat, type SessionAsk } from "./TaskCard";

/**
 * A chat about something that isn't a task, in the same window as a task's: the first time it opens,
 * a session starts from `prompt`; later it reopens that conversation. Messages the session hands
 * over to send show in the chat to review and send.
 */
function TopicChat({
  id,
  prompt,
  title,
  ask,
  onSent,
  onPlan,
  onClose,
}: {
  id: string;
  prompt: () => string;
  title: string;
  ask: SessionAsk;
  /** A handed-over message was sent. */
  onSent?: () => void;
  /** The session wrote a new "[orb] plan" block: its lines. */
  onPlan?: (lines: string[]) => void;
  onClose: () => void;
}) {
  const [link, setLink] = useState<SessionLink | undefined>();
  const reload = useCallback(() => {
    db.getSessionLinks().then((links) => setLink(links[id]), () => {});
  }, [id]);
  useEffect(() => {
    (async () => {
      if (!(await db.getSessionLinks())[id]) await startChatSession(id, prompt(), reload);
      reload();
    })();
  }, [id]);
  const progress = useSessionProgress(id, link, reload);
  const working = useJobStatus(`session:${id}`);
  const sentCount = link?.sentKeys?.length ?? 0;
  const planKey = progress?.plan ? JSON.stringify(progress.plan) : null;
  useEffect(() => {
    if (planKey && progress?.plan) onPlan?.(progress.plan.map((s) => s.title));
  }, [planKey]);
  useEffect(() => {
    if (sentCount > 0) onSent?.();
  }, [sentCount]);
  return (
    <SessionChat
      taskId={id}
      title={title}
      ask={ask}
      messages={progress?.messages ?? []}
      working={working ?? (link && !link.sessionId ? "Reading the source" : undefined)}
      toSend={progress ? unsentMessages(progress.sends, link) : []}
      canReply={!!link?.sessionId}
      plain
      onClose={onClose}
      onChange={reload}
    />
  );
}

/** An update's Explain: a session reads where the update came from and explains it, then answers follow-ups. */
export function ExplainChat({ update, onClose }: { update: ExplainedUpdate; onClose: () => void }) {
  return (
    <TopicChat
      id={update.key}
      prompt={() => explainPrompt(update)}
      title="Update detail chat"
      ask={{ step: null, title: `Explain the following update from ${update.label}`, note: update.text }}
      onClose={onClose}
    />
  );
}

/** A watched topic's Discuss: a session reads the latest on it, says where it stands, then answers follow-ups. */
export function WatchChat({
  topic,
  projectName,
  onActions,
  onClose,
}: {
  topic: WatchedTopic;
  projectName: string | null;
  /** The chat restated the conditional actions (an "[orb] plan" block): its lines. */
  onActions: (lines: string[]) => void;
  onClose: () => void;
}) {
  return (
    <TopicChat
      id={`${WATCH_CHAT}${topic.id}`}
      prompt={() => watchChatPrompt({ ...topic, projectName })}
      title="Watched topic chat"
      ask={{ step: null, title: `About the watched topic "${topic.topic}"`, note: topic.status?.summary ?? "" }}
      onPlan={onActions}
      onClose={onClose}
    />
  );
}

/**
 * An inbox item's Draft response: a session reads the message, drafts a reply in your voice and
 * refines it with you. A Slack reply comes back to review and send from the chat, after which the
 * item is marked handled; an email reply stays in the chat to copy.
 */
export function ReplyChat({ reply, onClose, onSent }: { reply: ReplyTopic; onClose: () => void; onSent: () => void }) {
  return (
    <TopicChat
      id={reply.id}
      prompt={() => replyPrompt(reply)}
      title="Reply chat"
      ask={{ step: null, title: `Reply to ${reply.from}${reply.where ? ` in ${reply.where}` : ""}`, note: reply.summary }}
      onSent={async () => {
        await setTaskState(reply.id, { status: "done" });
        onSent();
      }}
      onClose={onClose}
    />
  );
}
