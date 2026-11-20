import { describe, expect, it } from "vitest";
import { typingIn, whyKey } from "./whyKeys";

const press = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; isComposing: boolean }> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  ...mods,
});
const empty = { typed: false, canAskLess: true };

describe("the Why? prompt's keys", () => {
  it("dismisses on Space and asks less often on L while nothing's typed", () => {
    expect(whyKey(press(" "), empty)).toBe("dismiss");
    expect(whyKey(press("l"), empty)).toBe("less_often");
    expect(whyKey(press("Escape"), empty)).toBe("leave");
  });

  it("types them into a reason once one is begun, and Shift+L is a capital L", () => {
    expect(whyKey(press(" "), { ...empty, typed: true })).toBeNull();
    expect(whyKey(press("l"), { ...empty, typed: true })).toBeNull();
    expect(whyKey(press("L", { shiftKey: true }), empty)).toBeNull();
    // Esc leaves whatever's typed.
    expect(whyKey(press("Escape"), { ...empty, typed: true })).toBe("leave");
  });

  it("leaves L alone when it already asks as rarely as it can, and keys with modifiers or mid-composition", () => {
    expect(whyKey(press("l"), { ...empty, canAskLess: false })).toBeNull();
    expect(whyKey(press(" ", { metaKey: true }), empty)).toBeNull();
    expect(whyKey(press("l", { ctrlKey: true }), empty)).toBeNull();
    expect(whyKey(press(" ", { isComposing: true }), empty)).toBeNull();
  });
});

describe("typingIn", () => {
  it("is a text field, but not a menu, button or checkbox", () => {
    expect(typingIn({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(typingIn({ tagName: "input" })).toBe(true);
    expect(typingIn({ tagName: "TEXTAREA" })).toBe(true);
    expect(typingIn({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(typingIn({ tagName: "SELECT" })).toBe(false);
    expect(typingIn({ tagName: "BUTTON" })).toBe(false);
    expect(typingIn({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(typingIn(null)).toBe(false);
  });
});
