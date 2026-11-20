/**
 * The Why? prompt's keys (see WhyPrompt): Esc leaves it; while nothing's typed, Space dismisses it
 * and L asks less often (Shift+L types a capital L, and a reason can hold either key once begun).
 */
export type WhyKey = "leave" | "dismiss" | "less_often" | null;

export function whyKey(
  e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; isComposing: boolean },
  o: { typed: boolean; canAskLess: boolean },
): WhyKey {
  if (e.key === "Escape") return "leave";
  if (o.typed || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing) return null;
  if (e.key === " ") return "dismiss";
  if (e.key === "l" && o.canAskLess) return "less_often";
  return null;
}

/**
 * Whether focus is somewhere you type (a text field, not a menu or button): the prompt doesn't take
 * focus from there, so a change that lands while you've moved on to typing elsewhere can't swallow
 * your keys.
 */
export function typingIn(el: { tagName: string; type?: string; isContentEditable?: boolean } | null): boolean {
  if (!el) return false;
  const tag = el.tagName.toUpperCase();
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "date"].includes((el.type ?? "text").toLowerCase());
  return !!el.isContentEditable;
}
