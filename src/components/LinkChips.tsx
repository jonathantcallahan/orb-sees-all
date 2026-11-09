import type { LinkKind, TaskLink } from "../links";
import { COLORED_ICONS, MONO_ICONS } from "../linkIcons";
import { ExternalLink } from "./common";

export function LinkIcon({ kind }: { kind: LinkKind }) {
  const colored = COLORED_ICONS[kind];
  if (colored) return <img className="link-chip-icon" src={colored} width={14} height={14} alt="" />;
  const mono = MONO_ICONS[kind] ?? MONO_ICONS.web!;
  return (
    <svg
      className="link-chip-icon"
      width="14"
      height="14"
      viewBox={mono.viewBox}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: mono.body }}
    />
  );
}

/**
 * Links as Google Docs–style smart chips: the product's icon, then the title. "list" puts one per
 * line. "icons" shows just each chip's icon on its round background, inline with the text around it,
 * with the title on hover.
 */
export function LinkChips({ links, layout = "wrap" }: { links: TaskLink[]; layout?: "wrap" | "list" | "icons" }) {
  if (links.length === 0) return null;
  if (layout === "icons")
    return (
      <span className="link-chips icons">
        {links.map((l) => (
          <ExternalLink key={l.url} href={l.url} className={`link-chip icon-only ${l.kind}`} title={l.title} label={l.title}>
            <LinkIcon kind={l.kind} />
          </ExternalLink>
        ))}
      </span>
    );
  return (
    <div className={`link-chips ${layout}`}>
      {links.map((l) => (
        <ExternalLink key={l.url} href={l.url} className={`link-chip ${l.kind}`} title={l.url}>
          <LinkIcon kind={l.kind} />
          <span className="link-chip-title">{l.title}</span>
        </ExternalLink>
      ))}
    </div>
  );
}
