import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import * as db from "../db";
import { isReady, runSetupChecks, type ConnectorCheck, type SetupReport } from "../setup";
import { CloseIcon, ExternalLink, Spinner } from "./common";
import { INSTALL_CLAUDE, isWindows, TERMINAL, useLoginCommand } from "../platform";

/** claude.ai's own list of your connectors, under Customize. */
export const CONNECTORS_URL = "https://claude.ai/new#customize/connectors/yours";

type Mark = "ok" | "bad" | "warn" | "wait" | "todo";

function StatusMark({ mark }: { mark: Mark }) {
  if (mark === "wait") return <Spinner />;
  return <span className={`setup-mark ${mark}`}>{{ ok: "✓", bad: "×", warn: "!", todo: "○" }[mark]}</span>;
}

/**
 * A shell command to run in Terminal (PowerShell on Windows), on one line, with a copy icon inside
 * the block. A long command scrolls sideways rather than wrapping.
 */
export function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="setup-command">
      <code>{text}</code>
      <button
        className="setup-command-copy"
        title={copied ? "Copied" : "Copy"}
        aria-label={copied ? "Copied" : "Copy command"}
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? (
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path d="M2.5 6.2 5 8.5l4.5-5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <rect x="3.75" y="3.75" width="6.5" height="6.5" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <path d="M8.25 2.4V2.2A1.2 1.2 0 0 0 7.05 1H2.2A1.2 1.2 0 0 0 1 2.2v4.85a1.2 1.2 0 0 0 1.2 1.2h.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        )}
      </button>
    </div>
  );
}

function Step({ mark, title, children }: { mark: Mark; title: ReactNode; children?: ReactNode }) {
  return (
    <li className="setup-step">
      <StatusMark mark={mark} />
      <div>
        <div className="setup-step-title">{title}</div>
        {children && <div className="small setup-step-body">{children}</div>}
      </div>
    </li>
  );
}

const CONNECTOR_NOTE: Record<ConnectorCheck["state"], string> = {
  connected: "Connected",
  needs_auth: "Needs you to sign in",
  pending: "Still connecting, check again",
  failed: "Couldn't connect",
  missing: "Not added",
};

function ConnectorRow({ c }: { c: ConnectorCheck }) {
  const mark: Mark = c.state === "connected" ? "ok" : c.state === "pending" ? "warn" : c.required ? "bad" : "todo";
  return (
    <li className="setup-connector">
      <StatusMark mark={mark} />
      <span>
        <strong>{c.label}</strong>
        {!c.required && <span className="muted"> · optional</span>}
        <span className="muted"> · {c.purpose}</span>
      </span>
      <span className={`small ${c.state === "connected" || c.state === "pending" || !c.required ? "muted" : "error"}`}>
        {CONNECTOR_NOTE[c.state]}
        {c.rawStatus && ` (${c.rawStatus})`}
      </span>
    </li>
  );
}

/**
 * The first-run walkthrough: checks Claude Code, the claude.ai login and each connector, shows how
 * to fix whatever's missing; then the first refresh finds their projects. (Orb learns the user's role in
 * the background, so it doesn't ask.) Opens by
 * itself until setup is done; Settings can open it again any time.
 */
export function SetupScreen({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [report, setReport] = useState<SetupReport | null>(null);
  const [checking, setChecking] = useState(false);
  const loginCommand = useLoginCommand();

  const check = useCallback(async () => {
    setChecking(true);
    setReport(null);
    try {
      setReport(await runSetupChecks(setReport));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const r = report;
  const ready = !!r && isReady(r);
  // A check that hasn't run yet: running while checks are underway, else waiting on an earlier step.
  const mark = (result: { ok: boolean } | null | undefined): Mark => (result ? (result.ok ? "ok" : "bad") : checking ? "wait" : "todo");
  const connectorsMark: Mark = r?.probeError ? "bad" : r?.connectors ? (ready ? "ok" : "bad") : checking ? "wait" : "todo";

  // Refresh all finds the projects first, then reads them; the header shows its progress.
  const finish = async () => {
    await db.setSetting("setup_done", "1");
    onDone();
  };

  return createPortal(
    <div className="modal-backdrop plan-modal-backdrop" onClick={onClose}>
      <div className="modal plan-modal setup-modal" role="dialog" aria-label="Set up Demian" onClick={(e) => e.stopPropagation()}>
        <header className="column-header">
          <h2>Set up Demian</h2>
          <button className="icon-button" onClick={onClose} title="Close" aria-label="Close">
            <CloseIcon />
          </button>
        </header>
        <p className="muted small setup-intro">
          Orb reads your Slack, email and calendar through Claude Code and your claude.ai connectors. It has no logins of its own, so this checks that
          those are in place.
        </p>

        <ol className="setup-steps">
          <Step mark={mark(r?.claude)} title={r?.claude?.ok ? `Claude Code ${r.claude.version ?? ""} is installed` : "Install Claude Code"}>
            {r?.claude && !r.claude.ok && (
              <>
                Open {TERMINAL}, run this, then check again:
                <Command text={INSTALL_CLAUDE} />
                {isWindows && (
                  <span>
                    Claude Code on Windows also needs <ExternalLink href="https://git-scm.com/downloads/win">Git for Windows</ExternalLink>.
                  </span>
                )}
                <ExternalLink href="https://docs.claude.com/en/docs/claude-code/setup">Install guide</ExternalLink>
              </>
            )}
          </Step>

          <Step mark={mark(r?.login)} title={r?.login?.ok ? `Claude Code is signed in${r.login.email ? ` as ${r.login.email}` : ""}` : "Sign in to Claude Code"}>
            {r?.login && !r.login.ok && (
              <>
                Being signed in at claude.ai in your browser isn't enough; Claude Code signs in on its own. In {TERMINAL}, run this and approve it in your
                browser with your Claude account (Pro, Max, Team or Enterprise), then check again:
                <Command text={loginCommand} />
              </>
            )}
          </Step>

          <Step mark={connectorsMark} title="Connect your accounts">
            {r?.probeError && <span className="error">Claude Code didn't start: {r.probeError}</span>}
            {r?.noClaudeAi && (
              <span className="error">
                Claude Code is signed in with an API key or a company token, so it can't reach the claude.ai connectors. Sign it in with your Claude
                account in {TERMINAL}, then check again:
                <Command text={loginCommand} />
              </span>
            )}
            {r?.connectors && (
              <>
                <ul className="setup-connectors">
                  {r.connectors.map((c) => (
                    <ConnectorRow key={c.id} c={c} />
                  ))}
                </ul>
                {!ready && !r.noClaudeAi && (
                  <p>
                    Add or sign in to the ones marked × at <ExternalLink href={CONNECTORS_URL}>claude.ai → Customize → Connectors</ExternalLink>, then check
                    again.{" "}
                    {r.connectors.some((c) => c.id === "jira" && c.state !== "connected") && (
                      <>
                        Jira isn't a claude.ai connector: it's an MCP server named <code>mcp-jira</code> your team sets up in Claude Code, and it may
                        need your company's VPN.
                      </>
                    )}
                  </p>
                )}
              </>
            )}
          </Step>

          <Step mark={r?.gh ? (r.gh.ok ? "ok" : "todo") : checking ? "wait" : "todo"} title={r?.gh?.ok ? "GitHub CLI is signed in" : "GitHub CLI (optional)"}>
            {r?.gh && !r.gh.ok && (
              <>
                For branch and PR status on project cards, install the <ExternalLink href="https://cli.github.com">GitHub CLI</ExternalLink> and run{" "}
                <code>gh auth login</code>. Skip it if you don't need that.
              </>
            )}
          </Step>

        </ol>

        <footer className="plan-modal-actions">
          <span className="small muted setup-status">
            {checking ? "Checking…" : ready ? "Everything's in place. The first refresh takes a few minutes." : ""}
          </span>
          <button className="cta-ghost" disabled={checking} onClick={check}>
            Check again
          </button>
          <button className="primary" disabled={!ready} onClick={finish}>
            Find my projects
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
