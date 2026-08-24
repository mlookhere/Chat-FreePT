import { beforeEach, describe, expect, it } from "vitest";
import { installChromeMock } from "./chrome-mock";

installChromeMock();
const storage = await import("../src/common/storage");
const { newRunState } = await import("../src/common/state-machine");
const { DEFAULT_SETTINGS } = await import("../src/common/types");

let stores: ReturnType<typeof installChromeMock>;

beforeEach(() => {
  stores = installChromeMock();
});

describe("settings", () => {
  it("returns defaults when nothing is stored", async () => {
    expect(await storage.loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("merges stored values over defaults", async () => {
    await storage.saveSettings({ ...DEFAULT_SETTINGS, autoContinueCap: 7 });
    const settings = await storage.loadSettings();
    expect(settings.autoContinueCap).toBe(7);
    expect(settings.quietMs).toBe(DEFAULT_SETTINGS.quietMs);
  });
});

describe("run state", () => {
  it("round-trips", async () => {
    const state = newRunState("c1", 123);
    await storage.saveRun(state);
    expect(await storage.loadRun("c1")).toEqual(state);
  });

  it("returns null for unknown conversations", async () => {
    expect(await storage.loadRun("nope")).toBeNull();
  });

  it("migrates pending keys to the real conversation id", async () => {
    const state = newRunState("pending:abc", 1);
    await storage.saveRun(state);
    const migrated = await storage.migrateRunKey(state, "real-id");
    expect(migrated.conversationId).toBe("real-id");
    expect(await storage.loadRun("real-id")).toEqual(migrated);
    expect(await storage.loadRun("pending:abc")).toBeNull();
  });

  it("deletes runs", async () => {
    const state = newRunState("c2", 1);
    await storage.saveRun(state);
    await storage.deleteRun("c2");
    expect(await storage.loadRun("c2")).toBeNull();
  });
});

describe("tab lock", () => {
  it("grants the lock to the first tab and refuses a live second tab", async () => {
    expect(await storage.acquireTabLock("c1", "tab-a")).toBe(true);
    expect(await storage.acquireTabLock("c1", "tab-b")).toBe(false);
  });

  it("is reentrant for the same nonce", async () => {
    expect(await storage.acquireTabLock("c1", "tab-a")).toBe(true);
    expect(await storage.acquireTabLock("c1", "tab-a")).toBe(true);
  });

  it("steals a stale lock", async () => {
    await storage.acquireTabLock("c1", "tab-a");
    const key = "cfpt:lock:c1";
    const lock = stores.local[key] as { nonce: string; at: number };
    stores.local[key] = { ...lock, at: Date.now() - 60_000 };
    expect(await storage.acquireTabLock("c1", "tab-b")).toBe(true);
  });

  it("release only removes its own lock", async () => {
    await storage.acquireTabLock("c1", "tab-a");
    await storage.releaseTabLock("c1", "tab-b");
    expect(await storage.acquireTabLock("c1", "tab-c")).toBe(false);
    await storage.releaseTabLock("c1", "tab-a");
    expect(await storage.acquireTabLock("c1", "tab-c")).toBe(true);
  });
});
