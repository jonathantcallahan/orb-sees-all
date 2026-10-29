import { useState } from "react";
import { setTaskState } from "../db";
import { draftReply } from "../jobs";
import type { QuickReply } from "../schema";
import { stateOf, type TaskState } from "../tasks";
import { useJobStatus } from "../useAppData";
import { formatWhen } from "../scheduler";
import { ExternalLink } from "./common";

const SOURCE_LABEL = { slack: "Slack", email: "Email" } as const;

function Draft({ reply, text, onRegenerate }: { reply: QuickReply; text: string; onRegenerate: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="reply-draft">
      <p className="small">{text}</p>
      <div className="reply-draft-actions">
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
    </div>
  );
}

function DraftingStatus({ id }: { id: string }) {
  const status = useJobStatus(`draft:${id}`);
  return (
    <span className="muted small inbox-drafting" title={status}>
      <span className="spin">✦</span> {status ?? "Drafting"}…
    </span>
  );
}

/** Slack messages and emails waiting on the user, with Claude-drafted responses to copy. */
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
            {draft && !drafting && <Draft reply={r} text={draft.text} onRegenerate={draftIt} />}
          </div>
        );
      })}
      </div>
    </section>
  );
}
