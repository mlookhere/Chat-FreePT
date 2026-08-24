import type { PageSignal } from "../common/types";
import { query } from "./selectors";

const RATE_LIMIT_RE =
  /you(?:'|’)?ve (?:hit|reached) (?:your|the) (?:limit|cap)|too many (?:requests|messages)|reached (?:your|the) message (?:limit|cap)|try again (?:later|after)|usage cap/i;
const CONVERSATION_FULL_RE =
  /maximum (?:conversation )?length|conversation is too long|start a new chat to continue/i;

function alertTexts(): string[] {
  const nodes = document.querySelectorAll('[role="alert"], [class*="toast"]');
  return Array.from(nodes, (n) => (n as HTMLElement).innerText ?? "").filter(Boolean);
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
