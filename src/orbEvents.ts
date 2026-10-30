/** Tells the orb a task was just finished, so it can ripple. */
export const TASK_DONE_EVENT = "orb:task-done";

export function announceTaskDone() {
  window.dispatchEvent(new Event(TASK_DONE_EVENT));
}

/** Hovering an overdue task's bar agitates the orb (ferrofluid spikes toward the cursor); leaving calms it. */
export const ORB_AGITATE_EVENT = "orb:agitate";

export function setOrbAgitated(on: boolean) {
  window.dispatchEvent(new CustomEvent(ORB_AGITATE_EVENT, { detail: on }));
}
