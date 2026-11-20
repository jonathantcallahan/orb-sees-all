/** Initials and colors for faces without an avatar (see Avatar). Pure, so they can be tested. */

/** Up to two initials for a name: "Jackie Jones" is "JJ", "Cher" is "C". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const first = [...words[0]][0] ?? "";
  const last = words.length > 1 ? ([...words[words.length - 1]][0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** A hue for someone's initials, the same each time for the same name. */
export function nameHue(name: string): number {
  let h = 0;
  for (const ch of name.trim().toLowerCase()) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return h;
}
