import type { LinkKind, TaskLink } from "../links";
import { IssueTypeIcon, useIssueType } from "./JiraIcons";
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

/** A chip's icon: for a Jira issue whose type the planner knows, its type's mark (as Jira's own smart links show it); else the product's. */
function ChipIcon({ link }: { link: TaskLink }) {
  const type = useIssueType(link.kind === "jira" ? link.url : null);
  return type !== undefined ? <IssueTypeIcon type={type} size={14} /> : <LinkIcon kind={link.kind} />;
}

/**
 * Links as Google Docs–style smart chips: the product's icon (a Jira issue's type), then the title. "list" puts one per
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
            <ChipIcon link={l} />
          </ExternalLink>
        ))}
      </span>
    );
  return (
    <div className={`link-chips ${layout}`}>
      {links.map((l) => (
        <ExternalLink key={l.url} href={l.url} className={`link-chip ${l.kind}`} title={l.url}>
          <ChipIcon link={l} />
          <span className="link-chip-title">{l.title}</span>
        </ExternalLink>
      ))}
    </div>
  );
}
