import { describe, expect, it } from "vitest";
import type { Effect, MachineEvent } from "../src/common/state-machine";
import { isActive, newRunState, reduce } from "../src/common/state-machine";
import type { Marker, RunState, Settings } from "../src/common/types";
import { DEFAULT_SETTINGS } from "../src/common/types";

const settings: Settings = { ...DEFAULT_SETTINGS, sendDelayMs: 1000, autoContinueCap: 3 };

function marker(status: Marker["status"], fields: Partial<Marker> = {}): Marker {
  return { status, version: 1, raw: status, ...fields };
}

function start(): RunState {
  const initial = newRunState("c1", 1000);
  return reduce(
    initial,
    { type: "USER_START", idea: "build a thing", repoMode: "existing", repoName: "o/r" },
    settings,
  ).state;
}

function drive(state: RunState, events: MachineEvent[]): { state: RunState; effects: Effect[] } {
  let current = state;
  const all: Effect[] = [];
  for (const event of events) {
    const result = reduce(current, event, settings);
    current = result.state;
    all.push(...result.effects);
  }
  return { state: current, effects: all };
}

function toStreaming(state: RunState): RunState {
  return drive(state, [{ type: "INSERT_OK" }, { type: "SEND_OK" }]).state;
}

describe("state persistence context", () => {
  it("persists idle repository and idea drafts before planning starts", () => {
    const initial = newRunState("c1", 1000);
    const result = reduce(
      initial,
      { type: "USER_UPDATE_DRAFT", repoName: "owner/draft", idea: "draft project" },
      settings,
    );
    expect(result.state.repoName).toBe("owner/draft");
    expect(result.state.repoMode).toBe("existing");
    expect(result.state.idea).toBe("draft project");
    expect(result.effects).toEqual([]);
  });

  it("tracks the latest human-authored message as queued messages are sent", () => {
    let state = start();
    expect(state.lastUserText).toBe("build a thing");
    state = reduce(
      state,
      { type: "USER_QUEUE_NEXT", text: "run the release checks" },
      settings,
    ).state;
    state = toStreaming(state);
    state = reduce(
      state,
      { type: "REPLY_COMPLETE", marker: marker("CONTINUE"), text: "" },
      settings,
    ).state;
    state = reduce(state, { type: "COOLDOWN_ELAPSED" }, settings).state;
    expect(state.lastUserText).toBe("run the release checks");
  });

  it("resumes when ChatGPT starts generating after an interruption", () => {
    const interrupted = reduce(
      toStreaming(start()),
      { type: "STREAM_INTERRUPTED", reason: "Generation stopped in ChatGPT" },
      settings,
    ).state;
    const resumed = reduce(interrupted, { type: "STREAM_STARTED" }, settings);
    expect(resumed.state.status).toBe("streaming");
    expect(resumed.state.lastLifecycleSignal).toBe("generation-start");
    expect(resumed.state.pauseReason).toBeUndefined();
  });

  it("resumes an interrupted run through the queued continuation boundary", () => {
    let state = toStreaming(start());
    state = reduce(
      state,
      { type: "USER_QUEUE_NEXT", text: "make the transition seamless" },
      settings,
    ).state;
    state = reduce(
      state,
      { type: "STREAM_INTERRUPTED", reason: "Generation stopped in ChatGPT" },
      settings,
    ).state;

    const resumed = reduce(state, { type: "USER_RESUME" }, settings);
    expect(resumed.state.status).toBe("cooldown");
    expect(resumed.effects).toContainEqual({ do: "startCooldown", ms: 1000 });

    const sent = reduce(resumed.state, { type: "COOLDOWN_ELAPSED" }, settings);
    expect(sent.state.status).toBe("inserting");
    expect(sent.state.lastUserText).toBe("make the transition seamless");
    expect(sent.state.queuedUserTexts).toBeUndefined();
    expect(sent.effects).toContainEqual({
      do: "insertAndSend",
      kind: "queued_user_text",
      text: "make the transition seamless",
    });
  });

  it("resumes an interrupted run with normal auto-continue when the queue is empty", () => {
    const interrupted = reduce(
      toStreaming(start()),
      { type: "STREAM_INTERRUPTED", reason: "Generation stopped in ChatGPT" },
      settings,
    ).state;

    const resumed = reduce(interrupted, { type: "USER_RESUME" }, settings);
    expect(resumed.state.status).toBe("cooldown");

    const sent = reduce(resumed.state, { type: "COOLDOWN_ELAPSED" }, settings);
    expect(sent.state.autoSends).toBe(1);
    expect(sent.effects).toContainEqual({ do: "insertAndSend", kind: "continue" });
  });

  it("repairs a persisted phantom stream from an interrupted resume", () => {
    let stale = reduce(
      toStreaming(start()),
      { type: "STREAM_INTERRUPTED", reason: "Generation stopped in ChatGPT" },
      settings,
    ).state;
    stale = { ...stale, status: "streaming" };

    const recovered = reduce(stale, { type: "RECOVERY_CONTINUE" }, settings);
    expect(recovered.state.status).toBe("cooldown");
    expect(recovered.effects).toContainEqual({ do: "startCooldown", ms: 1000 });
  });

  it("recovers only an interrupted permission flow", () => {
    const interrupted = reduce(
      toStreaming(start()),
      { type: "STREAM_INTERRUPTED", reason: "Generation stopped in ChatGPT" },
      settings,
    ).state;
    const recovered = reduce(interrupted, { type: "PERMISSION_CONTINUED" }, settings);
    expect(recovered.state.status).toBe("streaming");
    expect(recovered.state.lastLifecycleSignal).toBe("permission-continued");
    expect(recovered.effects).toContainEqual({ do: "reconcile" });

    const manuallyPaused = reduce(toStreaming(start()), { type: "USER_PAUSE" }, settings).state;
    expect(reduce(manuallyPaused, { type: "PERMISSION_CONTINUED" }, settings).state).toBe(
      manuallyPaused,
    );
  });
});

describe("state machine continuation lifecycle", () => {
  it("USER_START enters planning and requests the plan prompt", () => {
    const initial = newRunState("c1", 1000);
    const { state, effects } = reduce(
      initial,
      { type: "USER_START", idea: "an idea", repoMode: "existing", repoName: "o/r" },
      settings,
    );
    expect(state.phase).toBe("planning");
    expect(state.status).toBe("inserting");
    expect(effects).toContainEqual({ do: "insertAndSend", kind: "plan" });
  });

  it("requires a repository before planning", () => {
    const result = reduce(
      newRunState("c1", 1000),
      { type: "USER_START", idea: "an idea", repoMode: "new", repoName: "" },
      settings,
    );
    expect(result.state.status).toBe("error");
    expect(result.state.errorCode).toBe("repo-required");
  });

  it("locks the normalized repository and refuses a later switch", () => {
    let state = reduce(
      newRunState("c1", 1000),
      {
        type: "USER_START",
        idea: "an idea",
        repoMode: "existing",
        repoName: "https://github.com/Owner/project.git",
      },
      settings,
    ).state;
    expect(state.repo).toBe("Owner/project");

    state = reduce(toStreaming(state), { type: "USER_STOP" }, settings).state;
    expect(state.repo).toBe("Owner/project");

    const switched = reduce(
      state,
      { type: "USER_START", idea: "other", repoMode: "existing", repoName: "owner/other" },
      settings,
    );
    expect(switched.state.status).toBe("error");
    expect(switched.state.errorCode).toBe("repo-mismatch");
    expect(switched.state.repo).toBe("Owner/project");
  });

  it("rejects a status marker that reports a different repository", () => {
    const result = reduce(
      toStreaming(start()),
      {
        type: "REPLY_COMPLETE",
        marker: marker("CONTINUE", { repo: "other/repo" }),
        text: "",
      },
      settings,
    );
    expect(result.state.status).toBe("error");
    expect(result.state.errorCode).toBe("repo-mismatch");
    expect(result.state.repo).toBe("o/r");
  });
});

describe("state machine continuation lifecycle", () => {
  it("walks insert → send → streaming", () => {
    const state = toStreaming(start());
    expect(state.status).toBe("streaming");
    expect(isActive(state)).toBe(true);
  });

  it("CONTINUE marker schedules a cooldown", () => {
    const streaming = toStreaming(start());
    const { state, effects } = reduce(
      streaming,
      { type: "REPLY_COMPLETE", marker: marker("CONTINUE"), text: "…" },
      settings,
    );
    expect(state.status).toBe("cooldown");
    expect(effects).toContainEqual({ do: "startCooldown", ms: 1000 });
  });

  it("cooldown elapse auto-continues and counts", () => {
    const streaming = toStreaming(start());
    const cooled = reduce(
      streaming,
      { type: "REPLY_COMPLETE", marker: marker("CONTINUE"), text: "" },
      settings,
    ).state;
    const { state, effects } = reduce(cooled, { type: "COOLDOWN_ELAPSED" }, settings);
    expect(state.status).toBe("inserting");
    expect(state.autoSends).toBe(1);
    expect(effects).toContainEqual({ do: "insertAndSend", kind: "continue" });
  });

  it("enforces the auto-continue cap", () => {
    let state = start();
    for (let i = 0; i < settings.autoContinueCap; i++) {
      state = toStreaming(state);
      state = reduce(
        state,
        { type: "REPLY_COMPLETE", marker: marker("CONTINUE"), text: "" },
        settings,
      ).state;
      state = reduce(state, { type: "COOLDOWN_ELAPSED" }, settings).state;
    }
    state = toStreaming(state);
    const result = reduce(
      state,
      { type: "REPLY_COMPLETE", marker: marker("CONTINUE"), text: "" },
      settings,
    );
    expect(result.state.status).toBe("error");
    expect(result.state.errorCode).toBe("cap-reached");
  });

  it("refreshes the contract every N auto-continues", () => {
    const refreshSettings = { ...settings, contractRefreshEvery: 2 };
    let state = start();
    const kinds: string[] = [];
    for (let i = 0; i < 3; i++) {
      state = toStreaming(state);
      state = reduce(
        state,
        { type: "REPLY_COMPLETE", marker: marker("CONTINUE"), text: "" },
        refreshSettings,
      ).state;
      const result = reduce(state, { type: "COOLDOWN_ELAPSED" }, refreshSettings);
      state = result.state;
      for (const effect of result.effects) {
        if (effect.do === "insertAndSend") kinds.push(effect.kind);
      }
    }
    expect(kinds).toContain("contract_refresh");
  });
});

describe("state machine reply checkpoints", () => {
  it("persists the assistant baseline when a reply is armed", () => {
    const sending = drive(start(), [{ type: "INSERT_OK" }]).state;
    const result = reduce(
      sending,
      { type: "REPLY_EXPECTED", baselineAssistantKey: "message:before-send" },
      settings,
    );
    expect(result.state.replyBaselineAssistantKey).toBe("message:before-send");
  });

  it("rejects a stale reply that matches the pre-send assistant baseline", () => {
    let state = toStreaming(start());
    state = {
      ...state,
      replyBaselineAssistantKey: "message:before-send",
    };
    const result = reduce(
      state,
      {
        type: "REPLY_COMPLETE",
        marker: marker("CONTINUE"),
        text: "",
        assistantKey: "message:before-send",
      },
      settings,
    );
    expect(result.state).toBe(state);
    expect(result.effects).toEqual([]);
  });

  it("consumes a fresh assistant turn only once", () => {
    let state = toStreaming(start());
    state = reduce(
      state,
      {
        type: "REPLY_COMPLETE",
        marker: marker("CONTINUE"),
        text: "",
        assistantKey: "message:fresh",
      },
      settings,
    ).state;
    expect(state.lastProcessedAssistantKey).toBe("message:fresh");
    expect(state.status).toBe("cooldown");

    state = { ...state, status: "streaming" };
    const duplicate = reduce(
      state,
      {
        type: "REPLY_COMPLETE",
        marker: marker("CONTINUE"),
        text: "",
        assistantKey: "message:fresh",
      },
      settings,
    );
    expect(duplicate.state).toBe(state);
    expect(duplicate.effects).toEqual([]);
  });

  it("accepts a fresh marker-bearing reply after the user answered directly in chat", () => {
    let state = toStreaming(start());
    state = reduce(
      state,
      {
        type: "REPLY_COMPLETE",
        marker: marker("NEEDS_INPUT"),
        text: "",
        assistantKey: "message:question",
      },
      settings,
    ).state;
    expect(state.status).toBe("awaiting_user");

    const result = reduce(
      state,
      {
        type: "REPLY_COMPLETE",
        marker: marker("CONTINUE"),
        text: "",
        assistantKey: "message:manual-answer-reply",
      },
      settings,
    );
    expect(result.state.status).toBe("cooldown");
    expect(result.state.lastProcessedAssistantKey).toBe("message:manual-answer-reply");
  });
});

describe("state machine marker transitions", () => {
  it("NEEDS_INPUT pauses for the user and notifies", () => {
    const streaming = toStreaming(start());
    const { state, effects } = reduce(
      streaming,
      { type: "REPLY_COMPLETE", marker: marker("NEEDS_INPUT", { note: "pick a name" }), text: "" },
      settings,
    );
    expect(state.status).toBe("awaiting_user");
    expect(state.pauseReason).toBe("pick a name");
    expect(effects.some((e) => e.do === "notify")).toBe(true);
  });

  it("PLAN_READY transitions to plan_ready and waits", () => {
    const streaming = toStreaming(start());
    const { state } = reduce(
      streaming,
      {
        type: "REPLY_COMPLETE",
        marker: marker("PLAN_READY", { repo: "o/r", note: "5 items" }),
        text: "the plan",
      },
      settings,
    );
    expect(state.phase).toBe("plan_ready");
    expect(state.status).toBe("awaiting_user");
    expect(state.repo).toBe("o/r");
    expect(state.planSummary).toBe("5 items");
  });

  it("USER_START_DEVELOPMENT resets counters and sends the develop prompt", () => {
    const streaming = toStreaming(start());
    let state = reduce(
      streaming,
      { type: "REPLY_COMPLETE", marker: marker("PLAN_READY"), text: "" },
      settings,
    ).state;
    const result = reduce(state, { type: "USER_START_DEVELOPMENT" }, settings);
    state = result.state;
    expect(state.phase).toBe("developing");
    expect(state.autoSends).toBe(0);
    expect(result.effects).toContainEqual({ do: "insertAndSend", kind: "develop" });
  });

  it("plan revision: CONTINUE from plan_ready re-enters planning", () => {
    const streaming = toStreaming(start());
    let state = reduce(
      streaming,
      { type: "REPLY_COMPLETE", marker: marker("PLAN_READY"), text: "" },
      settings,
    ).state;
    state = reduce(state, { type: "STREAM_STARTED" }, settings).state;
    const result = reduce(
      state,
      { type: "REPLY_COMPLETE", marker: marker("CONTINUE"), text: "" },
      settings,
    );
    expect(result.state.phase).toBe("planning");
    expect(result.state.status).toBe("cooldown");
  });

  it("COMPLETE shows the modal", () => {
    const streaming = toStreaming(start());
    let state = reduce(
      streaming,
      { type: "REPLY_COMPLETE", marker: marker("PLAN_READY"), text: "" },
      settings,
    ).state;
    state = reduce(state, { type: "USER_START_DEVELOPMENT" }, settings).state;
    state = toStreaming(state);
    const { state: done, effects } = reduce(
      state,
      { type: "REPLY_COMPLETE", marker: marker("COMPLETE", { repo: "o/r" }), text: "" },
      settings,
    );
    expect(done.phase).toBe("complete");
    expect(done.status).toBe("complete");
    expect(effects.some((e) => e.do === "showCompletion")).toBe(true);
  });
});

describe("state machine recovery and user control", () => {
  it("missing marker nudges once, then pauses", () => {
    let state = toStreaming(start());
    const first = reduce(
      state,
      { type: "REPLY_COMPLETE", marker: null, text: "no marker" },
      settings,
    );
    state = first.state;
    expect(state.nudges).toBe(1);
    expect(first.effects).toContainEqual({ do: "insertAndSend", kind: "nudge" });

    state = toStreaming(state);
    const second = reduce(state, { type: "REPLY_COMPLETE", marker: null, text: "" }, settings);
    expect(second.state.status).toBe("error");
    expect(second.state.errorCode).toBe("marker-missing");
  });

  it("a successful marker resets the nudge counter", () => {
    let state = toStreaming(start());
    state = reduce(state, { type: "REPLY_COMPLETE", marker: null, text: "" }, settings).state;
    state = toStreaming(state);
    state = reduce(
      state,
      { type: "REPLY_COMPLETE", marker: marker("CONTINUE"), text: "" },
      settings,
    ).state;
    expect(state.nudges).toBe(0);
  });

  it("pause blocks stream events; resume reconciles", () => {
    let state = toStreaming(start());
    state = reduce(state, { type: "USER_PAUSE" }, settings).state;
    expect(state.status).toBe("paused");
    const ignored = reduce(state, { type: "STREAM_STARTED" }, settings);
    expect(ignored.state).toBe(state);

    const resumed = reduce(state, { type: "USER_RESUME" }, settings);
    expect(resumed.state.status).toBe("streaming");
    expect(resumed.effects).toContainEqual({ do: "reconcile" });
  });

  it("STREAM_INTERRUPTED pauses without scheduling continuation", () => {
    const result = reduce(
      toStreaming(start()),
      { type: "STREAM_INTERRUPTED", reason: "Generation stopped in ChatGPT" },
      settings,
    );
    expect(result.state.status).toBe("paused");
    expect(result.state.pauseReason).toBe("Generation stopped in ChatGPT");
    expect(result.effects).toContainEqual({ do: "badge", text: "II" });
    expect(result.effects.some((effect) => effect.do === "startCooldown")).toBe(false);
  });

  it("USER_STOP resets the run but preserves the repository lock", () => {
    const state = reduce(toStreaming(start()), { type: "USER_STOP" }, settings).state;
    expect(state.phase).toBe("idle");
    expect(state.status).toBe("idle");
    expect(state.repo).toBe("o/r");
    expect(state.repoName).toBe("o/r");
  });

  it("page signals pause with the right code", () => {
    const cases = [
      ["rate-limit", "rate-limited"],
      ["logged-out", "logged-out"],
      ["network-error", "network-error"],
      ["conversation-full", "conversation-full"],
    ] as const;
    for (const [signal, code] of cases) {
      const state = toStreaming(start());
      const result = reduce(state, { type: "PAGE_SIGNAL", signal }, settings);
      expect(result.state.status).toBe("error");
      expect(result.state.errorCode).toBe(code);
    }
  });

  it("USER_REPLY sends the user's text with the marker re-arm", () => {
    const streaming = toStreaming(start());
    const paused = reduce(
      streaming,
      { type: "REPLY_COMPLETE", marker: marker("NEEDS_INPUT"), text: "" },
      settings,
    ).state;
    const { state, effects } = reduce(paused, { type: "USER_REPLY", text: "use sqlite" }, settings);
    expect(state.status).toBe("inserting");
    expect(effects).toContainEqual({ do: "insertAndSend", kind: "user_text", text: "use sqlite" });
  });

  it("ignores REPLY_COMPLETE arriving outside a streaming state", () => {
    const idle = newRunState("c1", 0);
    const result = reduce(
      idle,
      { type: "REPLY_COMPLETE", marker: marker("CONTINUE"), text: "" },
      settings,
    );
    expect(result.state).toBe(idle);
    expect(result.effects).toEqual([]);
  });

  it("caps the activity log", () => {
    let state = start();
    for (let i = 0; i < 260; i++) {
      state = reduce(state, { type: "USER_PAUSE" }, settings).state;
      state = reduce(state, { type: "USER_RESUME" }, settings).state;
    }
    expect(state.log.length).toBeLessThanOrEqual(200);
  });
});
