/**
 * Since when a finished task stays in Today until you move it out (see inToday): the start of the
 * day this version first ran. Before, a finished task left Today the day after (or at once, if it
 * was carried over from an earlier day); those had already gone and don't come back, while ones
 * finished earlier that first day do. Kept in localStorage, like the area switches.
 */
const KEY = "today:done-stays-since";

export function doneStaysSince(now = new Date()): string {
  const startOfDay = () => new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return saved;
    const at = startOfDay();
    localStorage.setItem(KEY, at);
    return at;
  } catch {
    return startOfDay();
  }
}
