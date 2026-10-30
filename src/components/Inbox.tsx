import { useState } from "react";
import { setTaskState } from "../db";
import { draftReply, sendSlackReply } from "../jobs";
import { slackThread } from "../projects";
import type { QuickReply } from "../schema";
import { stateOf, type TaskState } from "../tasks";
import { useJobStatus } from "../useAppData";
import { formatWhen } from "../scheduler";
import { ComposeModal, ExternalLink, Spinner } from "./common";

const SOURCE_LABEL = { slack: "Slack", email: "Email" } as const;

function Draft({ reply, text, onRegenerate, onSent }: { reply: QuickReply; text: string; onRegenerate: () => void; onSent: () => void }) {
  const [copied, setCopied] = useState(false);
  // Slack replies go out from here, through the same review-and-send modal as blocker reminders.
  const canSend = reply.source === "slack" && !!slackThread(reply.link);
  const [composing, setComposing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sending = useJobStatus(`reply:${reply.id}`);
  const send = async () => {
    if (!composing?.trim() || !reply.link) return;
    try {
      setError(null);
      await sendSlackReply(reply.id, reply.link, composing.trim());
      setComposing(null);
      onSent();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="reply-draft">
      <p className="small">{text}</p>
      <div className="reply-draft-actions">
        {canSend && (
          <button className="link-button small" onClick={() => setComposing(text)}>
            Send reply
          </button>
        )}
        <button
          className="link-button small"
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <ExternalLink href={reply.link} className="link-button small">
          Open {reply.source === "email" ? "email" : "thread"}
        </ExternalLink>
        <button className="link-button small muted" onClick={onRegenerate}>
          Regenerate
        </button>
      </div>
      {composing !== null && (
        <ComposeModal
          heading={`Reply to ${reply.from}`}
          note={`Replies in the ${reply.where ?? "Slack"} thread, as you.`}
          text={composing}
          status={sending ? `${sending}…` : error ? `Couldn't send: ${error}` : null}
          failed={!!error && !sending}
          busy={!!sending}
          onChange={setComposing}
          onCancel={() => !sending && setComposing(null)}
          onSend={send}
        />
      )}
    </div>
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
      {open.map((r) => {
        const drafting = running.includes(`draft:${r.id}`);
        const draft = drafts.get(r.id);
        const draftIt = () => draftReply(r).catch(() => {});
        return (
          <div key={r.id} className="card inbox-item">
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
              {drafting ? (
                <DraftingStatus id={r.id} />
              ) : (
                !draft && (
                  <button className="link-button small inbox-action" onClick={draftIt}>
                    Draft response
                  </button>
                )
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
                ×
              </button>
            </div>
            {draft && !drafting && <Draft reply={r} text={draft.text} onRegenerate={draftIt} onSent={onChange} />}
          </div>
        );
      })}
      </div>
    </section>
  );
}
