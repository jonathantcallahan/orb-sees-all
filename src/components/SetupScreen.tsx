import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import * as db from "../db";
import { setUserProfile } from "../prompts";
import { isReady, runSetupChecks, type ConnectorCheck, type SetupReport } from "../setup";
import { CloseIcon, ExternalLink, Spinner } from "./common";
import { INSTALL_CLAUDE, isWindows, TERMINAL } from "../platform";

const CONNECTORS_URL = "https://claude.ai/settings/connectors";

type Mark = "ok" | "bad" | "warn" | "wait" | "todo";

function StatusMark({ mark }: { mark: Mark }) {
  if (mark === "wait") return <Spinner />;
  return <span className={`setup-mark ${mark}`}>{{ ok: "✓", bad: "×", warn: "!", todo: "○" }[mark]}</span>;
}

/** A shell command with a Copy button, for steps the user runs in Terminal (PowerShell on Windows). */
function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="setup-command">
      <code>{text}</code>
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
 * to fix whatever's missing and takes a line about the user; then the first refresh finds their projects. Opens by
 * itself until setup is done; Settings can open it again any time.
 */
export function SetupScreen({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [report, setReport] = useState<SetupReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [about, setAbout] = useState("");

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
    db.getSetting("user_profile").then((t) => setAbout(t ?? ""), () => {});
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
    await db.setSetting("user_profile", about.trim());
    setUserProfile(about);
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
                In {TERMINAL}, run <code>claude</code>, type <code>/login</code> and choose your Claude account (a Pro, Max, Team or Enterprise subscription). Then
                check again.
              </>
            )}
          </Step>

          <Step mark={connectorsMark} title="Connect your accounts">
            {r?.probeError && <span className="error">Claude Code didn't start: {r.probeError}</span>}
            {r?.noClaudeAi && (
              <span className="error">
                Claude Code can't see any claude.ai connectors, so it isn't using a claude.ai account. In {TERMINAL}, run <code>claude</code>, type{" "}
                <code>/login</code> and choose your Claude account (not an API key), then check again.
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
                    Add or sign in to the ones marked × at <ExternalLink href={CONNECTORS_URL}>claude.ai → Settings → Connectors</ExternalLink>, then check
                    again.{" "}
                    {r.connectors.some((c) => c.id === "jira" && c.state !== "connected") &&
                      "Jira is a local MCP server named mcp-jira; set it up in Claude Code if you want it (see the README)."}
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

          <Step mark={about.trim() ? "ok" : "todo"} title="Tell Orb about you">
            <textarea
              className="setup-about"
              rows={2}
              value={about}
              placeholder="e.g. a product manager on the payments team"
              onChange={(e) => setAbout(e.target.value)}
            />
            <span className="muted">Claude uses this to judge what matters to you. You can change it in Settings.</span>
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
