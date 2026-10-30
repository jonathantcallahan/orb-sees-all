/**
 * Reviewing a Slack message before Orb posts it: the message drawn the way Slack will show it
 * (your name and avatar, mentions, links, formatting), with the text to edit under it.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import * as db from "../db";
import { CloseIcon, ExternalLink } from "./common";

const MOD = navigator.platform.includes("Mac") ? "⌘" : "Ctrl+";

/** Slack names Orb has seen in your projects, by user id, and which of them is you. */
interface People {
  names: Map<string, string>;
  me: string | null;
}

/** Walks a project's stored profile and snapshot for anyone with a Slack id and a name. */
function collectPeople(projects: db.Project[]): People {
  const names = new Map<string, string>();
  let me: string | null = null;
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach(visit);
    const o = value as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name : typeof o.person === "string" ? o.person : null;
    if (name && typeof o.slack_user_id === "string") {
      names.set(o.slack_user_id, name);
      if (o.is_me === true) me = name;
    }
    Object.values(o).forEach(visit);
  };
  projects.forEach((p) => {
    visit(p.profile);
    visit(p.snapshot);
  });
  return { names, me };
}

function usePeople(): People {
  const [people, setPeople] = useState<People>({ names: new Map(), me: null });
  useEffect(() => {
    db.listProjects().then((projects) => setPeople(collectPeople(projects)), () => {});
  }, []);
  return people;
}

/** One line of Slack mrkdwn: mentions, channel and web links, *bold*, _italic_, ~strike~ and `code`. */
function inline(text: string, names: Map<string, string>, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /<@([A-Z0-9]+)(?:\|([^>]+))?>|<#([A-Z0-9]+)(?:\|([^>]*))?>|<!(here|channel|everyone)>|<(https?:[^|>]+)(?:\|([^>]+))?>|`([^`]+)`|\*([^*\n]+)\*|_([^_\n]+)_|~([^~\n]+)~/g;
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<span key={k} className="slack-mention">@{m[2] ?? names.get(m[1]) ?? m[1]}</span>);
    else if (m[3]) out.push(<span key={k} className="slack-mention">#{m[4] || m[3]}</span>);
    else if (m[5]) out.push(<span key={k} className="slack-mention broadcast">@{m[5]}</span>);
    else if (m[6]) out.push(<span key={k} className="slack-link">{m[7] ?? m[6]}</span>);
    else if (m[8]) out.push(<code key={k} className="slack-code">{m[8]}</code>);
    else if (m[9]) out.push(<b key={k}>{inline(m[9], names, k)}</b>);
    else if (m[10]) out.push(<i key={k}>{inline(m[10], names, k)}</i>);
    else if (m[11]) out.push(<s key={k}>{inline(m[11], names, k)}</s>);
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A message's text as Slack lays it out: code blocks, quotes, bullets and plain lines. */
function SlackText({ text, names }: { text: string; names: Map<string, string> }) {
  const parts = text.split(/```/);
  return (
    <div className="slack-text">
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <pre key={i} className="slack-pre">
            {part.replace(/^\n|\n$/g, "")}
          </pre>
        ) : (
          part.split("\n").map((line, j) => {
            const k = `${i}-${j}`;
            if (/^&gt;|^>/.test(line)) return <div key={k} className="slack-quote">{inline(line.replace(/^(&gt;|>)\s?/, ""), names, k)}</div>;
            const bullet = line.match(/^\s*[•\-*]\s+(.*)$/);
            if (bullet) return <div key={k} className="slack-bullet">{inline(bullet[1], names, k)}</div>;
            return <div key={k} className="slack-line">{line ? inline(line, names, k) : " "}</div>;
          })
        ),
      )}
    </div>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

/**
 * The review: a Slack-style preview of the message, the text to edit beneath it, and Send.
 * Esc or the backdrop cancels; ⌘↩ sends.
 */
export function SlackSendModal({
  to,
  text,
  status,
  failed,
  busy,
  onChange,
  onCancel,
  onSend,
}: {
  /** "#channel", a channel id, or a thread's permalink. */
  to: string;
  text: string;
  status: string | null;
  failed: boolean;
  busy: boolean;
  onChange: (text: string) => void;
  onCancel: () => void;
  onSend: () => void;
}) {
  const people = usePeople();
  const thread = to.startsWith("http");
  const where = thread ? "the thread" : to;
  const me = people.me ?? "You";
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, 280)}px`;
  }, [text]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  return createPortal(
    <div
      className="modal-backdrop plan-modal-backdrop"
      onClick={(e) => {
        e.stopPropagation();
        onCancel();
      }}
    >
      <div className="modal slack-modal" role="dialog" aria-label={`Send to ${where}`} onClick={(e) => e.stopPropagation()}>
        <header className="slack-modal-head">
          <h2>Send to {where}</h2>
          <button className="icon-button" onClick={onCancel} title="Close" aria-label="Close">
            <CloseIcon />
          </button>
        </header>

        <div className="slack-modal-body">
          <div className="slack-preview" aria-label="How it will look in Slack">
            {thread && <div className="slack-thread-note">Reply in thread</div>}
            <div className="slack-message">
              <div className="slack-avatar" aria-hidden>
                {initials(me)}
              </div>
              <div className="slack-content">
                <div className="slack-meta">
                  <span className="slack-name">{me}</span>
                  <span className="slack-time">{time}</span>
                </div>
                {text.trim() ? <SlackText text={text} names={people.names} /> : <div className="slack-empty">Nothing to send yet.</div>}
              </div>
            </div>
          </div>

          <label className="field">
            <span className="field-label">Message</span>
            <textarea
              ref={ref}
              autoFocus
              className="slack-editor"
              value={text}
              disabled={busy}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSend();
              }}
            />
          </label>
        </div>

        <footer className="slack-modal-foot">
          <span className={`small ${failed ? "error" : "muted"} remind-status`}>{status ?? `Posts in ${where} as you.`}</span>
          {thread && (
            <ExternalLink href={to} className="link-button small more-link">
              Open thread
            </ExternalLink>
          )}
          <button className="cta-ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button className="cta-primary" disabled={busy || !text.trim()} onClick={onSend} title={`Send (${MOD}↩)`}>
            Send
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
