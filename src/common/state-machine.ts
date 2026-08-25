import type {
  ActivityEntry,
  ErrorCode,
  Marker,
  PageSignal,
  RepoMode,
  RunState,
  Settings,
} from "./types";

export type MachineEvent =
  | { type: "USER_START"; idea: string; repoMode: RepoMode; repoName: string }
  | { type: "USER_START_DEVELOPMENT" }
  | { type: "USER_PAUSE" }
  | { type: "USER_RESUME" }
  | { type: "USER_STOP" }
  | { type: "USER_REPLY"; text: string }
  | { type: "USER_SET_AUTO_CONTINUE"; enabled: boolean }
  | { type: "USER_QUEUE_NEXT"; text: string }
  | { type: "USER_CLEAR_QUEUE" }
  | { type: "INSERT_OK" }
  | { type: "INSERT_FAIL"; detail: string }
  | { type: "SEND_OK" }
  | { type: "SEND_FAIL"; detail: string }
  | { type: "STREAM_STARTED" }
  | { type: "REPLY_COMPLETE"; marker: Marker | null; text: string }
  | { type: "STREAM_STUCK" }
  | { type: "COOLDOWN_ELAPSED" }
  | { type: "PAGE_SIGNAL"; signal: PageSignal };

export type PromptKind =
  | "plan"
  | "develop"
  | "continue"
  | "contract_refresh"
  | "nudge"
  | "user_text"
  | "queued_user_text";

export type Effect =
  | { do: "insertAndSend"; kind: PromptKind; text?: string }
  | { do: "startCooldown"; ms: number }
  | { do: "notify"; title: string; message: string }
  | { do: "badge"; text: string }
  | { do: "showModal" }
  | { do: "reconcile" };

export interface ReduceResult {
  state: RunState;
  effects: Effect[];
}

interface ReduceContext {
  state: RunState;
  effects: Effect[];
  settings: Settings;
  now: number;
}

type UserEvent = Extract<
  MachineEvent,
  {
    type:
      | "USER_START"
      | "USER_START_DEVELOPMENT"
      | "USER_PAUSE"
      | "USER_RESUME"
      | "USER_STOP"
      | "USER_REPLY"
      | "USER_SET_AUTO_CONTINUE"
      | "USER_QUEUE_NEXT"
      | "USER_CLEAR_QUEUE";
  }
>;
type StartEvent = Extract<UserEvent, { type: "USER_START" }>;
type UserReplyEvent = Extract<UserEvent, { type: "USER_REPLY" }>;
type QueueEvent = Extract<UserEvent, { type: "USER_QUEUE_NEXT" }>;
type SendEvent = Extract<
  MachineEvent,
  { type: "INSERT_OK" | "INSERT_FAIL" | "SEND_OK" | "SEND_FAIL" }
>;
type StreamEvent = Extract<
  MachineEvent,
  { type: "STREAM_STARTED" | "REPLY_COMPLETE" | "STREAM_STUCK" }
>;
type SystemEvent = Extract<MachineEvent, { type: "COOLDOWN_ELAPSED" | "PAGE_SIGNAL" }>;

const MAX_LOG = 200;
const ACTIVE_STATUSES = new Set(["inserting", "sending", "streaming", "cooldown"]);
const USER_EVENTS = new Set<MachineEvent["type"]>([
  "USER_START",
  "USER_START_DEVELOPMENT",
  "USER_PAUSE",
  "USER_RESUME",
  "USER_STOP",
  "USER_REPLY",
  "USER_SET_AUTO_CONTINUE",
  "USER_QUEUE_NEXT",
  "USER_CLEAR_QUEUE",
]);
const SEND_EVENTS = new Set<MachineEvent["type"]>([
  "INSERT_OK",
  "INSERT_FAIL",
  "SEND_OK",
  "SEND_FAIL",
]);
const STREAM_EVENTS = new Set<MachineEvent["type"]>([
  "STREAM_STARTED",
  "REPLY_COMPLETE",
  "STREAM_STUCK",
]);

export function newRunState(conversationId: string, now: number): RunState {
  return {
    v: 1,
    conversationId,
    phase: "idle",
    status: "idle",
    idea: "",
    repoMode: "new",
    repoName: "",
    autoContinueEnabled: true,
    autoSends: 0,
    nudges: 0,
    repliesSinceContract: 0,
    startedAt: now,
    updatedAt: now,
    log: [],
  };
}

export function isActive(state: RunState): boolean {
  return ACTIVE_STATUSES.has(state.status);
}

export function autoContinueEnabled(state: RunState): boolean {
  return state.autoContinueEnabled !== false;
}

/** Remaining delay for a persisted cooldown. Legacy cooldowns without a deadline resume now. */
export function cooldownRemainingMs(state: RunState, now = Date.now()): number {
  if (state.status !== "cooldown") return 0;
  return Math.max(0, (state.cooldownUntil ?? now) - now);
}

/** Pure orchestration reducer; event-domain handlers keep transition logic independently bounded. */
export function reduce(prev: RunState, event: MachineEvent, settings: Settings): ReduceResult {
  const now = Date.now();
  const ctx: ReduceContext = {
    state: { ...prev, updatedAt: now, log: [...prev.log] },
    effects: [],
    settings,
    now,
  };

  let accepted: boolean;
  if (isUserEvent(event)) accepted = reduceUserEvent(ctx, event);
  else if (isSendEvent(event)) accepted = reduceSendEvent(ctx, event);
  else if (isStreamEvent(event)) accepted = reduceStreamEvent(ctx, event);
  else accepted = reduceSystemEvent(ctx, event);

  if (!accepted) return { state: prev, effects: [] };
  if (ctx.state.status !== "cooldown") delete ctx.state.cooldownUntil;
  return { state: ctx.state, effects: ctx.effects };
}

function isUserEvent(event: MachineEvent): event is UserEvent {
  return USER_EVENTS.has(event.type);
}

function isSendEvent(event: MachineEvent): event is SendEvent {
  return SEND_EVENTS.has(event.type);
}

function isStreamEvent(event: MachineEvent): event is StreamEvent {
  return STREAM_EVENTS.has(event.type);
}

function note(ctx: ReduceContext, kind: ActivityEntry["kind"], text: string): void {
  ctx.state.log.push({ at: ctx.now, kind, text });
  if (ctx.state.log.length > MAX_LOG) {
    ctx.state.log.splice(0, ctx.state.log.length - MAX_LOG);
  }
}

function fail(ctx: ReduceContext, code: ErrorCode, message: string): void {
  ctx.state.status = "error";
  ctx.state.errorCode = code;
  ctx.state.pauseReason = message;
  note(ctx, "error", message);
  ctx.effects.push({ do: "badge", text: "!" });
  ctx.effects.push({ do: "notify", title: "Chat FreePT paused", message });
}

function reduceUserEvent(ctx: ReduceContext, event: UserEvent): boolean {
  switch (event.type) {
    case "USER_START":
      return startRun(ctx, event);
    case "USER_START_DEVELOPMENT":
      return startDevelopment(ctx);
    case "USER_PAUSE":
      return pauseRun(ctx);
    case "USER_RESUME":
      return resumeRun(ctx);
    case "USER_STOP":
      return stopRun(ctx);
    case "USER_REPLY":
      return sendUserReply(ctx, event);
    case "USER_SET_AUTO_CONTINUE":
      return setAutoContinue(ctx, event.enabled);
    case "USER_QUEUE_NEXT":
      return queueNextMessage(ctx, event);
    case "USER_CLEAR_QUEUE":
      return clearQueuedMessage(ctx);
  }
}

function startRun(ctx: ReduceContext, event: StartEvent): boolean {
  const state = ctx.state;
  if (state.status !== "idle" && state.phase !== "stopped" && state.phase !== "complete") {
    return false;
  }
  state.phase = "planning";
  state.status = "inserting";
  state.idea = event.idea;
  state.repoMode = event.repoMode;
  state.repoName = event.repoName;
  state.autoSends = 0;
  state.nudges = 0;
  state.repliesSinceContract = 0;
  state.startedAt = ctx.now;
  delete state.queuedUserText;
  delete state.errorCode;
  delete state.pauseReason;
  note(ctx, "info", "Planning started");
  ctx.effects.push({ do: "insertAndSend", kind: "plan" }, { do: "badge", text: "RUN" });
  return true;
}

function startDevelopment(ctx: ReduceContext): boolean {
  const state = ctx.state;
  if (state.phase !== "plan_ready") return false;
  state.phase = "developing";
  state.status = "inserting";
  state.autoSends = 0;
  state.nudges = 0;
  note(ctx, "info", "Development started");
  ctx.effects.push({ do: "insertAndSend", kind: "develop" }, { do: "badge", text: "RUN" });
  return true;
}

function pauseRun(ctx: ReduceContext): boolean {
  if (ctx.state.status === "paused") return false;
  ctx.state.status = "paused";
  ctx.state.pauseReason = "Paused by you";
  note(ctx, "info", "Paused");
  ctx.effects.push({ do: "badge", text: "II" });
  return true;
}

function resumeRun(ctx: ReduceContext): boolean {
  const state = ctx.state;
  if (state.status !== "paused" && state.status !== "error" && state.status !== "awaiting_user") {
    return false;
  }
  state.status = "streaming";
  delete state.pauseReason;
  delete state.errorCode;
  note(ctx, "info", "Resumed — re-checking conversation state");
  ctx.effects.push({ do: "reconcile" }, { do: "badge", text: "RUN" });
  return true;
}

function stopRun(ctx: ReduceContext): boolean {
  const enabled = autoContinueEnabled(ctx.state);
  const reset = newRunState(ctx.state.conversationId, ctx.now);
  reset.autoContinueEnabled = enabled;
  reset.log = [{ at: ctx.now, kind: "info", text: "Stopped and reset" }];
  ctx.state = reset;
  ctx.effects.push({ do: "badge", text: "" });
  return true;
}

function sendUserReply(ctx: ReduceContext, event: UserReplyEvent): boolean {
  const state = ctx.state;
  if (state.status !== "awaiting_user" && state.status !== "paused" && state.status !== "error") {
    return false;
  }
  state.status = "inserting";
  state.nudges = 0;
  delete state.pauseReason;
  delete state.errorCode;
  note(ctx, "send", "Sending your reply");
  ctx.effects.push(
    { do: "insertAndSend", kind: "user_text", text: event.text },
    { do: "badge", text: "RUN" },
  );
  return true;
}

function setAutoContinue(ctx: ReduceContext, enabled: boolean): boolean {
  const state = ctx.state;
  if (autoContinueEnabled(state) === enabled && state.autoContinueEnabled !== undefined) return false;
  state.autoContinueEnabled = enabled;
  note(ctx, "info", `Auto-continue ${enabled ? "enabled" : "disabled"}`);

  if (!enabled && state.status === "cooldown" && !state.queuedUserText) {
    waitForManualContinue(ctx);
    return true;
  }

  if (
    enabled &&
    state.status === "awaiting_user" &&
    state.lastMarker?.status === "CONTINUE" &&
    isContinuablePhase(state)
  ) {
    delete state.pauseReason;
    handleContinue(ctx);
  }
  return true;
}

function queueNextMessage(ctx: ReduceContext, event: QueueEvent): boolean {
  const text = event.text.trim();
  if (!text || !isContinuablePhase(ctx.state)) return false;
  ctx.state.queuedUserText = text;
  note(ctx, "info", "Queued next user message");

  if (ctx.state.status === "awaiting_user" && ctx.state.lastMarker?.status === "CONTINUE") {
    delete ctx.state.pauseReason;
    scheduleContinuation(ctx);
  }
  return true;
}

function clearQueuedMessage(ctx: ReduceContext): boolean {
  if (!ctx.state.queuedUserText) return false;
  delete ctx.state.queuedUserText;
  note(ctx, "info", "Cleared queued user message");
  if (!autoContinueEnabled(ctx.state) && ctx.state.status === "cooldown") {
    waitForManualContinue(ctx);
  }
  return true;
}

function reduceSendEvent(ctx: ReduceContext, event: SendEvent): boolean {
  switch (event.type) {
    case "INSERT_OK":
      if (ctx.state.status !== "inserting") return false;
      ctx.state.status = "sending";
      return true;
    case "INSERT_FAIL":
      fail(ctx, "composer-insert-failed", `Could not write into the composer: ${event.detail}`);
      return true;
    case "SEND_OK":
      if (ctx.state.status !== "sending") return false;
      ctx.state.status = "streaming";
      return true;
    case "SEND_FAIL":
      fail(ctx, "send-failed", `Could not send the message: ${event.detail}`);
      return true;
  }
}

function reduceStreamEvent(ctx: ReduceContext, event: StreamEvent): boolean {
  switch (event.type) {
    case "STREAM_STARTED":
      if (ctx.state.status === "paused" || ctx.state.status === "idle") return false;
      ctx.state.status = "streaming";
      return true;
    case "REPLY_COMPLETE":
      if (ctx.state.status !== "streaming" && ctx.state.status !== "sending") return false;
      ctx.state.repliesSinceContract += 1;
      handleReply(ctx, event.marker, event.text);
      return true;
    case "STREAM_STUCK":
      fail(
        ctx,
        "stream-stuck",
        `ChatGPT has been generating for over ${ctx.settings.maxStreamMinutes} minutes — check the tab.`,
      );
      return true;
  }
}

function reduceSystemEvent(ctx: ReduceContext, event: SystemEvent): boolean {
  switch (event.type) {
    case "COOLDOWN_ELAPSED":
      return finishCooldown(ctx);
    case "PAGE_SIGNAL":
      if (!isActive(ctx.state) && ctx.state.status !== "awaiting_user") return false;
      handlePageSignal(ctx, event.signal);
      return true;
  }
}

function finishCooldown(ctx: ReduceContext): boolean {
  const state = ctx.state;
  if (state.status !== "cooldown") return false;

  if (state.queuedUserText) {
    const text = state.queuedUserText;
    delete state.queuedUserText;
    state.status = "inserting";
    note(ctx, "send", "Sending queued user message");
    ctx.effects.push({ do: "insertAndSend", kind: "queued_user_text", text });
    return true;
  }

  if (!autoContinueEnabled(state)) {
    waitForManualContinue(ctx);
    return true;
  }

  state.status = "inserting";
  state.autoSends += 1;
  const refresh = state.repliesSinceContract >= ctx.settings.contractRefreshEvery;
  if (refresh) state.repliesSinceContract = 0;
  note(ctx, "send", refresh ? "Auto-continue (with contract refresh)" : "Auto-continue");
  ctx.effects.push({ do: "insertAndSend", kind: refresh ? "contract_refresh" : "continue" });
  return true;
}

function handlePageSignal(ctx: ReduceContext, signal: PageSignal): void {
  switch (signal) {
    case "rate-limit":
      fail(ctx, "rate-limited", "ChatGPT reported a usage limit. Resume when it lifts.");
      return;
    case "logged-out":
      fail(ctx, "logged-out", "You appear to be logged out of ChatGPT.");
      return;
    case "network-error":
      fail(ctx, "network-error", "ChatGPT hit an error mid-reply. Use Regenerate, then Resume.");
      return;
    case "conversation-full":
      fail(
        ctx,
        "conversation-full",
        "This conversation hit its length limit. Use the handoff prompt in a new chat.",
      );
  }
}

function handleReply(ctx: ReduceContext, marker: Marker | null, text: string): void {
  const state = ctx.state;
  if (!marker) {
    if (state.phase !== "planning" && state.phase !== "developing") {
      state.status = "awaiting_user";
      return;
    }
    if (state.nudges === 0) {
      state.nudges = 1;
      state.status = "inserting";
      note(ctx, "warn", "Reply had no status marker — sending recovery nudge");
      ctx.effects.push({ do: "insertAndSend", kind: "nudge" });
    } else {
      fail(ctx, "marker-missing", "ChatGPT stopped emitting the status marker.");
    }
    return;
  }

  state.nudges = 0;
  state.lastMarker = marker;
  if (marker.repo) state.repo = marker.repo;
  note(ctx, "marker", marker.raw);
  handleMarker(ctx, marker, text);
}

function handleMarker(ctx: ReduceContext, marker: Marker, text: string): void {
  const state = ctx.state;
  switch (marker.status) {
    case "CONTINUE":
      handleContinue(ctx);
      return;
    case "NEEDS_INPUT":
    case "ERROR":
      state.status = "awaiting_user";
      state.pauseReason = marker.note ?? "ChatGPT needs your input.";
      ctx.effects.push(
        { do: "badge", text: "?" },
        {
          do: "notify",
          title: "Chat FreePT needs you",
          message: marker.note ?? "ChatGPT is waiting for your input.",
        },
      );
      return;
    case "PLAN_READY":
      state.phase = "plan_ready";
      state.status = "awaiting_user";
      state.planSummary = marker.note ?? excerpt(text);
      ctx.effects.push(
        { do: "badge", text: "PLAN" },
        {
          do: "notify",
          title: "Master plan ready",
          message: "Review the plan, then press Start development.",
        },
      );
      return;
    case "COMPLETE":
      state.phase = "complete";
      state.status = "complete";
      ctx.effects.push(
        { do: "badge", text: "DONE" },
        { do: "showModal" },
        {
          do: "notify",
          title: "Development complete",
          message: state.repo
            ? `ChatGPT reports ${state.repo} is done.`
            : "ChatGPT reports the project is done.",
        },
      );
  }
}

function handleContinue(ctx: ReduceContext): void {
  const state = ctx.state;
  if (state.phase === "plan_ready") state.phase = "planning";
  if (!isContinuablePhase(state)) {
    state.status = "awaiting_user";
    return;
  }
  if (state.queuedUserText) {
    scheduleContinuation(ctx);
    return;
  }
  if (!autoContinueEnabled(state)) {
    waitForManualContinue(ctx);
    return;
  }
  if (state.autoSends >= ctx.settings.autoContinueCap) {
    fail(
      ctx,
      "cap-reached",
      `Auto-continue cap (${ctx.settings.autoContinueCap}) reached for this phase.`,
    );
    return;
  }
  scheduleContinuation(ctx);
}

function isContinuablePhase(state: RunState): boolean {
  return state.phase === "planning" || state.phase === "developing";
}

function scheduleContinuation(ctx: ReduceContext): void {
  ctx.state.status = "cooldown";
  ctx.state.cooldownUntil = ctx.now + ctx.settings.sendDelayMs;
  ctx.effects.push({ do: "startCooldown", ms: ctx.settings.sendDelayMs });
}

function waitForManualContinue(ctx: ReduceContext): void {
  ctx.state.status = "awaiting_user";
  ctx.state.pauseReason = "Auto-continue is off.";
  note(ctx, "info", "Waiting because auto-continue is off");
  ctx.effects.push({ do: "badge", text: "II" });
}

function excerpt(text: string): string {
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length > 400 ? `${clean.slice(0, 400)}…` : clean;
}
