import { useEffect, useRef, useState } from "react";
import * as db from "../db";
import { learnRole } from "../jobs";
import { spinOrb } from "../orbEvents";
import { runCli } from "../cli";
import { CONNECTORS, runSetupChecks, type ConnectorCheck, type SetupReport } from "../setup";
import { OnboardingGuide, StepStack, type GuideKind } from "./OnboardingGuide";
import { ScrambleText } from "./common";
import { PressureBlob } from "./PressureBlob";
import { SetupScreen } from "./SetupScreen";

/** A calm orb for the onboarding screen: no tasks yet, so no pressure. */
const CALM = { projectsOnMe: 0, criticalTasks: 0, load: 0, level: 0.12 };
/** The least time the tools check stays up, so it reads as a step, not a flicker. */
const STEP_MS = 1100;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The steps; a re-check picks up from one. */
type Stage = "claude" | "login" | "tools" | "role";

/** What's stopping setup: what to say, which step to check again, and what that button says. */
interface Problem {
  text: string;
  stage: Stage;
  /** For steps you fix outside the app (signing in, connecting a tool): the re-check button's label. */
  recheck?: string;
  /** The walk-through for fixing it, when there is one. */
  guide?: GuideKind;
  connectors?: ConnectorCheck[] | null;
  apiKey?: boolean;
  /** Only optional connectors are missing: shown once, with Continue. */
  optionalOnly?: boolean;
}

/** How often install and sign-in are looked at again while onboarding waits on them. */
const POLL_MS = 4000;

/**
 * First run (and the menu bar's Replay onboarding): a black screen with Demian at its center. Its
 * name scrambles into being underneath. Installing Claude Code and signing in are checked quietly:
 * a step that's already done is just ticked off in the guide's progress, and it opens on the first
 * one that needs you. Checking the tools takes a few seconds, so that has its line. Where a step needs
 * you to do something outside the app (sign in, connect a tool), it says so. Claude works out your
 * role itself, so there's nothing to fill in. Then a greeting and a single Start, which opens the app
 * and begins loading everything.
 */
/** How long the closing greeting takes to unscramble; Start appears once it has. */
const GREETING_MS = 2800;

/** What a simulation pretends is in place, set with its toggles. */
interface Simulated {
  installed: boolean;
  signedIn: boolean;
  /** Signed in with a Claude account, rather than an API key. */
  claudeAccount: boolean;
  /** Connector ids that are connected. */
  connected: string[];
}
const SIM_START: Simulated = { installed: false, signedIn: false, claudeAccount: true, connected: [] };

/** Setup checks that report what the simulation's toggles say instead of running anything. */
function simulatedChecks(sim: Simulated) {
  const run = async (program: string, args: string[]) => {
    if (program === "gh") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "--version") return sim.installed ? { code: 0, stdout: "2.1.0 (Claude Code)\n", stderr: "" } : { code: 1, stdout: "", stderr: "" };
    return { code: 0, stdout: JSON.stringify({ loggedIn: sim.signedIn, authMethod: sim.claudeAccount ? "claude.ai" : "api_key" }), stderr: "" };
  };
  const servers = sim.claudeAccount ? CONNECTORS.filter((c) => sim.connected.includes(c.id)).map((c) => ({ name: c.server, status: "connected" })) : [];
  const stream = async () => ({ code: 0, stdout: JSON.stringify({ type: "system", subtype: "init", mcp_servers: servers }), stderr: "" });
  return { run, stream };
}

/** The simulation's toggles, along the top: what's installed, signed in and connected. */
function SimulationBar({ sim, onChange, onEnd }: { sim: Simulated; onChange: (s: Simulated) => void; onEnd: () => void }) {
  const toggle = (label: string, on: boolean, set: (on: boolean) => void, disabled = false) => (
    <label key={label} className={`onboarding-sim-toggle${on ? " on" : ""}${disabled ? " disabled" : ""}`}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => set(e.target.checked)} />
      {label}
    </label>
  );
  return (
    <div className="onboarding-sim-bar">
      <span className="onboarding-sim-title">Simulation</span>
      {toggle("Claude Code installed", sim.installed, (on) => onChange({ ...sim, installed: on }))}
      {toggle("Signed in", sim.signedIn, (on) => onChange({ ...sim, signedIn: on }), !sim.installed)}
      {toggle("Claude account (not API key)", sim.claudeAccount, (on) => onChange({ ...sim, claudeAccount: on }), !sim.signedIn)}
      <span className="onboarding-sim-sep" />
      {CONNECTORS.map((c) =>
        toggle(
          c.label,
          sim.connected.includes(c.id),
          (on) => onChange({ ...sim, connected: on ? [...sim.connected, c.id] : sim.connected.filter((id) => id !== c.id) }),
          !sim.signedIn || !sim.claudeAccount,
        ),
      )}
      <button className="link-button small onboarding-sim-end" onClick={onEnd}>
        End
      </button>
    </div>
  );
}

export function Onboarding({ onDone, simulate = false }: { onDone: () => void; simulate?: boolean }) {
  const [line, setLine] = useState("Demian");
  const [greeting, setGreeting] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [ready, setReady] = useState(false);
  const [details, setDetails] = useState(false);
  /** Where to (re)start: the whole sequence the first time, a single step after a re-check. */
  const [run, setRun] = useState<{ from: Stage; n: number }>({ from: "claude", n: 0 });
  const report = useRef<SetupReport | null>(null);
  /** The optional connectors have been shown once; after Continue (or a re-check) they don't stop setup again. */
  const optionalShown = useRef(false);
  /** In a simulation, what's pretended to be in place. */
  const [sim, setSim] = useState<Simulated>(SIM_START);
  const simRef = useRef(sim);
  simRef.current = sim;

  useEffect(() => {
    let cancelled = false;
    const live = () => !cancelled;
    /** Waits until the checks have answered `pick`. */
    const until = async <T,>(pick: (r: SetupReport) => T | null | undefined): Promise<T | null> => {
      for (;;) {
        const r = report.current;
        const v = r ? pick(r) : null;
        if (v !== null && v !== undefined) return v;
        if (!live()) return null;
        await wait(100);
      }
    };
    (async () => {
      // A guided step stays up while the next check runs, so "Get started" doesn't blink away and
      // scramble back between steps; it's replaced by the next step, or cleared once all pass.
      setProblem((p) => (p?.guide ? p : null));
      setReady(false);
      setGreeting(false);
      report.current = null;
      // The name spells itself out of noise, slowly, the first time.
      if (run.n === 0) await wait(3600);
      if (!live()) return;
      let finished = false;
      const fake = simulate ? simulatedChecks(simRef.current) : null;
      runSetupChecks((r) => (report.current = r), fake?.run, fake?.stream).then((r) => {
        report.current = r;
        finished = true;
      });

      // Installed and signed in are quick to check and say nothing when they pass: the guide opens on
      // the first step that needs you, with the ones before it ticked off.
      const claude = await until((r) => r.claude);
      if (!live()) return;
      if (!claude?.ok) return setProblem({ text: "Get started", stage: "claude", recheck: "Check again", guide: "install" });

      const login = await until((r) => r.login);
      if (!live()) return;
      if (!login?.ok) return setProblem({ text: "Get started", stage: "login", recheck: "Check sign-in again", guide: "login" });
      spinOrb();

      setLine(run.from === "tools" ? "Checking your tools again" : "Connecting your tools");
      const start = Date.now();
      while (!finished && live()) await wait(100);
      await wait(Math.max(0, STEP_MS - (Date.now() - start)));
      if (!live()) return;
      const r = report.current!;
      if (r.probeError) return setProblem({ text: "Claude Code couldn't start to check your tools.", stage: "tools", recheck: "Check tools again" });
      if (r.noClaudeAi)
        return setProblem({ text: "Get started", stage: "login", recheck: "Check sign-in again", guide: "login", apiKey: true });
      const missing = (r.connectors ?? []).filter((c) => c.required && c.state !== "connected");
      if (missing.length) return setProblem({ text: "Get started", stage: "tools", guide: "connectors", connectors: r.connectors });
      // Everything needed is there. Once, say what else Demian can use, so it isn't a secret.
      const extra = (r.connectors ?? []).filter((c) => !c.required && c.state !== "connected");
      if (extra.length && !optionalShown.current) {
        optionalShown.current = true;
        return setProblem({ text: "Get started", stage: "tools", guide: "connectors", connectors: r.connectors, optionalOnly: true });
      }
      spinOrb();

      setProblem(null);
      setLine("Getting to know your role");
      // Learn it unless both the role and the name are already known.
      const known = simulate || ((await db.getSetting("user_profile"))?.trim() && (await db.getSetting("user_name"))?.trim());
      if (!known) await learnRole().catch(() => "");
      const name = (await db.getSetting("user_name"))?.trim();
      if (!live()) return;
      await wait(known ? STEP_MS : 400);
      spinOrb();
      if (!simulate) await db.setSetting("setup_done", "1");
      if (!live()) return;

      setGreeting(true);
      setLine(`Hello${name ? ` ${name}` : ""}, we're going to do great things together.`);
      await wait(GREETING_MS + 200);
      if (live()) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [run]);

  // While it waits on an install or a sign-in, it looks again every few seconds and carries on by
  // itself once it's done (both checks are cheap; connectors aren't, so those wait for Check again,
  // which every step also has, for when this is slow to notice).
  useEffect(() => {
    const kind = problem?.guide;
    if ((kind !== "install" && kind !== "login") || simulate) return;
    let stop = false;
    const timer = setInterval(async () => {
      const out = await runCli("claude", kind === "install" ? ["--version"] : ["auth", "status"]).catch(() => null);
      let ok = out?.code === 0;
      if (ok && kind === "login") {
        try {
          const s = JSON.parse(out!.stdout);
          // Signed in with an API key already: carry on only once it's a Claude account.
          ok = !!s.loggedIn && (!problem!.apiKey || s.authMethod === "claude.ai");
        } catch {
          ok = false;
        }
      }
      if (ok && !stop) setRun((r) => ({ from: problem!.stage, n: r.n + 1 }));
    }, POLL_MS);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [problem, simulate]);

  const recheck = () => {
    if (!problem) return;
    // In a simulation, the step's own button (Install, Sign in) pretends it worked.
    if (simulate && problem.guide === "install") setSim((s) => ({ ...s, installed: true }));
    if (simulate && problem.guide === "login") setSim((s) => ({ ...s, signedIn: true, claudeAccount: true }));
    setRun((r) => ({ from: problem.stage, n: r.n + 1 }));
  };
  /** A toggle changed: start over from the top with it, the optional connectors shown again too. */
  const changeSim = (next: Simulated) => {
    setSim(next);
    simRef.current = next;
    optionalShown.current = false;
    setRun((r) => ({ from: "claude", n: r.n + 1 }));
  };

  return (
    <div className="onboarding">
      {simulate && <SimulationBar sim={sim} onChange={changeSim} onEnd={onDone} />}
      <div className="onboarding-orb">
        <PressureBlob pressure={CALM} look="crystal" />
      </div>
      <div className="onboarding-line">
        <ScrambleText text={problem ? problem.text : line} from="◇◆░▒▓※∂" duration={problem ? 500 : greeting ? GREETING_MS : run.n === 0 && line === "Demian" ? 3200 : 500} />
        {problem?.guide && <StepStack at={problem.guide} />}
      </div>
      {problem?.guide && (
        <OnboardingGuide
          kind={problem.guide}
          connectors={problem.connectors}
          apiKey={problem.apiKey}
          optionalOnly={problem.optionalOnly}
          onCheck={recheck}
          onContinue={problem.optionalOnly ? recheck : undefined}
          simulate={simulate}
        />
      )}
      <div className="onboarding-actions">
        {problem && !problem.guide && (
          <button className="cta-primary" onClick={recheck}>
            {problem.recheck ?? "Try again"}
          </button>
        )}
        {problem && !simulate && (
          <button className="link-button small onboarding-help" onClick={() => setDetails(true)}>
            More help
          </button>
        )}
        {ready && (
          <button className="cta-primary onboarding-start" onClick={onDone} autoFocus>
            Start
          </button>
        )}
      </div>
      {details && (
        <SetupScreen
          onClose={() => setDetails(false)}
          onDone={() => {
            setDetails(false);
            setRun((r) => ({ from: problem?.stage ?? "claude", n: r.n + 1 }));
          }}
        />
      )}
    </div>
  );
}
