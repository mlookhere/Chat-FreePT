import { describe, expect, it } from "vitest";
import {
  autoContinueEnabled,
  isWaitingForManualContinue,
  newRunState,
  queuedMessages,
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
    { type: "USER_START", idea: "build it", repoMode: "existing", repoName: "owner/project" },
    { type: "INSERT_OK" },
    { type: "SEND_OK" },
  ]).state;
}

describe("continuous mode", () => {
  it("is always enabled, including legacy runs that stored false", () => {
    expect(autoContinueEnabled(newRunState("new", 1))).toBe(true);
    const legacy = { ...newRunState("legacy", 1), autoContinueEnabled: false };
    expect(autoContinueEnabled(legacy)).toBe(true);
    expect(isWaitingForManualContinue(legacy)).toBe(false);
  });

  it("continues even if a legacy state says auto-continue was off", () => {
    const state = { ...streamingRun(), autoContinueEnabled: false };
    const result = reduce(
      state,
      { type: "REPLY_COMPLETE", marker: marker("CONTINUE"), text: "continue" },
      settings,
    );

    expect(result.state.status).toBe("cooldown");
    expect(result.effects).toContainEqual({ do: "startCooldown", ms: 1000 });
  });

  it("does not stop at the old per-phase continuation cap", () => {
    let state = { ...streamingRun(), autoSends: settings.autoContinueCap + 20 };
    state = reduce(
      state,
      { type: "REPLY_COMPLETE", marker: marker("CONTINUE"), text: "" },
      settings,
    ).state;
    const result = reduce(state, { type: "COOLDOWN_ELAPSED" }, settings);

    expect(result.state.status).toBe("inserting");
    expect(result.state.autoSends).toBe(settings.autoContinueCap + 21);
    expect(result.effects).toContainEqual({ do: "insertAndSend", kind: "continue" });
    expect(result.state.errorCode).toBeUndefined();
  });
});

describe("queued continuation input", () => {
  it("sends queued user text before generic continuation", () => {
    let state = streamingRun();
    state = reduce(
      state,
      { type: "USER_QUEUE_NEXT", text: "  Run the audit first.  " },
      settings,
    ).state;
    state = reduce(
      state,
      { type: "REPLY_COMPLETE", marker: marker("CONTINUE"), text: "" },
      settings,
    ).state;

    const result = reduce(state, { type: "COOLDOWN_ELAPSED" }, settings);
    expect(result.state.status).toBe("inserting");
    expect(queuedMessages(result.state)).toEqual([]);
    expect(result.effects).toContainEqual({
      do: "insertAndSend",
      kind: "queued_user_text",
      text: "Run the audit first.",
    });
  });

  it("keeps multiple queued messages FIFO and supports reorder/remove", () => {
    let state = streamingRun();
    state = reduce(state, { type: "USER_QUEUE_NEXT", text: "first" }, settings).state;
    state = reduce(state, { type: "USER_QUEUE_NEXT", text: "second" }, settings).state;
    state = reduce(state, { type: "USER_QUEUE_NEXT", text: "third" }, settings).state;
    expect(queuedMessages(state)).toEqual(["first", "second", "third"]);

    state = reduce(state, { type: "USER_MOVE_QUEUE", index: 2, direction: -1 }, settings).state;
    expect(queuedMessages(state)).toEqual(["first", "third", "second"]);

    state = reduce(state, { type: "USER_REMOVE_QUEUE", index: 1 }, settings).state;
    expect(queuedMessages(state)).toEqual(["first", "second"]);

    state = reduce(
      state,
      { type: "REPLY_COMPLETE", marker: marker("CONTINUE"), text: "" },
      settings,
    ).state;
    const first = reduce(state, { type: "COOLDOWN_ELAPSED" }, settings);
    expect(first.effects).toContainEqual({
      do: "insertAndSend",
      kind: "queued_user_text",
      text: "first",
    });
    expect(queuedMessages(first.state)).toEqual(["second"]);
  });

  it("migrates the legacy single-message slot into the ordered queue", () => {
    const legacy = { ...streamingRun(), queuedUserText: "legacy next" };
    expect(queuedMessages(legacy)).toEqual(["legacy next"]);

    const appended = reduce(legacy, { type: "USER_QUEUE_NEXT", text: "new next" }, settings).state;
    expect(appended.queuedUserText).toBeUndefined();
    expect(queuedMessages(appended)).toEqual(["legacy next", "new next"]);
  });

  it("clearing a queue does not cancel continuous mode", () => {
    let state = streamingRun();
    state = reduce(state, { type: "USER_QUEUE_NEXT", text: "Do this next." }, settings).state;
    state = reduce(
      state,
      { type: "REPLY_COMPLETE", marker: marker("CONTINUE"), text: "" },
      settings,
    ).state;
    expect(state.status).toBe("cooldown");

    state = reduce(state, { type: "USER_CLEAR_QUEUE" }, settings).state;
    expect(state.status).toBe("cooldown");
    expect(queuedMessages(state)).toEqual([]);
  });
});

describe("run reset semantics", () => {
  it("STOP resets stale run state, preserves the repo, and restores continuous mode", () => {
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
    expect(result.state.autoContinueEnabled).toBe(true);
    expect(queuedMessages(result.state)).toEqual([]);
    expect(result.state.repo).toBe("owner/repo");
    expect(result.state.lastMarker).toBeUndefined();
    expect(result.state.pauseReason).toBeUndefined();
    expect(result.state.errorCode).toBeUndefined();
    expect(result.state.cooldownUntil).toBeUndefined();
    expect(result.state.autoSends).toBe(0);
    expect(result.state.nudges).toBe(0);
    expect(result.state.repliesSinceContract).toBe(0);
    expect(result.effects).toContainEqual({ do: "badge", text: "" });
  });

  it("NEW PROJECT uses the same clean reset", () => {
    const dirty: RunState = {
      ...streamingRun(),
      phase: "complete",
      status: "complete",
      autoContinueEnabled: false,
      queuedUserText: "stale instruction",
      repo: "owner/repo",
      planSummary: "old plan",
      lastMarker: marker("COMPLETE"),
      autoSends: 3,
    };

    const result = reduce(dirty, { type: "USER_NEW_PROJECT" }, settings);
    expect(result.state.phase).toBe("idle");
    expect(result.state.status).toBe("idle");
    expect(result.state.autoContinueEnabled).toBe(true);
    expect(result.state.idea).toBe("");
    expect(result.state.repo).toBe("owner/repo");
    expect(queuedMessages(result.state)).toEqual([]);
    expect(result.state.lastMarker).toBeUndefined();
    expect(result.state.autoSends).toBe(0);
    expect(result.state.log).toHaveLength(1);
    expect(result.state.log.at(-1)?.text).toBe("Ready for a new project");
    expect(result.effects).toContainEqual({ do: "badge", text: "" });
  });
});
