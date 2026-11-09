import { useEffect, useMemo, useRef, useState } from "react";
import * as db from "../db";
import { applyDiscussedActions, assessPendingTasks, checkWatchedTopic, checkWatchedTopics, watchFromText } from "../jobs";
import { stateOf, type TaskState } from "../tasks";
import { actionLine, orderTopics, OUTCOME_STEP, outcomeState, outcomeTaskDescription, shortDate, type WatchedOutcome, type WatchedTopic } from "../watched";
import { BadgeSelect, ExternalLink, RefreshButton, useAutoGrow } from "./common";
import { formatWhen } from "../scheduler";
import { TaskChatDockProvider, type TaskChatDock } from "./chatDock";
import { WatchChat } from "./ExplainChat";
import { LinkChips } from "./LinkChips";
import { linkKind } from "../links";
import { CardBox, TaskCard, type CardExtension, type CardTask, type OutlineStep } from "./TaskCard";

/** A project a topic can belong to: its id and the name it's shown by. */
export type TopicProject = { id: string; name: string };

/** What a settled conditional action says at the end of its line; one still waiting says nothing (its circle shows it). */
const STATE_LABEL: Record<"not_needed" | "acted", string> = { not_needed: "Not needed", acted: "Task created" };

/**
 * Topics the user asked Demian to keep an eye on, in their own area, laid out like Tasks: the add
 * box and the topics on the left, a topic's chat on the right while one is open (Discuss). Each
 * topic is a task card (TaskCard with a CardExtension): its status (Watching, Human or Done),
 * description and step box work as a task's do, with its conditional actions as the steps; it has
 * no priority. A ready action ("if X hasn't
 * happened by Friday, chase Y", and Friday has passed) offers Create and open task, and the status
 * shows Human; once every action is handled, the topic is Done.
 */
export function WatchedTopics({
  topics,
  projects,
  states,
  running,
  unread,
  onSeen,
  onViewTask,
  onChange,
}: {
  topics: WatchedTopic[];
  /** Topics with updates you haven't opened, and how opening one marks it seen (see unread.ts). */
  unread?: Set<string>;
  onSeen?: (id: string) => void;
  projects: TopicProject[];
  /** Status, done and dismissed (Unwatch) for each topic, kept as a task's are. */
  states: Map<string, TaskState>;
  running: string[];
  onViewTask: (taskId: string) => void;
  onChange: () => void;
}) {
  const shown = orderTopics(topics, (id) => stateOf(states, id));
  // The chat dock beside the list, as in Tasks (but a topic's chat never moves it anywhere).
  const [owner, setOwner] = useState<TaskChatDock["owner"]>(null);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const dock = useMemo<TaskChatDock>(
    () => ({ owner, target, open: (id, kind) => setOwner({ id, kind }), close: (id) => setOwner((cur) => (cur?.id === id ? null : cur)) }),
    [owner, target],
  );
  // A topic that's unwatched (or gone) gives the dock back.
  useEffect(() => {
    if (owner && !shown.some((t) => t.id === owner.id)) setOwner(null);
  }, [owner, shown.map((t) => t.id).join("|")]);
  return (
    <TaskChatDockProvider value={dock}>
      <div className="detail-split">
        <section className="column detail-pane">
          <header className="column-header">
            <div className="title-line">
              <h2>Watched topics</h2>
            </div>
            {shown.length > 0 && (
              // Never spins: what's being checked shows in the status line at the bottom of the window.
              <RefreshButton busy={false} title="Check all watched topics" onClick={() => checkWatchedTopics().catch(() => {})} />
            )}
          </header>
          <AddTopic onAdded={onChange} />
          <div className="task-list">
            <h4 className="section-title watched-group-title">
              Topics {shown.length > 0 && <span className="muted">{shown.length}</span>}
            </h4>
            {shown.length === 0 ? (
              <p className="muted small">Nothing watched yet.</p>
            ) : (
              shown.map((t) => (
                <TopicCard
                  key={t.id}
                  topic={t}
                  state={stateOf(states, t.id)}
                  projects={projects}
                  checking={running.includes(`watch:${t.id}`)}
                  filling={running.includes(`watchfill:${t.id}`)}
                  unread={unread?.has(t.id)}
                  onSeen={onSeen && (() => onSeen(t.id))}
                  onViewTask={onViewTask}
                  onChange={onChange}
                />
              ))
            )}
          </div>
        </section>
        <section className="detail-pane chat-dock" ref={setTarget}>
          {!owner && <p className="muted small chat-dock-empty">Click Discuss on a topic to open a chat here</p>}
        </section>
      </div>
    </TaskChatDockProvider>
  );
}

/** One topic, as a task card. */
function TopicCard({
  topic: t,
  state,
  projects,
  checking,
  filling,
  unread,
  onSeen,
  onViewTask,
  onChange,
}: {
  unread?: boolean;
  onSeen?: () => void;
  topic: WatchedTopic;
  state: TaskState;
  projects: TopicProject[];
  /** Demian is checking where it stands. */
  checking: boolean;
  /** Demian is still filling it in from what the user wrote. */
  filling: boolean;
  onViewTask: (id: string) => void;
  onChange: () => void;
}) {
  const project = projects.find((p) => p.id === t.projectId) ?? null;
  const task: CardTask = {
    id: t.id,
    title: t.topic,
    description: t.details,
    source: "watched",
    status: state.status,
    done: state.done,
    todayOn: null,
    project: project ? { id: project.id, name: project.name } : undefined,
  };
  const steps: OutlineStep[] = t.outcomes.map((o) => {
    const state = outcomeState(o);
    const step = OUTCOME_STEP[state];
    return {
      title: actionLine(o),
      by: null,
      progress: step ? { state: step } : undefined,
      line: <ActionLine outcome={o} />,
      // One still waiting has nothing at the end: its circle says so.
      trailing: state === "waiting" ? undefined : <ActionEnd topic={t} outcome={o} onViewTask={onViewTask} onChange={onChange} />,
    };
  });
  const busy = filling ? "Filling it in…" : checking ? "Checking…" : null;
  const latest = t.history[t.history.length - 1];
  const watch: CardExtension = {
    steps,
    heading: "Conditional actions",
    role: busy ?? (steps.length ? `${steps.length} ${steps.length === 1 ? "action" : "actions"}` : "None"),
    empty: <p className="muted small watched-none">None: Demian just keeps track of where it stands. Discuss it to add one.</p>,
    // Checks run on their own (every refresh, and after a change); the ↻ at the top checks them all now, a card's own ↻ just that one.
    actions: ({ discuss, chatOpen }) => (
      <button className="cta-ghost" disabled={chatOpen} onClick={discuss}>
        Discuss
      </button>
    ),
    // Its project, under the title (project names can be long for the title row).
    meta: projects.length ? (
      <BadgeSelect
        label="Project"
        value={t.projectId ?? ""}
        empty={!t.projectId}
        arrow={false}
        options={[{ value: "", label: "No project" }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
        onChange={(v) => db.updateWatchedTopic(t.id, { projectId: v || null }).then(onChange)}
      />
    ) : undefined,
    links: t.status?.links.map((l) => ({ url: l.link, title: l.title })),
    chat: (close) => (
      <WatchChat
        topic={t}
        projectName={project?.name ?? null}
        onActions={(lines) => applyDiscussedActions(t.id, lines).then((changed) => changed && onChange(), () => {})}
        onClose={close}
      />
    ),
    titlePending: filling ? "Generating title…" : null,
    // When its latest update was collected, beside the title on hover.
    // "Updated 10:17 AM" today, "Updated yesterday", "Updated Nov 2".
    stamp: latest ? `Updated ${formatWhen(latest.at).replace(/^Yesterday$/, "yesterday")}` : null,
    after: t.history.length ? <UpdatesBox updates={t.history} /> : null,
    // Checks just this topic now (filling it in already ends with a check).
    refresh: { busy: checking || filling, onClick: () => checkWatchedTopic(t.id).catch(() => {}) },
  };
  return (
    <TaskCard
      task={task}
      plan={undefined}
      planning={false}
      assessing={false}
      compact={state.done}
      watch={watch}
      unread={unread}
      onSeen={onSeen}
      onChange={onChange}
    />
  );
}

/** Every update a topic's checks found, newest first, each with when it was collected and its sources. */
function UpdatesBox({ updates }: { updates: WatchedTopic["history"] }) {
  return (
    <CardBox heading="Updates" note={<span className="automation-role timestamp">{updates.length}</span>}>
      <ol className="watched-updates">
        {[...updates].reverse().map((u) => (
          // When it was collected, then what it said under it, then its sources as link chips.
          <li key={u.at}>
            <span className="timestamp watched-update-at">{formatWhen(u.at)}</span>
            <span className="small watched-update-text">{u.summary}</span>
            <LinkChips links={u.links.map((l) => ({ url: l.link, title: l.title, kind: linkKind(l.link) }))} />
          </li>
        ))}
      </ol>
    </CardBox>
  );
}

/** A conditional action's line: the condition and its date set off as badges, since they decide when Demian acts. */
function ActionLine({ outcome: o }: { outcome: WatchedOutcome }) {
  return (
    <>
      If {o.event} <span className="badge step-badge">{o.when === "happens" ? "has happened" : "hasn't happened by"}</span>
      {o.when === "not_by" && o.by && (
        <>
          {" "}
          <span className="badge step-badge">{shortDate(o.by)}</span>
        </>
      )}
      , then {o.then}
    </>
  );
}

/** The end of a conditional action's line: Create and open task when it's ready, else where it stands (nothing while it waits). */
function ActionEnd({ topic, outcome: o, onViewTask, onChange }: { topic: WatchedTopic; outcome: WatchedOutcome; onViewTask: (id: string) => void; onChange: () => void }) {
  const state = outcomeState(o);
  const [creating, setCreating] = useState(false);
  const [failed, setFailed] = useState(false);
  // Set once the task exists, so a retry after a failed save doesn't add it twice.
  const created = useRef<string | null>(null);
  const create = async () => {
    setCreating(true);
    setFailed(false);
    try {
      if (!created.current) {
        created.current = await db.addManualTask(o.then, topic.projectId, outcomeTaskDescription(topic, o));
        assessPendingTasks().catch(() => {});
      }
      await db.setOutcomeTask(topic.id, o.id, created.current);
      onChange();
      onViewTask(created.current);
    } catch {
      setFailed(true);
    } finally {
      setCreating(false);
    }
  };
  if (state === "ready")
    return (
      <button className={`cta-primary${failed ? " error" : ""}`} disabled={creating} onClick={create}>
        {failed ? "Couldn't create it. Try again" : "Create and open task"}
      </button>
    );
  if (state === "acted" && o.taskId)
    return (
      <button className="link-button small" onClick={() => onViewTask(o.taskId!)}>
        View task
      </button>
    );
  if (state === "waiting") return null;
  return (
    <ExternalLink href={o.link} className="muted small">
      {STATE_LABEL[state]}
    </ExternalLink>
  );
}

/** Examples the empty add box cycles through, to show the kinds of things it can watch. */
// Some with a follow-up, some only to keep an eye on: a topic doesn't need a conditional action.
const EXAMPLES = [
  "If Legal hasn't signed off on the vendor contract by Friday, chase them",
  "Keep an eye on the pricing discussion in #pricing",
  "Waiting on the Q1 budget numbers from finance. Once they're in, update the forecast sheet",
  "Watch how the search ranking experiment is doing",
  "Tell me when the design review feedback comes in, then triage it",
  "Keep track of the reorg rumors around the platform team",
  "If nobody has picked up the onboarding bug in Jira by Monday, raise it at standup",
  "Follow the vendor security review",
  "If the offsite venue isn't confirmed by the end of the month, book the backup",
];
const EXAMPLE_MS = 7000;

/** The example to show in the empty add box, changing every few seconds while it's empty. */
function useCyclingExample(active: boolean): string {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setI((n) => (n + 1) % EXAMPLES.length), EXAMPLE_MS);
    return () => clearInterval(id);
  }, [active]);
  return EXAMPLES[i];
}

/**
 * The add box, like Tasks' Add a task: write what to watch in your own words ("If Legal hasn't
 * signed off on the Acme contract by Friday, chase them") and press Return. It goes straight into
 * Topics and is watched from then on; Demian fills in its title, details, project and conditional
 * actions from what you wrote.
 */
function AddTopic({ onAdded }: { onAdded: (id: string) => void }) {
  const [entry, setEntry] = useState("");
  const [adding, setAdding] = useState(false);
  const example = useCyclingExample(entry === "");
  const box = useAutoGrow(entry, example);
  const add = async () => {
    const text = entry.trim();
    if (!text || adding) return;
    setAdding(true);
    try {
      const id = await watchFromText(text);
      setEntry("");
      onAdded(id);
    } finally {
      setAdding(false);
    }
  };
  return (
    <form
      className="add-task watched-add"
      onSubmit={(e) => {
        e.preventDefault();
        add();
      }}
    >
      <textarea
        className="watched-entry"
        ref={box}
        rows={4}
        value={entry}
        disabled={adding}
        onChange={(e) => setEntry(e.target.value)}
        onKeyDown={(e) => {
          // Return adds it; Shift-Return starts a new line.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            add();
          } else if (e.key === "Escape") setEntry("");
        }}
        placeholder={example}
        aria-label="Watch a topic"
      />
    </form>
  );
}
