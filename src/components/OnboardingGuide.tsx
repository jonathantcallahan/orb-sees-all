import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { INSTALL_CLAUDE, TERMINAL } from "../platform";
import type { ConnectorCheck } from "../setup";
import { Command, CONNECTORS_URL } from "./SetupScreen";

/** Which fix the guide walks through. */
export type GuideKind = "install" | "login" | "connectors";

/** Opens a terminal running one of setup's fixed steps (see open_setup_terminal in lib.rs). */
const openSetupTerminal = (step: "install" | "login") => invoke("open_setup_terminal", { step });

const STEPS: { kind: GuideKind; label: string }[] = [
  { kind: "install", label: "Claude Code" },
  { kind: "login", label: "Signed in" },
  { kind: "connectors", label: "Connectors" },
];

/** Where setup stands, from what the checks found: done up to the step that needs you. */
function Progress({ at }: { at: GuideKind }) {
  const reached = STEPS.findIndex((s) => s.kind === at);
  return (
    <div className="onboarding-progress" aria-label="Setup progress">
      {STEPS.map((s, i) => (
        <span key={s.kind} className={i < reached ? "done" : i === reached ? "current" : undefined}>
          {i < reached ? "✓" : "○"} {s.label}
        </span>
      ))}
    </div>
  );
}

/**
 * The walk-through under onboarding's line when a step needs the person: what to do, in order, with
 * a button that does the fiddly part (opens Terminal running Claude's installer or its sign-in, or
 * opens claude.ai's Connectors page). Install and sign-in are noticed on their own, so there's
 * nothing to click afterwards; connectors need Check again.
 */
export function OnboardingGuide({
  kind,
  connectors,
  apiKey,
  onCheck,
}: {
  kind: GuideKind;
  connectors?: ConnectorCheck[] | null;
  /** Signed in with an API key rather than a Claude account, so the connectors aren't there. */
  apiKey?: boolean;
  onCheck: () => void;
}) {
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = (step: "install" | "login") => {
    setError(null);
    openSetupTerminal(step).then(
      () => setOpened(true),
      (e) => setError(String(e)),
    );
  };

  if (kind === "install")
    return (
      <div className="onboarding-guide">
        <Progress at={kind} />
        <ol>
          <li>Demian works through Claude Code, Claude's app for your computer. Install it with one click:</li>
        </ol>
        <div className="onboarding-guide-actions">
          <button className="cta-primary" onClick={() => open("install")}>
            Install Claude Code
          </button>
        </div>
        <ol start={2}>
          <li>{TERMINAL} opens and runs Claude's installer. Leave it until it says it's done; it takes about a minute.</li>
          <li>Come back here. Demian notices it's installed and carries on.</li>
        </ol>
        {(opened || error) && (
          <div className="onboarding-guide-fallback">
            {error && <p>{TERMINAL} didn't open. </p>}
            <p>To run it yourself, open {TERMINAL}, paste this and press Return:</p>
            <Command text={INSTALL_CLAUDE} />
          </div>
        )}
      </div>
    );

  if (kind === "login")
    return (
      <div className="onboarding-guide">
        <Progress at={kind} />
        <ol>
          <li>
            {apiKey
              ? "Claude Code is signed in with an API key, which can't reach your Slack, email or calendar. Sign in with your Claude account instead:"
              : "Sign in to Claude Code with your Claude account:"}
          </li>
        </ol>
        <div className="onboarding-guide-actions">
          <button className="cta-primary" onClick={() => open("login")}>
            Sign in
          </button>
        </div>
        <ol start={2}>
          <li>Your browser opens. Approve it with the Claude account you use at claude.ai (Pro, Max, Team or Enterprise).</li>
          <li>When {TERMINAL} says you're signed in, come back here. Demian carries on by itself.</li>
        </ol>
        {(opened || error) && (
          <div className="onboarding-guide-fallback">
            {error && <p>{TERMINAL} didn't open. </p>}
            <p>
              Or in {TERMINAL}: type <code>claude</code>, press Return, then type <code>/login</code> and choose your Claude account, not an API key.
            </p>
          </div>
        )}
      </div>
    );

  const needed = (connectors ?? []).filter((c) => c.required);
  const optional = (connectors ?? []).filter((c) => !c.required);
  return (
    <div className="onboarding-guide">
      <Progress at={kind} />
      <ol>
        <li>Demian reads your work through the connectors on your Claude account. Open Connectors in Claude:</li>
      </ol>
      <div className="onboarding-guide-actions">
        <button className="cta-primary" onClick={() => openUrl(CONNECTORS_URL)}>
          Open Connectors
        </button>
      </div>
      <ol start={2}>
        <li>Connect each one still marked ○, signing in with your work account:</li>
      </ol>
      <ul className="onboarding-connectors">
        {needed.map((c) => (
          <li key={c.id} className={c.state === "connected" ? "done" : undefined}>
            <span className="onboarding-connector-mark">{c.state === "connected" ? "✓" : "○"}</span>
            {c.label}
            <span className="onboarding-connector-purpose">{c.purpose}</span>
          </li>
        ))}
        {optional
          .filter((c) => c.state !== "connected")
          .map((c) => (
            <li key={c.id} className="optional">
              <span className="onboarding-connector-mark">·</span>
              {c.label}
              <span className="onboarding-connector-purpose">optional · {c.purpose}</span>
            </li>
          ))}
      </ul>
      <ol start={3}>
        <li>Come back and check again. If Slack asks for an admin's approval, that has to come through first.</li>
      </ol>
      <div className="onboarding-guide-actions">
        <button className="cta-ghost" onClick={onCheck}>
          Check again
        </button>
      </div>
    </div>
  );
}
