import { useState } from "react";
import { setTaskState } from "../db";
import type { QuickReply } from "../schema";
import { stateOf, type TaskState } from "../tasks";
import { formatWhen } from "../scheduler";
import { CloseIcon, ExternalLink } from "./common";
import { ReplyChat } from "./ExplainChat";

const SOURCE_LABEL = { slack: "Slack", email: "Email" } as const;

/** Slack messages and emails waiting on the user; Draft response opens a chat with Claude to write the reply. */
export function Inbox({ replies, states, onChange }: { replies: QuickReply[]; states: Map<string, TaskState>; onChange: () => void }) {
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
        <InboxItem key={r.id} reply={r} onChange={onChange} />
      ))}
      </div>
    </section>
  );
}

/** One inbox row. Draft response opens the reply chat (which picks up where it left off if reopened). */
function InboxItem({ reply: r, onChange }: { reply: QuickReply; onChange: () => void }) {
  const [chatting, setChatting] = useState(false);
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
        <button className="link-button small inbox-action" onClick={() => setChatting(true)}>
          Draft response
        </button>
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
      {chatting && <ReplyChat reply={r} onClose={() => setChatting(false)} onSent={onChange} />}
    </div>
  );
}
