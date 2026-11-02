import { useCallback, useEffect, useState } from "react";
import * as db from "../db";
import { applyAction, describeAction } from "../globalActions";
import { globalChatKey, startGlobalChat } from "../jobs";
import { projectName } from "../projects";
import type { Project } from "../db";
import { unsentMessages, useSessionProgress, type PendingAction, type SessionLink } from "../sessions";
import { useJobStatus } from "../useAppData";
import { Spinner } from "./common";
import { SessionChat } from "./TaskCard";

/**
 * A change the chat proposed, as a card: what it does, with Apply and Not this. Applying it runs the
 * change, tells the session what came of it, and leaves the card showing the result.
 */
function ActionRow({
  chatKey,
  item,
  link,
  describe,
  onChange,
}: {
  chatKey: string;
  item: PendingAction;
  link: SessionLink | undefined;
  describe: (item: PendingAction) => string;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const result = link?.applied?.[item.key];
  if (link?.dismissedKeys?.includes(item.key)) return null;
  const summary = describe(item);
  const apply = async () => {
    if (!item.action) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await applyAction(item.action);
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
    <div className={`handoff action-card small${result ? " applied" : ""}`}>
      <div className="handoff-head">
        <span className="action-summary">{summary}</span>
        {!result && item.action && (
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
      {result && <div className="muted">✓ {result.result}</div>}
      {error && <div className="error">Couldn't apply it: {error}</div>}
    </div>
  );
}

/**
 * The global chat, opened from the corner beside Refresh all: tell Demian what it has wrong or
 * missing, and it proposes changes (split or add a project, a standing correction, a refresh) to
 * apply one by one. One ongoing conversation, kept across restarts; New chat starts another.
 */
export function GlobalChat({ projects, onClose, onApplied }: { projects: Project[]; onClose: () => void; onApplied: () => void }) {
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

  // Names for the cards: projects by id, channels by id.
  const project = (id: string) => {
    const p = projects.find((x) => x.channel_id === id);
    return p ? projectName(p) : id;
  };
  const channel = (id: string) => projects.flatMap((p) => p.channels).find((c) => c.channel_id === id)?.name ?? id;
  const describe = (item: PendingAction) => (item.action ? describeAction(item.action, project, channel) : (item.error ?? "Couldn't read this change"));

  if (!key) return null;
  const started = !!link;
  return (
    <SessionChat
      taskId={key}
      title="Demian chat"
      ask={null}
      plain
      messages={progress?.messages ?? []}
      working={working ?? (link && !link.sessionId ? "Starting" : undefined)}
      toSend={progress ? unsentMessages(progress.sends, link) : []}
      canReply
      placeholder="Tell Demian what's wrong or missing…"
      empty={
        <p className="muted small global-chat-empty">
          Tell Demian what it has wrong or missing: a project that's really two, one it hasn't found, context the daily plan is missing. It'll
          propose changes for you to apply.
        </p>
      }
      headAction={
        started && (
          <button
            className="link-button small more-link"
            onClick={async () => {
              setLink(undefined);
              setKey(await globalChatKey(true));
            }}
          >
            New chat
          </button>
        )
      }
      extra={(progress?.actions ?? []).map((item) => (
        <ActionRow
          key={item.key}
          chatKey={key}
          item={item}
          link={link}
          describe={describe}
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
