import {
  autoContinueEnabled,
  isWaitingForManualContinue,
  type MachineEvent,
} from "../../common/state-machine";
import type { RunState } from "../../common/types";
import { healthCheck, query, queryGuideTarget } from "../selectors";
import { SetupGuide } from "./setup-guide";
import { PANEL_CSS } from "./styles";

export interface PanelHooks {
  onEvent: (event: MachineEvent) => void;
  getHandoffPrompt: () => string;
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
  private readonly setupGuide = new SetupGuide();
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

  constructor(private readonly hooks: PanelHooks) {
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

    const viewKey = `${state.phase}|${state.status}|${state.pauseReason ?? ""}|${autoContinueEnabled(state)}|${state.queuedUserText ?? ""}|${passive}`;
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
    this.setupGuide.dispose();
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

  private showSetupModal(mode: "paid" | "free" = "paid"): void {
    this.launcherTipEl.classList.add("cfpt-hidden");
    this.host.dataset["highlighted"] = "false";
    this.setupBackdropEl.innerHTML = mode === "free" ? freeSetupHtml() : paidSetupHtml();
    this.setupBackdropEl.classList.remove("cfpt-hidden");
    this.host.dataset["onboarding"] = "setup";
    queueMicrotask(() => {
      this.setupBackdropEl.querySelector<HTMLButtonElement>("button")?.focus();
    });
  }

  private async startSetupGuide(): Promise<void> {
    this.setupBackdropEl.classList.add("cfpt-hidden");
    this.onboarding.setupShown = true;
    this.host.dataset["onboarding"] = "done";
    await this.persistOnboarding();
    this.toggle(false);
    await this.setupGuide.start();
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
    if (passive) return warn + this.passiveHtml(state);
    const controls = this.automationControlsHtml(state);
    return warn + controls + this.statusBodyHtml(state);
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
    const queued = state.queuedUserText?.trim() ?? "";
    const queueControls = canQueueNext(state) ? this.queueControlsHtml(queued) : "";
    return `
      <div class="cfpt-field">
        <label class="cfpt-check-row">
          <input type="checkbox" data-action="auto-continue" ${enabled ? "checked" : ""} />
          <span><strong>Auto-continue</strong></span>
        </label>
        <p class="cfpt-note">When off, Chat FreePT waits instead of sending its next automatic continue. A queued user message still sends once.</p>
        ${queueControls}
      </div>
    `;
  }

  private queueControlsHtml(queued: string): string {
    const summary = queued
      ? `<p class="cfpt-note"><strong>Queued next:</strong> ${esc(queued)}</p>
         <button class="cfpt-btn" type="button" data-action="showqueue">Edit queued message</button>
         <button class="cfpt-btn" type="button" data-action="clearqueue">Clear queued message</button>`
      : `<button class="cfpt-btn" type="button" data-action="showqueue">Queue next message</button>`;
    return `
      <div class="cfpt-field">
        ${summary}
        <div class="cfpt-field cfpt-hidden" data-ref="queue-editor">
          <label>Next user message</label>
          <textarea data-ref="queue-next" rows="3" placeholder="Send this instead of the next automatic continue…">${esc(queued)}</textarea>
          <button class="cfpt-btn cfpt-btn-primary" type="button" data-action="savequeue">Save queued message</button>
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
    return `
      <h3>What should ChatGPT build for you?</h3>
      <div class="cfpt-field">
        <textarea data-ref="idea" rows="6" placeholder="Describe the project you want built…">${esc(
          state.idea,
        )}</textarea>
      </div>
      <div class="cfpt-radio-row">
        <label><input type="radio" name="repomode" value="new" ${state.repoMode === "new" ? "checked" : ""}/> New private repo</label>
        <label><input type="radio" name="repomode" value="existing" ${state.repoMode === "existing" ? "checked" : ""}/> Existing repo</label>
      </div>
      <div class="cfpt-field">
        <label>Repo name (optional for new; owner/name for existing)</label>
        <input type="text" data-ref="reponame" value="${esc(state.repoName)}" placeholder="e.g. my-idea or owner/my-repo"/>
      </div>
      <p class="cfpt-note">Full autonomous GitHub work uses Developer mode + the remote GitHub MCP. Free-plan users can still use Chat FreePT in an assisted workflow, but should prepare an existing repo first and expect manual GitHub steps when ChatGPT lacks write tools.</p>
      <button class="cfpt-btn" type="button" data-action="setup-open">GitHub setup</button>
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
      case "clearqueue":
        this.hooks.onEvent({ type: "USER_CLEAR_QUEUE" });
        break;
      case "tip-continue":
        void this.acknowledgeLauncherTip(this.tipCheckboxChecked());
        break;
      case "setup-open":
      case "setup-back":
        this.showSetupModal();
        break;
      case "free-setup":
        this.showSetupModal("free");
        break;
      case "setup-guide":
        void this.startSetupGuide();
        break;
      case "setup-done":
        void this.acknowledgeSetup();
        break;
    }
  }

  private startProject(): void {
    const idea = this.refValue("idea");
    if (!idea.trim()) return;
    this.hooks.onEvent({
      type: "USER_START",
      idea,
      repoMode: this.radioValue("repomode") === "existing" ? "existing" : "new",
      repoName: this.refValue("reponame").trim(),
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
    const text = this.refValue("queue-next").trim();
    if (!text) return;
    this.hooks.onEvent({ type: "USER_QUEUE_NEXT", text });
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

  private radioValue(name: string): string {
    const el = this.panelEl.querySelector(
      `input[name="${name}"]:checked`,
    ) as HTMLInputElement | null;
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

function paidSetupHtml(): string {
  return `
    <section class="cfpt-setup-card" role="dialog" aria-modal="true" aria-labelledby="cfpt-setup-title">
      <button class="cfpt-icon-close" type="button" data-action="setup-done" aria-label="Close setup">×</button>
      <div class="cfpt-setup-icon" aria-hidden="true">${airplaneSvg()}</div>
      <div class="cfpt-plan-badge">Paid plan · full GitHub automation</div>
      <h2 id="cfpt-setup-title">Connect GitHub with a follow-along guide</h2>
      <p class="cfpt-setup-lead">For full autonomous repository work, Chat FreePT needs ChatGPT's Developer mode and a custom GitHub MCP/plugin with the write permissions you approve. ChatGPT marks Developer mode as Elevated Risk because unverified connectors can modify data.</p>
      <p class="cfpt-setup-lead">The guide opens Settings, enables Developer mode, then takes you to Plugins. It can open the custom app form and fill the GitHub MCP name, remote server URL, and OAuth choice automatically. You still approve ChatGPT's risk warning and GitHub OAuth yourself; afterward the guide returns here and Chat FreePT verifies the actual GitHub capabilities.</p>
      <div class="cfpt-setup-actions">
        <button class="cfpt-btn" type="button" data-action="free-setup">Using ChatGPT Free?</button>
        <button class="cfpt-btn" type="button" data-action="setup-done">I'll set it up myself</button>
        <button class="cfpt-btn cfpt-btn-primary" type="button" data-action="setup-guide">Follow along</button>
      </div>
    </section>`;
}

function freeSetupHtml(): string {
  return `
    <section class="cfpt-setup-card" role="dialog" aria-modal="true" aria-labelledby="cfpt-free-title">
      <button class="cfpt-icon-close" type="button" data-action="setup-done" aria-label="Close setup">×</button>
      <div class="cfpt-plan-badge">ChatGPT Free · assisted GitHub workflow</div>
      <h2 id="cfpt-free-title">Prepare GitHub manually first</h2>
      <p class="cfpt-setup-lead">Chat FreePT's local planning, continuation, queueing, pause, and NEEDS_INPUT flow still works on Free. The limitation is the full custom-MCP/Developer-mode path, so repository actions may need you.</p>
      <ol class="cfpt-setup-steps">
        <li>Create the target GitHub repository yourself before starting Chat FreePT.</li>
        <li>Make sure <strong>main</strong> exists and create <strong>dev</strong> from the same starting commit.</li>
        <li>In Chat FreePT choose <strong>Existing repo</strong> and enter <code>owner/repo</code>; do not rely on New private repo creation.</li>
        <li>Enable whatever GitHub/plugin access your ChatGPT account currently exposes. If no write tool is available, keep GitHub open separately.</li>
        <li>When ChatGPT cannot create a branch/file, Issue/label, PR, merge, or inspect CI, it should stop with <strong>NEEDS_INPUT</strong>. Perform only that requested GitHub step manually, return to the chat, and Resume.</li>
        <li>Because those writes are manual, Free mode is assisted rather than fully autonomous; never treat a missing/zero CI result as green.</li>
      </ol>
      <p class="cfpt-setup-footnote">Chat FreePT does not receive your GitHub password or token. Workspace policy and ChatGPT feature availability can vary by account.</p>
      <div class="cfpt-setup-actions">
        <button class="cfpt-btn" type="button" data-action="setup-back">Back</button>
        <button class="cfpt-btn cfpt-btn-primary" type="button" data-action="setup-done">I understand</button>
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