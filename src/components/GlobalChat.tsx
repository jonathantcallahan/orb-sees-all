import { useCallback, useEffect, useState } from "react";
import * as db from "../db";
import { actionNames, applyAction, describeAction } from "../globalActions";
import { globalChatKey, startGlobalChat } from "../jobs";
import { projectName } from "../projects";
import type { Project } from "../db";
import { unsentMessages, useSessionProgress, type PendingAction, type SessionLink } from "../sessions";
import { useJobStatus } from "../useAppData";
import { Spinner } from "./common";
import { SessionChat } from "./TaskCard";
import { useOrbName } from "../orbLook";

/**
 * A change the chat proposed, as a card: what it does, with Apply and Not this. Applying it runs the
 * change and tells the session what came of it; the card then goes (View learnings shows what stuck).
 */
function ActionRow({
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
  const orbName = useOrbName();
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
      subtitle={`Ask ${orbName} to adjust your workspace`}
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
