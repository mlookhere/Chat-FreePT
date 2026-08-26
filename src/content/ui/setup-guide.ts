import { queryGuideTarget, type GuideTargetId } from "../selectors";

export type SetupGuideStep =
  | "security"
  | "developer"
  | "developer-toggle"
  | "plugins"
  | "plugin-search"
  | "plugin-add"
  | "plugin-name"
  | "plugin-server"
  | "plugin-auth"
  | "plugin-risk"
  | "plugin-create"
  | "oauth"
  | "chat-plus"
  | "developer-menu"
  | "github-app"
  | "done";

interface StoredGuide {
  active: boolean;
  step: SetupGuideStep;
  returnUrl: string;
}

interface GuideCopy {
  title: string;
  body: string;
  actions: string;
}

const SESSION_KEY = "cfpt:setup-guide:v2";
const MCP_URL = "https://api.githubcopilot.com/mcp/";
const PLUGINS_URL = "https://chatgpt.com/plugins";
const SEARCH_VALUE = "GitHub MCP";
const SCROLL_RETRY_MS = 150;

const GUIDE_STEPS = new Set<SetupGuideStep>([
  "security",
  "developer",
  "developer-toggle",
  "plugins",
  "plugin-search",
  "plugin-add",
  "plugin-name",
  "plugin-server",
  "plugin-auth",
  "plugin-risk",
  "plugin-create",
  "oauth",
  "chat-plus",
  "developer-menu",
  "github-app",
  "done",
]);

const GUIDE_CSS = `
:host {
  all: initial;
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483647;
  color-scheme: inherit;
  --surface: color-mix(in srgb, Canvas 92%, transparent);
  --text: CanvasText;
  --muted: color-mix(in srgb, CanvasText 65%, transparent);
  --border: color-mix(in srgb, CanvasText 18%, transparent);
  --accent: #10a37f;
}
* { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
.cfpt-guide-hidden { display: none !important; }
.cfpt-guide-ring {
  position: fixed;
  pointer-events: none;
  border: 3px solid var(--accent);
  border-radius: 12px;
  box-shadow: 0 0 0 5px color-mix(in srgb, var(--accent) 18%, transparent), 0 0 0 9999px rgba(0, 0, 0, 0.12);
  transition: left 120ms ease, top 120ms ease, width 120ms ease, height 120ms ease;
}
.cfpt-guide-card {
  position: fixed;
  pointer-events: auto;
  width: min(340px, calc(100vw - 24px));
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 18px 55px rgba(0, 0, 0, 0.26);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  font-size: 13px;
  line-height: 1.45;
}
.cfpt-guide-card strong { display: block; margin-right: 24px; font-size: 14px; }
.cfpt-guide-card p { margin: 7px 0 0; color: var(--muted); }
.cfpt-guide-card code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; overflow-wrap: anywhere; }
.cfpt-guide-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 11px; }
.cfpt-guide-btn {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 7px 11px;
  background: color-mix(in srgb, CanvasText 7%, transparent);
  color: var(--text);
  cursor: pointer;
  font: inherit;
  font-weight: 600;
}
.cfpt-guide-btn-primary { background: var(--accent); color: white; border-color: transparent; }
.cfpt-guide-close {
  position: absolute;
  inset-inline-end: 8px;
  top: 7px;
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 19px;
}
.cfpt-guide-close:hover { background: color-mix(in srgb, CanvasText 8%, transparent); color: var(--text); }
@media (prefers-reduced-motion: reduce) { .cfpt-guide-ring { transition: none; } }
`;

const TARGETS: Partial<Record<SetupGuideStep, GuideTargetId>> = {
  security: "settingsSecurity",
  developer: "developerModeRow",
  "developer-toggle": "developerModeToggle",
  "plugin-search": "pluginSearchInput",
  "plugin-add": "pluginAddButton",
  "plugin-name": "pluginNameInput",
  "plugin-server": "pluginServerInput",
  "plugin-auth": "pluginAuthControl",
  "plugin-risk": "pluginRiskCheckbox",
  "plugin-create": "pluginCreateButton",
  "chat-plus": "composerPlusButton",
  "developer-menu": "conversationDeveloperMode",
  "github-app": "conversationGitHubMcp",
};

const EARLY_COPY_STEPS = new Set<SetupGuideStep>([
  "security",
  "developer",
  "developer-toggle",
  "plugins",
  "plugin-search",
  "plugin-add",
  "plugin-name",
  "plugin-server",
  "plugin-auth",
]);

export class SetupGuide {
  private readonly host: HTMLDivElement;
  private readonly shadow: ShadowRoot;
  private readonly ring: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private readonly observer: MutationObserver;
  private active = false;
  private step: SetupGuideStep = "security";
  private returnUrl = "https://chatgpt.com/";
  private lastScrolledStep: SetupGuideStep | null = null;
  private lastScrollAttemptAt = 0;
  private disposed = false;

  constructor() {
    this.host = document.createElement("div");
    this.host.id = "cfpt-setup-guide-root";
    this.shadow = this.host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = GUIDE_CSS;
    this.shadow.appendChild(style);

    this.ring = document.createElement("div");
    this.ring.className = "cfpt-guide-ring cfpt-guide-hidden";
    this.shadow.appendChild(this.ring);

    this.card = document.createElement("div");
    this.card.className = "cfpt-guide-card cfpt-guide-hidden";
    this.card.setAttribute("role", "dialog");
    this.card.setAttribute("aria-live", "polite");
    this.shadow.appendChild(this.card);

    document.body.appendChild(this.host);
    this.shadow.addEventListener("click", (event) => this.onGuideClick(event));
    document.addEventListener("click", this.onPageClick, true);
    window.addEventListener("resize", this.onViewportChange);
    window.addEventListener("scroll", this.onViewportChange, true);
    this.observer = new MutationObserver(() => this.render());
    this.observer.observe(document.documentElement, { childList: true, subtree: true });
    this.restore();
  }

  async start(): Promise<void> {
    this.active = true;
    this.step = "security";
    this.returnUrl = chatReturnUrl();
    this.resetScrollTracking();
    this.persist();
    this.render();
    openSettings();
  }

  async cancel(): Promise<void> {
    this.active = false;
    this.hide();
    this.persist();
  }

  dispose(): void {
    this.disposed = true;
    this.observer.disconnect();
    document.removeEventListener("click", this.onPageClick, true);
    window.removeEventListener("resize", this.onViewportChange);
    window.removeEventListener("scroll", this.onViewportChange, true);
    this.host.remove();
  }

  private readonly onViewportChange = (): void => this.render();

  private readonly onPageClick = (event: Event): void => {
    if (!this.active) return;
    const target = this.currentTarget();
    const clicked = event.target instanceof Node ? event.target : null;
    if (!target || !clicked || !target.contains(clicked)) return;
    this.afterTargetClick(target);
  };

  private restore(): void {
    try {
      const raw = window.sessionStorage.getItem(SESSION_KEY);
      const value = raw ? (JSON.parse(raw) as Partial<StoredGuide>) : undefined;
      if (value?.active === true && isGuideStep(value.step)) {
        this.active = true;
        this.step = value.step;
        this.returnUrl = typeof value.returnUrl === "string" ? value.returnUrl : chatReturnUrl();
      }
    } catch {
      this.active = false;
    }
    if (!this.disposed) this.render();
  }

  private persist(): void {
    try {
      const value: StoredGuide = {
        active: this.active,
        step: this.step,
        returnUrl: this.returnUrl,
      };
      window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(value));
    } catch {
      // The guide remains usable for the current page even if tab-session persistence fails.
    }
  }

  private currentTarget(): HTMLElement | null {
    if (this.step === "developer-menu") {
      return (
        queryGuideTarget("conversationDeveloperMode") ?? queryGuideTarget("conversationGitHubMcp")
      );
    }
    const id = TARGETS[this.step];
    return id ? queryGuideTarget(id) : null;
  }

  private render(): void {
    if (!this.active || this.disposed) {
      this.hide();
      return;
    }
    if (this.advanceCompletedStep()) return;

    const target = this.currentTarget();
    const targetReady = target ? this.ensureTargetVisible(target) : false;
    if (target && targetReady) this.positionRing(target);
    else this.ring.classList.add("cfpt-guide-hidden");

    this.card.innerHTML = this.cardHtml(Boolean(target));
    this.card.classList.remove("cfpt-guide-hidden");
    this.positionCard(targetReady ? target : null);
  }

  private advanceCompletedStep(): boolean {
    return this.advanceSettingsStep() || this.advancePluginStep();
  }

  private advanceSettingsStep(): boolean {
    const toggle = queryGuideTarget("developerModeToggle");
    if (this.step === "security" && toggle) {
      void this.setStep("developer");
      return true;
    }
    if ((this.step === "developer" || this.step === "developer-toggle") && toggle) {
      if (isControlEnabled(toggle)) {
        void this.setStep("plugins");
        return true;
      }
    }
    return false;
  }

  private advancePluginStep(): boolean {
    if (this.existingPluginCompletesCreation()) return true;
    return this.advancePluginFormStep();
  }

  private existingPluginCompletesCreation(): boolean {
    if (this.step !== "plugin-search" && this.step !== "plugin-add") return false;
    if (!queryGuideTarget("githubMcpPluginResult")) return false;
    this.returnToChat();
    return true;
  }

  private advancePluginFormStep(): boolean {
    switch (this.step) {
      case "plugin-search":
        return this.advanceWhenFieldMatches("pluginSearchInput", SEARCH_VALUE, "plugin-add");
      case "plugin-name":
        return this.advanceWhenFieldMatches("pluginNameInput", SEARCH_VALUE, "plugin-server");
      case "plugin-server":
        return this.advanceWhenFieldMatches("pluginServerInput", MCP_URL, "plugin-auth", true);
      case "plugin-auth": {
        const auth = queryGuideTarget("pluginAuthControl");
        if (!controlValue(auth).includes("oauth")) return false;
        void this.setStep("plugin-risk");
        return true;
      }
      case "plugin-risk": {
        const risk = queryGuideTarget("pluginRiskCheckbox");
        if (!risk || !isControlEnabled(risk)) return false;
        void this.setStep("plugin-create");
        return true;
      }
      default:
        return false;
    }
  }

  private advanceWhenFieldMatches(
    id: GuideTargetId,
    expected: string,
    next: SetupGuideStep,
    ignoreTrailingSlash = false,
  ): boolean {
    let actual = fieldValue(queryGuideTarget(id)).trim();
    let target = expected;
    if (ignoreTrailingSlash) {
      actual = actual.replace(/\/$/, "");
      target = target.replace(/\/$/, "");
    }
    if (actual.toLowerCase() !== target.toLowerCase()) return false;
    void this.setStep(next);
    return true;
  }

  private hide(): void {
    this.ring.classList.add("cfpt-guide-hidden");
    this.card.classList.add("cfpt-guide-hidden");
  }

  private positionRing(target: HTMLElement): void {
    const rect = target.getBoundingClientRect();
    const pad = 5;
    Object.assign(this.ring.style, {
      left: `${Math.max(4, rect.left - pad)}px`,
      top: `${Math.max(4, rect.top - pad)}px`,
      width: `${Math.max(24, rect.width + pad * 2)}px`,
      height: `${Math.max(24, rect.height + pad * 2)}px`,
    });
    this.ring.classList.remove("cfpt-guide-hidden");
  }

  private positionCard(target: HTMLElement | null): void {
    if (!target) {
      Object.assign(this.card.style, {
        left: "auto",
        right: "18px",
        top: "auto",
        bottom: "18px",
      });
      return;
    }

    const rect = target.getBoundingClientRect();
    const width = Math.min(340, window.innerWidth - 24);
    const left = Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - width - 12));
    const roomBelow = window.innerHeight - rect.bottom;
    const top = roomBelow > 210 ? rect.bottom + 12 : Math.max(12, rect.top - 190);
    Object.assign(this.card.style, {
      left: `${left}px`,
      right: "auto",
      top: `${top}px`,
      bottom: "auto",
    });
  }

  private ensureTargetVisible(target: HTMLElement): boolean {
    if (this.step !== "developer" && this.step !== "developer-toggle") return true;
    if (this.lastScrolledStep === this.step) return true;

    const container = settingsScrollContainer(target);
    if (isVisibleWithin(target, container)) {
      this.lastScrolledStep = this.step;
      return true;
    }

    const now = Date.now();
    if (now - this.lastScrollAttemptAt < SCROLL_RETRY_MS) return false;
    this.lastScrollAttemptAt = now;

    if (container) centerInScrollContainer(target, container);
    else if (typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ behavior: "auto", block: "center", inline: "nearest" });
    }
    requestAnimationFrame(() => this.render());
    return false;
  }

  private afterTargetClick(target: HTMLElement): void {
    switch (this.step) {
      case "security":
        this.deferStep("developer");
        break;
      case "developer-toggle":
        setTimeout(() => {
          if (isControlEnabled(target)) void this.setStep("plugins");
        }, 120);
        break;
      case "plugin-add":
        this.deferStep("plugin-name");
        break;
      case "plugin-risk":
        setTimeout(() => {
          if (isControlEnabled(target)) void this.setStep("plugin-create");
        }, 80);
        break;
      case "plugin-create":
        this.deferStep("oauth");
        break;
      case "chat-plus":
        this.deferStep("developer-menu");
        break;
      case "developer-menu":
        if (target === queryGuideTarget("conversationGitHubMcp")) this.deferStep("done");
        else this.deferStep("github-app");
        break;
      case "github-app":
        this.deferStep("done");
        break;
    }
  }

  private deferStep(step: SetupGuideStep): void {
    setTimeout(() => void this.setStep(step), 80);
  }

  private async setStep(step: SetupGuideStep): Promise<void> {
    this.step = step;
    this.resetScrollTracking();
    this.persist();
    this.render();
  }

  private resetScrollTracking(): void {
    this.lastScrolledStep = null;
    this.lastScrollAttemptAt = 0;
  }

  private onGuideClick(event: Event): void {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-guide-action]");
    if (!target) return;
    event.stopPropagation();
    const action = target.dataset["guideAction"];
    if (action === "cancel") void this.cancel();
    else if (action === "developer-next") void this.setStep("developer-toggle");
    else if (action === "open-plugins") this.openPlugins();
    else if (action === "search-plugin") this.searchForPlugin();
    else if (action === "fill-name") {
      this.fillField("pluginNameInput", SEARCH_VALUE, "plugin-server");
    } else if (action === "fill-url") {
      this.fillField("pluginServerInput", MCP_URL, "plugin-auth");
    } else if (action === "auth-next") void this.setStep("plugin-risk");
    else if (action === "risk-next") this.advanceRisk();
    else if (action === "return-chat") this.returnToChat();
    else if (action === "finish") void this.finish();
  }

  private openPlugins(): void {
    void this.setStep("plugin-search").then(() => navigate(PLUGINS_URL));
  }

  private searchForPlugin(): void {
    const search = queryGuideTarget("pluginSearchInput");
    if (!(search instanceof HTMLInputElement || search instanceof HTMLTextAreaElement)) return;
    setNativeValue(search, SEARCH_VALUE);
    setTimeout(() => void this.setStep("plugin-add"), 250);
  }

  private fillField(id: GuideTargetId, value: string, next: SetupGuideStep): void {
    const field = queryGuideTarget(id);
    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) return;
    setNativeValue(field, value);
    void this.setStep(next);
  }

  private advanceRisk(): void {
    const checkbox = queryGuideTarget("pluginRiskCheckbox");
    if (checkbox && isControlEnabled(checkbox)) void this.setStep("plugin-create");
  }

  private returnToChat(): void {
    void this.setStep("chat-plus").then(() => navigate(this.returnUrl));
  }

  private async finish(): Promise<void> {
    this.step = "done";
    this.active = false;
    this.persist();
    this.hide();
  }

  private cardHtml(found: boolean): string {
    const content = guideCopy(this.step, found);
    return `
      <button class="cfpt-guide-close" type="button" data-guide-action="cancel" aria-label="Stop setup guide">×</button>
      <strong>${content.title}</strong>
      <p>${content.body}</p>
      ${content.actions}
    `;
  }
}

function guideCopy(step: SetupGuideStep, found: boolean): GuideCopy {
  const wait = found ? "" : " I’m waiting for this ChatGPT control to appear.";
  return EARLY_COPY_STEPS.has(step) ? guideCopyEarly(step, wait) : guideCopyLate(step, wait);
}

function guideCopyEarly(step: SetupGuideStep, wait: string): GuideCopy {
  switch (step) {
    case "security":
      return copy(
        "1 · Security and login",
        `Click the highlighted <b>Security and login</b> item.${wait}`,
      );
    case "developer":
      return copy(
        "2 · Developer mode",
        `Developer mode is lower on this page. I’ll bring the row into the Settings viewport before highlighting it.${wait}`,
        primary("developer-next", "Show the switch"),
      );
    case "developer-toggle":
      return copy(
        "3 · Enable Developer mode",
        `Turn on the highlighted <b>Developer mode</b> switch. If it is already on, the guide skips this step automatically.${wait}`,
      );
    case "plugins":
      return copy(
        "4 · Open Plugins",
        "Developer mode is ready. Continue to ChatGPT Plugins; the guide checks for an existing GitHub MCP before asking you to create one.",
        primary("open-plugins", "Open Plugins"),
      );
    case "plugin-search":
      return copy(
        "5 · Check for GitHub MCP",
        `Search for <b>${SEARCH_VALUE}</b>. If your developer app already exists, the guide will reuse it.${wait}`,
        primary("search-plugin", "Search GitHub MCP"),
      );
    case "plugin-add":
      return copy(
        "6 · Create the app",
        `No existing <b>GitHub MCP</b> app was found. Click the highlighted <b>Create app</b> button.${wait}`,
      );
    case "plugin-name":
      return copy(
        "7 · Name",
        `Use <b>${SEARCH_VALUE}</b> so it is easy to recognize later.${wait}`,
        primary("fill-name", `Use ${SEARCH_VALUE}`),
      );
    case "plugin-server":
      return copy(
        "8 · Server URL",
        `Put <code>${MCP_URL}</code> in the highlighted Server URL field.${wait}`,
        primary("fill-url", "Fill server URL"),
      );
    case "plugin-auth":
      return copy(
        "9 · Authentication",
        `Set Authentication to <b>OAuth</b> in the highlighted control.${wait}`,
        primary("auth-next", "OAuth selected — next"),
      );
    default:
      return guideCopyLate(step, wait);
  }
}

function guideCopyLate(step: SetupGuideStep, wait: string): GuideCopy {
  switch (step) {
    case "plugin-risk":
      return copy(
        "10 · Risk acknowledgement",
        `Read the warning, then check the highlighted acknowledgement.${wait}`,
        primary("risk-next", "Checked — next"),
      );
    case "plugin-create":
      return copy("11 · Create", `Click the highlighted <b>Create</b> button.${wait}`);
    case "oauth":
      return copy(
        "12 · Complete GitHub OAuth",
        "Finish the GitHub authorization ChatGPT opens. Approve the repository and workflow write permissions you intend Chat FreePT to use, then return here.",
        primary("return-chat", "Connected — return to chat"),
      );
    case "chat-plus":
      return copy(
        "13 · Add it to this chat",
        `Click the highlighted <b>+</b> beside the composer.${wait}`,
      );
    case "developer-menu":
      return copy(
        "14 · Developer mode",
        `Choose the highlighted <b>Developer mode</b> entry. If GitHub MCP appears directly, choose it instead.${wait}`,
      );
    case "github-app":
      return copy(
        "15 · GitHub MCP",
        `Choose the highlighted <b>GitHub MCP</b> plugin for this conversation.${wait}`,
      );
    case "done":
      return copy(
        "Setup complete",
        "Chat FreePT can now run its GitHub capability preflight in this conversation.",
        primary("finish", "Done"),
      );
    default:
      return copy("Setup", `Continue with the highlighted ChatGPT control.${wait}`);
  }
}

function copy(title: string, body: string, actions = ""): GuideCopy {
  return {
    title,
    body,
    actions: actions ? `<div class="cfpt-guide-actions">${actions}</div>` : "",
  };
}

function primary(action: string, label: string): string {
  return `<button class="cfpt-guide-btn cfpt-guide-btn-primary" type="button" data-guide-action="${action}">${label}</button>`;
}

function isGuideStep(value: unknown): value is SetupGuideStep {
  return typeof value === "string" && GUIDE_STEPS.has(value as SetupGuideStep);
}

function isControlEnabled(element: HTMLElement): boolean {
  if (element instanceof HTMLInputElement) return element.checked;
  return (
    element.getAttribute("aria-checked") === "true" ||
    element.getAttribute("data-state") === "checked"
  );
}

function fieldValue(element: HTMLElement | null): string {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.value;
  }
  return "";
}

function controlValue(element: HTMLElement | null): string {
  if (!element) return "";
  if (element instanceof HTMLSelectElement || element instanceof HTMLInputElement) {
    return element.value.toLowerCase();
  }
  return `${element.getAttribute("data-value") ?? ""} ${element.textContent ?? ""}`.toLowerCase();
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function settingsScrollContainer(target: HTMLElement): HTMLElement | null {
  let node = target.parentElement;
  while (node && node !== document.body) {
    const style = getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }

  const modal = target.closest<HTMLElement>("#modal-settings") ?? document.getElementById("modal-settings");
  return modal?.querySelector<HTMLElement>('[class*="overflow-y-auto"]') ?? null;
}

function isVisibleWithin(target: HTMLElement, container: HTMLElement | null): boolean {
  const targetRect = target.getBoundingClientRect();
  const boundary = container?.getBoundingClientRect();
  const top = boundary && boundary.height > 0 ? boundary.top : 0;
  const bottom = boundary && boundary.height > 0 ? boundary.bottom : window.innerHeight;
  return targetRect.bottom > top + 8 && targetRect.top < bottom - 8;
}

function centerInScrollContainer(target: HTMLElement, container: HTMLElement): void {
  const targetRect = target.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const height = container.clientHeight || containerRect.height;
  const offset = targetRect.top - containerRect.top - Math.max(0, (height - targetRect.height) / 2);
  container.scrollTop += offset;
}

function chatReturnUrl(): string {
  const current = window.location.href;
  if (current.includes("/plugins") || current.includes("#settings")) return "https://chatgpt.com/";
  return current;
}

function openSettings(): void {
  if (window.location.origin === "https://chatgpt.com") {
    window.location.hash = "#settings";
    return;
  }
  navigate("https://chatgpt.com/#settings");
}

function navigate(url: string): void {
  try {
    window.location.assign(url);
  } catch {
    // JSDOM/test environments do not implement navigation; tab-session state still survives.
  }
}
