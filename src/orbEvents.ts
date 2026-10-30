/** Tells the orb a task was just finished, so it can ripple. */
export const TASK_DONE_EVENT = "orb:task-done";

export function announceTaskDone() {
  window.dispatchEvent(new Event(TASK_DONE_EVENT));
}
