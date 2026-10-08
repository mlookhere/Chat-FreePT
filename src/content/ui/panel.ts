import {
  autoContinueEnabled,
  isWaitingForManualContinue,
  queuedMessages,
  type MachineEvent,
} from "../../common/state-machine";
import { normalizeRepositoryInput } from "../../common/repository";
import type { RunState } from "../../common/types";
import type { DiagnosticsStatus } from "../diagnostics";
import { healthCheck, query, queryGuideTarget } from "../selectors";
import { PANEL_CSS } from "./styles";

export interface PanelHooks {
  onEvent: (event: MachineEvent) => void;
  getHandoffPrompt: () => string;
  getDiagnosticsStatus?: () => DiagnosticsStatus;
  onDiagnosticsStart?: () => void;
  onDiagnosticsStop?: () => void;
  onDiagnosticsExport?: () => void;
}

interface OnboardingState {
  launcherTipSuppressed: boolean;
  setupShown: boolean;
}

interface NativeSurfaceSnapshot {
  form: HTMLFormElement;
  surface: HTMLElement;
  parent: HTMLElement;
  composer: HTMLElement | null;
  composerContentEditable: string | null;
  composerTabIndex: string | null;
  composerAriaDisabled: string | null;
  position: string;
  inset: string;
  width: string;
  height: string;
  overflow: string;
  clipPath: string;
  opacity: string;
  pointerEvents: string;
  visibility: string;
  inert: boolean;
  ariaHidden: string | null;
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
  launcherTipSuppressed: false,
  setupShown: false,
};

const STATUS_LABEL: Record<string, string> = {
  idle: "Idle",
  inserting: "Writing prompt…",
  sending: "Sending…",
  streaming: "ChatGPT is working…",
  cooldown: "Waiting to auto-continue…",
  awaiting_user: "Waiting for you",
  paused: "Paused",
  error: "Paused on a problem",
  complete: "Complete",
};

function esc(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function normalizeOnboarding(value: unknown): OnboardingState {
  if (!value || typeof value !== "object") return { ...DEFAULT_ONBOARDING };
  const candidate = value as Partial<OnboardingState>;
  return {
    launcherTipSuppressed: candidate.launcherTipSuppressed === true,
    setupShown: candidate.setupShown === true,
  };
}

function canQueueNext(state: RunState): boolean {
  return state.phase === "planning" || state.phase === "developing";
}

function themeValue(styles: CSSStyleDeclaration[], names: string[]): string {
  for (const name of names) {
    for (const style of styles) {
      const value = style.getPropertyValue(name).trim();
      if (value) return value;
    }
  }
  return "";
}

function isTransparentColor(value: string): boolean {
  const normalized = value.replace(/\s+/g, "").toLowerCase();
  return (
    !normalized ||
    normalized === "transparent" ||
    normalized === "rgba(0,0,0,0)" ||
    normalized === "rgb(0 0 0/0)"
  );
}

function effectiveBackground(element: HTMLElement): string {
  let current: HTMLElement | null = element;
  while (current) {
    const value = getComputedStyle(current).backgroundColor;
    if (!isTransparentColor(value)) return value;
    current = current.parentElement;
  }
  return "";
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
  private readonly launcherTipEl: HTMLDivElement;
  private readonly setupBackdropEl: HTMLDivElement;
  private readonly mountObserver: MutationObserver;
  private readonly themeObserver: MutationObserver;
  private lastViewKey = "";
  private stopArmed = false;
  private mountQueued = false;
  private disposed = false;
  private onboarding = { ...DEFAULT_ONBOARDING };
  private nativeSurface: NativeSurfaceSnapshot | null = null;
  private nativeAutomationAccess = false;
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
    this.launcherTipEl = overlay.tip;
    this.setupBackdropEl = overlay.setup;

    this.bindEvents();
    this.mountObserver = new MutationObserver(() => this.scheduleMount());
    this.mountObserver.observe(document.documentElement, { childList: true, subtree: true });
    this.themeObserver = new MutationObserver(() => this.syncOverlayTheme());
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
    this.updateDiagnosticsDom();
  }

  setNativeAutomationAccess(enabled: boolean): void {
    this.nativeAutomationAccess = enabled;
    if (this.host.dataset["expanded"] !== "true") return;
    this.applyNativeTakeover();
    if (!enabled) queueMicrotask(() => this.focusIntegratedSurface());
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
      this.applyNativeTakeover();
      queueMicrotask(() => this.focusIntegratedSurface());
    } else {
      this.setupBackdropEl.classList.add("cfpt-hidden");
      this.restoreNativeTakeover();
    }
  }

  render(state: RunState, passive = false): void {
    const visualState = passive ? "attention" : launcherState(state);
    this.host.dataset["state"] = visualState;
    this.host.dataset["status"] = state.status;
    this.host.dataset["phase"] = state.phase;
    this.launcher.dataset["state"] = visualState;

    const viewKey = `${state.phase}|${state.status}|${state.pauseReason ?? ""}|${state.repo ?? ""}|${state.lastMarker?.status ?? ""}|${state.lastMarker?.item ?? ""}|${state.lastMarker?.url ?? ""}|${state.lastLifecycleSignal ?? ""}|${queuedMessages(state).join("\u001f")}|${autoContinueEnabled(state)}|${passive}`;
    if (viewKey !== this.lastViewKey) {
      this.lastViewKey = viewKey;
      this.stopArmed = false;
      this.panelEl.innerHTML = this.panelShell(this.bodyHtml(state, passive));
    }
    this.updateDynamic(state);
    this.mount();
  }

  dispose(): void {
    this.disposed = true;
    this.mountObserver.disconnect();
    this.themeObserver.disconnect();
    window.removeEventListener("resize", this.onViewportChange);
    window.removeEventListener("scroll", this.onViewportChange, true);
    window.removeEventListener("focusin", this.guardNativeFocusCapture, true);
    for (const type of FREEPT_INPUT_EVENTS) {
      window.removeEventListener(type, this.isolateFreePtInputCapture, true);
    }
    this.restoreNativeTakeover(false);
    this.host.remove();
    this.overlayHost.remove();
  }

  async acknowledgeLauncherTip(suppress: boolean): Promise<void> {
    this.launcherTipEl.classList.add("cfpt-hidden");
    this.host.dataset["highlighted"] = "false";
    if (suppress) this.onboarding.launcherTipSuppressed = true;
    const tooltip = this.launcherShadow.querySelector<HTMLElement>("#cfpt-launcher-tooltip");
    if (tooltip) tooltip.textContent = "Chat FreePT";
    await this.persistOnboarding();
    if (!this.onboarding.setupShown) this.showSetupModal();
    else this.host.dataset["onboarding"] = "done";
  }

  async acknowledgeSetup(): Promise<void> {
    this.setupBackdropEl.classList.add("cfpt-hidden");
    if (this.host.dataset["expanded"] === "true") this.panelEl.classList.remove("cfpt-hidden");
    this.onboarding.setupShown = true;
    this.host.dataset["onboarding"] = "done";
    await this.persistOnboarding();
  }

  showCompletionModal(_state: RunState): void {
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
    tip: HTMLDivElement;
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

    const tip = document.createElement("div");
    tip.className = "cfpt-onboarding-toast cfpt-hidden";
    tip.setAttribute("role", "status");
    tip.innerHTML = launcherTipHtml();
    shadow.appendChild(tip);

    const setup = document.createElement("div");
    setup.className = "cfpt-setup-backdrop cfpt-hidden";
    shadow.appendChild(setup);
    return { host, shadow, backdrop, panel, tip, setup };
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
    window.addEventListener("resize", this.onViewportChange);
    window.addEventListener("scroll", this.onViewportChange, true);
    window.addEventListener("focusin", this.guardNativeFocusCapture, true);
    for (const type of FREEPT_INPUT_EVENTS) {
      window.addEventListener(type, this.isolateFreePtInputCapture, true);
    }
  }

  private readonly isolateFreePtInputCapture = (event: Event): void => {
    if (this.host.dataset["expanded"] !== "true") return;
    const snapshot = this.nativeSurface;
    const path = event.composedPath();
    const fromFreePt = path.includes(this.overlayHost);
    const fromGuardedNative =
      snapshot !== null && !this.nativeAutomationAccess && path.includes(snapshot.surface);
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
    if (this.host.dataset["expanded"] !== "true" || this.nativeAutomationAccess) return;
    const snapshot = this.nativeSurface;
    const target = event.target;
    if (!snapshot || !(target instanceof Node) || !snapshot.surface.contains(target)) return;

    event.stopImmediatePropagation();
    const field = this.activeIntegratedTextField();
    if (field) queueMicrotask(() => field.focus({ preventScroll: true }));
  };

  private readonly onViewportChange = (): void => {
    if (!this.launcherTipEl.classList.contains("cfpt-hidden")) this.positionLauncherTip();
  };

  private stopComposerPropagation(event: Event): void {
    if (
      event.composedPath().includes(this.panelEl) ||
      event.composedPath().includes(this.setupBackdropEl) ||
      event.composedPath().includes(this.launcherTipEl)
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
      void this.acknowledgeLauncherTip(this.tipCheckboxChecked());
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
    if (!this.onboarding.launcherTipSuppressed) this.showLauncherTip();
    else if (!this.onboarding.setupShown) this.showSetupModal();
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
    this.launcherTipEl.classList.add("cfpt-hidden");
    this.host.dataset["onboarding"] = "tip";
    this.host.dataset["highlighted"] = "true";
    const tooltip = this.launcherShadow.querySelector<HTMLElement>("#cfpt-launcher-tooltip");
    if (tooltip) tooltip.textContent = "Chat FreePT — click to extend this composer";
  }

  private showSetupModal(): void {
    this.launcherTipEl.classList.add("cfpt-hidden");
    this.host.dataset["highlighted"] = "false";
    this.toggle(true);
    this.panelEl.classList.add("cfpt-hidden");
    this.setupBackdropEl.innerHTML = repositorySetupHtml();
    this.setupBackdropEl.classList.remove("cfpt-hidden");
    this.host.dataset["onboarding"] = "setup";
    queueMicrotask(() => {
      this.setupBackdropEl.querySelector<HTMLButtonElement>("button")?.focus();
    });
  }

  private tipCheckboxChecked(): boolean {
    const input = this.launcherTipEl.querySelector<HTMLInputElement>(
      '[data-ref="suppress-launcher-tip"]',
    );
    return input?.checked === true;
  }

  private scheduleMount(): void {
    if (this.mountQueued) return;
    this.mountQueued = true;
    queueMicrotask(() => {
      this.mountQueued = false;
      this.mount();
    });
  }

  private nativeComposerSurface(): HTMLElement | null {
    const surface = query("composerSurface");
    if (surface instanceof HTMLElement && surface.tagName !== "FORM") return surface;
    const composer = query("composer");
    const form = composer instanceof HTMLElement ? composer.closest("form") : null;
    const body = form?.querySelector<HTMLElement>("[data-composer-body]");
    if (body) return body;
    return surface instanceof HTMLElement ? surface : null;
  }

  private nativeComposerForm(): HTMLFormElement | null {
    const surface = this.nativeComposerSurface();
    const surfaceForm = surface?.closest("form");
    if (surfaceForm instanceof HTMLFormElement) return surfaceForm;
    const composer = query("composer");
    const form = composer instanceof HTMLElement ? composer.closest("form") : null;
    return form instanceof HTMLFormElement ? form : null;
  }

  private mount(): void {
    const plus = queryGuideTarget("composerPlusButton");
    if (plus?.parentElement) {
      if (plus.nextElementSibling !== this.host) plus.insertAdjacentElement("afterend", this.host);
      this.host.dataset["fallback"] = "false";
    } else {
      const anchor = this.nativeComposerSurface() ?? query("composerHeader");
      if (anchor && this.host.parentElement !== anchor) anchor.appendChild(this.host);
      this.host.dataset["fallback"] = "true";
    }

    const surface = this.nativeComposerSurface();
    const slot = surface?.parentElement;
    if (surface && slot) {
      if (
        this.overlayHost.parentElement !== slot ||
        this.overlayHost.previousElementSibling !== surface
      ) {
        surface.insertAdjacentElement("afterend", this.overlayHost);
      }
    } else if (!this.overlayHost.isConnected) {
      this.nativeComposerForm()?.appendChild(this.overlayHost);
    }

    this.syncOverlayTheme();
    if (this.host.dataset["expanded"] === "true") this.applyNativeTakeover();
    if (!this.launcherTipEl.classList.contains("cfpt-hidden")) this.positionLauncherTip();
  }

  private syncOverlayTheme(): void {
    const surface = this.nativeComposerSurface();
    if (!surface) return;
    const form = this.nativeComposerForm();
    const submit = form?.querySelector<HTMLElement>(
      '#composer-submit-button, button[data-testid="send-button"], button[type="submit"]',
    );
    const styleElements = [surface, form, submit, document.body, document.documentElement].filter(
      (element): element is HTMLElement => element instanceof HTMLElement,
    );
    const styles = styleElements.map((element) => getComputedStyle(element));
    const surfaceStyle = styles[0];
    if (!surfaceStyle) return;

    const setVar = (name: string, value: string): void => {
      if (value) this.overlayHost.style.setProperty(name, value);
      else this.overlayHost.style.removeProperty(name);
    };
    const read = (...names: string[]): string => themeValue(styles, names);

    setVar(
      "--cfpt-native-surface",
      read(
        "--composer-surface-primary",
        "--main-surface-primary",
        "--color-background-composer-surface",
        "--color-surface",
      ) || effectiveBackground(surface),
    );
    setVar(
      "--cfpt-native-text",
      read("--text-primary", "--color-text-primary", "--color-text") || surfaceStyle.color,
    );
    setVar("--cfpt-native-radius", surfaceStyle.borderRadius);
    const accent =
      read(
        "--theme-submit-btn-bg",
        "--theme-submit-button-bg",
        "--accent-primary",
        "--accent-color",
        "--color-accent",
        "--color-text-composer-reference",
        "--app-color-border-focus",
        "--app-color-accent-blue",
        "--accent-blue",
      ) ||
      (submit && !isTransparentColor(getComputedStyle(submit).backgroundColor)
        ? getComputedStyle(submit).backgroundColor
        : "");
    setVar("--cfpt-accent", accent);
    setVar(
      "--cfpt-focus",
      read("--app-color-border-focus", "--focus-ring", "--color-border-focus") || accent,
    );
    setVar(
      "--cfpt-field-surface",
      read(
        "--composer-surface-secondary",
        "--main-surface-secondary",
        "--color-surface-secondary",
        "--app-color-background-surface-under",
      ),
    );
    setVar("--cfpt-border", read("--border-light", "--color-border", "--app-color-border"));
    setVar(
      "--cfpt-border-strong",
      read("--border-medium", "--color-border-strong", "--app-color-border-heavy"),
    );
    setVar(
      "--cfpt-muted",
      read("--text-secondary", "--color-text-secondary", "--app-color-text-secondary"),
    );
    if (surfaceStyle.colorScheme) this.overlayHost.style.colorScheme = surfaceStyle.colorScheme;
  }

  private applyNativeTakeover(): void {
    const surface = this.nativeComposerSurface();
    const form = this.nativeComposerForm();
    const parent = surface?.parentElement;
    if (!surface || !form || !parent) return;

    if (
      this.overlayHost.parentElement !== parent ||
      this.overlayHost.previousElementSibling !== surface
    ) {
      surface.insertAdjacentElement("afterend", this.overlayHost);
    }

    if (this.nativeSurface?.surface === surface) {
      this.guardNativeSurface(!this.nativeAutomationAccess);
      return;
    }

    this.restoreNativeTakeover(false);
    this.moveFocusOutsideNativeSurface(surface);
    const composerCandidate = query("composer");
    const composer =
      composerCandidate instanceof HTMLElement && surface.contains(composerCandidate)
        ? composerCandidate
        : null;
    this.nativeSurface = {
      form,
      surface,
      parent,
      composer,
      composerContentEditable: composer?.getAttribute("contenteditable") ?? null,
      composerTabIndex: composer?.getAttribute("tabindex") ?? null,
      composerAriaDisabled: composer?.getAttribute("aria-disabled") ?? null,
      position: surface.style.position,
      inset: surface.style.inset,
      width: surface.style.width,
      height: surface.style.height,
      overflow: surface.style.overflow,
      clipPath: surface.style.clipPath,
      opacity: surface.style.opacity,
      pointerEvents: surface.style.pointerEvents,
      visibility: surface.style.visibility,
      inert: surface.inert === true,
      ariaHidden: surface.getAttribute("aria-hidden"),
    };

    surface.style.position = "absolute";
    surface.style.inset = "0 auto auto 0";
    surface.style.width = "1px";
    surface.style.height = "1px";
    surface.style.overflow = "hidden";
    surface.style.clipPath = "inset(50%)";
    surface.style.opacity = "0";
    surface.style.pointerEvents = "none";
    surface.dataset["cfptNativeHidden"] = "true";
    form.dataset["cfptTakeover"] = "true";
    this.guardNativeSurface(!this.nativeAutomationAccess);
  }

  private guardNativeSurface(guarded: boolean): void {
    const snapshot = this.nativeSurface;
    if (!snapshot) return;
    snapshot.surface.inert = guarded;
    snapshot.surface.style.visibility = guarded ? "hidden" : snapshot.visibility;
    snapshot.surface.dataset["cfptNativeGuarded"] = String(guarded);
    snapshot.surface.setAttribute("aria-hidden", "true");
    this.setNativeComposerEditable(snapshot, !guarded);
    if (guarded && snapshot.surface.contains(document.activeElement)) this.focusIntegratedSurface();
  }

  private setNativeComposerEditable(snapshot: NativeSurfaceSnapshot, editable: boolean): void {
    const composer = snapshot.composer;
    if (!composer) return;
    if (!editable) {
      composer.setAttribute("contenteditable", "false");
      composer.setAttribute("tabindex", "-1");
      composer.setAttribute("aria-disabled", "true");
      return;
    }
    this.restoreAttribute(composer, "contenteditable", snapshot.composerContentEditable);
    this.restoreAttribute(composer, "tabindex", snapshot.composerTabIndex);
    this.restoreAttribute(composer, "aria-disabled", snapshot.composerAriaDisabled);
  }

  private restoreAttribute(element: HTMLElement, name: string, value: string | null): void {
    if (value === null) element.removeAttribute(name);
    else element.setAttribute(name, value);
  }

  private moveFocusOutsideNativeSurface(surface: HTMLElement): void {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !surface.contains(active)) return;
    this.focusIntegratedSurface();
    if (surface.contains(document.activeElement)) active.blur();
  }

  private focusIntegratedSurface(): void {
    const target =
      this.lastIntegratedField?.isConnected === true
        ? this.lastIntegratedField
        : (this.panelEl.querySelector<HTMLElement>(
            '[data-ref="idea"], [data-ref="reply"], [data-ref="queue-next"], [data-ref="reponame"]',
          ) ??
          this.setupBackdropEl.querySelector<HTMLElement>("button, input, textarea") ??
          this.panelEl.querySelector<HTMLElement>("button, input, textarea"));
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      this.lastIntegratedField = target;
    }
    target?.focus({ preventScroll: true });
  }

  private restoreNativeTakeover(focusNative = true): void {
    const snapshot = this.nativeSurface;
    if (!snapshot) return;
    snapshot.surface.style.position = snapshot.position;
    snapshot.surface.style.inset = snapshot.inset;
    snapshot.surface.style.width = snapshot.width;
    snapshot.surface.style.height = snapshot.height;
    snapshot.surface.style.overflow = snapshot.overflow;
    snapshot.surface.style.clipPath = snapshot.clipPath;
    snapshot.surface.style.opacity = snapshot.opacity;
    snapshot.surface.style.pointerEvents = snapshot.pointerEvents;
    snapshot.surface.style.visibility = snapshot.visibility;
    snapshot.surface.inert = snapshot.inert;
    this.setNativeComposerEditable(snapshot, true);
    if (snapshot.ariaHidden === null) snapshot.surface.removeAttribute("aria-hidden");
    else snapshot.surface.setAttribute("aria-hidden", snapshot.ariaHidden);
    delete snapshot.surface.dataset["cfptNativeHidden"];
    delete snapshot.surface.dataset["cfptNativeGuarded"];
    delete snapshot.form.dataset["cfptTakeover"];
    this.nativeSurface = null;
    if (!focusNative) return;
    queueMicrotask(() => {
      const composer = query("composer");
      if (composer instanceof HTMLElement) composer.focus({ preventScroll: true });
    });
  }

  private positionLauncherTip(): void {
    const form = this.nativeComposerForm();
    if (!form) return;
    const anchor = form.getBoundingClientRect();
    const rect = this.host.getBoundingClientRect();
    const width = Math.min(310, Math.max(220, anchor.width - 24));
    const left = Math.min(
      Math.max(12, rect.left - anchor.left - 10),
      Math.max(12, anchor.width - width - 12),
    );
    const relativeTop = rect.top - anchor.top;
    const top = relativeTop > 175 ? relativeTop - 165 : rect.bottom - anchor.top + 10;
    Object.assign(this.launcherTipEl.style, {
      width: `${Math.round(width)}px`,
      left: `${Math.round(left)}px`,
      right: "auto",
      top: `${Math.round(top)}px`,
      bottom: "auto",
    });
  }

  private panelShell(body: string): string {
    return `
      <div class="cfpt-panel-head">
        <strong>Chat FreePT</strong>
        <button class="cfpt-panel-close" type="button" data-action="close" aria-label="Return to the native ChatGPT composer">${airplaneSvg()}<span>Native</span></button>
      </div>
      <div class="cfpt-body">${body}</div>
    `;
  }

  private bodyHtml(state: RunState, passive: boolean): string {
    const health = healthCheck();
    const showHealthWarning =
      state.status === "error" &&
      state.errorCode === "composer-insert-failed" &&
      health.missing.length > 0;
    const warn = showHealthWarning
      ? `<div class="cfpt-warn">ChatGPT's page structure changed — missing: ${esc(
          health.missing.join(", "),
        )}. Auto-run cannot operate until the extension is updated.</div>`
      : "";
    if (passive)
      return warn + this.passiveHtml(state) + this.checkpointHtml(state) + this.diagnosticsHtml();
    const controls = this.automationControlsHtml(state);
    return (
      warn +
      controls +
      this.statusBodyHtml(state) +
      this.checkpointHtml(state) +
      this.diagnosticsHtml()
    );
  }

  private statusBodyHtml(state: RunState): string {
    switch (state.status) {
      case "idle":
        return this.ideaFormHtml(state);
      case "inserting":
      case "sending":
      case "streaming":
      case "cooldown":
        return this.runningHtml(state);
      case "awaiting_user":
        return state.phase === "plan_ready"
          ? this.planReadyHtml(state)
          : this.needsInputHtml(state);
      case "paused":
      case "error":
        return this.pausedHtml(state);
      case "complete":
        return this.completeHtml(state);
      default:
        return "";
    }
  }

  private automationControlsHtml(state: RunState): string {
    const enabled = autoContinueEnabled(state);
    const queue = queuedMessages(state);
    const queueControls = canQueueNext(state) ? this.queueControlsHtml(queue) : "";
    return `
      <div class="cfpt-field">
        <label class="cfpt-check-row">
          <input type="checkbox" data-action="auto-continue" ${enabled ? "checked" : ""} />
          <span><strong>Auto-continue</strong></span>
        </label>
        <p class="cfpt-note">When off, Chat FreePT waits instead of sending a generic continue. Queued messages still send one at a time at safe turn boundaries.</p>
        ${queueControls}
      </div>
    `;
  }

  private checkpointHtml(state: RunState): string {
    if (!state.repo) return "";
    const queueDepth = queuedMessages(state).length;
    const marker = state.lastMarker?.status ?? "none";
    const item = state.lastMarker?.item ?? "none";
    const lifecycle = state.lastLifecycleSignal ?? "none";
    const markerUrl = state.lastMarker?.url ?? "";
    const url = /^https:\/\/github\.com\//i.test(markerUrl)
      ? `<a class="cfpt-link" href="${esc(markerUrl)}" target="_blank" rel="noreferrer noopener">${esc(markerUrl)}</a>`
      : esc(markerUrl || "none");
    return `
      <div class="cfpt-field" data-ref="checkpoint">
        <strong>Ultra Code checkpoint</strong>
        <p class="cfpt-note">Repo: ${esc(state.repo)}</p>
        <p class="cfpt-note">Phase: ${esc(phaseLabel(state.phase))} · Item: ${esc(item)} · Marker: ${esc(marker)}</p>
        <p class="cfpt-note">Queue: ${queueDepth} · Last lifecycle: ${esc(lifecycle)}</p>
        <p class="cfpt-note">CI / PR: ${url}</p>
      </div>
    `;
  }

  private diagnosticsHtml(): string {
    return `
      <div class="cfpt-field">
        <strong>State diagnostics</strong>
        <p class="cfpt-note" data-ref="diagnostics-status"></p>
        <button class="cfpt-btn" type="button" data-action="diagnostics-start">Start recording</button>
        <button class="cfpt-btn" type="button" data-action="diagnostics-stop">Stop recording</button>
        <button class="cfpt-btn" type="button" data-action="diagnostics-export">Export JSON</button>
        <p class="cfpt-note">Captures page, DOM, lifecycle, extension state, and redacted network structure. It does not save chat text, typed prompts, cookies, OAuth data, or authorization headers.</p>
      </div>
    `;
  }

  private queueControlsHtml(queue: string[]): string {
    const items = queue
      .map(
        (message, index) => `
          <div class="cfpt-field" data-ref="queue-item" data-index="${index}">
            <p class="cfpt-note"><strong>${index + 1}.</strong> ${esc(message)}</p>
            <button class="cfpt-btn" type="button" data-action="queue-up" data-index="${index}" ${index === 0 ? "disabled" : ""}>Move up</button>
            <button class="cfpt-btn" type="button" data-action="queue-down" data-index="${index}" ${index === queue.length - 1 ? "disabled" : ""}>Move down</button>
            <button class="cfpt-btn" type="button" data-action="queue-remove" data-index="${index}">Remove</button>
          </div>`,
      )
      .join("");
    return `
      <div class="cfpt-field">
        <strong>Message queue · ${queue.length}</strong>
        <p class="cfpt-note">Queued messages run FIFO before generic auto-continue.</p>
        ${items}
        <button class="cfpt-btn" type="button" data-action="showqueue">Add queued message</button>
        ${queue.length > 0 ? '<button class="cfpt-btn" type="button" data-action="clearqueue">Clear all</button>' : ""}
        <div class="cfpt-field cfpt-hidden" data-ref="queue-editor">
          <label>Queued user message</label>
          <textarea data-ref="queue-next" rows="3" placeholder="Send this at the next safe turn boundary…"></textarea>
          <button class="cfpt-btn cfpt-btn-primary" type="button" data-action="savequeue">Add to queue</button>
          <button class="cfpt-btn" type="button" data-action="hidequeue">Cancel</button>
        </div>
      </div>`;
  }

  private passiveHtml(state: RunState): string {
    return `
      <h3>Active in another tab</h3>
      <p class="cfpt-note">Another ChatGPT tab currently owns this conversation. This tab is read-only and will take over automatically if the other tab closes or stops responding.</p>
      <p class="cfpt-note">Current state: ${esc(phaseLabel(state.phase))} · ${esc(
        STATUS_LABEL[state.status] ?? state.status,
      )}</p>
    `;
  }

  private ideaFormHtml(state: RunState): string {
    const repoField = state.repo
      ? `<div class="cfpt-field">
           <label>Repository locked to this conversation</label>
           <input type="text" data-ref="reponame" value="${esc(state.repo)}" readonly />
           <p class="cfpt-note">To use a different repository, start a new ChatGPT conversation.</p>
         </div>`
      : `<div class="cfpt-field">
           <label>GitHub repository</label>
           <input type="text" data-ref="reponame" value="" placeholder="owner/repo or https://github.com/owner/repo" />
           <p class="cfpt-note">Need a new one? <a class="cfpt-link" href="https://github.com/new" target="_blank" rel="noreferrer noopener">Create a private repository on GitHub</a>, then paste its owner/name or URL here.</p>
           <p class="cfpt-note" data-ref="repo-error"></p>
         </div>`;

    return `
      <h3>What should ChatGPT build for you?</h3>
      ${repoField}
      <div class="cfpt-field">
        <textarea data-ref="idea" rows="6" placeholder="Describe the project you want built…">${esc(
          state.idea,
        )}</textarea>
      </div>
      <p class="cfpt-note">One ChatGPT conversation is permanently bound to one GitHub repository. Chat FreePT will verify access to that exact repo before work begins.</p>
      <button class="cfpt-btn" type="button" data-action="setup-open">Repository setup</button>
      <button class="cfpt-btn cfpt-btn-primary" data-action="start">Start planning</button>
    `;
  }

  private runningHtml(state: RunState): string {
    const sendNow =
      state.status === "cooldown"
        ? `<button class="cfpt-btn" data-action="sendnow">Send now</button>`
        : "";
    return `
      <div class="cfpt-status-line"><span class="cfpt-spinner"></span>
        <strong data-ref="statusline">${esc(STATUS_LABEL[state.status] ?? state.status)}</strong>
      </div>
      <div class="cfpt-counters" data-ref="counters"></div>
      <div class="cfpt-log" data-ref="log"></div>
      ${sendNow}
      <button class="cfpt-btn" data-action="pause">Pause</button>
      <button class="cfpt-btn cfpt-btn-danger" data-action="stop">Stop</button>
    `;
  }

  private planReadyHtml(state: RunState): string {
    return `
      <h3>Master plan ready</h3>
      <p class="cfpt-note">${esc(state.planSummary ?? "Review the plan in the conversation.")}</p>
      ${repoLine(state)}
      <p class="cfpt-note">Want changes? Reply in the chat and the plan phase resumes automatically. Happy with it?</p>
      <button class="cfpt-btn cfpt-btn-primary" data-action="startdev">Start development</button>
      <button class="cfpt-btn cfpt-btn-danger" data-action="stop">Stop</button>
    `;
  }

  private needsInputHtml(state: RunState): string {
    const autoPaused = isWaitingForManualContinue(state);
    return `
      <h3>${autoPaused ? "Auto-continue is off" : "ChatGPT needs your input"}</h3>
      <p class="cfpt-note">${esc(state.pauseReason ?? "See the conversation for the question.")}</p>
      ${
        autoPaused
          ? ""
          : `<div class="cfpt-field">
               <textarea data-ref="reply" rows="4" placeholder="Type your answer…"></textarea>
             </div>
             <button class="cfpt-btn cfpt-btn-primary" data-action="reply">Send reply</button>
             <button class="cfpt-btn" data-action="resume">I answered in the chat — resume</button>`
      }
      <button class="cfpt-btn cfpt-btn-danger" data-action="stop">Stop</button>
    `;
  }

  private pausedHtml(state: RunState): string {
    const handoff =
      state.errorCode === "conversation-full"
        ? `<button class="cfpt-btn" data-action="copyhandoff">Copy handoff prompt for a new chat</button>`
        : "";
    return `
      <h3>${state.status === "error" ? "Paused on a problem" : "Paused"}</h3>
      <p class="cfpt-note">${esc(state.pauseReason ?? "")}</p>
      <div class="cfpt-log" data-ref="log"></div>
      ${handoff}
      <button class="cfpt-btn cfpt-btn-primary" data-action="resume">Resume</button>
      <button class="cfpt-btn cfpt-btn-danger" data-action="stop">Stop</button>
    `;
  }

  private completeHtml(state: RunState): string {
    return `
      <h3>Development complete</h3>
      ${repoLine(state)}
      <p class="cfpt-note">ChatGPT reports the project is done — verify it at the repo.</p>
      <button class="cfpt-btn cfpt-btn-primary" data-action="newproject">New project</button>
    `;
  }

  private updateDynamic(state: RunState): void {
    const counters = this.panelEl.querySelector('[data-ref="counters"]');
    if (counters) {
      const bits = [`auto-continues: ${state.autoSends}`];
      const queueDepth = queuedMessages(state).length;
      if (queueDepth) bits.push(`queue: ${queueDepth}`);
      if (state.lastMarker?.item) bits.push(`item ${state.lastMarker.item}`);
      if (state.repo) bits.push(state.repo);
      counters.textContent = bits.join(" · ");
    }
    const logEl = this.panelEl.querySelector('[data-ref="log"]');
    if (logEl) {
      logEl.innerHTML = state.log
        .slice(-8)
        .map((entry) => {
          const time = new Date(entry.at).toLocaleTimeString();
          return `<div class="${esc(entry.kind)}">${esc(time)} ${esc(entry.text)}</div>`;
        })
        .join("");
      logEl.scrollTop = logEl.scrollHeight;
    }
    const statusLine = this.panelEl.querySelector('[data-ref="statusline"]');
    if (statusLine) statusLine.textContent = STATUS_LABEL[state.status] ?? state.status;
    this.updateDiagnosticsDom();
  }

  private updateDiagnosticsDom(): void {
    const status = this.diagnosticsStatus;
    const line = this.panelEl.querySelector<HTMLElement>('[data-ref="diagnostics-status"]');
    if (line) {
      line.textContent = status.recording
        ? `Recording · ${status.records} events${status.dropped ? ` · ${status.dropped} trimmed` : ""}`
        : status.records > 0
          ? `Stopped · ${status.records} events ready to export`
          : "Not recording";
    }
    const start = this.panelEl.querySelector<HTMLButtonElement>(
      '[data-action="diagnostics-start"]',
    );
    const stop = this.panelEl.querySelector<HTMLButtonElement>('[data-action="diagnostics-stop"]');
    const exportButton = this.panelEl.querySelector<HTMLButtonElement>(
      '[data-action="diagnostics-export"]',
    );
    if (start) start.disabled = status.recording;
    if (stop) stop.disabled = !status.recording;
    if (exportButton) exportButton.disabled = status.records === 0;
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
      case "tip-continue":
        void this.acknowledgeLauncherTip(this.tipCheckboxChecked());
        break;
      case "setup-open":
        this.showSetupModal();
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

function airplaneSvg(): string {
  return `
    <svg class="cfpt-airplane" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 2.5c-.8 0-1.4.6-1.4 1.4v5.3L3 13.8v2l7.6-2.4v4.2l-2.3 1.7v1.4l3.7-1.1 3.7 1.1v-1.4l-2.3-1.7v-4.2l7.6 2.4v-2l-7.6-4.6V3.9c0-.8-.6-1.4-1.4-1.4Z"></path>
    </svg>`;
}

function launcherTipHtml(): string {
  return `
    <button class="cfpt-icon-close" type="button" data-action="tip-continue" aria-label="Dismiss launcher tip">×</button>
    <strong>Chat FreePT lives here</strong>
    <p>The airplane sits beside ChatGPT's + button. Open it whenever you want Chat FreePT to take over the composer.</p>
    <label class="cfpt-check-row">
      <input type="checkbox" data-ref="suppress-launcher-tip" />
      <span>Don't show this tip again</span>
    </label>
    <button class="cfpt-btn cfpt-btn-primary cfpt-toast-continue" type="button" data-action="tip-continue">Continue</button>`;
}

function repositorySetupHtml(): string {
  return `
    <section class="cfpt-setup-card" role="region" aria-labelledby="cfpt-setup-title">
      <button class="cfpt-icon-close" type="button" data-action="setup-done" aria-label="Close repository setup">×</button>
      <div class="cfpt-setup-icon" aria-hidden="true">${airplaneSvg()}</div>
      <div class="cfpt-plan-badge">One conversation · one repository</div>
      <h2 id="cfpt-setup-title">Choose the GitHub repository first</h2>
      <p class="cfpt-setup-lead">Chat FreePT locks this ChatGPT conversation to one repository before planning starts. Existing repositories work immediately.</p>
      <ol class="cfpt-setup-steps">
        <li>For a new project, <a class="cfpt-link" href="https://github.com/new" target="_blank" rel="noreferrer noopener">create a private repository on GitHub</a>.</li>
        <li>Return here and enter <strong>owner/repo</strong> or the root GitHub repository URL.</li>
        <li>Describe the project and press <strong>Start planning</strong>.</li>
        <li>ChatGPT verifies write access and CI capabilities against that exact repository. Missing access stops with <strong>NEEDS_INPUT</strong>.</li>
      </ol>
      <p class="cfpt-setup-footnote">Once planning starts, the repository is read-only for this conversation. Start a new ChatGPT conversation to work in another repo.</p>
      <div class="cfpt-setup-actions">
        <button class="cfpt-btn cfpt-btn-primary" type="button" data-action="setup-done">Continue</button>
      </div>
    </section>`;
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "idle":
      return "Ready";
    case "planning":
      return "Planning";
    case "plan_ready":
      return "Plan ready";
    case "developing":
      return "Developing";
    case "complete":
      return "Complete";
    case "stopped":
      return "Stopped";
    default:
      return phase;
  }
}

function launcherState(state: RunState): string {
  if (state.status === "error") return "error";
  if (state.status === "awaiting_user") return "attention";
  if (state.status === "complete") return "done";
  if (state.status === "idle") return "idle";
  return "run";
}

function repoLine(state: RunState): string {
  if (!state.repo) return "";
  return `<p class="cfpt-note">Repo: <a class="cfpt-link" href="https://github.com/${esc(
    state.repo,
  )}" target="_blank" rel="noreferrer noopener">${esc(state.repo)}</a></p>`;
}
