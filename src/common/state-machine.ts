import { normalizeRepositoryInput } from "./repository";
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
  | { type: "USER_UPDATE_DRAFT"; idea: string; repoName: string }
  | { type: "USER_START_DEVELOPMENT" }
  | { type: "USER_PAUSE" }
  | { type: "USER_RESUME"; lastUserText?: string }
  | { type: "USER_STOP" }
  | { type: "USER_NEW_PROJECT" }
  | { type: "USER_REPLY"; text: string }
  | { type: "USER_SET_AUTO_CONTINUE"; enabled: boolean }
  | { type: "USER_QUEUE_NEXT"; text: string }
  | { type: "USER_REMOVE_QUEUE"; index: number }
  | { type: "USER_MOVE_QUEUE"; index: number; direction: -1 | 1 }
  | { type: "USER_CLEAR_QUEUE" }
  | { type: "INSERT_OK" }
  | { type: "INSERT_FAIL"; detail: string }
  | { type: "SEND_OK" }
  | { type: "SEND_FAIL"; detail: string }
  | { type: "REPLY_EXPECTED"; baselineAssistantKey?: string }
  | { type: "STREAM_STARTED" }
  | {
      type: "REPLY_COMPLETE";
      marker: Marker | null;
      text: string;
      assistantKey?: string;
    }
  | { type: "STREAM_STUCK" }
  | { type: "STREAM_INTERRUPTED"; reason?: string }
  | { type: "PERMISSION_CONTINUED" }
  | { type: "COOLDOWN_ELAPSED" }
  | { type: "PAGE_SIGNAL"; signal: PageSignal };

export type PromptKind =
  "plan" | "develop" | "continue" | "contract_refresh" | "nudge" | "user_text" | "queued_user_text";

export type Effect =
  | { do: "insertAndSend"; kind: PromptKind; text?: string }
  | { do: "startCooldown"; ms: number }
  | { do: "notify"; title: string; message: string }
  | { do: "badge"; text: string }
  | { do: "showCompletion" }
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
      | "USER_UPDATE_DRAFT"
      | "USER_START_DEVELOPMENT"
      | "USER_PAUSE"
      | "USER_RESUME"
      | "USER_STOP"
      | "USER_NEW_PROJECT"
      | "USER_REPLY"
      | "USER_SET_AUTO_CONTINUE"
      | "USER_QUEUE_NEXT"
      | "USER_REMOVE_QUEUE"
      | "USER_MOVE_QUEUE"
      | "USER_CLEAR_QUEUE";
  }
>;
type StartEvent = Extract<UserEvent, { type: "USER_START" }>;
type UserReplyEvent = Extract<UserEvent, { type: "USER_REPLY" }>;
type QueueEvent = Extract<UserEvent, { type: "USER_QUEUE_NEXT" }>;
type RemoveQueueEvent = Extract<UserEvent, { type: "USER_REMOVE_QUEUE" }>;
type MoveQueueEvent = Extract<UserEvent, { type: "USER_MOVE_QUEUE" }>;
type SendEvent = Extract<
  MachineEvent,
  { type: "INSERT_OK" | "INSERT_FAIL" | "SEND_OK" | "SEND_FAIL" | "REPLY_EXPECTED" }
>;
type StreamEvent = Extract<
  MachineEvent,
  { type: "STREAM_STARTED" | "REPLY_COMPLETE" | "STREAM_STUCK" | "STREAM_INTERRUPTED" }
>;
type SystemEvent = Extract<MachineEvent, { type: "COOLDOWN_ELAPSED" | "PAGE_SIGNAL" }>;

const MAX_LOG = 200;
const ACTIVE_STATUSES = new Set(["inserting", "sending", "streaming", "cooldown"]);
const USER_EVENTS = new Set<MachineEvent["type"]>([
  "USER_START",
  "USER_UPDATE_DRAFT",
  "USER_START_DEVELOPMENT",
  "USER_PAUSE",
  "USER_RESUME",
  "USER_STOP",
  "USER_NEW_PROJECT",
  "USER_REPLY",
  "USER_SET_AUTO_CONTINUE",
  "USER_QUEUE_NEXT",
  "USER_REMOVE_QUEUE",
  "USER_MOVE_QUEUE",
  "USER_CLEAR_QUEUE",
]);
const SEND_EVENTS = new Set<MachineEvent["type"]>([
  "INSERT_OK",
  "INSERT_FAIL",
  "SEND_OK",
  "SEND_FAIL",
  "REPLY_EXPECTED",
]);
const STREAM_EVENTS = new Set<MachineEvent["type"]>([
  "STREAM_STARTED",
  "REPLY_COMPLETE",
  "STREAM_STUCK",
  "STREAM_INTERRUPTED",
  "PERMISSION_CONTINUED",
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

/** Ordered queued user messages, including migration from the legacy single-message slot. */
export function queuedMessages(state: RunState): string[] {
  if (state.queuedUserTexts?.length) return state.queuedUserTexts.filter((text) => text.trim());
  const legacy = state.queuedUserText?.trim();
  return legacy ? [legacy] : [];
}

function setQueuedMessages(state: RunState, messages: string[]): void {
  const clean = messages.map((text) => text.trim()).filter(Boolean);
  delete state.queuedUserText;
  if (clean.length > 0) state.queuedUserTexts = clean;
  else delete state.queuedUserTexts;
}

export function isWaitingForManualContinue(state: RunState): boolean {
  return (
    state.status === "awaiting_user" &&
    state.lastMarker?.status === "CONTINUE" &&
    !autoContinueEnabled(state) &&
    isContinuablePhase(state)
  );
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
    case "USER_UPDATE_DRAFT":
      return updateDraft(ctx, event.idea, event.repoName);
    case "USER_START_DEVELOPMENT":
      return startDevelopment(ctx);
    case "USER_PAUSE":
      return pauseRun(ctx);
    case "USER_RESUME":
      return resumeRun(ctx, event.lastUserText);
    case "USER_STOP":
      return stopRun(ctx);
    case "USER_NEW_PROJECT":
      return newProject(ctx);
    case "USER_REPLY":
      return sendUserReply(ctx, event);
    case "USER_SET_AUTO_CONTINUE":
      return setAutoContinue(ctx, event.enabled);
    case "USER_QUEUE_NEXT":
      return queueNextMessage(ctx, event);
    case "USER_REMOVE_QUEUE":
      return removeQueuedMessage(ctx, event);
    case "USER_MOVE_QUEUE":
      return moveQueuedMessage(ctx, event);
    case "USER_CLEAR_QUEUE":
      return clearQueuedMessages(ctx);
  }
}

function updateDraft(ctx: ReduceContext, idea: string, repoName: string): boolean {
  if (ctx.state.status !== "idle") return false;
  if (ctx.state.idea === idea && ctx.state.repoName === repoName) return false;
  ctx.state.idea = idea;
  if (!ctx.state.repo) ctx.state.repoName = repoName;
  return true;
}

function startRun(ctx: ReduceContext, event: StartEvent): boolean {
  const state = ctx.state;
  if (state.status !== "idle" && state.phase !== "stopped" && state.phase !== "complete") {
    return false;
  }

  const requestedRepo = normalizeRepositoryInput(event.repoName);
  if (!state.repo && !requestedRepo) {
    fail(ctx, "repo-required", "Choose and lock a GitHub repository before planning.");
    return true;
  }
  if (state.repo && requestedRepo && requestedRepo.toLowerCase() !== state.repo.toLowerCase()) {
    fail(
      ctx,
      "repo-mismatch",
      `This conversation is locked to ${state.repo}. Start a new ChatGPT conversation to use ${requestedRepo}.`,
    );
    return true;
  }

  const lockedRepo = state.repo ?? requestedRepo;
  if (!lockedRepo) return false;
  state.repo = lockedRepo;
  state.repoMode = "existing";
  state.repoName = lockedRepo;
  state.phase = "planning";
  state.status = "inserting";
  state.idea = event.idea;
  state.lastUserText = event.idea.trim();
  state.autoSends = 0;
  state.nudges = 0;
  state.repliesSinceContract = 0;
  state.startedAt = ctx.now;
  delete state.queuedUserText;
  delete state.queuedUserTexts;
  delete state.lastLifecycleSignal;
  delete state.errorCode;
  delete state.pauseReason;
  note(ctx, "info", "Planning started");
  ctx.effects.push({ do: "insertAndSend", kind: "plan" }, { do: "badge", text: "RUN" });
  return true;
}

function startDevelopment(ctx: ReduceContext): boolean {
  const state = ctx.state;
  if (state.phase !== "plan_ready") return false;
  if (!state.repo) {
    fail(ctx, "repo-required", "This conversation has no locked GitHub repository.");
    return true;
  }
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

function resumeRun(ctx: ReduceContext, lastUserText?: string): boolean {
  const state = ctx.state;
  if (state.status !== "paused" && state.status !== "error" && state.status !== "awaiting_user") {
    return false;
  }
  const text = lastUserText?.trim();
  if (text) state.lastUserText = text;
  state.status = "streaming";
  delete state.pauseReason;
  delete state.errorCode;
  note(ctx, "info", "Resumed — re-checking conversation state");
  ctx.effects.push({ do: "reconcile" }, { do: "badge", text: "RUN" });
  return true;
}

function resetRun(ctx: ReduceContext, logText: string): void {
  const enabled = autoContinueEnabled(ctx.state);
  const lockedRepo = ctx.state.repo;
  const reset = newRunState(ctx.state.conversationId, ctx.now);
  reset.autoContinueEnabled = enabled;
  if (lockedRepo) {
    reset.repo = lockedRepo;
    reset.repoMode = "existing";
    reset.repoName = lockedRepo;
  }
  reset.log = [{ at: ctx.now, kind: "info", text: logText }];
  ctx.state = reset;
}

function stopRun(ctx: ReduceContext): boolean {
  resetRun(ctx, "Stopped and reset");
  ctx.effects.push({ do: "badge", text: "" });
  return true;
}

function newProject(ctx: ReduceContext): boolean {
  resetRun(ctx, "Ready for a new project");
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
  state.lastUserText = event.text.trim();
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
  if (autoContinueEnabled(state) === enabled && state.autoContinueEnabled !== undefined)
    return false;
  state.autoContinueEnabled = enabled;
  note(ctx, "info", `Auto-continue ${enabled ? "enabled" : "disabled"}`);

  if (!enabled && state.status === "cooldown" && queuedMessages(state).length === 0) {
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
  setQueuedMessages(ctx.state, [...queuedMessages(ctx.state), text]);
  note(ctx, "info", "Queued user message");

  if (ctx.state.status === "awaiting_user" && ctx.state.lastMarker?.status === "CONTINUE") {
    delete ctx.state.pauseReason;
    scheduleContinuation(ctx);
  }
  return true;
}

function removeQueuedMessage(ctx: ReduceContext, event: RemoveQueueEvent): boolean {
  const queue = queuedMessages(ctx.state);
  if (!Number.isInteger(event.index) || event.index < 0 || event.index >= queue.length) {
    return false;
  }
  queue.splice(event.index, 1);
  setQueuedMessages(ctx.state, queue);
  note(ctx, "info", "Removed queued user message");
  if (!autoContinueEnabled(ctx.state) && ctx.state.status === "cooldown" && queue.length === 0) {
    waitForManualContinue(ctx);
  }
  return true;
}

function moveQueuedMessage(ctx: ReduceContext, event: MoveQueueEvent): boolean {
  const queue = queuedMessages(ctx.state);
  const target = event.index + event.direction;
  if (
    !Number.isInteger(event.index) ||
    event.index < 0 ||
    event.index >= queue.length ||
    target < 0 ||
    target >= queue.length
  ) {
    return false;
  }
  const [message] = queue.splice(event.index, 1);
  if (!message) return false;
  queue.splice(target, 0, message);
  setQueuedMessages(ctx.state, queue);
  note(ctx, "info", "Reordered queued user messages");
  return true;
}

function clearQueuedMessages(ctx: ReduceContext): boolean {
  if (queuedMessages(ctx.state).length === 0) return false;
  setQueuedMessages(ctx.state, []);
  note(ctx, "info", "Cleared queued user messages");
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
    case "REPLY_EXPECTED":
      if (ctx.state.status !== "sending") return false;
      if (event.baselineAssistantKey) {
        ctx.state.replyBaselineAssistantKey = event.baselineAssistantKey;
      } else {
        delete ctx.state.replyBaselineAssistantKey;
      }
      return true;
  }
}

function reduceStreamEvent(ctx: ReduceContext, event: StreamEvent): boolean {
  switch (event.type) {
    case "STREAM_STARTED":
      return startStream(ctx);
    case "REPLY_COMPLETE":
      return completeReply(ctx, event);
    case "STREAM_INTERRUPTED":
      return interruptStream(ctx, event.reason);
    case "PERMISSION_CONTINUED":
      return continuePermission(ctx);
    case "STREAM_STUCK":
      ctx.state.lastLifecycleSignal = "stream-stuck";
      fail(
        ctx,
        "stream-stuck",
        `ChatGPT has been generating for over ${ctx.settings.maxStreamMinutes} minutes — check the tab.`,
      );
      return true;
  }
}

function startStream(ctx: ReduceContext): boolean {
  if (ctx.state.status === "idle") return false;
  if (ctx.state.status === "paused" && ctx.state.lastLifecycleSignal !== "generation-interrupted") {
    return false;
  }
  ctx.state.status = "streaming";
  ctx.state.lastLifecycleSignal = "generation-start";
  delete ctx.state.pauseReason;
  delete ctx.state.errorCode;
  return true;
}

function completeReply(
  ctx: ReduceContext,
  event: Extract<StreamEvent, { type: "REPLY_COMPLETE" }>,
): boolean {
  if (!canConsumeReply(ctx.state, event.marker)) return false;
  if (isDuplicateReply(ctx.state, event.assistantKey)) return false;

  if (event.assistantKey) ctx.state.lastProcessedAssistantKey = event.assistantKey;
  delete ctx.state.replyBaselineAssistantKey;
  ctx.state.lastLifecycleSignal = "generation-complete";
  ctx.state.repliesSinceContract += 1;
  handleReply(ctx, event.marker, event.text);
  return true;
}

function canConsumeReply(state: RunState, marker: Marker | null): boolean {
  return (
    state.status === "streaming" ||
    state.status === "sending" ||
    (state.status === "awaiting_user" && marker !== null && isContinuablePhase(state))
  );
}

function isDuplicateReply(state: RunState, assistantKey: string | undefined): boolean {
  return Boolean(
    assistantKey &&
    (assistantKey === state.lastProcessedAssistantKey ||
      assistantKey === state.replyBaselineAssistantKey),
  );
}

function continuePermission(ctx: ReduceContext): boolean {
  const state = ctx.state;
  if (state.phase !== "planning" && state.phase !== "developing" && state.phase !== "plan_ready") {
    return false;
  }
  if (
    state.status !== "sending" &&
    state.status !== "streaming" &&
    !(state.status === "paused" && state.lastLifecycleSignal === "generation-interrupted")
  ) {
    return false;
  }
  state.status = "streaming";
  state.lastLifecycleSignal = "permission-continued";
  delete state.pauseReason;
  delete state.errorCode;
  note(ctx, "info", "GitHub permission continued automatically");
  ctx.effects.push({ do: "reconcile" }, { do: "badge", text: "RUN" });
  return true;
}

function interruptStream(ctx: ReduceContext, reason?: string): boolean {
  if (
    ctx.state.status === "idle" ||
    ctx.state.status === "paused" ||
    ctx.state.status === "complete"
  ) {
    return false;
  }
  ctx.state.status = "paused";
  ctx.state.lastLifecycleSignal = "generation-interrupted";
  ctx.state.pauseReason = reason ?? "Generation stopped in ChatGPT";
  note(ctx, "info", "Generation interrupted — automation paused");
  ctx.effects.push({ do: "badge", text: "II" });
  return true;
}

function reduceSystemEvent(ctx: ReduceContext, event: SystemEvent): boolean {
  switch (event.type) {
    case "COOLDOWN_ELAPSED":
      return finishCooldown(ctx);
    case "PAGE_SIGNAL":
      if (!isActive(ctx.state) && ctx.state.status !== "awaiting_user") return false;
      ctx.state.lastLifecycleSignal = `page:${event.signal}`;
      handlePageSignal(ctx, event.signal);
      return true;
  }
}

function finishCooldown(ctx: ReduceContext): boolean {
  const state = ctx.state;
  if (state.status !== "cooldown") return false;

  const queue = queuedMessages(state);
  const nextQueued = queue.shift();
  if (nextQueued) {
    setQueuedMessages(state, queue);
    state.status = "inserting";
    state.lastUserText = nextQueued;
    note(ctx, "send", "Sending queued user message");
    ctx.effects.push({ do: "insertAndSend", kind: "queued_user_text", text: nextQueued });
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
  if (!validateMarkerRepository(ctx, marker)) return;
  note(ctx, "marker", marker.raw);
  handleMarker(ctx, marker, text);
}

function validateMarkerRepository(ctx: ReduceContext, marker: Marker): boolean {
  if (!ctx.state.repo) {
    fail(ctx, "repo-required", "This conversation has no locked GitHub repository.");
    return false;
  }
  if (!marker.repo) return true;

  const reported = normalizeRepositoryInput(marker.repo);
  if (!reported || reported.toLowerCase() !== ctx.state.repo.toLowerCase()) {
    fail(
      ctx,
      "repo-mismatch",
      `ChatGPT reported repository ${marker.repo}, but this conversation is locked to ${ctx.state.repo}. Start a new ChatGPT conversation to switch repositories.`,
    );
    return false;
  }
  return true;
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
        { do: "showCompletion" },
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
  if (queuedMessages(state).length > 0) {
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
