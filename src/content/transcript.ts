import { query, queryLast } from "./selectors";

export interface AssistantMessage {
  el: HTMLElement;
  text: string;
}

/**
 * The newest assistant message. Long conversations virtualize older turns away, so only
 * ever read from the end — the last turn is always mounted.
 */
export function lastAssistantMessage(): AssistantMessage | null {
  const el = queryLast("assistantMessage") as HTMLElement | null;
  if (!el) return null;
  return { el, text: el.innerText ?? el.textContent ?? "" };
}

export function lastMessageRole(): "assistant" | "user" | null {
  const assistant = queryLast("assistantMessage") as HTMLElement | null;
  const user = queryLast("userMessage") as HTMLElement | null;
  if (!assistant && !user) return null;
  if (!assistant) return "user";
  if (!user) return "assistant";
  const order = assistant.compareDocumentPosition(user);
  return order & Node.DOCUMENT_POSITION_FOLLOWING ? "user" : "assistant";
}

/** A visible tool-call indicator inside the newest assistant turn (MCP calls stall output). */
export function toolCallIndicatorVisible(): boolean {
  const turn = queryLast("assistantMessage") as HTMLElement | null;
  if (!turn) return false;
  if (turn.querySelector('[data-testid*="tool"]')) return true;
  const probe = turn.parentElement ?? turn;
  const text = (probe.innerText ?? "").slice(0, 400);
  return /\b(Working|Running|Using|Calling|Searching|Reading|Talking to|Connecting)\b(\.\.\.|…)?/.test(
    text.split("\n")[0] ?? "",
  );
}

export function conversationRootEl(): HTMLElement {
  return (query("conversationRoot") as HTMLElement | null) ?? document.body;
}
