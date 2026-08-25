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
    { type: "USER_START", idea: "build a thing", repoMode: "new", repoName: "" },
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
    expect(effects.some((e) => e.do === "showModal")).toBe(true);
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

  it("USER_STOP resets the run", () => {
    const state = reduce(toStreaming(start()), { type: "USER_STOP" }, settings).state;
    expect(state.phase).toBe("idle");
    expect(state.status).toBe("idle");
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
