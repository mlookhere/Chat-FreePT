/**
 * The single owner of every selector pointed at chatgpt.com. Nothing else in the
 * extension may query the host page directly: the page's DOM is not ours, it changes
 * without notice, and when it does this registry is the one place to fix.
 */

export type TargetId =
  | "composer"
  | "composerHeader"
  | "composerSurface"
  | "sendButton"
  | "stopButton"
  | "assistantMessage"
  | "userMessage"
  | "conversationRoot"
  | "regenerateButton"
  | "loginButton"
  | "pageAlert"
  | "toolIndicator";

export interface Candidate {
  css: string;
  /** When present, css hits are filtered by visible text. */
  textRe?: RegExp;
}

interface Target {
  required: boolean;
  candidates: Candidate[];
}

const REGISTRY: Record<TargetId, Target> = {
  composer: {
    required: true,
    candidates: [
      { css: "#prompt-textarea" },
      { css: 'div.ProseMirror[contenteditable="true"]' },
      { css: 'form[data-type="unified-composer"] [contenteditable="true"]' },
      { css: 'main [contenteditable="true"]' },
    ],
  },
  composerHeader: {
    required: false,
    candidates: [
      { css: "#thread-bottom [data-prompt-textarea-header]" },
      { css: "main [data-prompt-textarea-header]" },
      { css: "[data-prompt-textarea-header]" },
    ],
  },
  composerSurface: {
    required: false,
    candidates: [
      { css: '#thread-bottom form[data-type="unified-composer"] [data-composer-surface="true"]' },
      { css: 'form[data-type="unified-composer"] [data-composer-surface="true"]' },
      { css: '[data-composer-surface="true"]' },
      { css: 'form[data-type="unified-composer"]' },
    ],
  },
  sendButton: {
    // ChatGPT intentionally omits Send while the composer is empty. clickSend() waits
    // for it after prompt insertion, so its idle absence is not a page-health failure.
    required: false,
    candidates: [
      { css: 'button[data-testid="send-button"]' },
      { css: "#composer-submit-button" },
      { css: 'button[aria-label="Send prompt"]' },
      { css: 'button[aria-label="Send"]' },
      { css: 'form[data-type="unified-composer"] button[type="submit"]' },
      { css: "form button", textRe: /^send$/i },
    ],
  },
  stopButton: {
    required: false,
    candidates: [
      { css: 'button[data-testid="stop-button"]' },
      { css: 'button[aria-label="Stop streaming"]' },
      { css: 'button[aria-label="Stop generating"]' },
      { css: 'button[aria-label*="Stop"]' },
    ],
  },
  assistantMessage: {
    required: false,
    candidates: [
      { css: '[data-message-author-role="assistant"][data-message-id]' },
      { css: '[data-message-author-role="assistant"]' },
      { css: '[data-testid^="conversation-turn"][data-turn="assistant"] .agent-turn' },
    ],
  },
  userMessage: {
    required: false,
    candidates: [
      { css: '[data-message-author-role="user"][data-message-id]' },
      { css: '[data-message-author-role="user"]' },
      { css: '[data-testid^="conversation-turn"][data-turn="user"] .user-turn' },
    ],
  },
  conversationRoot: {
    required: true,
    candidates: [{ css: "#thread" }, { css: "main#main" }, { css: "main" }, { css: "body" }],
  },
  regenerateButton: {
    required: false,
    candidates: [
      { css: 'button[data-testid="regenerate-thread-error-button"]' },
      { css: "main button", textRe: /^(regenerate|try again)$/i },
    ],
  },
  loginButton: {
    required: false,
    candidates: [
      { css: '[data-testid="login-button"]' },
      { css: "button, a", textRe: /^log in$/i },
    ],
  },
  pageAlert: {
    required: false,
    candidates: [{ css: '[role="alert"], [class*="toast"]' }],
  },
  toolIndicator: {
    required: false,
    candidates: [{ css: '[data-testid*="tool"]' }],
  },
};

function matches(candidate: Candidate, root: ParentNode): Element[] {
  let found: Element[];
  try {
    found = Array.from(root.querySelectorAll(candidate.css));
  } catch {
    return [];
  }
  if (!candidate.textRe) return found;
  const re = candidate.textRe;
  return found.filter((el) => re.test((el.textContent ?? "").trim()));
}

export interface Resolution {
  element: Element;
  candidateIndex: number;
}

export function resolve(id: TargetId, root: ParentNode = document): Resolution | null {
  const target = REGISTRY[id];
  for (let i = 0; i < target.candidates.length; i++) {
    const candidate = target.candidates[i];
    if (!candidate) continue;
    const found = matches(candidate, root);
    const element = found[0];
    if (element) return { element, candidateIndex: i };
  }
  return null;
}

export function query(id: TargetId, root: ParentNode = document): Element | null {
  return resolve(id, root)?.element ?? null;
}

/** All matches from the first viable candidate, preserving registry fallback order. */
export function queryAll(id: TargetId, root: ParentNode = document): Element[] {
  for (const candidate of REGISTRY[id].candidates) {
    const found = matches(candidate, root);
    if (found.length > 0) return found;
  }
  return [];
}

/** Last match wins — used for "the newest assistant message". */
export function queryLast(id: TargetId, root: ParentNode = document): Element | null {
  const target = REGISTRY[id];
  for (const candidate of target.candidates) {
    const found = matches(candidate, root);
    const last = found[found.length - 1];
    if (last) return last;
  }
  return null;
}

export function require_(id: TargetId, timeoutMs = 10000, pollMs = 200): Promise<Element> {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const attempt = (): void => {
      const el = query(id);
      if (el) {
        resolvePromise(el);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`selector target not found: ${id}`));
        return;
      }
      setTimeout(attempt, pollMs);
    };
    attempt();
  });
}

export interface HealthReport {
  missing: TargetId[];
  degraded: { id: TargetId; candidateIndex: number }[];
}

/** Run at mount, on navigation, and before every send; missing required targets pause the run. */
export function healthCheck(root: ParentNode = document): HealthReport {
  const missing: TargetId[] = [];
  const degraded: HealthReport["degraded"] = [];
  for (const id of Object.keys(REGISTRY) as TargetId[]) {
    const target = REGISTRY[id];
    const res = resolve(id, root);
    if (!res) {
      if (target.required) missing.push(id);
    } else if (res.candidateIndex > 0) {
      degraded.push({ id, candidateIndex: res.candidateIndex });
    }
  }
  return { missing, degraded };
}
