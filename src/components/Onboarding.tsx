import { useEffect, useRef, useState } from "react";
import * as db from "../db";
import { learnRole } from "../jobs";
import { spinOrb } from "../orbEvents";
import { runSetupChecks, type SetupReport } from "../setup";
import { ScrambleText } from "./common";
import { PressureBlob } from "./PressureBlob";
import { SetupScreen } from "./SetupScreen";

/** A calm orb for the onboarding screen: no tasks yet, so no pressure. */
const CALM = { projectsOnMe: 0, criticalTasks: 0, load: 0, level: 0.12 };
/** The least time each step stays up, so the sequence reads as a rhythm, not a flicker. */
const STEP_MS = 1100;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The steps, in order; a re-check picks up from one. */
type Stage = "claude" | "login" | "tools" | "role";
const ORDER: Stage[] = ["claude", "login", "tools", "role"];

/** What's stopping setup: what to say, which step to check again, and what that button says. */
interface Problem {
  text: string;
  stage: Stage;
  /** For steps you fix outside the app (signing in, connecting a tool): the re-check button's label. */
  recheck?: string;
}

/**
 * First run (and the menu bar's Replay onboarding): a black screen with Demian at its center. Its
 * name scrambles into being underneath, then the same line scrambles through each setup step as it
 * runs (1 Claude Code, 2 your sign-in, 3 your tools, 4 your role). The orb spins up as each step
 * passes and coasts back down. Where a step needs you to do something outside the app (sign in,
 * connect a tool), it says so, with a button to check just that again. Claude works out your role
 * itself, so there's nothing to fill in. Then "Setup complete" and a single Start, which opens the
 * app and begins loading everything.
 */
/** How long the closing greeting takes to unscramble; Start appears once it has. */
const GREETING_MS = 2800;

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [line, setLine] = useState("Demian");
  const [greeting, setGreeting] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [ready, setReady] = useState(false);
  const [details, setDetails] = useState(false);
  /** Where to (re)start: the whole sequence the first time, a single step after a re-check. */
  const [run, setRun] = useState<{ from: Stage; n: number }>({ from: "claude", n: 0 });
  const report = useRef<SetupReport | null>(null);

  useEffect(() => {
    let cancelled = false;
    const live = () => !cancelled;
    const at = (stage: Stage) => ORDER.indexOf(stage) >= ORDER.indexOf(run.from);
    /** Waits until the checks have answered `pick`, and at least `min` ms. */
    const until = async <T,>(pick: (r: SetupReport) => T | null | undefined, min: number): Promise<T | null> => {
      const start = Date.now();
      for (;;) {
        const r = report.current;
        const v = r ? pick(r) : null;
        if (v !== null && v !== undefined && Date.now() - start >= min) return v;
        if (!live()) return null;
        await wait(100);
      }
    };
    (async () => {
      setProblem(null);
      setReady(false);
      setGreeting(false);
      report.current = null;
      // The name spells itself out of noise, slowly, the first time.
      if (run.n === 0) await wait(3600);
      if (!live()) return;
      let finished = false;
      runSetupChecks((r) => (report.current = r)).then((r) => {
        report.current = r;
        finished = true;
      });

      if (at("claude")) setLine("Finding Claude Code");
      const claude = await until((r) => r.claude, at("claude") ? STEP_MS : 0);
      if (!live()) return;
      if (!claude?.ok) return setProblem({ text: "Claude Code isn't installed on this Mac.", stage: "claude", recheck: "Check again" });
      if (at("claude")) spinOrb();

      if (at("login")) setLine(run.from === "login" ? "Checking your sign-in again" : "Checking your Claude sign-in");
      const login = await until((r) => r.login, at("login") ? STEP_MS : 0);
      if (!live()) return;
      if (!login?.ok) return setProblem({ text: "Sign in to Claude Code with your claude.ai account.", stage: "login", recheck: "Check sign-in again" });
      if (at("login")) spinOrb();

      setLine(run.from === "tools" ? "Checking your tools again" : "Connecting your tools");
      const start = Date.now();
      while (!finished && live()) await wait(100);
      await wait(Math.max(0, STEP_MS - (Date.now() - start)));
      if (!live()) return;
      const r = report.current!;
      if (r.probeError) return setProblem({ text: "Claude Code couldn't start to check your tools.", stage: "tools", recheck: "Check tools again" });
      if (r.noClaudeAi) return setProblem({ text: "Claude Code isn't using a claude.ai account, so its connectors aren't there.", stage: "login", recheck: "Check sign-in again" });
      const missing = (r.connectors ?? []).filter((c) => c.required && c.state !== "connected");
      if (missing.length) {
        const names = missing.map((c) => c.label);
        const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
        return setProblem({
          text: `Connect ${list} in Claude (claude.ai › Settings › Connectors).`,
          stage: "tools",
          recheck: missing.length === 1 ? `Check ${names[0]} again` : "Check connectors again",
        });
      }
      spinOrb();

      setLine("Getting to know your role");
      // Learn it unless both the role and the name are already known.
      const known = (await db.getSetting("user_profile"))?.trim() && (await db.getSetting("user_name"))?.trim();
      if (!known) await learnRole().catch(() => "");
      const name = (await db.getSetting("user_name"))?.trim();
      if (!live()) return;
      await wait(known ? STEP_MS : 400);
      spinOrb();
      await db.setSetting("setup_done", "1");
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

  return (
    <div className="onboarding">
      <div className="onboarding-orb">
        <PressureBlob pressure={CALM} look="crystal" />
      </div>
      <div className="onboarding-line">
        <ScrambleText text={problem ? problem.text : line} from="◇◆░▒▓※∂" duration={greeting && !problem ? GREETING_MS : run.n === 0 && line === "Demian" ? 3200 : 500} />
      </div>
      <div className="onboarding-actions">
        {problem && (
          <>
            <button className="cta-primary" onClick={() => setRun((r) => ({ from: problem.stage, n: r.n + 1 }))}>
              {problem.recheck ?? "Try again"}
            </button>
            <button className="cta-ghost" onClick={() => setDetails(true)}>
              How to fix it
            </button>
          </>
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
