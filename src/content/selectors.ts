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

export type GuideTargetId =
  | "composerPlusButton"
  | "settingsSecurity"
  | "developerModeRow"
  | "developerModeToggle"
  | "pluginSearchInput"
  | "pluginAddButton"
  | "githubMcpPluginResult"
  | "pluginNameInput"
  | "pluginServerUrlOption"
  | "pluginServerInput"
  | "pluginAuthControl"
  | "pluginOauthOption"
  | "pluginRiskCheckbox"
  | "pluginCreateButton"
  | "conversationDeveloperMode"
  | "conversationGitHubMcp";

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

/** Optional, text-aware targets used only by the composer integration and opt-in setup guide. */
const GUIDE_RESOLVERS: Record<GuideTargetId, () => HTMLElement | null> = {
  composerPlusButton,
  settingsSecurity: () => clickableText(/^Security and login$/i),
  developerModeRow,
  developerModeToggle,
  pluginSearchInput,
  pluginAddButton,
  githubMcpPluginResult,
  pluginNameInput,
  pluginServerUrlOption,
  pluginServerInput,
  pluginAuthControl,
  pluginOauthOption,
  pluginRiskCheckbox,
  pluginCreateButton,
  conversationDeveloperMode: () => clickableText(/^Developer mode$/i),
  conversationGitHubMcp: () => clickableText(/^(Chat FreePT GitHub MCP|GitHub MCP)$/i),
};

export function queryGuideTarget(id: GuideTargetId): HTMLElement | null {
  return GUIDE_RESOLVERS[id]();
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
    document.querySelector('form[data-type="unified-composer"]');
  if (!form) return null;
  return textElement(/^\+$/i, form, "button") as HTMLElement | null;
}

function developerModeToggle(): HTMLElement | null {
  const semantic = document.querySelector<HTMLElement>(
    'button[role="switch"][aria-label="Developer mode"], [role="switch"][aria-label="Developer mode"]',
  );
  if (semantic) return semantic;
  return controlNearText(
    /^Developer mode$/i,
    'button[role="switch"], [role="switch"], input[type="checkbox"]',
  );
}

function developerModeRow(): HTMLElement | null {
  const toggle = developerModeToggle();
  if (toggle) {
    let node: HTMLElement | null = toggle;
    for (let depth = 0; node && depth < 7; depth += 1) {
      const text = node.textContent ?? "";
      if (/Allows you to add unverified connectors/i.test(text)) return node;
      node = node.parentElement;
    }
  }

  const label = textElement(/^Developer mode$/i);
  if (!(label instanceof HTMLElement)) return toggle;
  let node: HTMLElement | null = label;
  for (let depth = 0; node && depth < 7; depth += 1) {
    if (toggle && node.contains(toggle)) return node;
    if (node.querySelector('button[role="switch"], [role="switch"], input[type="checkbox"]')) {
      return node;
    }
    node = node.parentElement;
  }
  return label.parentElement ?? label;
}

function pluginSearchInput(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '#plugin-search, input[aria-label="Search plugins"], input[placeholder="Search plugins"]',
  );
}

function pluginAddButton(): HTMLElement | null {
  const labeled = document.querySelector<HTMLElement>(
    'button[aria-label="Create app"], button[aria-label*="Add plugin" i], button[aria-label*="Create plugin" i], button[title*="Add plugin" i]',
  );
  if (labeled) return labeled;
  const plus = textElement(/^\+$/, document, "button");
  if (plus instanceof HTMLElement) return plus;
  const search = pluginSearchInput();
  const container = search?.parentElement?.parentElement;
  const buttons = container ? Array.from(container.querySelectorAll<HTMLElement>("button")) : [];
  return buttons.at(-1) ?? null;
}

function githubMcpPluginResult(): HTMLElement | null {
  const labeled = document.querySelector<HTMLElement>(
    'a[aria-label="Open Chat FreePT GitHub MCP"], button[aria-label="Open Chat FreePT GitHub MCP"]',
  );
  if (labeled) return labeled;
  return clickableText(/^Chat FreePT GitHub MCP$/i);
}

function pluginNameInput(): HTMLElement | null {
  return (document.getElementById("custom-connector-name") ??
    fieldNearLabel(/^(Name|Plugin name)$/i, "input")) as HTMLElement | null;
}

function pluginServerUrlOption(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[role="radio"][aria-label="Server URL"], button[aria-label="Server URL"]',
  );
}

function pluginServerInput(): HTMLElement | null {
  return (document.getElementById("custom-connector-url") ??
    fieldNearLabel(
      /(Server URL|Remote MCP|MCP server URL)/i,
      'input[type="url"], input',
    )) as HTMLElement | null;
}

function pluginAuthControl(): HTMLElement | null {
  return (document.getElementById("custom-connector-auth") ??
    fieldNearLabel(/Authentication/i, 'select, [role="combobox"], button')) as HTMLElement | null;
}

function pluginOauthOption(): HTMLElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"], [role="menuitem"], [role="menuitemradio"], button'),
  );
  const exact = candidates.filter((element) => /^OAuth$/i.test((element.textContent ?? "").trim()));
  exact.sort((a, b) => a.children.length - b.children.length);
  return exact[0] ?? null;
}

function pluginRiskCheckbox(): HTMLElement | null {
  return (document.getElementById("trust-checkbox") ??
    controlNearText(
      /I understand.*continue/i,
      'input[type="checkbox"], [role="checkbox"]',
    )) as HTMLElement | null;
}

function pluginCreateButton(): HTMLElement | null {
  const modal = document.getElementById("modal-create-custom-connector");
  const submit = modal?.querySelector<HTMLElement>('button[type="submit"]');
  return submit ?? clickableText(/^Create$/i);
}

function clickableText(pattern: RegExp): HTMLElement | null {
  const text = textElement(pattern);
  if (!(text instanceof HTMLElement)) return null;
  return (
    text.closest<HTMLElement>(
      'button, a, [role="button"], [role="tab"], [role="menuitem"], [role="option"]',
    ) ?? text
  );
}

function fieldNearLabel(pattern: RegExp, selector: string): HTMLElement | null {
  const label = textElement(pattern, document, "label, span, div, p");
  if (!(label instanceof HTMLElement)) return null;
  if (label instanceof HTMLLabelElement && label.htmlFor) {
    const linked = document.getElementById(label.htmlFor);
    if (linked instanceof HTMLElement) return linked;
  }
  let node: HTMLElement | null = label;
  for (let depth = 0; node && depth < 5; depth += 1) {
    const control = node.querySelector<HTMLElement>(selector);
    if (control) return control;
    node = node.parentElement;
  }
  return null;
}

function controlNearText(pattern: RegExp, selector: string): HTMLElement | null {
  const label = textElement(pattern);
  if (!(label instanceof HTMLElement)) return null;
  let node: HTMLElement | null = label;
  for (let depth = 0; node && depth < 7; depth += 1) {
    const control = node.querySelector<HTMLElement>(selector);
    if (control) return control;
    node = node.parentElement;
  }
  return null;
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
