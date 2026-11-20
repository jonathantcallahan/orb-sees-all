/**
 * A small Markdown reader for docs Demian writes (a TDD draft): headings, paragraphs, quotes, lists
 * (nested by indent), tables, code and rules. Inline marks stay in the text; the view renders them
 * (see Markdown.tsx).
 */

export type MdBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "para"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: MdItem[] }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "code"; text: string }
  | { kind: "rule" };

export interface MdItem {
  text: string;
  /** Lists under it. */
  children: MdBlock[];
}

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s*(```|~~~)/;
const QUOTE = /^\s{0,3}>/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const isTableStart = (line: string, next: string | undefined) => line.trim().startsWith("|") && next !== undefined && TABLE_SEP.test(next);

/** Starts something other than a paragraph, which ends the paragraph before it. */
const startsBlock = (line: string, next: string | undefined) =>
  FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST.test(line) || isTableStart(line, next);

/** A table row's cells, with `\|` kept as a pipe inside a cell. */
export function tableCells(line: string): string[] {
  const cells = line
    .trim()
    .replace(/\\\|/g, "\u0000")
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|");
  return cells.map((c) => c.replace(/\u0000/g, "|").trim());
}

interface ListLine {
  indent: number;
  ordered: boolean;
  marker: string;
  text: string;
}

/** The list lines from `i` on (continuation lines joined to their item), and where the list ends. */
function listLines(lines: string[], i: number): [ListLine[], number] {
  const out: ListLine[] = [];
  while (i < lines.length) {
    const line = lines[i];
    const m = LIST.exec(line);
    if (m && !RULE.test(line)) {
      out.push({ indent: m[1].replace(/\t/g, "    ").length, ordered: /\d/.test(m[2]), marker: m[2], text: m[3].trim() });
      i++;
      continue;
    }
    if (!line.trim()) {
      // A blank line inside a list: it goes on only if a list item follows.
      let j = i;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j < lines.length && LIST.test(lines[j]) && !RULE.test(lines[j])) {
        i = j;
        continue;
      }
      break;
    }
    // An indented line under an item carries on its text; anything else ends the list.
    if (/^\s+\S/.test(line) && out.length && !startsBlock(line, lines[i + 1])) {
      out[out.length - 1].text += ` ${line.trim()}`;
      i++;
      continue;
    }
    break;
  }
  return [out, i];
}

function buildList(entries: ListLine[], start: number): [MdBlock, number] {
  const base = entries[start].indent;
  const items: MdItem[] = [];
  let k = start;
  // Bullets and numbers at the same level are two lists.
  while (k < entries.length && entries[k].indent >= base && (entries[k].indent > base || entries[k].ordered === entries[start].ordered)) {
    if (entries[k].indent > base) {
      const [child, next] = buildList(entries, k);
      if (!items.length) items.push({ text: "", children: [] });
      items[items.length - 1].children.push(child);
      k = next;
    } else {
      items.push({ text: entries[k].text, children: [] });
      k++;
    }
  }
  const first = entries[start];
  return [{ kind: "list", ordered: first.ordered, start: first.ordered ? parseInt(first.marker, 10) || 1 : 1, items }, k];
}

export function parseMarkdown(md: string): MdBlock[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      blocks.push({ kind: "heading", level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].replace(/^\s{0,3}>\s?/, ""));
      blocks.push({ kind: "quote", text: body.join(" ").trim() });
      continue;
    }
    if (isTableStart(line, lines[i + 1])) {
      const head = tableCells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(tableCells(lines[i++]));
      blocks.push({ kind: "table", head, rows });
      continue;
    }
    if (LIST.test(line)) {
      const [entries, next] = listLines(lines, i);
      let k = 0;
      while (k < entries.length) {
        const [list, after] = buildList(entries, k);
        blocks.push(list);
        k = after;
      }
      i = next;
      continue;
    }
    const para = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) para.push(lines[i++].trim());
    blocks.push({ kind: "para", text: para.join(" ") });
  }
  return blocks;
}

/**
 * A key for each smallest piece of a doc (a heading, paragraph, list item, table row): what the
 * view compares to show what a change touched.
 */
export function blockKey(kind: string, text: string): string {
  return `${kind}:${text.replace(/\s+/g, " ").trim()}`;
}

/** The keys of every piece of `md` (see blockKey). */
export function pieceKeys(md: string): Set<string> {
  const keys = new Set<string>();
  const walk = (blocks: MdBlock[]) => {
    for (const b of blocks) {
      if (b.kind === "list")
        for (const item of b.items) {
          keys.add(blockKey("li", item.text));
          walk(item.children);
        }
      else if (b.kind === "table") {
        keys.add(blockKey("tr", b.head.join("|")));
        for (const r of b.rows) keys.add(blockKey("tr", r.join("|")));
      } else if (b.kind !== "rule") keys.add(blockKey(b.kind, b.text));
    }
  };
  walk(parseMarkdown(md));
  return keys;
}

/** A doc's name: its first top-level heading, as plain text, or null when it has none. */
export function docName(md: string): string | null {
  const h = parseMarkdown(md).find((b) => b.kind === "heading" && b.level === 1);
  if (!h || h.kind !== "heading") return null;
  const text = h.text
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/(^|\s)[*_](\S[^*_]*?)[*_](?=\s|$)/g, "$1$2")
    .trim();
  return text || null;
}
