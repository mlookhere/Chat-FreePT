import { beforeEach, describe, expect, it } from "vitest";
import { autoContinueEnabled, newRunState } from "../src/common/state-machine";
import { loadRun, runKey, saveRun } from "../src/common/storage";
import { installChromeMock } from "./chrome-mock";

let stores: ReturnType<typeof installChromeMock>;

beforeEach(() => {
  stores = installChromeMock();
});

describe("continuation state storage", () => {
  it("loads a legacy v1 run without the new toggle as enabled", async () => {
    const legacy = newRunState("legacy", 1);
    delete legacy.autoContinueEnabled;
    stores.local[runKey("legacy")] = legacy;

    const loaded = await loadRun("legacy");
    expect(loaded).not.toBeNull();
    expect(autoContinueEnabled(loaded!)).toBe(true);
  });

  it("persists the toggle and queued user message with the conversation run", async () => {
    const state = {
      ...newRunState("c1", 1),
      phase: "developing" as const,
      status: "streaming" as const,
      autoContinueEnabled: false,
      queuedUserText: "Run this next.",
    };

    await saveRun(state);
    const loaded = await loadRun("c1");

    expect(loaded?.autoContinueEnabled).toBe(false);
    expect(loaded?.queuedUserText).toBe("Run this next.");
  });
});
