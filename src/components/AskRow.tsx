import { answerAsk, askSummary } from "../chatAsks";
import type { ChatAsk } from "../claude";

/**
 * Something Claude Code asks before using a tool, as a card in the chat: what Claude wants to do,
 * with Deny, Always (allows the same kind of call for the rest of the chat, by the rule Claude Code
 * suggests; there's none for some calls) and Allow. The turn waits on it.
 */
export function AskRow({ chatKey, ask }: { chatKey: string; ask: ChatAsk }) {
  const { eyebrow, title, code, detail } = askSummary(ask);
  return (
    <div className="handoff ask-card small" role="group" aria-label={eyebrow}>
      <span className="handoff-eyebrow">{eyebrow}</span>
      <span className="handoff-title" title={title}>
        {title}
      </span>
      {code && <pre className="ask-code">{code}</pre>}
      {detail && (
        <div className="muted handoff-preview" title={detail}>
          {detail}
        </div>
      )}
      <div className="handoff-actions action-buttons">
        <button className="cta-ghost" title="Claude is told you declined, and carries on without it" onClick={() => answerAsk(chatKey, ask.id, "deny")}>
          Deny
        </button>
        {ask.rules.length > 0 && (
          <button className="cta-ghost" title={`Allows this for the rest of the chat: ${ask.rules.join(", ")}`} onClick={() => answerAsk(chatKey, ask.id, "always")}>
            Always
          </button>
        )}
        <button className="cta-primary" onClick={() => answerAsk(chatKey, ask.id, "allow")}>
          Allow
        </button>
      </div>
    </div>
  );
}
