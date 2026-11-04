import { useRef, useState } from "react";
import { addManualTask, setTaskState } from "../db";
import { assessPendingTasks } from "../jobs";
import type { QuickReply } from "../schema";
import { stateOf, type TaskState } from "../tasks";
import { formatWhen } from "../scheduler";
import { CloseIcon, ExternalLink, Spinner } from "./common";
import { ReplyChat } from "./ExplainChat";
import { DockedChat, useChatDock } from "./chatDock";

const SOURCE_LABEL = { slack: "Slack", email: "Email" } as const;

/**
 * Slack messages and emails waiting on a response from the user; Draft response opens a chat with
 * Claude to write the reply. Inbox items aren't tasks: one that turns out to need real work can be
 * made into a task (Create as task), which takes it out of the inbox. A message that's already on the
 * task list (`taskIds`) doesn't show here as well.
 */
export function Inbox({
  replies,
  states,
  taskIds,
  busy = false,
  onChange,
}: {
  replies: QuickReply[];
  states: Map<string, TaskState>;
  taskIds: Set<string>;
  /** The task refresh that fills it is running: a spinner by its title. */
  busy?: boolean;
  onChange: () => void;
}) {
  const open = replies.filter((r) => {
    const st = stateOf(states, r.id);
    return !st.done && !st.dismissed && !taskIds.has(r.id);
  });
  if (open.length === 0) return null;

  return (
    <section className="inbox">
      <h4 className="section-title">
        Inbox <span className="muted">{open.length}</span>
        {busy && (
          <span className="section-spinner" title="Looking for new messages…" aria-label="Looking for new messages">
            <Spinner />
          </span>
        )}
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
  // In the Detail view the chat opens in the dock beside the inbox, not as a window.
  const dock = useChatDock();
  const owner = `reply:${r.id}`;
  const [creating, setCreating] = useState(false);
  const [createFailed, setCreateFailed] = useState(false);
  // Set once the task exists, so a retry after a failed hand-off doesn't add it twice.
  const created = useRef(false);
  const createTask = async () => {
    setCreating(true);
    setCreateFailed(false);
    try {
      if (!created.current) {
        const where = r.where ? ` (${r.where})` : "";
        await addManualTask(`${r.from}: ${r.summary}`, null, `${r.from} asked${where}: ${r.summary}${r.link ? `\n${r.link}` : ""}`);
        created.current = true;
        assessPendingTasks().catch(() => {});
      }
      await setTaskState(r.id, { status: "done" });
      onChange();
    } catch {
      setCreateFailed(true);
    } finally {
      setCreating(false);
    }
  };
  const draft = () => (dock ? dock.open(owner) : setChatting(true));
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
        <button className="link-button small inbox-action" onClick={draft}>
          Draft response
        </button>
        <button
          className={`link-button small inbox-action${createFailed ? " error" : ""}`}
          title="Add this to your tasks and take it out of the inbox"
          disabled={creating}
          onClick={createTask}
        >
          {createFailed ? "Couldn't create it. Try again" : "Create as task"}
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
      {dock && (
        <DockedChat dock={dock} owner={owner}>
          <ReplyChat key={r.id} reply={r} onClose={() => dock.close(owner)} onSent={onChange} />
        </DockedChat>
      )}
    </div>
  );
}
