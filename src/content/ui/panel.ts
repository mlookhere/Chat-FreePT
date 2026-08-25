import type { MachineEvent } from "../../common/state-machine";
import type { RunState } from "../../common/types";
import { healthCheck, query } from "../selectors";
import { PANEL_CSS } from "./styles";

export interface PanelHooks {
  onEvent: (event: MachineEvent) => void;
  onNewProject: () => void;
  getHandoffPrompt: () => string;
}

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

/**
 * Native-style Chat FreePT controls embedded in ChatGPT's composer header slot. A closed
 * shadow root keeps both style systems isolated, while a subtree observer re-homes the
 * single host when ChatGPT replaces its composer during SPA navigation or hydration.
 */
export class Panel {
  private readonly host: HTMLDivElement;
  private readonly shadow: ShadowRoot;
  private readonly dock: HTMLButtonElement;
  private readonly dockPhase: HTMLSpanElement;
  private readonly dockStatus: HTMLSpanElement;
  private readonly chevron: HTMLSpanElement;
  private readonly panelEl: HTMLDivElement;
  private readonly mountObserver: MutationObserver;
  private lastViewKey = "";
  private stopArmed = false;
  private mountQueued = false;

  constructor(private readonly hooks: PanelHooks) {
    this.host = document.createElement("div");
    this.host.id = "cfpt-root";
    this.host.dataset["cfptEmbedded"] = "true";
    this.host.dataset["expanded"] = "false";
    this.shadow = this.host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = PANEL_CSS;
    this.shadow.appendChild(style);

    this.panelEl = document.createElement("div");
    this.panelEl.className = "cfpt-panel cfpt-hidden";
    this.panelEl.addEventListener("click", (event) => this.onClick(event));
    this.shadow.appendChild(this.panelEl);

    this.dock = document.createElement("button");
    this.dock.type = "button";
    this.dock.className = "cfpt-dock";
    this.dock.title = "Chat FreePT controls";
    this.dock.setAttribute("aria-expanded", "false");
    this.dock.innerHTML = `
      <span class="cfpt-mark" aria-hidden="true">FP</span>
      <span class="cfpt-dock-title">Chat FreePT</span>
      <span class="cfpt-chip" data-phase="idle">Ready</span>
      <span class="cfpt-dock-status">Idle</span>
      <span class="cfpt-chevron" aria-hidden="true">▴</span>
    `;
    this.dock.addEventListener("click", () => this.toggle());
    this.shadow.appendChild(this.dock);

    this.dockPhase = this.requiredShadowElement<HTMLSpanElement>(".cfpt-chip");
    this.dockStatus = this.requiredShadowElement<HTMLSpanElement>(".cfpt-dock-status");
    this.chevron = this.requiredShadowElement<HTMLSpanElement>(".cfpt-chevron");

    this.mountObserver = new MutationObserver(() => this.scheduleMount());
    this.mountObserver.observe(document.documentElement, { childList: true, subtree: true });
    this.mount();
  }

  toggle(force?: boolean): void {
    const show = force ?? this.panelEl.classList.contains("cfpt-hidden");
    this.panelEl.classList.toggle("cfpt-hidden", !show);
    this.host.dataset["expanded"] = String(show);
    this.dock.setAttribute("aria-expanded", String(show));
    this.chevron.textContent = show ? "▾" : "▴";
  }

  render(state: RunState, passive = false): void {
    const visualState = passive ? "attention" : dockState(state);
    this.host.dataset["state"] = visualState;
    this.host.dataset["status"] = state.status;
    this.host.dataset["phase"] = state.phase;
    this.dock.dataset["state"] = visualState;
    this.dockPhase.dataset["phase"] = state.phase;
    this.dockPhase.textContent = phaseLabel(state.phase);
    this.dockStatus.textContent = passive
      ? "Active in another tab"
      : (STATUS_LABEL[state.status] ?? state.status);

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
    this.mountObserver.disconnect();
    this.host.remove();
  }

  private requiredShadowElement<T extends Element>(selector: string): T {
    const element = this.shadow.querySelector(selector);
    if (!element) throw new Error(`Chat FreePT shadow element missing: ${selector}`);
    return element as T;
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
    const anchor = query("composerHeader");
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
      <p class="cfpt-note">Requires a ChatGPT GitHub MCP connector with write access
      (Developer Mode). ChatGPT does all GitHub work itself — this extension never touches
      your repos.</p>
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

  showCompletionModal(_state: RunState): void {
    // Completion stays embedded instead of creating a page-wide overlay.
    this.toggle(true);
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

function dockState(state: RunState): string {
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
