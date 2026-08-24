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
  "plan" | "develop" | "continue" | "contract_refresh" | "nudge" | "user_text";

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

const MAX_LOG = 200;
const ACTIVE_STATUSES = new Set(["inserting", "sending", "streaming", "cooldown"]);

export function newRunState(conversationId: string, now: number): RunState {
  return {
    v: 1,
    conversationId,
    phase: "idle",
    status: "idle",
    idea: "",
    repoMode: "new",
    repoName: "",
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

/** Remaining delay for a persisted cooldown. Legacy cooldowns without a deadline resume now. */
export function cooldownRemainingMs(state: RunState, now = Date.now()): number {
  if (state.status !== "cooldown") return 0;
  return Math.max(0, (state.cooldownUntil ?? now) - now);
}

/**
 * The entire orchestration decision logic, as a pure function. The run controller feeds
 * DOM/UI events in and executes the returned effects; nothing here touches the page,
 * timers, or chrome.* APIs.
 */
export function reduce(prev: RunState, event: MachineEvent, settings: Settings): ReduceResult {
  const now = Date.now();
  const state: RunState = { ...prev, updatedAt: now, log: [...prev.log] };
  const effects: Effect[] = [];

  const note = (kind: ActivityEntry["kind"], text: string): void => {
    state.log.push({ at: now, kind, text });
    if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
  };

  const fail = (code: ErrorCode, message: string): void => {
    state.status = "error";
    state.errorCode = code;
    state.pauseReason = message;
    note("error", message);
    effects.push({ do: "badge", text: "!" });
    effects.push({ do: "notify", title: "Chat FreePT paused", message });
  };

  switch (event.type) {
    case "USER_START": {
      if (state.status !== "idle" && state.phase !== "stopped" && state.phase !== "complete") {
        return { state: prev, effects: [] };
      }
      state.phase = "planning";
      state.status = "inserting";
      state.idea = event.idea;
      state.repoMode = event.repoMode;
      state.repoName = event.repoName;
      state.autoSends = 0;
      state.nudges = 0;
      state.repliesSinceContract = 0;
      state.startedAt = now;
      delete state.errorCode;
      delete state.pauseReason;
      note("info", "Planning started");
      effects.push({ do: "insertAndSend", kind: "plan" });
      effects.push({ do: "badge", text: "RUN" });
      break;
    }

    case "USER_START_DEVELOPMENT": {
      if (state.phase !== "plan_ready") return { state: prev, effects: [] };
      state.phase = "developing";
      state.status = "inserting";
      state.autoSends = 0;
      state.nudges = 0;
      note("info", "Development started");
      effects.push({ do: "insertAndSend", kind: "develop" });
      effects.push({ do: "badge", text: "RUN" });
      break;
    }

    case "USER_PAUSE": {
      if (state.status === "paused") return { state: prev, effects: [] };
      state.status = "paused";
      state.pauseReason = "Paused by you";
      note("info", "Paused");
      effects.push({ do: "badge", text: "II" });
      break;
    }

    case "USER_RESUME": {
      if (
        state.status !== "paused" &&
        state.status !== "error" &&
        state.status !== "awaiting_user"
      ) {
        return { state: prev, effects: [] };
      }
      state.status = "streaming";
      delete state.pauseReason;
      delete state.errorCode;
      note("info", "Resumed — re-checking conversation state");
      effects.push({ do: "reconcile" });
      effects.push({ do: "badge", text: "RUN" });
      break;
    }

    case "USER_STOP": {
      state.phase = "stopped";
      state.status = "idle";
      note("info", "Stopped");
      effects.push({ do: "badge", text: "" });
      break;
    }

    case "USER_REPLY": {
      if (
        state.status !== "awaiting_user" &&
        state.status !== "paused" &&
        state.status !== "error"
      ) {
        return { state: prev, effects: [] };
      }
      state.status = "inserting";
      state.nudges = 0;
      delete state.pauseReason;
      delete state.errorCode;
      note("send", "Sending your reply");
      effects.push({ do: "insertAndSend", kind: "user_text", text: event.text });
      effects.push({ do: "badge", text: "RUN" });
      break;
    }

    case "INSERT_OK": {
      if (state.status !== "inserting") return { state: prev, effects: [] };
      state.status = "sending";
      break;
    }

    case "INSERT_FAIL": {
      fail("composer-insert-failed", `Could not write into the composer: ${event.detail}`);
      break;
    }

    case "SEND_OK": {
      if (state.status !== "sending") return { state: prev, effects: [] };
      state.status = "streaming";
      break;
    }

    case "SEND_FAIL": {
      fail("send-failed", `Could not send the message: ${event.detail}`);
      break;
    }

    case "STREAM_STARTED": {
      if (state.status === "paused" || state.status === "idle") return { state: prev, effects: [] };
      state.status = "streaming";
      break;
    }

    case "REPLY_COMPLETE": {
      if (state.status !== "streaming" && state.status !== "sending") {
        return { state: prev, effects: [] };
      }
      state.repliesSinceContract += 1;
      handleReply(state, event.marker, event.text, settings, effects, note, fail);
      break;
    }

    case "STREAM_STUCK": {
      fail(
        "stream-stuck",
        `ChatGPT has been generating for over ${settings.maxStreamMinutes} minutes — check the tab.`,
      );
      break;
    }

    case "COOLDOWN_ELAPSED": {
      if (state.status !== "cooldown") return { state: prev, effects: [] };
      state.status = "inserting";
      state.autoSends += 1;
      const refresh = state.repliesSinceContract >= settings.contractRefreshEvery;
      if (refresh) state.repliesSinceContract = 0;
      note("send", refresh ? "Auto-continue (with contract refresh)" : "Auto-continue");
      effects.push({ do: "insertAndSend", kind: refresh ? "contract_refresh" : "continue" });
      break;
    }

    case "PAGE_SIGNAL": {
      if (!isActive(state) && state.status !== "awaiting_user") return { state: prev, effects: [] };
      switch (event.signal) {
        case "rate-limit":
          fail("rate-limited", "ChatGPT reported a usage limit. Resume when it lifts.");
          break;
        case "logged-out":
          fail("logged-out", "You appear to be logged out of ChatGPT.");
          break;
        case "network-error":
          fail("network-error", "ChatGPT hit an error mid-reply. Use Regenerate, then Resume.");
          break;
        case "conversation-full":
          fail(
            "conversation-full",
            "This conversation hit its length limit. Use the handoff prompt in a new chat.",
          );
          break;
      }
      break;
    }
  }

  if (state.status !== "cooldown") delete state.cooldownUntil;
  return { state, effects };
}

function handleReply(
  state: RunState,
  marker: Marker | null,
  text: string,
  settings: Settings,
  effects: Effect[],
  note: (kind: ActivityEntry["kind"], text: string) => void,
  fail: (code: ErrorCode, message: string) => void,
): void {
  if (!marker) {
    if (state.phase !== "planning" && state.phase !== "developing") {
      state.status = "awaiting_user";
      return;
    }
    if (state.nudges === 0) {
      state.nudges = 1;
      state.status = "inserting";
      note("warn", "Reply had no status marker — sending recovery nudge");
      effects.push({ do: "insertAndSend", kind: "nudge" });
    } else {
      fail("marker-missing", "ChatGPT stopped emitting the status marker.");
    }
    return;
  }

  state.nudges = 0;
  state.lastMarker = marker;
  if (marker.repo) state.repo = marker.repo;
  note("marker", marker.raw);

  switch (marker.status) {
    case "CONTINUE": {
      if (state.phase === "plan_ready") state.phase = "planning";
      if (state.phase !== "planning" && state.phase !== "developing") {
        state.status = "awaiting_user";
        return;
      }
      if (state.autoSends >= settings.autoContinueCap) {
        fail(
          "cap-reached",
          `Auto-continue cap (${settings.autoContinueCap}) reached for this phase.`,
        );
        return;
      }
      state.status = "cooldown";
      state.cooldownUntil = state.updatedAt + settings.sendDelayMs;
      effects.push({ do: "startCooldown", ms: settings.sendDelayMs });
      return;
    }
    case "NEEDS_INPUT":
    case "ERROR": {
      state.status = "awaiting_user";
      state.pauseReason = marker.note ?? "ChatGPT needs your input.";
      effects.push({ do: "badge", text: "?" });
      effects.push({
        do: "notify",
        title: "Chat FreePT needs you",
        message: marker.note ?? "ChatGPT is waiting for your input.",
      });
      return;
    }
    case "PLAN_READY": {
      state.phase = "plan_ready";
      state.status = "awaiting_user";
      state.planSummary = marker.note ?? excerpt(text);
      effects.push({ do: "badge", text: "PLAN" });
      effects.push({
        do: "notify",
        title: "Master plan ready",
        message: "Review the plan, then press Start development.",
      });
      return;
    }
    case "COMPLETE": {
      state.phase = "complete";
      state.status = "complete";
      effects.push({ do: "badge", text: "DONE" });
      effects.push({ do: "showModal" });
      effects.push({
        do: "notify",
        title: "Development complete",
        message: state.repo
          ? `ChatGPT reports ${state.repo} is done.`
          : "ChatGPT reports the project is done.",
      });
      return;
    }
  }
}

function excerpt(text: string): string {
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length > 400 ? `${clean.slice(0, 400)}…` : clean;
}
