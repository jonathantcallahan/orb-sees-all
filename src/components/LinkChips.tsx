import type { LinkKind, TaskLink } from "../links";
import { COLORED_ICONS, MONO_ICONS } from "../linkIcons";
import { ExternalLink } from "./common";

function LinkIcon({ kind }: { kind: LinkKind }) {
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

/** Links as Google Docs–style smart chips: the product's icon, then the title. */
export function LinkChips({ links }: { links: TaskLink[] }) {
  if (links.length === 0) return null;
  return (
    <div className="link-chips">
      {links.map((l) => (
        <ExternalLink key={l.url} href={l.url} className={`link-chip ${l.kind}`} title={l.url}>
          <LinkIcon kind={l.kind} />
          <span className="link-chip-title">{l.title}</span>
        </ExternalLink>
      ))}
    </div>
  );
}
