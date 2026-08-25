import type { MachineEvent } from "../../common/state-machine";
import type { RunState } from "../../common/types";
import { healthCheck, query } from "../selectors";
import { PANEL_CSS } from "./styles";

export interface PanelHooks {
  onEvent: (event: MachineEvent) => void;
  onNewProject: () => void;
  getHandoffPrompt: () => string;
}

interface OnboardingState {
  launcherTipSuppressed: boolean;
  setupShown: boolean;
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

/**
 * Compact Chat FreePT controls mounted directly inside ChatGPT's composer surface. The
 * airplane launcher is always present; the full controls float above it only while open.
 * A closed shadow root isolates both style systems while a subtree observer re-homes the
 * single host when ChatGPT replaces its composer during SPA navigation or hydration.
 */
export class Panel {
  private readonly host: HTMLDivElement;
  private readonly shadow: ShadowRoot;
  private readonly launcher: HTMLButtonElement;
  private readonly panelEl: HTMLDivElement;
  private readonly launcherTipEl: HTMLDivElement;
  private readonly setupBackdropEl: HTMLDivElement;
  private readonly mountObserver: MutationObserver;
  private lastViewKey = "";
  private stopArmed = false;
  private mountQueued = false;
  private disposed = false;
  private onboarding = { ...DEFAULT_ONBOARDING };

  constructor(private readonly hooks: PanelHooks) {
    this.host = document.createElement("div");
    this.host.id = "cfpt-root";
    this.host.dataset["cfptEmbedded"] = "true";
    this.host.dataset["cfptLauncher"] = "airplane";
    this.host.dataset["expanded"] = "false";
    this.host.dataset["onboarding"] = "loading";
    this.host.dataset["highlighted"] = "false";
    this.shadow = this.host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = PANEL_CSS;
    this.shadow.appendChild(style);

    this.panelEl = document.createElement("div");
    this.panelEl.className = "cfpt-panel cfpt-hidden";
    this.shadow.appendChild(this.panelEl);

    this.launcher = document.createElement("button");
    this.launcher.type = "button";
    this.launcher.className = "cfpt-launcher";
    this.launcher.title = "Open Chat FreePT";
    this.launcher.setAttribute("aria-label", "Open Chat FreePT");
    this.launcher.setAttribute("aria-expanded", "false");
    this.launcher.innerHTML = `
      <svg class="cfpt-airplane" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M12 2.5c-.8 0-1.4.6-1.4 1.4v5.3L3 13.8v2l7.6-2.4v4.2l-2.3 1.7v1.4l3.7-1.1 3.7 1.1v-1.4l-2.3-1.7v-4.2l7.6 2.4v-2l-7.6-4.6V3.9c0-.8-.6-1.4-1.4-1.4Z"></path>
      </svg>
    `;
    this.launcher.addEventListener("click", () => {
      if (!this.launcherTipEl.classList.contains("cfpt-hidden")) {
        void this.acknowledgeLauncherTip(this.tipCheckboxChecked());
      }
      this.toggle();
    });
    this.shadow.appendChild(this.launcher);

    this.launcherTipEl = document.createElement("div");
    this.launcherTipEl.className = "cfpt-onboarding-toast cfpt-hidden";
    this.launcherTipEl.setAttribute("role", "status");
    this.launcherTipEl.innerHTML = `
      <div class="cfpt-toast-arrow" aria-hidden="true"></div>
      <button class="cfpt-icon-close" type="button" data-action="tip-continue" aria-label="Dismiss launcher tip">×</button>
      <strong>Chat FreePT lives here</strong>
      <p>Use the airplane inside the ChatGPT input whenever you want to open Chat FreePT.</p>
      <label class="cfpt-check-row">
        <input type="checkbox" data-ref="suppress-launcher-tip" />
        <span>Don't show this tip again</span>
      </label>
      <button class="cfpt-btn cfpt-btn-primary cfpt-toast-continue" type="button" data-action="tip-continue">Continue</button>
    `;
    this.shadow.appendChild(this.launcherTipEl);

    this.setupBackdropEl = document.createElement("div");
    this.setupBackdropEl.className = "cfpt-setup-backdrop cfpt-hidden";
    this.setupBackdropEl.setAttribute("role", "presentation");
    this.setupBackdropEl.innerHTML = `
      <section class="cfpt-setup-card" role="dialog" aria-modal="true" aria-labelledby="cfpt-setup-title">
        <button class="cfpt-icon-close" type="button" data-action="setup-done" aria-label="Close setup instructions">×</button>
        <div class="cfpt-setup-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false"><path d="M12 2.5c-.8 0-1.4.6-1.4 1.4v5.3L3 13.8v2l7.6-2.4v4.2l-2.3 1.7v1.4l3.7-1.1 3.7 1.1v-1.4l-2.3-1.7v-4.2l7.6 2.4v-2l-7.6-4.6V3.9c0-.8-.6-1.4-1.4-1.4Z"></path></svg>
        </div>
        <h2 id="cfpt-setup-title">Set up GitHub access once</h2>
        <p class="cfpt-setup-lead">For fully autonomous new-repository work, ChatGPT needs a GitHub MCP app with repository and workflow write access.</p>
        <ol class="cfpt-setup-steps">
          <li>Open <strong>Settings → Security and login → Developer mode</strong> and turn it on.</li>
          <li>Open ChatGPT Plugins, select <strong>+</strong>, and add <code>https://api.githubcopilot.com/mcp/</code> using OAuth.</li>
          <li>In the conversation's Plus menu, choose <strong>Developer mode</strong> and select that GitHub app.</li>
          <li>Authorize the repository and workflow write access Chat FreePT's preflight requests.</li>
        </ol>
        <p class="cfpt-setup-footnote">Existing repositories may work with another GitHub connector if it passes Chat FreePT's capability preflight. Chat FreePT never receives your GitHub credentials.</p>
        <div class="cfpt-setup-actions">
          <a class="cfpt-btn" href="https://chatgpt.com/plugins" target="_blank" rel="noreferrer noopener">Open ChatGPT Plugins</a>
          <button class="cfpt-btn cfpt-btn-primary" type="button" data-action="setup-done">Got it</button>
        </div>
      </section>
    `;
    this.shadow.appendChild(this.setupBackdropEl);

    this.shadow.addEventListener("click", (event) => this.onClick(event));
    this.setupBackdropEl.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !this.setupBackdropEl.classList.contains("cfpt-hidden")) {
        void this.acknowledgeSetup();
      }
    });

    this.mountObserver = new MutationObserver(() => this.scheduleMount());
    this.mountObserver.observe(document.documentElement, { childList: true, subtree: true });
    this.mount();
    void this.initOnboarding();
  }

  toggle(force?: boolean): void {
    const show = force ?? this.panelEl.classList.contains("cfpt-hidden");
    this.panelEl.classList.toggle("cfpt-hidden", !show);
    this.host.dataset["expanded"] = String(show);
    this.launcher.setAttribute("aria-expanded", String(show));
    this.launcher.setAttribute("aria-label", show ? "Close Chat FreePT" : "Open Chat FreePT");
  }

  render(state: RunState, passive = false): void {
    const visualState = passive ? "attention" : launcherState(state);
    this.host.dataset["state"] = visualState;
    this.host.dataset["status"] = state.status;
    this.host.dataset["phase"] = state.phase;
    this.launcher.dataset["state"] = visualState;
    const status = passive ? "Active in another tab" : (STATUS_LABEL[state.status] ?? state.status);
    this.launcher.title = `Chat FreePT · ${phaseLabel(state.phase)} · ${status}`;

    const viewKey = `${state.phase}|${state.status}|${state.pauseReason ?? ""}|${passive}`;
    if (viewKey !== this.lastViewKey) {
      this.lastViewKey = viewKey;
      this.stopArmed = false;
      this.panelEl.innerHTML = `<div class="cfpt-body">${this.bodyHtml(state, passive)}</div>`;
    }
    this.updateDynamic(state);
    this.mount();
  }

  dispose(): void {
    this.disposed = true;
    this.mountObserver.disconnect();
    this.host.remove();
  }

  async acknowledgeLauncherTip(suppress: boolean): Promise<void> {
    this.launcherTipEl.classList.add("cfpt-hidden");
    this.host.dataset["highlighted"] = "false";
    if (suppress) this.onboarding.launcherTipSuppressed = true;
    await this.persistOnboarding();
    if (!this.onboarding.setupShown) {
      this.showSetupModal();
    } else {
      this.host.dataset["onboarding"] = "done";
    }
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

  private async initOnboarding(): Promise<void> {
    try {
      const found = await chrome.storage.local.get(ONBOARDING_KEY);
      this.onboarding = normalizeOnboarding(found[ONBOARDING_KEY]);
    } catch {
      this.onboarding = { ...DEFAULT_ONBOARDING };
    }
    if (this.disposed) return;

    if (!this.onboarding.launcherTipSuppressed) {
      this.showLauncherTip();
      return;
    }
    if (!this.onboarding.setupShown) {
      this.showSetupModal();
      return;
    }
    this.host.dataset["onboarding"] = "done";
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
  }

  private showSetupModal(): void {
    this.launcherTipEl.classList.add("cfpt-hidden");
    this.host.dataset["highlighted"] = "false";
    this.setupBackdropEl.classList.remove("cfpt-hidden");
    this.host.dataset["onboarding"] = "setup";
    queueMicrotask(() => {
      const button = this.setupBackdropEl.querySelector<HTMLButtonElement>(
        '[data-action="setup-done"]',
      );
      button?.focus();
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
    const anchor = query("composerSurface") ?? query("composerHeader");
    if (!anchor || this.host.parentElement === anchor) return;
    anchor.appendChild(this.host);
  }

  private bodyHtml(state: RunState, passive: boolean): string {
    const health = healthCheck();
    const warn =
      health.missing.length > 0
        ? `<div class="cfpt-warn">ChatGPT's page structure changed — missing: ${esc(
            health.missing.join(", "),
          )}. Auto-run cannot operate until the extension is updated.</div>`
        : "";

    if (passive) return warn + this.passiveHtml(state);

    switch (state.status) {
      case "idle":
        return warn + this.ideaFormHtml(state);
      case "inserting":
      case "sending":
      case "streaming":
      case "cooldown":
        return warn + this.runningHtml(state);
      case "awaiting_user":
        return (
          warn +
          (state.phase === "plan_ready" ? this.planReadyHtml(state) : this.needsInputHtml(state))
        );
      case "paused":
      case "error":
        return warn + this.pausedHtml(state);
      case "complete":
        return warn + this.completeHtml(state);
      default:
        return warn;
    }
  }

  private passiveHtml(state: RunState): string {
    return `
      <h3>Active in another tab</h3>
      <p class="cfpt-note">Another ChatGPT tab currently owns this conversation. This tab is
      read-only and will take over automatically if the other tab closes or stops responding.</p>
      <p class="cfpt-note">Current state: ${esc(phaseLabel(state.phase))} · ${esc(
        STATUS_LABEL[state.status] ?? state.status,
      )}</p>
    `;
  }

  private ideaFormHtml(state: RunState): string {
    return `
      <h3>What should ChatGPT build for you?</h3>
      <div class="cfpt-field">
        <textarea data-ref="idea" rows="5" placeholder="Describe the project you want built…">${esc(
          state.idea,
        )}</textarea>
      </div>
      <div class="cfpt-radio-row">
        <label><input type="radio" name="repomode" value="new" ${
          state.repoMode === "new" ? "checked" : ""
        }/> New private repo</label>
        <label><input type="radio" name="repomode" value="existing" ${
          state.repoMode === "existing" ? "checked" : ""
        }/> Existing repo</label>
      </div>
      <div class="cfpt-field">
        <label>Repo name (optional for new; owner/name for existing)</label>
        <input type="text" data-ref="reponame" value="${esc(state.repoName)}" placeholder="e.g. my-idea or owner/my-repo"/>
      </div>
      <p class="cfpt-note">New private repos generally need GitHub's official remote MCP in
      ChatGPT Developer Mode because repository and label creation are required. Existing
      repos can use any GitHub toolset that passes the mode-aware preflight. Chat FreePT
      never receives your GitHub credentials. <a class="cfpt-link" href="https://chatgpt.com/plugins"
      target="_blank" rel="noreferrer noopener">Open ChatGPT Plugins</a>.</p>
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
      <p class="cfpt-note">Want changes? Just reply in the chat — the plan phase resumes
      automatically. Happy with it?</p>
      <button class="cfpt-btn cfpt-btn-primary" data-action="startdev">Start development</button>
      <button class="cfpt-btn cfpt-btn-danger" data-action="stop">Stop</button>
    `;
  }

  private needsInputHtml(state: RunState): string {
    return `
      <h3>ChatGPT needs your input</h3>
      <p class="cfpt-note">${esc(state.pauseReason ?? "See the conversation for the question.")}</p>
      <div class="cfpt-field">
        <textarea data-ref="reply" rows="3" placeholder="Type your answer…"></textarea>
      </div>
      <button class="cfpt-btn cfpt-btn-primary" data-action="reply">Send reply</button>
      <button class="cfpt-btn" data-action="resume">I answered in the chat — resume</button>
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

  private onClick(e: Event): void {
    const target = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
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
        this.hooks.onNewProject();
        break;
      case "copyhandoff":
        this.copyHandoff(target);
        break;
      case "tip-continue":
        void this.acknowledgeLauncherTip(this.tipCheckboxChecked());
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
