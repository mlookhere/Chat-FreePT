import type { MachineEvent } from "../../common/state-machine";
import type { RunState } from "../../common/types";
import { healthCheck } from "../selectors";
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
 * The floating launcher + side panel. Rendered inside a closed shadow root so the host
 * page's styles and ours never touch. The body re-renders only when the view key
 * changes; counters and the activity log update in place so textareas keep focus.
 */
export class Panel {
  private readonly host: HTMLDivElement;
  private readonly shadow: ShadowRoot;
  private readonly fab: HTMLButtonElement;
  private readonly panelEl: HTMLDivElement;
  private lastViewKey = "";
  private stopArmed = false;

  constructor(private readonly hooks: PanelHooks) {
    this.host = document.createElement("div");
    this.host.id = "cfpt-root";
    this.shadow = this.host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = PANEL_CSS;
    this.shadow.appendChild(style);

    this.fab = document.createElement("button");
    this.fab.className = "cfpt-fab";
    this.fab.textContent = "FP";
    this.fab.title = "Chat FreePT";
    this.fab.addEventListener("click", () => this.toggle());
    this.shadow.appendChild(this.fab);

    this.panelEl = document.createElement("div");
    this.panelEl.className = "cfpt-panel cfpt-hidden";
    this.panelEl.addEventListener("click", (e) => this.onClick(e));
    this.shadow.appendChild(this.panelEl);

    document.documentElement.appendChild(this.host);

    // The page's framework occasionally rewrites documentElement children; re-attach.
    const keepAlive = new MutationObserver(() => {
      if (!this.host.isConnected) document.documentElement.appendChild(this.host);
    });
    keepAlive.observe(document.documentElement, { childList: true });
  }

  toggle(force?: boolean): void {
    const show = force ?? this.panelEl.classList.contains("cfpt-hidden");
    this.panelEl.classList.toggle("cfpt-hidden", !show);
  }

  render(state: RunState, passive = false): void {
    this.fab.dataset["state"] = passive ? "attention" : fabState(state);

    const viewKey = `${state.phase}|${state.status}|${state.pauseReason ?? ""}|${passive}`;
    if (viewKey !== this.lastViewKey) {
      this.lastViewKey = viewKey;
      this.stopArmed = false;
      this.panelEl.innerHTML = this.viewHtml(state, passive);
    }
    this.updateDynamic(state);
  }

  private viewHtml(state: RunState, passive: boolean): string {
    return `
      <div class="cfpt-header">
        <span class="cfpt-title">Chat FreePT</span>
        <span class="cfpt-chip" data-phase="${esc(state.phase)}">${esc(phaseLabel(state.phase))}</span>
        <button class="cfpt-btn" data-action="close" style="margin:0;padding:2px 8px">×</button>
      </div>
      <div class="cfpt-body">${this.bodyHtml(state, passive)}</div>
    `;
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
      <h3>Development complete 🎉</h3>
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
    const target = (e.target as HTMLElement).closest("[data-action]");
    if (!target) return;
    const action = (target as HTMLElement).dataset["action"];
    switch (action) {
      case "close":
        this.toggle(false);
        break;
      case "start": {
        const idea = this.refValue("idea");
        if (!idea.trim()) return;
        const mode = this.radioValue("repomode") === "existing" ? "existing" : "new";
        this.hooks.onEvent({
          type: "USER_START",
          idea,
          repoMode: mode,
          repoName: this.refValue("reponame").trim(),
        });
        break;
      }
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
      case "reply": {
        const text = this.refValue("reply");
        if (!text.trim()) return;
        this.hooks.onEvent({ type: "USER_REPLY", text });
        break;
      }
      case "stop": {
        if (!this.stopArmed) {
          this.stopArmed = true;
          (target as HTMLElement).textContent = "Confirm stop";
          setTimeout(() => {
            this.stopArmed = false;
            if (target.isConnected) (target as HTMLElement).textContent = "Stop";
          }, 3000);
          return;
        }
        this.hooks.onEvent({ type: "USER_STOP" });
        break;
      }
      case "newproject":
        this.hooks.onNewProject();
        break;
      case "copyhandoff": {
        const prompt = this.hooks.getHandoffPrompt();
        void navigator.clipboard.writeText(prompt).then(() => {
          (target as HTMLElement).textContent = "Copied — paste it into a new chat";
        });
        break;
      }
    }
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

  showCompletionModal(state: RunState): void {
    const existing = this.shadow.querySelector(".cfpt-modal-backdrop");
    if (existing) existing.remove();
    const backdrop = document.createElement("div");
    backdrop.className = "cfpt-modal-backdrop";
    const repoUrl = state.repo ? `https://github.com/${state.repo}` : undefined;
    backdrop.innerHTML = `
      <div class="cfpt-modal">
        <div class="big">🎉</div>
        <h2>Development complete</h2>
        <p>ChatGPT reports every plan item is merged and CI is green${
          state.repo ? ` on <strong>${esc(state.repo)}</strong>` : ""
        }. Verify it at the repository.</p>
        ${
          repoUrl
            ? `<a class="cfpt-btn cfpt-btn-primary cfpt-link" style="color:#fff" href="${esc(
                repoUrl,
              )}" target="_blank" rel="noreferrer noopener">View repository</a>`
            : ""
        }
        <button class="cfpt-btn" data-close="1">Close</button>
      </div>
    `;
    backdrop.addEventListener("click", (e) => {
      const el = e.target as HTMLElement;
      if (el === backdrop || el.dataset["close"]) backdrop.remove();
    });
    this.shadow.appendChild(backdrop);
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

function fabState(state: RunState): string {
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
