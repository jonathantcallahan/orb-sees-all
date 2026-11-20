/** A run of chat text: plain words, or a link to open in the browser, or a reference (a file) shown by its name. */
export interface ChatPiece {
  text: string;
  /** A web or mail link the words open. */
  href?: string;
  /** What a reference that can't be opened from here points at (a file path), shown on hover. */
  title?: string;
}

/** Text with markdown marks (bold, italics, code) dropped: chats show Claude's words plainly. */
export const plain = (text: string) =>
  text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|\W)[*_]([^*_\n]+)[*_](?=\W|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1");

/**
 * The links Claude writes: a Markdown link, `[words](target)` (a target may hold one level of
 * brackets, as Wikipedia's do, and a quoted title); Slack's `<url|words>` or `<url>`; and a bare url.
 */
const LINK =
  /\[([^\]\n]+)\]\(\s*<?([^\s()<>]*(?:\([^\s()]*\)[^\s()<>]*)*)>?(?:\s+"[^"\n]*")?\s*\)|<((?:https?:\/\/|mailto:)[^\s|>]+)(?:\|([^>\n]+))?>|(https?:\/\/[^\s<>]+)/gi;
const WEB = /^(?:https?:\/\/[^\s/]+|mailto:\S+@)/i;
/** Marks where a link was taken out, so markdown marks can be dropped around it without touching it. */
const SLOT = /(\d+)/;

const count = (text: string, ch: string) => text.split(ch).length - 1;

/**
 * A bare url without what follows it in the sentence: a closing stop, comma, quote or markdown
 * mark, or a bracket that closes one opened before the url rather than inside it.
 */
function trimUrl(url: string): string {
  let u = url;
  for (;;) {
    const last = u.slice(-1);
    if (/[.,;:!?'"*_`\]’”>]/.test(last) || (last === ")" && count(u, "(") < count(u, ")"))) u = u.slice(0, -1);
    else return u;
  }
}

/**
 * A chat message's text split into words and links. Markdown marks are dropped from the words
 * (unless `strip` is false, for what the user typed), never from a link's url.
 */
export function chatPieces(text: string, strip = true): ChatPiece[] {
  const links: ChatPiece[] = [];
  const words = (s: string) => (strip ? plain(s) : s);
  const marked = text.replace(LINK, (whole, label?: string, target?: string, angled?: string, angledLabel?: string, bare?: string) => {
    let after = "";
    if (label !== undefined) {
      const to = (target ?? "").trim();
      if (!to) return whole;
      links.push(WEB.test(to) ? { text: words(label), href: to } : { text: words(label), title: to });
    } else if (angled) links.push({ text: angledLabel ? words(angledLabel) : angled, href: angled });
    else {
      const url = trimUrl(bare ?? "");
      if (!WEB.test(url)) return whole;
      after = (bare ?? "").slice(url.length);
      links.push({ text: url, href: url });
    }
    return `${links.length - 1}${after}`;
  });
  if (!links.length) return [{ text: words(text) }];
  const pieces: ChatPiece[] = [];
  const parts = words(marked).split(SLOT);
  parts.forEach((part, i) => {
    if (i % 2) pieces.push(links[Number(part)]);
    else if (part) pieces.push({ text: part });
  });
  return pieces;
}
