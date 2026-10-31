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

/** Tells the orb an update was just read, so a shockwave runs through it the way the card went. */
export const ORB_SHOCK_EVENT = "orb:shock";

export function shockOrb() {
  window.dispatchEvent(new Event(ORB_SHOCK_EVENT));
}

/** Spins the orb up for about half a second, then lets it coast back down smoothly (onboarding steps). */
export const ORB_SPIN_EVENT = "orb:spin";

export function spinOrb() {
  window.dispatchEvent(new Event(ORB_SPIN_EVENT));
}
