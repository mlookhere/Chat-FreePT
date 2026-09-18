import { query, queryLast } from "./selectors";

export interface AssistantMessage {
  el: HTMLElement;
  text: string;
  /** Stable across DOM re-renders/reloads when ChatGPT exposes a turn/message id. */
  key: string;
}

/**
 * The newest assistant message. Long conversations virtualize older turns away, so only
 * ever read from the end — the last turn is always mounted.
 */
export function lastAssistantMessage(): AssistantMessage | null {
  const el = queryLast("assistantMessage") as HTMLElement | null;
  if (!el) return null;
  const text = el.innerText ?? el.textContent ?? "";
  return { el, text, key: assistantMessageKey(el, text) };
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
  if (query("toolIndicator", turn)) return true;
  const probe = turn.parentElement ?? turn;
  const text = (probe.innerText ?? "").slice(0, 400);
  return /\b(Working|Running|Using|Calling|Searching|Reading|Talking to|Connecting)\b(\.\.\.|…)?/.test(
    text.split("\n")[0] ?? "",
  );
}

export function conversationRootEl(): HTMLElement {
  return (query("conversationRoot") as HTMLElement | null) ?? document.body;
}

function assistantMessageKey(el: HTMLElement, text: string): string {
  const directId = el.getAttribute("data-message-id");
  if (directId) return `message:${directId}`;

  const messageHost = el.closest<HTMLElement>("[data-message-id]");
  const hostId = messageHost?.getAttribute("data-message-id");
  if (hostId) return `message:${hostId}`;

  const turn = el.closest<HTMLElement>('[data-testid^="conversation-turn"]');
  const turnId = turn?.getAttribute("data-testid");
  if (turnId) return `turn:${turnId}`;

  return `text:${fnv1a(text)}`;
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
