import { Fragment, type ReactNode } from "react";
import { blockKey, parseMarkdown, type MdBlock } from "../markdown";
import { ExternalLink } from "./common";

// Code, bold, a link, italics (*x*, or _x_ between words), or a bare web address.
const INLINE = /(`[^`]+`)|\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|\*(?!\s)([^*]+?)\*|(?<![\w])_(?!\s)([^_]+?)_(?![\w])|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])/g;

/** Markdown's backslash escapes, as the characters they stand for. */
const unescape = (text: string) => text.replace(/\\([\\`*_{}[\]()#+\-.!|>])/g, "$1");

/** A line of Markdown's inline marks as elements: code, bold, italics and links. */
export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    const i = m.index ?? 0;
    if (i > at) out.push(unescape(text.slice(at, i)));
    const key = out.length;
    if (m[1]) out.push(<code key={key}>{m[1].slice(1, -1)}</code>);
    else if (m[2] !== undefined) out.push(<strong key={key}>{inline(m[2])}</strong>);
    else if (m[3] !== undefined)
      out.push(
        <ExternalLink key={key} href={m[4]} className="md-link" title={m[4]}>
          {inline(m[3])}
        </ExternalLink>,
      );
    else if (m[5] !== undefined) out.push(<em key={key}>{inline(m[5])}</em>);
    else if (m[6] !== undefined) out.push(<em key={key}>{inline(m[6])}</em>);
    else if (m[7])
      out.push(
        <ExternalLink key={key} href={m[7]} className="md-link" title={m[7]}>
          {m[7]}
        </ExternalLink>,
      );
    at = i + m[0].length;
  }
  if (at < text.length) out.push(unescape(text.slice(at)));
  return out;
}

/**
 * A Markdown doc, read-only. With `before` (the keys of the doc as it was, see pieceKeys), the
 * pieces that are new or changed since are marked, so a change shows where it landed.
 */
export function Markdown({ text, before }: { text: string; before?: Set<string> | null }) {
  const mark = (kind: string, raw: string) => (before && !before.has(blockKey(kind, raw)) ? "md-changed" : undefined);
  const blocks = (list: MdBlock[]): ReactNode[] =>
    list.map((b, i) => {
      switch (b.kind) {
        case "heading": {
          const Tag = `h${Math.min(b.level + 1, 6)}` as "h2";
          return (
            <Tag key={i} className={[`md-h${b.level}`, mark("heading", b.text)].filter(Boolean).join(" ")}>
              {inline(b.text)}
            </Tag>
          );
        }
        case "para":
          return (
            <p key={i} className={mark("para", b.text)}>
              {inline(b.text)}
            </p>
          );
        case "quote":
          return (
            <blockquote key={i} className={mark("quote", b.text)}>
              {inline(b.text)}
            </blockquote>
          );
        case "code":
          return (
            <pre key={i} className={mark("code", b.text)}>
              <code>{b.text}</code>
            </pre>
          );
        case "rule":
          return <hr key={i} />;
        case "table":
          return (
            <div key={i} className="md-table-wrap">
              <table>
                <thead>
                  <tr className={mark("tr", b.head.join("|"))}>
                    {b.head.map((c, j) => (
                      <th key={j}>{inline(c)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((r, j) => (
                    <tr key={j} className={mark("tr", r.join("|"))}>
                      {r.map((c, k) => (
                        <td key={k}>{inline(c)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        case "list": {
          const items = b.items.map((item, j) => (
            <li key={j} className={item.text ? mark("li", item.text) : undefined}>
              {item.text && <span className="md-li-text">{inline(item.text)}</span>}
              {item.children.length > 0 && <Fragment>{blocks(item.children)}</Fragment>}
            </li>
          ));
          return b.ordered ? (
            <ol key={i} start={b.start === 1 ? undefined : b.start}>
              {items}
            </ol>
          ) : (
            <ul key={i}>{items}</ul>
          );
        }
      }
    });
  return <div className="md">{blocks(parseMarkdown(text))}</div>;
}
