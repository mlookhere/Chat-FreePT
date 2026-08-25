import { afterEach, describe, expect, it, vi } from "vitest";
import { cooldownRemainingMs, newRunState, reduce } from "../src/common/state-machine";
import type { Marker, RunState, Settings } from "../src/common/types";
import { DEFAULT_SETTINGS } from "../src/common/types";

const settings: Settings = { ...DEFAULT_SETTINGS, sendDelayMs: 8_000 };

function marker(): Marker {
  return { status: "CONTINUE", version: 1, raw: "CONTINUE" };
}

function streamingState(): RunState {
  const initial = newRunState("c1", Date.now());
  const started = reduce(
    initial,
    { type: "USER_START", idea: "build", repoMode: "new", repoName: "" },
    settings,
  ).state;
  const sending = reduce(started, { type: "INSERT_OK" }, settings).state;
  return reduce(sending, { type: "SEND_OK" }, settings).state;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("persisted cooldowns", () => {
  it("stores an absolute deadline when CONTINUE starts a cooldown", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);

    const result = reduce(
      streamingState(),
      { type: "REPLY_COMPLETE", marker: marker(), text: "" },
      settings,
    );

    expect(result.state.status).toBe("cooldown");
    expect(result.state.cooldownUntil).toBe(18_000);
    expect(result.effects).toContainEqual({ do: "startCooldown", ms: 8_000 });
  });

  it("calculates only the remaining delay after reload", () => {
    const state = { ...newRunState("c1", 0), status: "cooldown" as const, cooldownUntil: 18_000 };

    expect(cooldownRemainingMs(state, 13_500)).toBe(4_500);
    expect(cooldownRemainingMs(state, 20_000)).toBe(0);
  });

  it("resumes legacy cooldown state without adding another full delay", () => {
    const state = { ...newRunState("c1", 0), status: "cooldown" as const };

    expect(cooldownRemainingMs(state, 50_000)).toBe(0);
  });

  it("clears the deadline when the cooldown elapses", () => {
    const state = {
      ...newRunState("c1", 0),
      phase: "developing" as const,
      status: "cooldown" as const,
      cooldownUntil: 18_000,
    };

    const result = reduce(state, { type: "COOLDOWN_ELAPSED" }, settings);

    expect(result.state.status).toBe("inserting");
    expect(result.state.cooldownUntil).toBeUndefined();
  });

  it("clears the deadline when the user pauses during cooldown", () => {
    const state = {
      ...newRunState("c1", 0),
      phase: "developing" as const,
      status: "cooldown" as const,
      cooldownUntil: 18_000,
    };

    const result = reduce(state, { type: "USER_PAUSE" }, settings);

    expect(result.state.status).toBe("paused");
    expect(result.state.cooldownUntil).toBeUndefined();
  });
});
