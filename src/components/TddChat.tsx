import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { saveDocDraft, type Project } from "../db";
import * as db from "../db";
import { createProjectDoc, discardTddDraft, draftProjectTdd, readTddDraftFile, startTddChat, tddChatKey, tddDraftError } from "../jobs";
import { docName, pieceKeys } from "../markdown";
import { projectName } from "../projects";
import { unsentMessages, useSessionProgress, type SessionLink } from "../sessions";
import { useJobStatus, useRunningJobs } from "../useAppData";
import { ExternalLink, Spinner, updatedText } from "./common";
import { Markdown } from "./Markdown";
import { SessionChat } from "./TaskCard";

/** Who holds the Projects area's details column while a project's TDD chat is open in it. */
export const tddChatOwner = (projectId: string) => `tdd:${projectId}`;

/** The project whose TDD chat holds the column, or null. */
export const tddChatProject = (owner: string | null) => (owner?.startsWith("tdd:") ? owner.slice(4) : null);

/** What to ask the TDD chat, cycling in the empty reply box. */
const EXAMPLES = [
  "Check the dependencies against the epic's tickets",
  "Turn the open questions into a table with an owner each",
  "Add what we decided in the last sync with the team",
  "Shorten the background to one paragraph",
];

/**
 * A TDD draft as a chat, in place of the project's details: the draft on top, and under it a
 * conversation with Demian, which changes the draft as you ask (its edits show as they land, and
 * what the last one changed is marked). You can edit it by hand too, then create it in Google Drive
 * or throw it away. While Demian drafts it, the column says how that's going.
 */
export function TddChat({ project, onClose, onChange }: { project: Project; onClose: () => void; onChange: () => void }) {
  const id = project.channel_id;
  const key = tddChatKey(id);
  const draft = project.doc_draft ?? null;
  const running = useRunningJobs();
  const drafting = running.includes(`tdd:${id}`);
  const draftingStatus = useJobStatus(`tdd:${id}`);
  const creating = running.includes(`tdd-create:${id}`);
  const creatingStatus = useJobStatus(`tdd-create:${id}`);
  const draftError = useJobStatus(tddDraftError(id));

  const [link, setLink] = useState<SessionLink | undefined>();
  const reload = useCallback(() => {
    db.getSessionLinks().then((links) => setLink(links[key]), () => {});
  }, [key]);
  useEffect(reload, [key, draft?.at]);
  const progress = useSessionProgress(key, link, reload);
  const working = useJobStatus(`session:${key}`);
  const busy = !!working || (!!link && !link.sessionId);

  // The draft as Demian is changing it, read from its file while a turn runs.
  const [live, setLive] = useState<string | null>(null);
  useEffect(() => {
    if (!busy) {
      setLive(null);
      return;
    }
    let stop = false;
    const read = () =>
      readTddDraftFile(id).then(
        (text) => !stop && text && setLive(text),
        () => {},
      );
    read();
    const t = window.setInterval(read, 1200);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [busy, id]);

  // The draft as it was when the last turn began: what that turn changed is marked against it.
  const [base, setBase] = useState<Set<string> | null>(null);
  const markdown = live ?? draft?.markdown ?? "";
  useEffect(() => {
    if (busy && draft) setBase(pieceKeys(draft.markdown));
  }, [busy]);

  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  // The doc is named in Drive by its own top heading, so changing that renames it.
  const name = draft ? (docName(draft.markdown) ?? draft.title) : "";

  // A change Demian just made: scrolled into view, unless you're reading somewhere else.
  const body = useRef<HTMLDivElement>(null);
  const changedCount = useMemo(() => (base ? [...pieceKeys(markdown)].filter((k) => !base.has(k)).length : 0), [base, markdown]);
  useLayoutEffect(() => {
    if (!changedCount) return;
    body.current?.querySelector(".md-changed")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [changedCount]);

  const doneEditing = async () => {
    if (draft && editing !== null && editing !== draft.markdown) {
      await saveDocDraft(id, { ...draft, markdown: editing, updated: new Date().toISOString() });
      setBase(null);
      onChange();
    }
    setEditing(null);
  };
  const create = () => {
    if (!draft) return;
    setError(null);
    createProjectDoc(id, name, draft.markdown).then(
      () => {
        onChange();
        onClose();
      },
      (e: Error) => setError(`Couldn't create it: ${e.message}`),
    );
  };
  const discard = async () => {
    await discardTddDraft(id);
    onChange();
    onClose();
  };
  const redraft = () => {
    setError(null);
    draftProjectTdd(id).then(onChange, onChange);
  };

  const locked = busy || creating || drafting;
  const doc = (
    <div className="tdd-doc">
      {draft ? (
        <>
          <div className="tdd-doc-body" ref={body}>
            {editing !== null ? (
              <textarea className="tdd-text" value={editing} aria-label="The draft, in Markdown" autoFocus onChange={(e) => setEditing(e.target.value)} />
            ) : (
              <>
                <Markdown text={markdown} before={base} />
                {draft.sources.length > 0 && (
                  <details className="tdd-sources small">
                    <summary className="muted">What it drew on ({draft.sources.length})</summary>
                    <ul>
                      {draft.sources.map((s) => (
                        <li key={s.link}>
                          <ExternalLink href={s.link}>{s.title}</ExternalLink>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            )}
          </div>
          <div className="tdd-doc-foot">
            <span className="muted small tdd-doc-when" title={`Drafted ${updatedText(draft.at)}${draft.updated ? `, last changed ${updatedText(draft.updated)}` : ""}`}>
              {busy && live && live !== draft.markdown ? "Demian is changing it" : draft.updated ? `Changed ${updatedText(draft.updated)}` : `Drafted ${updatedText(draft.at)}`}
            </span>
            {discarding ? (
              <span className="tdd-confirm small">
                Throw the draft away?
                <button className="link-button small danger" onClick={discard}>
                  Discard
                </button>
                <button className="link-button small" onClick={() => setDiscarding(false)}>
                  Keep it
                </button>
              </span>
            ) : (
              <span className="tdd-doc-actions">
                {editing === null ? (
                  <button className="link-button small" onClick={() => setEditing(draft.markdown)} disabled={locked} title="Edit the Markdown by hand">
                    Edit
                  </button>
                ) : (
                  <button className="link-button small" onClick={doneEditing}>
                    Done
                  </button>
                )}
                <button className="link-button small" onClick={() => setDiscarding(true)} disabled={locked || editing !== null}>
                  Discard
                </button>
                <button className="cta-primary small" onClick={create} disabled={locked || editing !== null || !draft.markdown.trim()} title={`Creates "${name}" in your Google Drive`}>
                  {creating ? (
                    <>
                      <Spinner /> {creatingStatus && creatingStatus !== "Working" ? creatingStatus : "Creating the doc"}
                    </>
                  ) : (
                    "Create in Google Drive"
                  )}
                </button>
              </span>
            )}
          </div>
          {error && <p className="error small tdd-error">{error}</p>}
        </>
      ) : drafting ? (
        <p className="muted small tdd-drafting">
          <Spinner /> {draftingStatus && draftingStatus !== "Working" ? draftingStatus : "Drafting a TDD"}
          <span className="tdd-drafting-note">Demian reads the project's tickets, channels, docs and meetings, then writes the draft here. It takes a few minutes.</span>
        </p>
      ) : (
        <p className="muted small tdd-drafting">
          {draftError ? `Couldn't draft it: ${draftError}` : "There's no draft."}{" "}
          <button className="link-button small" onClick={redraft}>
            {draftError ? "Try again" : "Draft a TDD"}
          </button>
        </p>
      )}
    </div>
  );

  return (
    <SessionChat
      taskId={key}
      title="TDD draft"
      subtitle={projectName(project)}
      className="tdd-chat"
      ask={null}
      plain
      top={doc}
      messages={progress?.messages ?? []}
      working={working ?? (link && !link.sessionId ? "Reading the draft" : undefined)}
      toSend={progress ? unsentMessages(progress.sends, link) : []}
      canReply={!!draft && !creating && editing === null}
      placeholder={link ? "Ask Demian to change the draft…" : EXAMPLES}
      empty={draft && <p className="muted small tdd-chat-empty">Ask Demian to change the draft: it checks facts against the project's tickets, channels, docs and meetings, and edits the doc above.</p>}
      onSend={link ? undefined : (message) => startTddChat(id, message, reload).then(reload, (e: Error) => setError(e.message))}
      onClose={onClose}
      onChange={() => {
        reload();
        onChange();
      }}
    />
  );
}
