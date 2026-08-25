import { queryGuideTarget, type GuideTargetId } from "../selectors";

export type SetupGuideStep =
  | "security"
  | "developer"
  | "developer-toggle"
  | "plugins"
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

const STORAGE_KEY = "cfpt:setup-guide:v1";
const MCP_URL = "https://api.githubcopilot.com/mcp/";
const PLUGINS_URL = "https://chatgpt.com/plugins";

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
    void this.restore();
  }

  async start(): Promise<void> {
    this.active = true;
    this.step = "security";
    this.returnUrl = chatReturnUrl();
    this.lastScrolledStep = null;
    await this.persist();
    this.render();
    openSettings();
  }

  async cancel(): Promise<void> {
    this.active = false;
    this.hide();
    await this.persist();
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

  private async restore(): Promise<void> {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const value = stored[STORAGE_KEY] as Partial<StoredGuide> | undefined;
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

  private async persist(): Promise<void> {
    try {
      const value: StoredGuide = {
        active: this.active,
        step: this.step,
        returnUrl: this.returnUrl,
      };
      await chrome.storage.local.set({ [STORAGE_KEY]: value });
    } catch {
      // The guide remains usable for the current page even if persistence is unavailable.
    }
  }

  private currentTarget(): HTMLElement | null {
    if (this.step === "developer-menu") {
      return queryGuideTarget("conversationDeveloperMode") ?? queryGuideTarget("conversationGitHubMcp");
    }
    const id = TARGETS[this.step];
    return id ? queryGuideTarget(id) : null;
  }

  private render(): void {
    if (!this.active || this.disposed) {
      this.hide();
      return;
    }

    const target = this.currentTarget();
    if (target) {
      this.positionRing(target);
      this.maybeScrollTarget(target);
    } else {
      this.ring.classList.add("cfpt-guide-hidden");
    }
    this.card.innerHTML = this.cardHtml(Boolean(target));
    this.card.classList.remove("cfpt-guide-hidden");
    this.positionCard(target);
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

  private maybeScrollTarget(target: HTMLElement): void {
    if (this.lastScrolledStep === this.step) return;
    if (this.step !== "developer" && this.step !== "developer-toggle") return;
    this.lastScrolledStep = this.step;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
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
    this.lastScrolledStep = null;
    await this.persist();
    this.render();
  }

  private onGuideClick(event: Event): void {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-guide-action]");
    if (!target) return;
    event.stopPropagation();
    const action = target.dataset["guideAction"];
    if (action === "cancel") void this.cancel();
    else if (action === "developer-next") void this.setStep("developer-toggle");
    else if (action === "open-plugins") this.openPlugins();
    else if (action === "fill-name") this.fillField("pluginNameInput", "GitHub MCP", "plugin-server");
    else if (action === "fill-url") this.fillField("pluginServerInput", MCP_URL, "plugin-auth");
    else if (action === "auth-next") void this.setStep("plugin-risk");
    else if (action === "risk-next") this.advanceRisk();
    else if (action === "return-chat") this.returnToChat();
    else if (action === "finish") void this.finish();
  }

  private openPlugins(): void {
    void this.setStep("plugin-add").then(() => navigate(PLUGINS_URL));
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
    await this.persist();
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

function guideCopy(step: SetupGuideStep, found: boolean): { title: string; body: string; actions: string } {
  const wait = found ? "" : " I’m waiting for this ChatGPT control to appear.";
  switch (step) {
    case "security":
      return copy("1 · Security and login", `Click the highlighted <b>Security and login</b> item.${wait}`);
    case "developer":
      return copy(
        "2 · Developer mode",
        `Developer mode is lower on this page. I’ve brought the highlighted row into view.${wait}`,
        primary("developer-next", "Show the switch"),
      );
    case "developer-toggle":
      return copy("3 · Enable Developer mode", `Turn on the highlighted <b>Developer mode</b> switch. ChatGPT labels this Elevated Risk because it permits unverified connectors.${wait}`);
    case "plugins":
      return copy(
        "4 · Open Plugins",
        "Developer mode is on. Continue to ChatGPT Plugins to add the official remote GitHub MCP endpoint.",
        primary("open-plugins", "Open Plugins"),
      );
    case "plugin-add":
      return copy("5 · Add a plugin", `Click the highlighted <b>+</b> button.${wait}`);
    case "plugin-name":
      return copy(
        "6 · Name",
        `Use <b>GitHub MCP</b> so it is easy to recognize later.${wait}`,
        primary("fill-name", "Use GitHub MCP"),
      );
    case "plugin-server":
      return copy(
        "7 · Server URL",
        `Put <code>${MCP_URL}</code> in the highlighted Server URL field.${wait}`,
        primary("fill-url", "Fill server URL"),
      );
    case "plugin-auth":
      return copy(
        "8 · Authentication",
        `Set Authentication to <b>OAuth</b> in the highlighted control.${wait}`,
        primary("auth-next", "OAuth selected — next"),
      );
    case "plugin-risk":
      return copy(
        "9 · Risk acknowledgement",
        `Read the warning, then check the highlighted acknowledgement.${wait}`,
        primary("risk-next", "Checked — next"),
      );
    case "plugin-create":
      return copy("10 · Create", `Click the highlighted <b>Create</b> button.${wait}`);
    case "oauth":
      return copy(
        "11 · Complete GitHub OAuth",
        "Finish the GitHub authorization ChatGPT opens. Approve the repository and workflow write permissions you intend Chat FreePT to use, then return here.",
        primary("return-chat", "Connected — return to chat"),
      );
    case "chat-plus":
      return copy("12 · Add it to this chat", `Click the highlighted <b>+</b> beside the composer.${wait}`);
    case "developer-menu":
      return copy("13 · Developer mode", `Choose the highlighted <b>Developer mode</b> entry. If GitHub MCP appears directly, choose it instead.${wait}`);
    case "github-app":
      return copy("14 · GitHub MCP", `Choose the highlighted <b>GitHub MCP</b> plugin for this conversation.${wait}`);
    case "done":
      return copy(
        "Setup complete",
        "Chat FreePT can now run its GitHub capability preflight in this conversation.",
        primary("finish", "Done"),
      );
  }
}

function copy(title: string, body: string, actions = ""): { title: string; body: string; actions: string } {
  return { title, body, actions: actions ? `<div class="cfpt-guide-actions">${actions}</div>` : "" };
}

function primary(action: string, label: string): string {
  return `<button class="cfpt-guide-btn cfpt-guide-btn-primary" type="button" data-guide-action="${action}">${label}</button>`;
}

function isGuideStep(value: unknown): value is SetupGuideStep {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(TARGETS, value)
    ? true
    : value === "plugins" || value === "oauth" || value === "done";
}

function isControlEnabled(element: HTMLElement): boolean {
  if (element instanceof HTMLInputElement) return element.checked;
  return element.getAttribute("aria-checked") === "true" || element.getAttribute("data-state") === "checked";
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
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
    // JSDOM/test environments do not implement navigation; the persisted step still survives.
  }
}
