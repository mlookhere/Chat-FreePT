import type { MachineEvent } from "../../common/state-machine";
import { normalizeRepositoryInput } from "../../common/repository";
import type { RunState } from "../../common/types";
import type { DiagnosticsStatus } from "../diagnostics";
import { query, queryGuideTarget } from "../selectors";
import { NativeComposerHost } from "./native-composer";
import { PANEL_CSS } from "./styles";
import {
  airplaneSvg,
  launcherState,
  panelViewKey,
  renderPanelBody,
  renderPanelShell,
  repositorySetupHtml,
  updateDiagnosticsDom,
  updatePanelDynamic,
} from "./view";

export interface PanelHooks {
  onEvent: (event: MachineEvent) => void;
  getHandoffPrompt: () => string;
  getDiagnosticsStatus?: () => DiagnosticsStatus;
  onDiagnosticsStart?: () => void;
  onDiagnosticsStop?: () => void;
  onDiagnosticsExport?: () => void;
}

interface OnboardingState {
  setupShown: boolean;
}

const FREEPT_INPUT_EVENTS = [
  "keydown",
  "keyup",
  "beforeinput",
  "input",
  "paste",
  "compositionstart",
  "compositionupdate",
  "compositionend",
] as const;

const ONBOARDING_KEY = "cfpt:onboarding:v1";
const DEFAULT_ONBOARDING: OnboardingState = {
  setupShown: false,
};

function normalizeOnboarding(value: unknown): OnboardingState {
  if (!value || typeof value !== "object") return { ...DEFAULT_ONBOARDING };
  const candidate = value as Partial<OnboardingState>;
  return { setupShown: candidate.setupShown === true };
}

/** Native-feeling launcher plus an in-place extended composer that replaces ChatGPT's visible bar. */
export class Panel {
  private readonly host: HTMLSpanElement;
  private readonly launcherShadow: ShadowRoot;
  private readonly launcher: HTMLButtonElement;
  private readonly overlayHost: HTMLDivElement;
  private readonly shadow: ShadowRoot;
  private readonly takeoverBackdropEl: HTMLDivElement;
  private readonly panelEl: HTMLDivElement;
  private readonly setupBackdropEl: HTMLDivElement;
  private readonly nativeComposer: NativeComposerHost;
  private readonly mountObserver: MutationObserver;
  private readonly themeObserver: MutationObserver;
  private lastViewKey = "";
  private stopArmed = false;
  private mountQueued = false;
  private disposed = false;
  private onboarding = { ...DEFAULT_ONBOARDING };
  private lastIntegratedField: HTMLInputElement | HTMLTextAreaElement | null = null;
  private diagnosticsStatus: DiagnosticsStatus = { recording: false, records: 0, dropped: 0 };

  constructor(private readonly hooks: PanelHooks) {
    this.diagnosticsStatus = hooks.getDiagnosticsStatus?.() ?? this.diagnosticsStatus;
    const launcherParts = this.createLauncher();
    this.host = launcherParts.host;
    this.launcherShadow = launcherParts.shadow;
    this.launcher = launcherParts.button;

    const overlay = this.createOverlay();
    this.overlayHost = overlay.host;
    this.shadow = overlay.shadow;
    this.takeoverBackdropEl = overlay.backdrop;
    this.panelEl = overlay.panel;
    this.setupBackdropEl = overlay.setup;
    this.nativeComposer = new NativeComposerHost(this.overlayHost, () => this.focusIntegratedSurface());

    this.bindEvents();
    this.mountObserver = new MutationObserver(() => this.scheduleMount());
    this.mountObserver.observe(document.documentElement, { childList: true, subtree: true });
    this.themeObserver = new MutationObserver(() => this.nativeComposer.syncTheme());
    const themeOptions: MutationObserverInit = {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme", "data-color-scheme"],
    };
    this.themeObserver.observe(document.documentElement, themeOptions);
    if (document.body) this.themeObserver.observe(document.body, themeOptions);
    this.mount();
    void this.initOnboarding();
  }

  setDiagnosticsStatus(status: DiagnosticsStatus): void {
    this.diagnosticsStatus = status;
    updateDiagnosticsDom(this.panelEl, status);
  }

  withNativeComposerAccess<T>(task: () => Promise<T>): Promise<T> {
    return this.nativeComposer.withAutomationAccess(task);
  }

  toggle(force?: boolean): void {
    const show = force ?? this.takeoverBackdropEl.classList.contains("cfpt-hidden");
    this.takeoverBackdropEl.classList.toggle("cfpt-hidden", !show);
    this.panelEl.classList.toggle("cfpt-hidden", !show);
    this.overlayHost.dataset["expanded"] = String(show);
    this.host.dataset["expanded"] = String(show);
    this.launcher.setAttribute("aria-expanded", String(show));
    this.launcher.setAttribute("aria-label", show ? "Close Chat FreePT" : "Open Chat FreePT");
    if (show) {
      this.mount();
      this.nativeComposer.activate();
      queueMicrotask(() => this.focusIntegratedSurface());
    } else {
      this.setupBackdropEl.classList.add("cfpt-hidden");
      this.nativeComposer.restore();
    }
  }

  render(state: RunState, passive = false): void {
    const visualState = passive ? "attention" : launcherState(state);
    this.host.dataset["state"] = visualState;
    this.host.dataset["status"] = state.status;
    this.host.dataset["phase"] = state.phase;
    this.launcher.dataset["state"] = visualState;

    const viewKey = panelViewKey(state, passive);
    if (viewKey !== this.lastViewKey) {
      this.lastViewKey = viewKey;
      this.stopArmed = false;
      this.panelEl.innerHTML = renderPanelShell(renderPanelBody(state, passive));
    }
    updatePanelDynamic(this.panelEl, state, this.diagnosticsStatus);
    this.mount();
  }

  dispose(): void {
    this.disposed = true;
    this.mountObserver.disconnect();
    this.themeObserver.disconnect();
    window.removeEventListener("focusin", this.guardNativeFocusCapture, true);
    for (const type of FREEPT_INPUT_EVENTS) {
      window.removeEventListener(type, this.isolateFreePtInputCapture, true);
    }
    this.nativeComposer.restore(false);
    this.host.remove();
    this.overlayHost.remove();
  }

  async acknowledgeSetup(): Promise<void> {
    this.setupBackdropEl.classList.add("cfpt-hidden");
    if (this.host.dataset["expanded"] === "true") this.panelEl.classList.remove("cfpt-hidden");
    this.onboarding.setupShown = true;
    this.host.dataset["onboarding"] = "done";
    this.host.dataset["highlighted"] = "false";
    const tooltip = this.launcherShadow.querySelector<HTMLElement>("#cfpt-launcher-tooltip");
    if (tooltip) tooltip.textContent = "Chat FreePT";
    await this.persistOnboarding();
  }

  showCompletion(_state: RunState): void {
    this.toggle(true);
  }

  private createLauncher(): {
    host: HTMLSpanElement;
    shadow: ShadowRoot;
    button: HTMLButtonElement;
  } {
    const host = document.createElement("span");
    host.id = "cfpt-root";
    host.dataset["cfptEmbedded"] = "true";
    host.dataset["cfptLauncher"] = "airplane";
    host.dataset["cfptHost"] = "launcher";
    host.dataset["expanded"] = "false";
    host.dataset["onboarding"] = "loading";
    host.dataset["highlighted"] = "false";
    host.dataset["fallback"] = "false";

    const shadow = host.attachShadow({ mode: "closed" });
    appendStyle(shadow);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cfpt-launcher";
    button.setAttribute("aria-label", "Open Chat FreePT");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-describedby", "cfpt-launcher-tooltip");
    button.innerHTML = airplaneSvg();
    button.addEventListener("pointerover", (event) => event.stopPropagation());
    button.addEventListener("mouseover", (event) => event.stopPropagation());
    button.addEventListener("pointerdown", (event) => event.stopPropagation());
    button.addEventListener("mousedown", (event) => event.stopPropagation());
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      this.onLauncherClick();
    });

    const tooltip = document.createElement("span");
    tooltip.id = "cfpt-launcher-tooltip";
    tooltip.className = "cfpt-launcher-tooltip";
    tooltip.setAttribute("role", "tooltip");
    tooltip.textContent = "Chat FreePT";
    shadow.append(button, tooltip);
    return { host, shadow, button };
  }

  private createOverlay(): {
    host: HTMLDivElement;
    shadow: ShadowRoot;
    backdrop: HTMLDivElement;
    panel: HTMLDivElement;
    setup: HTMLDivElement;
  } {
    const host = document.createElement("div");
    host.id = "cfpt-overlay-root";
    host.dataset["cfptHost"] = "overlay";
    host.dataset["expanded"] = "false";
    const shadow = host.attachShadow({ mode: "closed" });
    appendStyle(shadow);

    const backdrop = document.createElement("div");
    backdrop.className = "cfpt-takeover-backdrop cfpt-hidden";
    const panel = document.createElement("div");
    panel.className = "cfpt-panel cfpt-hidden";
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "Chat FreePT extended composer");
    backdrop.appendChild(panel);
    shadow.appendChild(backdrop);

    const setup = document.createElement("div");
    setup.className = "cfpt-setup-backdrop cfpt-hidden";
    shadow.appendChild(setup);
    return { host, shadow, backdrop, panel, setup };
  }

  private bindEvents(): void {
    this.shadow.addEventListener("click", (event) => {
      this.stopComposerPropagation(event);
      this.onClick(event);
    });
    this.shadow.addEventListener("pointerdown", (event) => this.stopComposerPropagation(event));
    this.shadow.addEventListener("mousedown", (event) => this.stopComposerPropagation(event));
    this.shadow.addEventListener("focusin", (event) => {
      this.rememberIntegratedFocus(event);
      this.stopComposerPropagation(event);
    });
    this.shadow.addEventListener("beforeinput", (event) => this.stopComposerPropagation(event));
    this.shadow.addEventListener("input", (event) => this.stopComposerPropagation(event));
    this.shadow.addEventListener("paste", (event) => this.stopComposerPropagation(event));
    this.shadow.addEventListener("compositionstart", (event) =>
      this.stopComposerPropagation(event),
    );
    this.shadow.addEventListener("compositionupdate", (event) =>
      this.stopComposerPropagation(event),
    );
    this.shadow.addEventListener("compositionend", (event) => this.stopComposerPropagation(event));
    this.shadow.addEventListener("keyup", (event) => this.stopComposerPropagation(event));
    this.shadow.addEventListener("keydown", (event) => {
      this.stopComposerPropagation(event);
      this.onKeyDown(event);
    });
    this.takeoverBackdropEl.addEventListener("click", (event) => {
      if (event.target === this.takeoverBackdropEl) this.toggle(false);
    });
    this.setupBackdropEl.addEventListener("click", (event) => {
      if (event.target === this.setupBackdropEl) void this.acknowledgeSetup();
    });
    window.addEventListener("focusin", this.guardNativeFocusCapture, true);
    for (const type of FREEPT_INPUT_EVENTS) {
      window.addEventListener(type, this.isolateFreePtInputCapture, true);
    }
  }

  private readonly isolateFreePtInputCapture = (event: Event): void => {
    if (this.host.dataset["expanded"] !== "true") return;
    const path = event.composedPath();
    const fromFreePt = path.includes(this.overlayHost);
    const fromGuardedNative = this.nativeComposer.isGuardedPath(path);
    if (!fromFreePt && !fromGuardedNative) return;

    if (event.type === "paste" && this.redirectPaste(event)) {
      event.stopImmediatePropagation();
      return;
    }
    if (event instanceof KeyboardEvent && event.key === "Escape") this.onKeyDown(event);
    event.stopImmediatePropagation();
  };

  private redirectPaste(event: Event): boolean {
    const field = this.activeIntegratedTextField();
    const clipboardData = (event as ClipboardEvent).clipboardData;
    if (!field || field.readOnly || field.disabled || !clipboardData) return false;

    event.preventDefault();
    const text = clipboardData.getData("text/plain");
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? start;
    // Own the paste without emitting a composed synthetic input event. ChatGPT listens
    // globally for composer input; re-dispatching here can re-enter its event machinery.
    field.setRangeText(text, start, end, "end");
    this.lastIntegratedField = field;
    field.focus({ preventScroll: true });
    queueMicrotask(() => field.focus({ preventScroll: true }));
    return true;
  }

  private activeIntegratedTextField(): HTMLInputElement | HTMLTextAreaElement | null {
    const active = this.shadow.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return active;
    return this.lastIntegratedField?.isConnected === true ? this.lastIntegratedField : null;
  }

  private rememberIntegratedFocus(event: Event): void {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      this.lastIntegratedField = target;
    }
  }

  private readonly guardNativeFocusCapture = (event: FocusEvent): void => {
    if (this.host.dataset["expanded"] !== "true") return;
    if (!this.nativeComposer.isGuardedTarget(event.target)) return;

    event.stopImmediatePropagation();
    const field = this.activeIntegratedTextField();
    if (field) queueMicrotask(() => field.focus({ preventScroll: true }));
  };

  private stopComposerPropagation(event: Event): void {
    if (
      event.composedPath().includes(this.panelEl) ||
      event.composedPath().includes(this.setupBackdropEl)
    ) {
      event.stopPropagation();
    }
  }

  private onKeyDown(event: Event): void {
    if (!(event instanceof KeyboardEvent) || event.key !== "Escape") return;
    if (!this.setupBackdropEl.classList.contains("cfpt-hidden")) {
      void this.acknowledgeSetup();
      return;
    }
    if (this.host.dataset["expanded"] === "true") this.toggle(false);
  }

  private onLauncherClick(): void {
    if (this.host.dataset["onboarding"] === "tip") {
      this.showSetupPanel();
      return;
    }
    this.toggle();
  }

  private async initOnboarding(): Promise<void> {
    try {
      const found = await chrome.storage.local.get(ONBOARDING_KEY);
      this.onboarding = normalizeOnboarding(found[ONBOARDING_KEY]);
    } catch {
      this.onboarding = { ...DEFAULT_ONBOARDING };
    }
    if (this.disposed) return;
    if (!this.onboarding.setupShown) this.showLauncherTip();
    else this.host.dataset["onboarding"] = "done";
  }

  private async persistOnboarding(): Promise<void> {
    try {
      await chrome.storage.local.set({ [ONBOARDING_KEY]: this.onboarding });
    } catch {
      // Onboarding persistence must never prevent the extension controls from operating.
    }
  }

  private showLauncherTip(): void {
    this.setupBackdropEl.classList.add("cfpt-hidden");
    this.host.dataset["onboarding"] = "tip";
    this.host.dataset["highlighted"] = "true";
    const tooltip = this.launcherShadow.querySelector<HTMLElement>("#cfpt-launcher-tooltip");
    if (tooltip) tooltip.textContent = "Chat FreePT — click to extend this composer";
  }

  private showSetupPanel(): void {
    this.host.dataset["highlighted"] = "false";
    const tooltip = this.launcherShadow.querySelector<HTMLElement>("#cfpt-launcher-tooltip");
    if (tooltip) tooltip.textContent = "Chat FreePT";
    this.toggle(true);
    this.panelEl.classList.add("cfpt-hidden");
    this.setupBackdropEl.innerHTML = repositorySetupHtml();
    this.setupBackdropEl.classList.remove("cfpt-hidden");
    this.host.dataset["onboarding"] = "setup";
    queueMicrotask(() => {
      this.setupBackdropEl.querySelector<HTMLButtonElement>("button")?.focus();
    });
  }

  private scheduleMount(): void {
    if (this.mountQueued) return;
    this.mountQueued = true;
    queueMicrotask(() => {
      this.mountQueued = false;
      this.mount();
    });
  }

  private mount(): void {
    const plus = queryGuideTarget("composerPlusButton");
    if (plus?.parentElement) {
      if (plus.nextElementSibling !== this.host) plus.insertAdjacentElement("afterend", this.host);
      this.host.dataset["fallback"] = "false";
    } else {
      const anchor = this.nativeComposer.surface() ?? query("composerHeader");
      if (anchor && this.host.parentElement !== anchor) anchor.appendChild(this.host);
      this.host.dataset["fallback"] = "true";
    }

    this.nativeComposer.mountOverlay();
    this.nativeComposer.syncTheme();
    if (this.host.dataset["expanded"] === "true") this.nativeComposer.activate();
  }

  private onClick(event: Event): void {
    event.stopPropagation();
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!target) return;
    switch (target.dataset["action"]) {
      case "close":
        this.toggle(false);
        break;
      case "start":
        this.startProject();
        break;
      case "startdev":
        this.hooks.onEvent({ type: "USER_START_DEVELOPMENT" });
        break;
      case "pause":
        this.hooks.onEvent({ type: "USER_PAUSE" });
        break;
      case "resume":
        this.hooks.onEvent({ type: "USER_RESUME" });
        break;
      case "sendnow":
        this.hooks.onEvent({ type: "COOLDOWN_ELAPSED" });
        break;
      case "reply":
        this.sendReply();
        break;
      case "stop":
        this.stopRun(target);
        break;
      case "newproject":
        this.hooks.onEvent({ type: "USER_NEW_PROJECT" });
        break;
      case "copyhandoff":
        this.copyHandoff(target);
        break;
      case "auto-continue":
        this.hooks.onEvent({
          type: "USER_SET_AUTO_CONTINUE",
          enabled: (target as HTMLInputElement).checked,
        });
        break;
      case "showqueue":
        this.showQueueEditor();
        break;
      case "hidequeue":
        this.hideQueueEditor();
        break;
      case "savequeue":
        this.saveQueuedMessage();
        break;
      case "queue-up":
        this.hooks.onEvent({
          type: "USER_MOVE_QUEUE",
          index: Number(target.dataset["index"]),
          direction: -1,
        });
        break;
      case "queue-down":
        this.hooks.onEvent({
          type: "USER_MOVE_QUEUE",
          index: Number(target.dataset["index"]),
          direction: 1,
        });
        break;
      case "queue-remove":
        this.hooks.onEvent({
          type: "USER_REMOVE_QUEUE",
          index: Number(target.dataset["index"]),
        });
        break;
      case "clearqueue":
        this.hooks.onEvent({ type: "USER_CLEAR_QUEUE" });
        break;
      case "setup-open":
        this.showSetupPanel();
        break;
      case "setup-done":
        void this.acknowledgeSetup();
        break;
      case "diagnostics-start":
        this.hooks.onDiagnosticsStart?.();
        break;
      case "diagnostics-stop":
        this.hooks.onDiagnosticsStop?.();
        break;
      case "diagnostics-export":
        this.hooks.onDiagnosticsExport?.();
        break;
    }
  }

  private startProject(): void {
    const idea = this.refValue("idea").trim();
    const rawRepo = this.refValue("reponame");
    const repo = normalizeRepositoryInput(rawRepo);
    if (!repo) {
      const error = this.panelEl.querySelector<HTMLElement>('[data-ref="repo-error"]');
      if (error) error.textContent = "Enter a valid owner/repo or root GitHub repository URL.";
      return;
    }
    if (!idea) return;
    this.hooks.onEvent({
      type: "USER_START",
      idea,
      repoMode: "existing",
      repoName: repo,
    });
  }

  private sendReply(): void {
    const text = this.refValue("reply");
    if (!text.trim()) return;
    this.hooks.onEvent({ type: "USER_REPLY", text });
  }

  private showQueueEditor(): void {
    const editor = this.panelEl.querySelector<HTMLElement>('[data-ref="queue-editor"]');
    editor?.classList.remove("cfpt-hidden");
    this.panelEl.querySelector<HTMLTextAreaElement>('[data-ref="queue-next"]')?.focus();
  }

  private hideQueueEditor(): void {
    this.panelEl
      .querySelector<HTMLElement>('[data-ref="queue-editor"]')
      ?.classList.add("cfpt-hidden");
  }

  private saveQueuedMessage(): void {
    const input = this.panelEl.querySelector<HTMLTextAreaElement>('[data-ref="queue-next"]');
    const text = input?.value.trim() ?? "";
    if (!text) return;
    this.hooks.onEvent({ type: "USER_QUEUE_NEXT", text });
    if (input) input.value = "";
    this.hideQueueEditor();
  }

  private stopRun(target: HTMLElement): void {
    if (!this.stopArmed) {
      this.stopArmed = true;
      target.textContent = "Confirm stop";
      setTimeout(() => {
        this.stopArmed = false;
        if (target.isConnected) target.textContent = "Stop";
      }, 3000);
      return;
    }
    this.hooks.onEvent({ type: "USER_STOP" });
  }

  private copyHandoff(target: HTMLElement): void {
    const prompt = this.hooks.getHandoffPrompt();
    void navigator.clipboard.writeText(prompt).then(() => {
      target.textContent = "Copied — paste it into a new chat";
    });
  }

  private refValue(ref: string): string {
    const el = this.panelEl.querySelector(`[data-ref="${ref}"]`) as
      HTMLTextAreaElement | HTMLInputElement | null;
    return el?.value ?? "";
  }
}

function appendStyle(root: ShadowRoot): void {
  const style = document.createElement("style");
  style.textContent = PANEL_CSS;
  root.appendChild(style);
}

