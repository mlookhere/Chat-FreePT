import { describe, expect, it } from "vitest";
import {
  autoContinueEnabled,
  newRunState,
  reduce,
  type Effect,
  type MachineEvent,
} from "../src/common/state-machine";
import type { Marker, RunState, Settings } from "../src/common/types";
import { DEFAULT_SETTINGS } from "../src/common/types";

const settings: Settings = { ...DEFAULT_SETTINGS, sendDelayMs: 1000, autoContinueCap: 3 };

function marker(status: Marker["status"]): Marker {
  return { status, version: 1, raw: status };
}

function drive(state: RunState, events: MachineEvent[]): { state: RunState; effects: Effect[] } {
  let current = state;
  const effects: Effect[] = [];
  for (const event of events) {
    const result = reduce(current, event, settings);
    current = result.state;
    effects.push(...result.effects);
  }
  return { state: current, effects };
}

function streamingRun(): RunState {
  return drive(newRunState("c1", 1000), [
    { type: "USER_START", idea: "build it", repoMode: "new", repoName: "" },
    { type: "INSERT_OK" },
    { type: "SEND_OK" },
  ]).state;
}

describe("continuation controls", () => {
  it("defaults new and legacy runs to auto-continue enabled", () => {
    expect(autoContinueEnabled(newRunState("new", 1))).toBe(true);
    const legacy = { ...newRunState("legacy", 1), autoContinueEnabled: undefined };
    expect(autoContinueEnabled(legacy)).toBe(true);
  });

  it("waits on CONTINUE when auto-continue is disabled", () => {
    let state = streamingRun();
    state = reduce(state, { type: "USER_SET_AUTO_CONTINUE", enabled: false }, settings).state;
    const result = reduce(
      state,
      { type: "REPLY_COMPLETE", marker: marker("CONTINUE"), text: "continue" },
      settings,
    );

    expect(result.state.status).toBe("awaiting_user");
    expect(result.state.pauseReason).toBe("Auto-continue is off.");
    expect(result.effects).not.toContainEqual({ do: "startCooldown", ms: 1000 });
  });

  it("disabling a pending automatic cooldown stops it and re-enabling resumes it", () => {
    let state = streamingRun();
    state = reduce(
      state,
      { type: "REPLY_COMPLETE", marker: marker("CONTINUE"), text: "" },
      settings,
    ).state;
    expect(state.status).toBe("cooldown");

    state = reduce(state, { type: "USER_SET_AUTO_CONTINUE", enabled: false }, settings).state;
    expect(state.status).toBe("awaiting_user");
    expect(state.cooldownUntil).toBeUndefined();

    const resumed = reduce(state, { type: "USER_SET_AUTO_CONTINUE", enabled: true }, settings);
    expect(resumed.state.status).toBe("cooldown");
    expect(resumed.effects).toContainEqual({ do: "startCooldown", ms: 1000 });
  });

  it("sends a queued user message before continue even when auto-continue is off", () => {
    let state = streamingRun();
    state = reduce(state, { type: "USER_SET_AUTO_CONTINUE", enabled: false }, settings).state;
    state = reduce(state, { type: "USER_QUEUE_NEXT", text: "  Run the audit first.  " }, settings).state;
    state = { ...state, autoSends: settings.autoContinueCap };

    state = reduce(
      state,
      { type: "REPLY_COMPLETE", marker: marker("CONTINUE"), text: "" },
      settings,
    ).state;
    expect(state.status).toBe("cooldown");

    const result = reduce(state, { type: "COOLDOWN_ELAPSED" }, settings);
    expect(result.state.status).toBe("inserting");
    expect(result.state.queuedUserText).toBeUndefined();
    expect(result.state.autoSends).toBe(settings.autoContinueCap);
    expect(result.effects).toContainEqual({
      do: "insertAndSend",
      kind: "user_text",
      text: "Run the audit first.",
    });
  });

  it("returns to waiting after a queued message reply while auto-continue remains off", () => {
    let state = streamingRun();
    state = reduce(state, { type: "USER_SET_AUTO_CONTINUE", enabled: false }, settings).state;
    state = reduce(state, { type: "USER_QUEUE_NEXT", text: "Check the tests." }, settings).state;
    state = reduce(
      state,
      { type: "REPLY_COMPLETE", marker: marker("CONTINUE"), text: "" },
      settings,
    ).state;
    state = reduce(state, { type: "COOLDOWN_ELAPSED" }, settings).state;
    state = drive(state, [{ type: "INSERT_OK" }, { type: "SEND_OK" }]).state;

    const result = reduce(
      state,
      { type: "REPLY_COMPLETE", marker: marker("CONTINUE"), text: "" },
      settings,
    );
    expect(result.state.status).toBe("awaiting_user");
    expect(result.state.pauseReason).toBe("Auto-continue is off.");
  });

  it("clearing the only queued message cancels a cooldown when auto-continue is off", () => {
    let state = streamingRun();
    state = reduce(state, { type: "USER_SET_AUTO_CONTINUE", enabled: false }, settings).state;
    state = reduce(state, { type: "USER_QUEUE_NEXT", text: "Do this next." }, settings).state;
    state = reduce(
      state,
      { type: "REPLY_COMPLETE", marker: marker("CONTINUE"), text: "" },
      settings,
    ).state;
    expect(state.status).toBe("cooldown");

    state = reduce(state, { type: "USER_CLEAR_QUEUE" }, settings).state;
    expect(state.status).toBe("awaiting_user");
    expect(state.queuedUserText).toBeUndefined();
    expect(state.cooldownUntil).toBeUndefined();
  });

  it("STOP resets stale run state while preserving the auto-continue preference", () => {
    const dirty: RunState = {
      ...streamingRun(),
      phase: "developing",
      status: "cooldown",
      autoContinueEnabled: false,
      queuedUserText: "stale instruction",
      repo: "owner/repo",
      planSummary: "old plan",
      pauseReason: "old pause",
      errorCode: "send-failed",
      lastMarker: marker("CONTINUE"),
      cooldownUntil: Date.now() + 5000,
      autoSends: 2,
      nudges: 1,
      repliesSinceContract: 7,
    };

    const result = reduce(dirty, { type: "USER_STOP" }, settings);
    expect(result.state.phase).toBe("idle");
    expect(result.state.status).toBe("idle");
    expect(result.state.autoContinueEnabled).toBe(false);
    expect(result.state.queuedUserText).toBeUndefined();
    expect(result.state.repo).toBeUndefined();
    expect(result.state.lastMarker).toBeUndefined();
    expect(result.state.pauseReason).toBeUndefined();
    expect(result.state.errorCode).toBeUndefined();
    expect(result.state.cooldownUntil).toBeUndefined();
    expect(result.state.autoSends).toBe(0);
    expect(result.state.nudges).toBe(0);
    expect(result.state.repliesSinceContract).toBe(0);
    expect(result.effects).toContainEqual({ do: "badge", text: "" });
  });
});
