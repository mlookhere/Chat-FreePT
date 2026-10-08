/**
 * The single owner of every selector pointed at chatgpt.com. Nothing else in the
 * extension may query the host page directly: the page's DOM is not ours, it changes
 * without notice, and when it does this registry is the one place to fix.
 */

export type TargetId =
  | "composer"
  | "composerHeader"
  | "composerSurface"
  | "composerForm"
  | "sendButton"
  | "stopButton"
  | "assistantMessage"
  | "userMessage"
  | "conversationRoot"
  | "regenerateButton"
  | "loginButton"
  | "pageAlert"
  | "toolIndicator";

export type GuideTargetId =
  | "composerPlusButton"
  | "githubPermissionPrompt"
  | "githubPermissionContinueButton";

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
      { css: '[data-chatgpt-composer] [data-composer-input] [role="textbox"]' },
      { css: 'form[data-chatgpt-composer] [role="textbox"]' },
      { css: "#prompt-textarea" },
      { css: '[data-chatgpt-composer] [data-composer-input] [contenteditable="true"]' },
      { css: 'form[data-chatgpt-composer] [contenteditable="true"]' },
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
      { css: "[data-chatgpt-composer] [data-composer-body]" },
      { css: "form[data-chatgpt-composer] [data-composer-body]" },
      { css: "[data-composer-body]" },
      { css: '#thread-bottom form[data-type="unified-composer"] [data-composer-surface="true"]' },
      { css: 'form[data-type="unified-composer"] [data-composer-surface="true"]' },
      { css: '[data-composer-surface="true"]' },
      { css: "form[data-chatgpt-composer]" },
      { css: 'form[data-type="unified-composer"]' },
    ],
  },
  composerForm: {
    required: false,
    candidates: [
      { css: "form[data-chatgpt-composer]" },
      { css: 'form[data-type="unified-composer"]' },
      { css: "#thread-bottom form" },
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
      { css: '[data-chatgpt-composer] button[type="submit"]' },
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
      // Keep broad label fallbacks inside the composer so unrelated page controls cannot match.
      { css: '#thread-bottom form button[aria-label*="Stop"]' },
      { css: 'form[data-chatgpt-composer] button[aria-label*="Stop"]' },
      { css: 'form[data-type="unified-composer"] button[aria-label*="Stop"]' },
    ],
  },
  assistantMessage: {
    required: false,
    candidates: [
      { css: '[data-message-author-role="assistant"][data-message-id]' },
      { css: '[data-message-author-role="assistant"]' },
      { css: '[data-testid^="conversation-turn"][data-turn="assistant"] .agent-turn' },
      { css: '[data-testid^="conversation-turn"][data-turn="assistant"]' },
    ],
  },
  userMessage: {
    required: false,
    candidates: [
      { css: '[data-message-author-role="user"][data-message-id]' },
      { css: '[data-message-author-role="user"]' },
      { css: '[data-testid^="conversation-turn"][data-turn="user"] .user-turn' },
      { css: '[data-testid^="conversation-turn"][data-turn="user"]' },
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

/** Optional, text-aware targets used only by the composer integration and opt-in setup guide. */
const GUIDE_RESOLVERS: Record<GuideTargetId, () => HTMLElement | null> = {
  composerPlusButton,
  githubPermissionPrompt,
  githubPermissionContinueButton,
};

export function queryGuideTarget(id: GuideTargetId): HTMLElement | null {
  return GUIDE_RESOLVERS[id]();
}

function githubPermissionPrompt(): HTMLElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="dialog"], [role="alertdialog"], [role="alert"], [data-state="open"]',
    ),
  );
  return (
    candidates.find((element) => {
      if (!isVisible(element)) return false;
      const text = (element.innerText ?? element.textContent ?? "").replace(/\s+/g, " ").trim();
      return (
        /github/i.test(text) &&
        /(freept|mcp|connector|allow|permission|access)/i.test(text) &&
        /continue/i.test(text)
      );
    }) ?? null
  );
}

function githubPermissionContinueButton(): HTMLElement | null {
  const prompt = githubPermissionPrompt();
  if (!prompt) return null;
  const button = textElement(/^continue$/i, prompt, 'button, [role="button"]');
  return button instanceof HTMLElement && isVisible(button) ? button : null;
}

function isVisible(element: HTMLElement): boolean {
  if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

function composerPlusButton(): HTMLElement | null {
  const selectors = [
    'button[data-testid="composer-plus-btn"]',
    'button[aria-label*="Add photos" i]',
    'button[aria-label*="Add files" i]',
    'button[aria-label*="Attach" i]',
    'button[aria-label*="Upload" i]',
  ];
  for (const css of selectors) {
    const found = document.querySelector<HTMLElement>(css);
    if (found) return found;
  }
  const form =
    query("composerSurface")?.closest("form") ??
    document.querySelector("form[data-chatgpt-composer]") ??
    document.querySelector('form[data-type="unified-composer"]');
  if (!form) return null;
  return textElement(/^\+$/i, form, "button") as HTMLElement | null;
}

function textElement(
  pattern: RegExp,
  root: ParentNode = document,
  css = "button, a, label, h1, h2, h3, h4, strong, span, div, p",
): Element | null {
  let nodes: Element[];
  try {
    nodes = Array.from(root.querySelectorAll(css));
  } catch {
    return null;
  }
  const matches = nodes.filter((element) => {
    if (element.getAttribute("aria-hidden") === "true") return false;
    return pattern.test((element.textContent ?? "").trim());
  });
  matches.sort(
    (a, b) =>
      a.children.length - b.children.length ||
      (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0),
  );
  return matches[0] ?? null;
}
