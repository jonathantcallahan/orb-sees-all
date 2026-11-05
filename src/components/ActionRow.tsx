import { useEffect, useState } from "react";
import * as db from "../db";
import { actionNames, applyAction, describeAction, taskChatChanges } from "../globalActions";
import type { PendingAction, SessionLink } from "../sessions";
import { Spinner } from "./common";

/**
 * A change the chat proposed, as a card: what it does, with Apply and Not this. Applying it runs the
 * change and tells the session what came of it; the card then goes (View learnings shows what stuck).
 */
export function ActionRow({
  chatKey,
  item,
  link,
  describe,
  said,
  onChange,
}: {
  chatKey: string;
  item: PendingAction;
  link: SessionLink | undefined;
  describe: (item: PendingAction) => string;
  /** What the user said in the chat before this was proposed, recorded as the reason. */
  said?: string;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const result = link?.applied?.[item.key];
  // Once applied (or turned down) it's done here; what Demian learned lives in Settings (View learnings).
  if (link?.dismissedKeys?.includes(item.key) || result) return null;
  const summary = describe(item);
  const apply = async () => {
    if (!item.action) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await applyAction(item.action, said, summary);
      // The session hears about it with your next message (see globalContext), so applying costs no turn.
      await db.updateSessionLink(chatKey, { applied: { ...(link?.applied ?? {}), [item.key]: { summary, result: outcome } } });
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="handoff action-card small">
      <div className="handoff-head">
        <span className="action-summary">{summary}</span>
        {item.action && (
          <span className="action-buttons">
            <button
              className="cta-ghost"
              disabled={busy}
              onClick={async () => {
                await db.updateSessionLink(chatKey, { dismissedKeys: [...(link?.dismissedKeys ?? []), item.key] });
                onChange();
              }}
            >
              Not this
            </button>
            <button className="cta-primary" disabled={busy} onClick={apply}>
              {busy ? <Spinner /> : "Apply"}
            </button>
          </span>
        )}
      </div>
      {error && <div className="error">Couldn't apply it: {error}</div>}
    </div>
  );
}

/**
 * A task chat's proposals to change its task (move it to another project, or change its title or
 * description), the changes a task's chat makes: each as a card to apply, always about this task
 * whatever the chat named.
 */
export function TaskChangeCards({ taskId, title, actions, link, said, onChange }: { taskId: string; title: string; actions: PendingAction[]; link: SessionLink | undefined; said?: string; onChange: () => void }) {
  const [projects, setProjects] = useState<db.Project[]>([]);
  useEffect(() => {
    db.listProjects().then(setProjects, () => {});
  }, []);
  const names = actionNames(projects);
  const changes = taskChatChanges(actions, taskId, title);
  if (!changes.length) return null;
  return (
    <>
      {changes.map((item) => (
        <ActionRow
          key={item.key}
          chatKey={taskId}
          item={item}
          link={link}
          describe={(i) => (i.action ? describeAction(i.action, names.project, names.channel, names.item) : (i.error ?? "Couldn't read this change"))}
          said={said}
          onChange={onChange}
        />
      ))}
    </>
  );
}
