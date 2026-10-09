import { queuedMessages } from "../../common/state-machine";
import type { RunState } from "../../common/types";
import type { DiagnosticsStatus } from "../diagnostics";
import { healthCheck } from "../selectors";

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

const MARKER_LABEL: Record<string, string> = {
  CONTINUE: "Continue",
  NEEDS_INPUT: "Needs input",
  PLAN_READY: "Plan ready",
  TESTING: "Testing",
  COMPLETE: "Complete",
  ERROR: "Error",
};

const LIFECYCLE_LABEL: Record<string, string> = {
  "generation-start": "Generation started",
  "generation-complete": "Generation completed",
  "generation-interrupted": "Generation interrupted",
  "permission-continued": "Permission continued",
  "conversation-handoff": "Conversation handoff",
  "conversation-handoff-started": "New conversation started",
  "interruption-resumed": "Interruption resumed",
  "interruption-recovered": "Interruption recovered",
};

function humanizeToken(value: string): string {
  const words = value.replace(/[_-]+/g, " ").trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? humanizeToken(status);
}

function markerLabel(status: string): string {
  return MARKER_LABEL[status] ?? humanizeToken(status);
}

function lifecycleLabel(signal: string): string {
  return LIFECYCLE_LABEL[signal] ?? humanizeToken(signal);
}

function esc(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function canQueueNext(state: RunState): boolean {
  return state.phase === "planning" || state.phase === "developing";
}

export function airplaneSvg(): string {
  return `
    <svg class="cfpt-airplane" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 2.5c-.8 0-1.4.6-1.4 1.4v5.3L3 13.8v2l7.6-2.4v4.2l-2.3 1.7v1.4l3.7-1.1 3.7 1.1v-1.4l-2.3-1.7v-4.2l7.6 2.4v-2l-7.6-4.6V3.9c0-.8-.6-1.4-1.4-1.4Z"></path>
    </svg>`;
}

export function repositorySetupHtml(): string {
  return `
    <section class="cfpt-setup-card" role="region" aria-labelledby="cfpt-setup-title">
      <button class="cfpt-icon-close" type="button" data-action="setup-done" aria-label="Close repository setup">×</button>
      <div class="cfpt-setup-icon" aria-hidden="true">${airplaneSvg()}</div>
      <div class="cfpt-plan-badge">One project · one repository</div>
      <h2 id="cfpt-setup-title">Choose the GitHub repository first</h2>
      <p class="cfpt-setup-lead">Chat FreePT keeps the project tied to this repository while it works, including automatic continuation into a new chat if the current conversation reaches its limit.</p>
      <ol class="cfpt-setup-steps">
        <li>For a new project, <a class="cfpt-link" href="https://github.com/new" target="_blank" rel="noreferrer noopener">create a private repository on GitHub</a>.</li>
        <li>Return here and enter <strong>owner/repo</strong> or the root GitHub repository URL.</li>
        <li>Describe the project and press <strong>Start planning</strong>.</li>
        <li>ChatGPT verifies write access and CI capabilities against that exact repository. Missing access stops with <strong>Needs input</strong>.</li>
      </ol>
      <p class="cfpt-setup-footnote">Once planning starts, Chat FreePT keeps using this repository for the project.</p>
      <div class="cfpt-setup-actions">
        <button class="cfpt-btn cfpt-btn-primary" type="button" data-action="setup-done">Continue</button>
      </div>
    </section>`;
}

export function launcherState(state: RunState): string {
  if (state.status === "error") return "error";
  if (state.status === "awaiting_user") return "attention";
  if (state.status === "complete") return "done";
  if (state.status === "idle") return "idle";
  return "run";
}

export function panelViewKey(state: RunState, passive: boolean): string {
  return [
    state.phase,
    state.status,
    state.pauseReason ?? "",
    state.repo ?? "",
    state.repoName,
    state.idea,
    state.lastUserText ?? "",
    state.lastMarker?.status ?? "",
    state.lastMarker?.item ?? "",
    state.lastMarker?.url ?? "",
    state.lastLifecycleSignal ?? "",
    queuedMessages(state).join("\u001f"),
    String(passive),
  ].join("|");
}

export function renderPanelShell(body: string): string {
  return `
    <div class="cfpt-panel-head">
      <strong>Chat FreePT</strong>
      <button class="cfpt-panel-close" type="button" data-action="close" aria-label="Return to the native ChatGPT composer">${airplaneSvg()}<span>Native</span></button>
    </div>
    <div class="cfpt-body">${body}</div>
  `;
}

export function renderPanelBody(state: RunState, passive: boolean): string {
  const health = healthCheck();
  const showHealthWarning =
    state.status === "error" &&
    state.errorCode === "composer-insert-failed" &&
    health.missing.length > 0;
  const warning = showHealthWarning
    ? `<div class="cfpt-warn">ChatGPT's page structure changed — missing: ${esc(
        health.missing.join(", "),
      )}. Auto-run cannot operate until the extension is updated.</div>`
    : "";

  if (passive) {
    return (
      warning +
      passiveHtml(state) +
      conversationContextHtml(state) +
      checkpointHtml(state) +
      diagnosticsHtml()
    );
  }
  return (
    warning +
    automationControlsHtml(state) +
    statusBodyHtml(state) +
    conversationContextHtml(state) +
    checkpointHtml(state) +
    diagnosticsHtml()
  );
}

export function updatePanelDynamic(
  panel: HTMLElement,
  state: RunState,
  diagnostics: DiagnosticsStatus,
): void {
  const counters = panel.querySelector('[data-ref="counters"]');
  if (counters) {
    const bits = [`auto-continues: ${state.autoSends}`];
    const queueDepth = queuedMessages(state).length;
    if (queueDepth) bits.push(`queue: ${queueDepth}`);
    if (state.lastMarker?.item) bits.push(`item ${state.lastMarker.item}`);
    if (state.repo) bits.push(state.repo);
    counters.textContent = bits.join(" · ");
  }

  const logEl = panel.querySelector<HTMLElement>('[data-ref="log"]');
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

  const statusLine = panel.querySelector('[data-ref="statusline"]');
  if (statusLine) statusLine.textContent = statusLabel(state.status);
  updateDiagnosticsDom(panel, diagnostics);
}

export function updateDiagnosticsDom(panel: HTMLElement, status: DiagnosticsStatus): void {
  const line = panel.querySelector<HTMLElement>('[data-ref="diagnostics-status"]');
  if (line) line.textContent = diagnosticsStatusText(status);

  setActionDisabled(panel, "diagnostics-start", status.recording);
  setActionDisabled(panel, "diagnostics-stop", !status.recording);
  setActionDisabled(panel, "diagnostics-export", status.records === 0);
}

function diagnosticsStatusText(status: DiagnosticsStatus): string {
  if (status.recording) {
    const trimmed = status.dropped ? ` · ${status.dropped} trimmed` : "";
    return `Recording · ${status.records} events${trimmed}`;
  }
  if (status.records > 0) return `Stopped · ${status.records} events ready to export`;
  return "Not recording";
}

function setActionDisabled(panel: HTMLElement, action: string, disabled: boolean): void {
  const button = panel.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
  if (button) button.disabled = disabled;
}

function statusBodyHtml(state: RunState): string {
  switch (state.status) {
    case "idle":
      return ideaFormHtml(state);
    case "inserting":
    case "sending":
    case "streaming":
    case "cooldown":
      return runningHtml(state);
    case "awaiting_user":
      if (state.phase === "testing") return testingHtml(state);
      return state.phase === "plan_ready" ? planReadyHtml(state) : needsInputHtml(state);
    case "paused":
    case "error":
      return pausedHtml(state);
    case "complete":
      return completeHtml(state);
    default:
      return "";
  }
}

function automationControlsHtml(state: RunState): string {
  const queue = queuedMessages(state);
  const queueControls =
    canQueueNext(state) || queue.length > 0 ? queueControlsHtml(queue, canQueueNext(state)) : "";
  return `
    <div class="cfpt-field">
      <strong>Continuous mode</strong>
      <p class="cfpt-note">Chat FreePT keeps the project moving automatically. It waits only when ChatGPT needs you, reaches testing, or finishes.</p>
      ${queueControls}
    </div>
  `;
}

function checkpointHtml(state: RunState): string {
  if (!state.repo) return "";
  const queueDepth = queuedMessages(state).length;
  const marker = state.lastMarker?.status ? markerLabel(state.lastMarker.status) : "None";
  const item = state.lastMarker?.item ?? "None";
  const lifecycle = state.lastLifecycleSignal ? lifecycleLabel(state.lastLifecycleSignal) : "None";
  const markerUrl = state.lastMarker?.url ?? "";
  const url = /^https:\/\/github\.com\//i.test(markerUrl)
    ? `<a class="cfpt-link" href="${esc(markerUrl)}" target="_blank" rel="noreferrer noopener">${esc(markerUrl)}</a>`
    : esc(markerUrl || "None");
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

function diagnosticsHtml(): string {
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

function queueControlsHtml(queue: string[], allowAdd: boolean): string {
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
      <p class="cfpt-note">Queued messages run FIFO before the next automatic continuation.</p>
      ${items}
      ${allowAdd ? '<button class="cfpt-btn" type="button" data-action="showqueue">Add queued message</button>' : ""}
      ${queue.length > 0 ? '<button class="cfpt-btn" type="button" data-action="clearqueue">Clear all</button>' : ""}
      <div class="cfpt-field cfpt-hidden" data-ref="queue-editor">
        <label>Queued user message</label>
        <textarea data-ref="queue-next" rows="3" placeholder="Send this at the next safe turn boundary…"></textarea>
        <button class="cfpt-btn cfpt-btn-primary" type="button" data-action="savequeue">Add to queue</button>
        <button class="cfpt-btn" type="button" data-action="hidequeue">Cancel</button>
      </div>
    </div>`;
}

function conversationContextHtml(state: RunState): string {
  const lastUser = state.lastUserText?.trim();
  if (!lastUser) return "";
  return `
    <div class="cfpt-field" data-ref="conversation-context">
      <strong>Last user message</strong>
      <p class="cfpt-message-preview">${esc(lastUser)}</p>
    </div>
  `;
}

function passiveHtml(state: RunState): string {
  return `
    <h3>Active in another tab</h3>
    <p class="cfpt-note">Another ChatGPT tab currently owns this conversation. This tab is read-only and will take over automatically if the other tab closes or stops responding.</p>
    <p class="cfpt-note">Current state: ${esc(phaseLabel(state.phase))} · ${esc(
      statusLabel(state.status),
    )}</p>
  `;
}

function ideaFormHtml(state: RunState): string {
  const repoField = state.repo
    ? `<div class="cfpt-field">
         <label>Project repository</label>
         <input type="text" data-ref="reponame" value="${esc(state.repo)}" readonly />
         <p class="cfpt-note">Chat FreePT keeps this repository with the project while it runs.</p>
       </div>`
    : `<div class="cfpt-field">
         <label>GitHub repository</label>
         <input type="text" data-ref="reponame" value="${esc(state.repoName)}" placeholder="owner/repo or https://github.com/owner/repo" />
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
    <p class="cfpt-note">Chat FreePT uses this repository as the durable project state and verifies access before work begins.</p>
    <button class="cfpt-btn" type="button" data-action="setup-open">Repository setup</button>
    <button class="cfpt-btn cfpt-btn-primary" data-action="start">Start planning</button>
  `;
}

function runningHtml(state: RunState): string {
  const sendNow =
    state.status === "cooldown"
      ? '<button class="cfpt-btn" data-action="sendnow">Send now</button>'
      : "";
  return `
    <div class="cfpt-status-line"><span class="cfpt-spinner"></span>
      <strong data-ref="statusline">${esc(statusLabel(state.status))}</strong>
    </div>
    <div class="cfpt-counters" data-ref="counters"></div>
    <div class="cfpt-log" data-ref="log"></div>
    ${sendNow}
    <button class="cfpt-btn" data-action="pause">Pause</button>
    <button class="cfpt-btn cfpt-btn-danger" data-action="stop">Stop</button>
  `;
}

function planReadyHtml(state: RunState): string {
  return `
    <h3>Master plan ready</h3>
    <p class="cfpt-note">${esc(state.planSummary ?? "The recorded plan is ready.")}</p>
    ${repoLine(state)}
    <p class="cfpt-note">Development starts automatically.</p>
    <button class="cfpt-btn cfpt-btn-danger" data-action="stop">Stop</button>
  `;
}

function needsInputHtml(state: RunState): string {
  return `
    <h3>ChatGPT needs your input</h3>
    <p class="cfpt-note">${esc(state.pauseReason ?? "See the conversation for the question.")}</p>
    <div class="cfpt-field">
      <textarea data-ref="reply" rows="4" placeholder="Type your answer…"></textarea>
    </div>
    <button class="cfpt-btn cfpt-btn-primary" data-action="reply">Send reply</button>
    <button class="cfpt-btn" data-action="resume">I answered in the chat — resume</button>
    <button class="cfpt-btn cfpt-btn-danger" data-action="stop">Stop</button>
  `;
}

function testingHtml(state: RunState): string {
  return `
    <h3>Ready for testing</h3>
    <p class="cfpt-note">${esc(state.pauseReason ?? "The project is ready for your validation.")}</p>
    ${repoLine(state)}
    <div class="cfpt-field">
      <textarea data-ref="reply" rows="4" placeholder="Add test results or requested changes…"></textarea>
    </div>
    <button class="cfpt-btn cfpt-btn-primary" data-action="reply">Send test result</button>
    <button class="cfpt-btn" data-action="resume">I responded in the chat — resume</button>
    <button class="cfpt-btn cfpt-btn-danger" data-action="stop">Stop</button>
  `;
}

function pausedHtml(state: RunState): string {
  const handoff =
    state.errorCode === "conversation-full"
      ? '<button class="cfpt-btn" data-action="copyhandoff">Copy handoff prompt for a new chat</button>'
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

function completeHtml(state: RunState): string {
  return `
    <h3>Development complete</h3>
    ${repoLine(state)}
    <p class="cfpt-note">ChatGPT reports the project is done — verify it at the repo.</p>
    <button class="cfpt-btn cfpt-btn-primary" data-action="newproject">New project</button>
  `;
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
    case "testing":
      return "Testing";
    case "complete":
      return "Complete";
    case "stopped":
      return "Stopped";
    default:
      return humanizeToken(phase);
  }
}

function repoLine(state: RunState): string {
  if (!state.repo) return "";
  return `<p class="cfpt-note">Repo: <a class="cfpt-link" href="https://github.com/${esc(
    state.repo,
  )}" target="_blank" rel="noreferrer noopener">${esc(state.repo)}</a></p>`;
}
