import { useCallback, useEffect, useState } from "react";
import * as db from "../db";
import { explainUpdate } from "../jobs";
import { explainPrompt, type ExplainedUpdate } from "../openInClaude";
import { useSessionProgress, type SessionLink } from "../sessions";
import { useJobStatus } from "../useAppData";
import { SessionChat } from "./TaskCard";

/**
 * An update's "Explain this": the same chat as a task's, with the update at the top. The first time
 * it opens, a session starts that reads the update's source and explains it; later it reopens that
 * conversation, ready for follow-up questions.
 */
export function ExplainChat({ update, onClose }: { update: ExplainedUpdate; onClose: () => void }) {
  const [link, setLink] = useState<SessionLink | undefined>();
  const reload = useCallback(() => {
    db.getSessionLinks().then((links) => setLink(links[update.key]), () => {});
  }, [update.key]);
  useEffect(() => {
    (async () => {
      if (!(await db.getSessionLinks())[update.key]) await explainUpdate(update.key, explainPrompt(update), reload);
      reload();
    })();
  }, [update.key]);
  const progress = useSessionProgress(update.key, link, reload);
  const working = useJobStatus(`session:${update.key}`);
  return (
    <SessionChat
      taskId={update.key}
      title="Update detail chat"
      ask={{ step: null, title: `Explain the following update from ${update.label}`, note: update.text }}
      messages={progress?.messages ?? []}
      working={working ?? (link && !link.sessionId ? "Reading the source" : undefined)}
      toSend={[]}
      canReply={!!link?.sessionId}
      plain
      onClose={onClose}
      onChange={reload}
    />
  );
}
