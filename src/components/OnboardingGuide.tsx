import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState, type CSSProperties, type ReactNode } from "react";
import { INSTALL_CLAUDE, isWindows, LOGIN_CLAUDE, TERMINAL } from "../platform";
import type { ConnectorCheck } from "../setup";
import { Command, CONNECTORS_URL } from "./SetupScreen";

/** Which fix the guide walks through. */
export type GuideKind = "install" | "login" | "connectors";

/** Opens a terminal running one of setup's fixed steps (see open_setup_terminal in lib.rs). */
const openSetupTerminal = (step: "install" | "login") => invoke("open_setup_terminal", { step });

/**
 * Setup's steps, in order. The first, letting Demian open (the xattr command on macOS, SmartScreen's
 * Run anyway on Windows), happens before the app can run at all, so it's always shown done: it
 * makes the whole path read as one sequence.
 */
const STEPS: { kind: GuideKind | "allow"; label: string }[] = [
  { kind: "allow", label: "Whitelist app" },
  { kind: "install", label: "Install Claude Code" },
  { kind: "login", label: "Sign in" },
  { kind: "connectors", label: "Connectors" },
];

/** The step wheel: each step sits this many degrees around the drum from the next. */
const WHEEL_STEP_DEG = 32;
/** The drum's radius, so neighbouring steps sit one line (18px) apart where they face you. */
const WHEEL_RADIUS = 9 / Math.tan(((WHEEL_STEP_DEG / 2) * Math.PI) / 180);

/**
 * Where setup stands, beside the title: the steps on a small drum, the current one facing you level
 * with the title and the others turning away above and below it. Moving on turns the drum. It holds
 * one line of the layout, so nothing around it moves.
 */
export function StepStack({ at }: { at: GuideKind }) {
  const reached = STEPS.findIndex((s) => s.kind === at);
  return (
    <span className="step-stack" aria-label="Setup progress">
      <span className="step-stack-window">
        <span className="step-stack-drum" style={{ "--wheel-radius": `${WHEEL_RADIUS}px` } as CSSProperties}>
          {STEPS.map((s, i) => {
            const d = i - reached;
            return (
              <span
                key={s.kind}
                className={`step-stack-item${i < reached ? " done" : i === reached ? " current" : ""}`}
                aria-current={i === reached ? "step" : undefined}
                style={{
                  transform: `rotateX(${-d * WHEEL_STEP_DEG}deg) translateZ(${WHEEL_RADIUS}px)`,
                  opacity: Math.max(0, 1 - Math.abs(d) * 0.45),
                  // A slight blur as a step turns away (a plain filter; WebKit misplaces backdrop blurs here).
                  filter: d ? `blur(${Math.min(Math.abs(d), 2) * 0.6}px)` : "none",
                }}
              >
                <span className="step-stack-mark">{i < reached ? "✓" : "○"}</span>
                {s.label}
              </span>
            );
          })}
        </span>
      </span>
    </span>
  );
}

function ConnectorItem({ c }: { c: ConnectorCheck }) {
  const done = c.state === "connected";
  return (
    <li className={done ? "done" : c.required ? undefined : "optional"}>
      <span className="onboarding-connector-mark">{done ? "✓" : "○"}</span>
      {c.label}
      {c.state === "needs_auth" && <span className="onboarding-connector-purpose">Added, needs you to sign in</span>}
    </li>
  );
}

/** A step you can do two ways, side by side: the button that does it, or the command to paste. */
function TwoWays({
  button,
  auto,
  command,
  manual,
  error,
  children,
}: {
  button: ReactNode;
  auto: string;
  command: string;
  manual: string;
  error: string | null;
  /** Anything more for the one-click side, under its button. */
  children?: ReactNode;
}) {
  return (
    <div className="onboarding-two-ways">
      <div>
        <div className="onboarding-way-label">
          One click <span className="onboarding-way-badge">Recommended</span>
        </div>
        <p>{error ? `${TERMINAL} didn't open. Use the command instead.` : auto}</p>
        {button}
        {children}
      </div>
      <div>
        <div className="onboarding-way-label">Manual</div>
        <p>{manual}</p>
        <Command text={command} />
      </div>
    </div>
  );
}

/**
 * The walk-through under onboarding's line when a step needs the person: what to do, in order, with
 * a button that does the fiddly part (opens Terminal running Claude's installer or its sign-in, or
 * opens claude.ai's Connectors page) or the command to paste. Install and sign-in are noticed on
 * their own; connectors take a slower check, so that step has Check again.
 */
export function OnboardingGuide({
  kind,
  connectors,
  apiKey,
  optionalOnly,
  onCheck,
  onContinue,
  simulate = false,
}: {
  kind: GuideKind;
  connectors?: ConnectorCheck[] | null;
  /** Signed in, but not with a Claude account (an API key or gateway token), so no connectors. */
  apiKey?: boolean;
  /** Everything needed is connected; this only shows what else can be added. */
  optionalOnly?: boolean;
  onCheck: () => void;
  /** Carry on without the optional connectors. */
  onContinue?: () => void;
  /** A simulation from Settings: Install and Sign in just move it on instead of running anything. */
  simulate?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const open = (step: "install" | "login") => {
    setError(null);
    if (simulate) return onCheck();
    openSetupTerminal(step).catch((e) => setError(String(e)));
  };
  const checkAgain = (
    <button className="cta-ghost" onClick={onCheck}>
      Check again
    </button>
  );

  if (kind === "install")
    return (
      <div className="onboarding-guide">
        <TwoWays
          button={
            <button className="cta-primary" onClick={() => open("install")}>
              Install Claude Code
            </button>
          }
          auto={`${TERMINAL} will open and run Claude's installer.`}
          command={INSTALL_CLAUDE}
          manual={`Open ${TERMINAL}, paste this and press Return`}
          error={error}
        >
          {isWindows && (
            <p className="onboarding-guide-note">
              Claude Code on Windows also needs Git for Windows. If the installer says it's missing,{" "}
              <a href="#" onClick={(e) => { e.preventDefault(); openUrl("https://git-scm.com/downloads/win"); }}>
                install Git
              </a>{" "}
              first.
            </p>
          )}
        </TwoWays>
      </div>
    );

  if (kind === "login")
    return (
      <div className="onboarding-guide">
        {apiKey && (
          <p className="onboarding-guide-note">
            Claude Code is signed in with an API key or a company token, which can't reach your Slack, email or calendar. Sign it in with your Claude
            account instead.
          </p>
        )}
        <TwoWays
          button={
            <button className="cta-primary" onClick={() => open("login")}>
              Sign in
            </button>
          }
          auto="Your browser will open. Approve it with the Claude account you use at claude.ai."
          command={LOGIN_CLAUDE}
          manual={`Open a new ${TERMINAL} window, paste this, press Return and approve it in your browser`}
          error={error}
        />
      </div>
    );

  const all = connectors ?? [];
  const needed = all.filter((c) => c.required);
  const optional = all.filter((c) => !c.required && (c.id !== "jira" || c.state === "connected"));
  const jira = all.find((c) => c.id === "jira");
  // The preview shows the connectors still to add, so it matches what they'll look for.
  const toAdd = [...needed, ...optional].filter((c) => c.state !== "connected");
  return (
    <div className="onboarding-guide onboarding-guide-wide">
      <div className="onboarding-two-ways onboarding-connectors-split">
        <div>
          <p>
            {optionalOnly
              ? "Slack, email and calendar are connected. Demian can use more, if you add them to your Claude account."
              : "Connect your tools on your Claude account, signing in with your work account, then check again."}
          </p>
          <div className="onboarding-guide-actions">
            <button className="cta-primary" onClick={() => openUrl(CONNECTORS_URL)}>
              Open Connectors
            </button>
            {checkAgain}
            {onContinue && (
              <button className="cta-ghost" onClick={onContinue}>
                Continue
              </button>
            )}
          </div>
          <ConnectorsPreview names={(toAdd.length ? toAdd : all).slice(0, 3).map((c) => c.label)} />
        </div>
        <div>
          {!optionalOnly && (
            <>
              <div className="onboarding-way-label">Required</div>
              <ul className="onboarding-connectors">
                {needed.map((c) => (
                  <ConnectorItem key={c.id} c={c} />
                ))}
              </ul>
            </>
          )}
          <div className="onboarding-way-label">Recommended</div>
          <ul className="onboarding-connectors">
            {optional.map((c) => (
              <ConnectorItem key={c.id} c={c} />
            ))}
          </ul>
          {jira && jira.state !== "connected" && (
            <span className="onboarding-tip" tabIndex={0}>
              What about Jira?
              <span className="onboarding-tip-bubble" role="tooltip">
                Jira isn't a claude.ai connector. It comes from an MCP server named <code>mcp-jira</code> that your team sets up in Claude Code. If
                you have it and it won't connect, you may need to be on your company's VPN.
              </span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A small drawing of claude.ai's Connectors settings, so people know what they're looking for when
 * the page opens: a row per connector with its Connect button, the cursor on the first. A sketch,
 * not a screenshot, so it doesn't go stale when the page changes.
 */
function ConnectorsPreview({ names }: { names: string[] }) {
  return (
    <div className="connectors-preview" aria-hidden>
      <div className="connectors-preview-bar">
        <span />
        <span />
        <span />
        <div className="connectors-preview-url">claude.ai/new#customize/connectors</div>
      </div>
      <div className="connectors-preview-body">
        <div className="connectors-preview-title">Connectors</div>
        {names.map((n, i) => (
          <div key={n} className={`connectors-preview-row${i === 0 ? " hover" : ""}`}>
            <span className="connectors-preview-icon">{n[0]}</span>
            <span className="connectors-preview-name">{n}</span>
            <span className="connectors-preview-connect">
              Connect
              {i === 0 && (
                <svg className="connectors-preview-cursor" width="14" height="18" viewBox="0 0 14 18">
                  <path d="M1 1v13.5l3.6-3.3 2.3 5.3 2.2-1-2.3-5.1H12z" fill="#fff" stroke="#000" strokeWidth="1.1" strokeLinejoin="round" />
                </svg>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
