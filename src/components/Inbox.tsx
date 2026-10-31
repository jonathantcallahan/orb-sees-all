import { useEffect, useState } from "react";
import { setTaskState } from "../db";
import { draftReply, sendSlackReply } from "../jobs";
import { slackThread } from "../projects";
import type { QuickReply } from "../schema";
import { stateOf, type TaskState } from "../tasks";
import { useJobStatus } from "../useAppData";
import { formatWhen } from "../scheduler";
import { CloseIcon, ComposeModal, ExternalLink, Spinner } from "./common";

const SOURCE_LABEL = { slack: "Slack", email: "Email" } as const;

/**
 * A drafted response in a centered editor. Slack replies can be sent from here, into the
 * message's thread; emails are copied or opened in Gmail.
 */
function ResponseModal({
  reply,
  draft,
  regenerating,
  onRegenerate,
  onClose,
  onSent,
}: {
  reply: QuickReply;
  draft: string;
  regenerating: boolean;
  onRegenerate: () => void;
  onClose: () => void;
  onSent: () => void;
}) {
  const [text, setText] = useState(draft);
  // A regenerated draft replaces the text.
  useEffect(() => setText(draft), [draft]);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useJobStatus(`reply:${reply.id}`);
  // Any Slack message can be answered from here: in its thread when its link names one, otherwise
  // Claude finds the message first.
  const canSend = reply.source === "slack";
  const threaded = !!(slackThread(reply.link) ?? slackThread(reply.id));
  const send = async () => {
    if (!text.trim()) return;
    try {
      setError(null);
      await sendSlackReply(reply, text.trim());
      onClose();
      onSent();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <ComposeModal
      heading={`Reply to ${reply.from}`}
      note={
        canSend
          ? threaded
            ? `Replies in the ${reply.where ?? "Slack"} thread, as you.`
            : `Finds ${reply.from}'s message and replies in its thread, as you.`
          : `Copy it into your reply${reply.where ? ` to "${reply.where}"` : ""}.`
      }
      text={text}
      status={sending ? `${sending}…` : regenerating ? "Drafting a new version…" : error ? `Couldn't send: ${error}` : null}
      failed={!!error && !sending}
      busy={!!sending || regenerating}
      onChange={setText}
      onCancel={() => !sending && onClose()}
      onSend={canSend ? send : undefined}
      actions={
        <>
          <button className="link-button small more-link" disabled={regenerating} onClick={onRegenerate}>
            Regenerate
          </button>
          <ExternalLink href={reply.link} className="link-button small more-link">
            Open {reply.source === "email" ? "email" : "thread"}
          </ExternalLink>
          <button
            className="link-button small more-link"
            onClick={async () => {
              await navigator.clipboard.writeText(text);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </>
      }
    />
  );
}

function DraftingStatus({ id }: { id: string }) {
  const status = useJobStatus(`draft:${id}`);
  return (
    <span className="muted small inbox-drafting" title={status}>
      <Spinner /> {status ?? "Drafting"}…
    </span>
  );
}

/** Slack messages and emails waiting on the user, with Claude-drafted responses to copy, or for Slack, to send. */
export function Inbox({
  replies,
  states,
  drafts,
  running,
  onChange,
}: {
  replies: QuickReply[];
  states: Map<string, TaskState>;
  drafts: Map<string, { text: string }>;
  running: string[];
  onChange: () => void;
}) {
  const open = replies.filter((r) => {
    const st = stateOf(states, r.id);
    return !st.done && !st.dismissed;
  });
  if (open.length === 0) return null;

  return (
    <section className="inbox">
      <h4 className="section-title">
        Inbox <span className="muted">{open.length}</span>
      </h4>
      <div className="inbox-list">
      {open.map((r) => (
        <InboxItem key={r.id} reply={r} draft={drafts.get(r.id)?.text} drafting={running.includes(`draft:${r.id}`)} onChange={onChange} />
      ))}
      </div>
    </section>
  );
}

/** One inbox row. Draft response opens the editor once the draft arrives; View draft reopens it. */
function InboxItem({ reply: r, draft, drafting, onChange }: { reply: QuickReply; draft?: string; drafting: boolean; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  // Set when you ask for a draft, so the editor opens when it's ready.
  const [awaiting, setAwaiting] = useState(false);
  useEffect(() => {
    if (awaiting && draft && !drafting) {
      setEditing(true);
      setAwaiting(false);
    }
  }, [awaiting, draft, drafting]);
  const draftIt = () => {
    setAwaiting(true);
    draftReply(r).catch(() => setAwaiting(false));
  };
  return (
    <div className="card inbox-item">
      <div className="inbox-row" title={r.where ?? undefined}>
        <span className={`source ${r.source}`}>{SOURCE_LABEL[r.source]}</span>
        <span className="inbox-from">{r.from}</span>
        <ExternalLink href={r.link} className="inbox-summary">
          {r.summary}
        </ExternalLink>
        {r.received && (
          <span className="inbox-time" title={new Date(r.received).toLocaleString()}>
            {formatWhen(r.received)}
          </span>
        )}
        {drafting && !editing ? (
          <DraftingStatus id={r.id} />
        ) : (
          <button className="link-button small inbox-action" onClick={() => (draft ? setEditing(true) : draftIt())}>
            {draft ? "View draft" : "Draft response"}
          </button>
        )}
        <button
          className="icon-button inbox-action"
          title="Mark as handled"
          aria-label="Mark as handled"
          onClick={async () => {
            await setTaskState(r.id, { status: "done" });
            onChange();
          }}
        >
          <CloseIcon />
        </button>
      </div>
      {editing && draft && (
        <ResponseModal reply={r} draft={draft} regenerating={drafting} onRegenerate={() => draftReply(r).catch(() => {})} onClose={() => setEditing(false)} onSent={onChange} />
      )}
    </div>
  );
}
