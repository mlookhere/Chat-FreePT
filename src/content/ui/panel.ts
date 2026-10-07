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
  element: HTMLElement;
  pointerEvents: string;
  inert: boolean;
}

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

/** Native-feeling launcher plus a body-level composer takeover that cannot inherit ChatGPT focus traps. */
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
  private lastViewKey = "";
  private stopArmed = false;
  private mountQueued = false;
  private disposed = false;
  private onboarding = { ...DEFAULT_ONBOARDING };
  private nativeSurface: NativeSurfaceSnapshot | null = null;
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
    this.mount();
    void this.initOnboarding();
  }

  setDiagnosticsStatus(status: DiagnosticsStatus): void {
    this.diagnosticsStatus = status;
    this.updateDiagnosticsDom();
  }

  toggle(force?: boolean): void {
    const show = force ?? this.takeoverBackdropEl.classList.contains("cfpt-hidden");
    this.takeoverBackdropEl.classList.toggle("cfpt-hidden", !show);
    this.panelEl.classList.toggle("cfpt-hidden", !show);
    this.host.dataset["expanded"] = String(show);
    this.launcher.setAttribute("aria-expanded", String(show));
    this.launcher.setAttribute("aria-label", show ? "Close Chat FreePT" : "Open Chat FreePT");
    if (show) {
      this.applyNativeTakeover();
      this.positionTakeover();
    } else {
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
    if (this.host.dataset["expanded"] === "true") this.positionTakeover();
  }

  dispose(): void {
    this.disposed = true;
    this.mountObserver.disconnect();
    window.removeEventListener("resize", this.onViewportChange);
    window.removeEventListener("scroll", this.onViewportChange, true);
    this.restoreNativeTakeover();
    this.host.remove();
    this.overlayHost.remove();
  }

  async acknowledgeLauncherTip(suppress: boolean): Promise<void> {
    this.launcherTipEl.classList.add("cfpt-hidden");
    this.host.dataset["highlighted"] = "false";
    if (suppress) this.onboarding.launcherTipSuppressed = true;
    await this.persistOnboarding();
    if (!this.onboarding.setupShown) this.showSetupModal();
    else this.host.dataset["onboarding"] = "done";
  }

  async acknowledgeSetup(): Promise<void> {
    this.setupBackdropEl.classList.add("cfpt-hidden");
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
    const shadow = host.attachShadow({ mode: "closed" });
    appendStyle(shadow);

    const backdrop = document.createElement("div");
    backdrop.className = "cfpt-takeover-backdrop cfpt-hidden";
    const panel = document.createElement("div");
    panel.className = "cfpt-panel cfpt-hidden";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
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
    document.body.appendChild(host);
    return { host, shadow, backdrop, panel, tip, setup };
  }

  private bindEvents(): void {
    this.shadow.addEventListener("click", (event) => this.onClick(event));
    this.shadow.addEventListener("pointerdown", (event) => this.stopComposerPropagation(event));
    this.shadow.addEventListener("mousedown", (event) => this.stopComposerPropagation(event));
    this.shadow.addEventListener("focusin", (event) => this.stopComposerPropagation(event));
    this.shadow.addEventListener("keydown", (event) => this.onKeyDown(event));
    this.takeoverBackdropEl.addEventListener("click", (event) => {
      if (event.target === this.takeoverBackdropEl) this.toggle(false);
    });
    this.setupBackdropEl.addEventListener("click", (event) => {
      if (event.target === this.setupBackdropEl) void this.acknowledgeSetup();
    });
    window.addEventListener("resize", this.onViewportChange);
    window.addEventListener("scroll", this.onViewportChange, true);
  }

  private readonly onViewportChange = (): void => {
    if (this.host.dataset["expanded"] === "true") this.positionTakeover();
    if (!this.launcherTipEl.classList.contains("cfpt-hidden")) this.positionLauncherTip();
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
    if (!this.launcherTipEl.classList.contains("cfpt-hidden")) {
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
    this.launcherTipEl.classList.remove("cfpt-hidden");
    this.host.dataset["onboarding"] = "tip";
    this.host.dataset["highlighted"] = "true";
    this.positionLauncherTip();
  }

  private showSetupModal(): void {
    this.launcherTipEl.classList.add("cfpt-hidden");
    this.host.dataset["highlighted"] = "false";
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

  private mount(): void {
    const plus = queryGuideTarget("composerPlusButton");
    if (plus?.parentElement) {
      if (plus.nextElementSibling !== this.host) plus.insertAdjacentElement("afterend", this.host);
      this.host.dataset["fallback"] = "false";
    } else {
      const anchor = query("composerSurface") ?? query("composerHeader");
      if (anchor && this.host.parentElement !== anchor) anchor.appendChild(this.host);
      this.host.dataset["fallback"] = "true";
    }
    if (!this.overlayHost.isConnected) document.body.appendChild(this.overlayHost);
    this.syncOverlayTheme();
    if (this.host.dataset["expanded"] === "true") {
      this.applyNativeTakeover();
      this.positionTakeover();
    }
    if (!this.launcherTipEl.classList.contains("cfpt-hidden")) this.positionLauncherTip();
  }

  private syncOverlayTheme(): void {
    const surface = query("composerSurface");
    if (!(surface instanceof HTMLElement)) return;
    const style = getComputedStyle(surface);
    if (style.backgroundColor)
      this.overlayHost.style.setProperty("--cfpt-native-surface", style.backgroundColor);
    if (style.color) this.overlayHost.style.setProperty("--cfpt-native-text", style.color);
  }

  private applyNativeTakeover(): void {
    const surface = query("composerSurface");
    if (!(surface instanceof HTMLElement)) return;
    if (this.nativeSurface?.element === surface) return;
    this.restoreNativeTakeover();
    this.moveFocusOutsideNativeSurface(surface);
    this.nativeSurface = {
      element: surface,
      pointerEvents: surface.style.pointerEvents,
      inert: surface.inert,
    };
    surface.style.pointerEvents = "none";
    surface.inert = true;
    surface.dataset["cfptTakeover"] = "true";
  }

  private moveFocusOutsideNativeSurface(surface: HTMLElement): void {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !surface.contains(active)) return;
    this.panelEl.querySelector<HTMLElement>(".cfpt-panel-close")?.focus({ preventScroll: true });
    if (surface.contains(document.activeElement)) active.blur();
  }

  private restoreNativeTakeover(): void {
    const snapshot = this.nativeSurface;
    if (!snapshot) return;
    snapshot.element.style.pointerEvents = snapshot.pointerEvents;
    snapshot.element.inert = snapshot.inert;
    delete snapshot.element.dataset["cfptTakeover"];
    this.nativeSurface = null;
  }

  private positionTakeover(): void {
    const surface = query("composerSurface");
    if (!(surface instanceof HTMLElement)) return;
    const rect = surface.getBoundingClientRect();
    const viewportWidth = Math.max(320, window.innerWidth);
    const margin = viewportWidth <= 620 ? 8 : 12;
    const fallbackWidth = Math.min(820, viewportWidth - margin * 2);
    const width =
      rect.width >= 280 ? Math.min(rect.width, viewportWidth - margin * 2) : fallbackWidth;
    const left =
      rect.width >= 280
        ? Math.min(Math.max(margin, rect.left), viewportWidth - width - margin)
        : (viewportWidth - width) / 2;
    const bottom = rect.height > 0 ? Math.max(8, window.innerHeight - rect.bottom) : 16;
    Object.assign(this.panelEl.style, {
      left: `${Math.round(left)}px`,
      right: "auto",
      bottom: `${Math.round(bottom)}px`,
      top: "auto",
      width: `${Math.round(width)}px`,
    });
  }

  private positionLauncherTip(): void {
    const rect = this.host.getBoundingClientRect();
    const width = Math.min(310, window.innerWidth - 24);
    const left = Math.min(
      Math.max(12, rect.left - 10),
      Math.max(12, window.innerWidth - width - 12),
    );
    const top = rect.top > 175 ? rect.top - 165 : rect.bottom + 10;
    Object.assign(this.launcherTipEl.style, {
      left: `${Math.round(left)}px`,
      right: "auto",
      top: `${Math.round(Math.max(12, top))}px`,
      bottom: "auto",
    });
  }

  private panelShell(body: string): string {
    return `
      <div class="cfpt-panel-head">
        <strong>Chat FreePT</strong>
        <button class="cfpt-panel-close" type="button" data-action="close" aria-label="Close Chat FreePT">×</button>
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
    const url =
      /^https:\/\/github\.com\//i.test(markerUrl)
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
    <section class="cfpt-setup-card" role="dialog" aria-modal="true" aria-labelledby="cfpt-setup-title">
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
