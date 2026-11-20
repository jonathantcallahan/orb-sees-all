import { projectConnectorsReady, saveProjectConnectors, setAreaOn } from "./features";
import { checkProjectConnectors } from "./setup";

/**
 * Once, for anyone set up before Projects needed Jira and GitHub (see features): Projects is turned
 * off when either is missing, as it is when a first run starts without them (see Onboarding). Its
 * projects are kept, and it can be turned on in Settings once both are set up. It runs until a check
 * can tell: a probe that couldn't run, or a Jira still connecting, tries again on the next launch.
 */
const DONE_KEY = "upgrade:projects-connectors";

/** Whether the upgrade check has settled (see turnOffProjectsWithoutConnectors). */
export const projectsUpgradeSettled = (): boolean => done();

const done = (): boolean => {
  try {
    return localStorage.getItem(DONE_KEY) === "1";
  } catch {
    return false;
  }
};

/** Settled: by a check that could tell, or by a first run's onboarding, which already set Projects from its own. */
export function markProjectsUpgradeDone() {
  try {
    localStorage.setItem(DONE_KEY, "1");
  } catch {
    // Storage refused: it checks again next launch.
  }
}

/**
 * Turns Projects off if Jira or GitHub is missing, the first time it can tell. "off" when it did,
 * "kept" when both are there, "unknown" when the check couldn't tell (it runs again next launch), and
 * "settled" when it had already run.
 */
export async function turnOffProjectsWithoutConnectors(check: typeof checkProjectConnectors = checkProjectConnectors): Promise<"off" | "kept" | "unknown" | "settled"> {
  if (done()) return "settled";
  const c = await check().catch(() => null);
  if (!c) return "unknown";
  saveProjectConnectors(c);
  markProjectsUpgradeDone();
  if (projectConnectorsReady({ ...c, at: new Date().toISOString() })) return "kept";
  setAreaOn("projects", false);
  return "off";
}

let once: Promise<unknown> | null = null;

/**
 * The upgrade check, run at most once per launch (the app's start and the first refresh share it), so
 * a refresh doesn't find or refresh projects that are about to be turned off. Only for someone already
 * set up: a first run sets Projects in onboarding.
 */
export function ensureProjectsUpgrade(): Promise<unknown> {
  if (done()) return Promise.resolve();
  once ??= turnOffProjectsWithoutConnectors().catch(() => {});
  return once;
}
