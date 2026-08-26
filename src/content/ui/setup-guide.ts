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

const SESSION_KEY = "cfpt:setup-guide:v4";
const MCP_URL = "https://api.githubcopilot.com/mcp/x/all";
const PLUGINS_URL = "https://chatgpt.com/plugins";
const APP_NAME = "Chat FreePT GitHub MCP";
const SCROLL_RETRY_MS = 150;
const SEARCH_SETTLE_MS = 800;

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
  width: min(350px, calc(100vw - 24px));
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
};

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
  private autoActionStep: SetupGuideStep | null = null;
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
    this.resetStepTracking();
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
    if (!this.active || this.step !== "plugin-risk") return;
    const target = this.currentTarget();
    const clicked = event.target instanceof Node ? event.target : null;
    if (!target || !clicked || !target.contains(clicked)) return;
    setTimeout(() => {
      if (isControlEnabled(target)) void this.setStep("plugin-create");
    }, 80);
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
    if (this.step === "security") return this.advanceSecurity();
    if (this.step === "developer") return this.advanceDeveloperRow();
    if (this.step === "developer-toggle") return this.advanceDeveloperToggle();
    return false;
  }

  private advanceSecurity(): boolean {
    const toggle = queryGuideTarget("developerModeToggle");
    if (toggle) {
      void this.setStep("developer-toggle");
      return true;
    }
    const security = queryGuideTarget("settingsSecurity");
    if (!security) return false;
    this.runOnce("security", () => {
      security.click();
      setTimeout(() => {
        if (this.step === "security") void this.setStep("developer");
      }, 120);
    });
    return false;
  }

  private advanceDeveloperRow(): boolean {
    const toggle = queryGuideTarget("developerModeToggle");
    if (!toggle) return false;
    void this.setStep("developer-toggle");
    return true;
  }

  private advanceDeveloperToggle(): boolean {
    const toggle = queryGuideTarget("developerModeToggle");
    if (!toggle) return false;
    if (isControlEnabled(toggle)) {
      this.openPlugins();
      return true;
    }
    this.runOnce("developer-toggle", () => {
      toggle.click();
      setTimeout(() => this.render(), 180);
    });
    return false;
  }

  private advancePluginStep(): boolean {
    if (this.existingPluginCompletesSetup()) return true;
    switch (this.step) {
      case "plugins":
        this.runOnce("plugins", () => this.openPlugins());
        return false;
      case "plugin-search":
        return this.autoSearchForPlugin();
      case "plugin-add":
        return this.autoOpenCreateForm();
      case "plugin-name":
        return this.autoFillName();
      case "plugin-server":
        return this.autoFillServer();
      case "plugin-auth":
        return this.autoSelectOauth();
      case "plugin-risk":
        return this.advanceRiskApproval();
      case "plugin-create":
        return this.autoCreateAfterApproval();
      default:
        return false;
    }
  }

  private advanceRiskApproval(): boolean {
    const risk = queryGuideTarget("pluginRiskCheckbox");
    if (!risk || !isControlEnabled(risk)) return false;
    void this.setStep("plugin-create");
    return true;
  }

  private existingPluginCompletesSetup(): boolean {
    if (!new Set<SetupGuideStep>(["plugin-search", "plugin-add", "oauth"]).has(this.step)) {
      return false;
    }
    if (!queryGuideTarget("githubMcpPluginResult")) return false;
    this.returnToChat();
    return true;
  }

  private autoSearchForPlugin(): boolean {
    const search = queryGuideTarget("pluginSearchInput");
    if (!(search instanceof HTMLInputElement || search instanceof HTMLTextAreaElement)) {
      return false;
    }
    if (fieldValue(search).trim().toLowerCase() !== APP_NAME.toLowerCase()) {
      setNativeValue(search, APP_NAME);
    }
    this.runOnce("plugin-search", () => {
      setTimeout(() => {
        if (this.step === "plugin-search") void this.setStep("plugin-add");
      }, SEARCH_SETTLE_MS);
    });
    return false;
  }

  private autoOpenCreateForm(): boolean {
    const create = queryGuideTarget("pluginAddButton");
    if (!create) return false;
    this.runOnce("plugin-add", () => {
      create.click();
      setTimeout(() => {
        if (this.step === "plugin-add") void this.setStep("plugin-name");
      }, 120);
    });
    return false;
  }

  private autoFillName(): boolean {
    const input = queryGuideTarget("pluginNameInput");
    if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return false;
    if (fieldValue(input).trim() !== APP_NAME) setNativeValue(input, APP_NAME);
    void this.setStep("plugin-server");
    return true;
  }

  private autoFillServer(): boolean {
    const option = queryGuideTarget("pluginServerUrlOption");
    if (option && !isControlEnabled(option)) {
      this.runOnce("plugin-server", () => {
        option.click();
        setTimeout(() => this.render(), 100);
      });
      return false;
    }
    const input = queryGuideTarget("pluginServerInput");
    if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return false;
    if (!sameUrl(fieldValue(input), MCP_URL)) setNativeValue(input, MCP_URL);
    void this.setStep("plugin-auth");
    return true;
  }

  private autoSelectOauth(): boolean {
    const auth = queryGuideTarget("pluginAuthControl");
    if (!auth) return false;
    if (auth instanceof HTMLSelectElement) {
      if (auth.value.toUpperCase() !== "OAUTH") setNativeSelectValue(auth, "OAUTH");
      void this.setStep("plugin-risk");
      return true;
    }
    if (controlValue(auth).includes("oauth")) {
      void this.setStep("plugin-risk");
      return true;
    }
    this.runOnce("plugin-auth", () => {
      auth.click();
      setTimeout(() => {
        const oauth = queryGuideTarget("pluginOauthOption");
        if (oauth && oauth !== auth) oauth.click();
        setTimeout(() => this.render(), 80);
      }, 80);
    });
    return false;
  }

  private autoCreateAfterApproval(): boolean {
    const create = queryGuideTarget("pluginCreateButton");
    if (!create || isDisabled(create)) return false;
    this.runOnce("plugin-create", () => {
      create.click();
      setTimeout(() => {
        if (this.step === "plugin-create") void this.setStep("oauth");
      }, 120);
    });
    return false;
  }

  private runOnce(step: SetupGuideStep, action: () => void): void {
    if (this.autoActionStep === step) return;
    this.autoActionStep = step;
    action();
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
    const width = Math.min(350, window.innerWidth - 24);
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

  private async setStep(step: SetupGuideStep): Promise<void> {
    this.step = step;
    this.resetStepTracking();
    this.persist();
    this.render();
  }

  private resetStepTracking(): void {
    this.lastScrolledStep = null;
    this.lastScrollAttemptAt = 0;
    this.autoActionStep = null;
  }

  private onGuideClick(event: Event): void {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-guide-action]");
    if (!target) return;
    event.stopPropagation();
    const action = target.dataset["guideAction"];
    if (action === "cancel") void this.cancel();
    else if (action === "return-chat") this.returnToChat();
    else if (action === "finish") void this.finish();
  }

  private openPlugins(): void {
    void this.setStep("plugin-search").then(() => navigate(PLUGINS_URL));
  }

  private returnToChat(): void {
    void this.setStep("done").then(() => navigate(this.returnUrl));
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
  switch (step) {
    case "security":
      return copy(
        "1 · Opening Security and login",
        `I’m opening <b>Security and login</b> for you.${wait}`,
      );
    case "developer":
      return copy(
        "2 · Finding Developer mode",
        `Developer mode is lower on this page. I’ll bring it into view automatically.${wait}`,
      );
    case "developer-toggle":
      return copy(
        "3 · Enabling Developer mode",
        `I’m turning on the highlighted <b>Developer mode</b> switch. If ChatGPT opens an additional warning or confirmation, you must approve that prompt yourself.${wait}`,
      );
    case "plugins":
      return copy(
        "4 · Opening Plugins",
        "Developer mode is ready. I’m opening Plugins automatically.",
      );
    case "plugin-search":
      return copy(
        "5 · Checking Chat FreePT GitHub MCP",
        `I’m searching for an existing exact <b>${APP_NAME}</b> custom app before creating anything.${wait}`,
      );
    case "plugin-add":
      return copy(
        "6 · Opening custom app setup",
        `No existing <b>${APP_NAME}</b> was found. I’m opening ChatGPT’s Create app form.${wait}`,
      );
    case "plugin-name":
      return copy("7 · Preparing app name", `I’m filling <b>${APP_NAME}</b>.${wait}`);
    case "plugin-server":
      return copy(
        "8 · Preparing full GitHub toolset",
        `I’m selecting Server URL and filling <code>${MCP_URL}</code>, GitHub’s remote all-toolsets endpoint.${wait}`,
      );
    case "plugin-auth":
      return copy(
        "9 · Preparing OAuth",
        `I’m selecting <b>OAuth</b> in ChatGPT’s Authentication field.${wait}`,
      );
    case "plugin-risk":
      return copy(
        "10 · Your approval required",
        `ChatGPT requires you to read and check the highlighted <b>I understand and want to continue</b> acknowledgement. Chat FreePT will never approve this risk disclosure for you. Once you check it, I’ll press Create automatically.${wait}`,
      );
    case "plugin-create":
      return copy(
        "11 · Creating the custom MCP",
        `Your risk acknowledgement is complete. I’m pressing <b>Create</b> and continuing to GitHub OAuth automatically.${wait}`,
      );
    case "oauth":
      return copy(
        "12 · Finish GitHub OAuth",
        "GitHub authorization is the remaining external consent step. Complete OAuth and approve only the access you intend to grant. When ChatGPT shows the custom app afterward, I’ll return to your original chat automatically; use the button below only if the host does not refresh on its own.",
        primary("return-chat", "OAuth finished — return to chat"),
      );
    case "done":
      return copy(
        "Setup complete",
        "You’re back in the conversation. Chat FreePT’s next GitHub preflight will inspect the tools actually exposed by the custom MCP and stop with NEEDS_INPUT if any required repository, Issue, label, PR, Git or Actions capability is still missing.",
        primary("finish", "Done"),
      );
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
    element.getAttribute("data-state") === "checked" ||
    element.getAttribute("data-state") === "on"
  );
}

function isDisabled(element: HTMLElement): boolean {
  if (element instanceof HTMLButtonElement) return element.disabled;
  return element.getAttribute("aria-disabled") === "true";
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
    const selectedText =
      element instanceof HTMLSelectElement ? (element.selectedOptions[0]?.textContent ?? "") : "";
    return `${element.value} ${selectedText}`.toLowerCase();
  }
  return `${element.getAttribute("data-value") ?? ""} ${element.textContent ?? ""}`.toLowerCase();
}

function sameUrl(left: string, right: string): boolean {
  return left.trim().replace(/\/$/, "").toLowerCase() === right.replace(/\/$/, "").toLowerCase();
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    element instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
  dispatchFieldEvents(element);
}

function setNativeSelectValue(element: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
  dispatchFieldEvents(element);
}

function dispatchFieldEvents(element: HTMLElement): void {
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

  const modal =
    target.closest<HTMLElement>("#modal-settings") ?? document.getElementById("modal-settings");
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
