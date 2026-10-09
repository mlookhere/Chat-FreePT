import type { PageSignal } from "../common/types";
import { query, queryAll } from "./selectors";

const RATE_LIMIT_RE =
  /you(?:'|’)?ve (?:hit|reached) (?:your|the) (?:limit|cap)|too many (?:requests|messages)|reached (?:your|the) message (?:limit|cap)|try again (?:later|after)|usage cap/i;
const CONVERSATION_FULL_RE =
  /you(?:'|’)?ve reached the maximum length for this conversation|maximum conversation length|conversation is too long|start a new chat to continue/i;

/** Only native page alerts count, not quoted warnings in a chat reply or FreePT UI. */
function isNativeAlert(node: Element): boolean {
  return !node.closest('#cfpt-root, [data-message-author-role], [hidden], [aria-hidden="true"]');
}

function alertTexts(): string[] {
  const alerts = queryAll("pageAlert").filter(isNativeAlert);
  // Some ChatGPT layouts render the same alert as an aside without role=alert.
  // Require the native action button for that fallback, so chat text cannot trigger a rollover.
  const asideFallbacks = Array.from(document.querySelectorAll("aside"))
    .filter(isNativeAlert)
    .filter((aside) =>
      Array.from(aside.querySelectorAll("button")).some((button) =>
        /^start new chat$/i.test(button.textContent?.trim() ?? ""),
      ),
    );
  return [...new Set([...alerts, ...asideFallbacks])]
    .map((node) => (node as HTMLElement).innerText ?? node.textContent ?? "")
    .filter(Boolean);
}

/**
 * Best-effort scan for page-level conditions that should pause the run. Called on a slow
 * poll while a run is active; the run controller de-duplicates repeat signals.
 */
export function scanPageSignals(): PageSignal | null {
  if (query("loginButton") && !query("composer")) return "logged-out";

  const alerts = alertTexts();
  for (const text of alerts) {
    if (CONVERSATION_FULL_RE.test(text)) return "conversation-full";
    if (RATE_LIMIT_RE.test(text)) return "rate-limit";
  }

  if (query("regenerateButton")) return "network-error";
  return null;
}
