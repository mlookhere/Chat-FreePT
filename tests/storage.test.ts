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

  it.each([
    {
      name: "malformed values",
      stored: {
        v: 99,
        continueMessage: "   ",
        autoContinueCap: -10,
        sendDelayMs: Number.POSITIVE_INFINITY,
        quietMs: "3000",
        toolQuietMs: 999_999,
        maxStreamMinutes: 0,
        contractRefreshEvery: 1_000,
        notificationsEnabled: "yes",
        templateRepo: null,
        unknownFutureField: "ignored",
      },
      expected: {
        ...DEFAULT_SETTINGS,
        autoContinueCap: 1,
        toolQuietMs: 120_000,
        maxStreamMinutes: 1,
        contractRefreshEvery: 100,
      },
    },
    {
      name: "partial legacy values",
      stored: {
        v: 0,
        continueMessage: "  keep going  ",
        autoContinueCap: 7,
        notificationsEnabled: false,
        obsoleteSetting: true,
      },
      expected: {
        ...DEFAULT_SETTINGS,
        continueMessage: "keep going",
        autoContinueCap: 7,
        notificationsEnabled: false,
      },
    },
    {
      name: "valid values",
      stored: {
        v: 1,
        continueMessage: "  next  ",
        autoContinueCap: 500,
        sendDelayMs: 2_000,
        quietMs: 60_000,
        toolQuietMs: 120_000,
        maxStreamMinutes: 180,
        contractRefreshEvery: 100,
        notificationsEnabled: false,
        templateRepo: "  owner/template  ",
      },
      expected: {
        v: 1,
        continueMessage: "next",
        autoContinueCap: 500,
        sendDelayMs: 2_000,
        quietMs: 60_000,
        toolQuietMs: 120_000,
        maxStreamMinutes: 180,
        contractRefreshEvery: 100,
        notificationsEnabled: false,
        templateRepo: "owner/template",
      },
    },
  ])("normalizes $name loaded from sync storage", async ({ stored, expected }) => {
    stores.sync["cfpt:settings"] = stored;
    expect(await storage.loadSettings()).toEqual(expected);
  });

  it("normalizes settings before writing sync storage", async () => {
    await storage.saveSettings({
      ...DEFAULT_SETTINGS,
      autoContinueCap: 999,
      sendDelayMs: 1,
      templateRepo: "  owner/template  ",
    });

    expect(stores.sync["cfpt:settings"]).toEqual({
      ...DEFAULT_SETTINGS,
      autoContinueCap: 500,
      sendDelayMs: 2_000,
      templateRepo: "owner/template",
    });
  });
});

describe("run state", () => {
  it("round-trips", async () => {
    const state = newRunState("c1", 123);
    await storage.saveRun(state);
    expect(await storage.loadRun("c1")).toEqual(state);
  });

  it("keeps simultaneous conversation state independent", async () => {
    const first = {
      ...newRunState("conversation-a", 1),
      idea: "first project",
      autoContinueEnabled: false,
    };
    const second = {
      ...newRunState("conversation-b", 2),
      idea: "second project",
      queuedUserText: "second follow-up",
    };

    await storage.saveRun(first);
    await storage.saveRun(second);

    expect(await storage.loadRun("conversation-a")).toEqual(first);
    expect(await storage.loadRun("conversation-b")).toEqual(second);
    expect(stores.local[storage.runKey("conversation-a")]).not.toEqual(
      stores.local[storage.runKey("conversation-b")],
    );
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

  it("allows different tabs to drive different conversations simultaneously", async () => {
    expect(await storage.acquireTabLock("conversation-a", "tab-a")).toBe(true);
    expect(await storage.acquireTabLock("conversation-b", "tab-b")).toBe(true);
    expect(await storage.heartbeatTabLock("conversation-a", "tab-a")).toBe(true);
    expect(await storage.heartbeatTabLock("conversation-b", "tab-b")).toBe(true);
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

  it("heartbeats only a lock owned by the same tab", async () => {
    await storage.acquireTabLock("c1", "tab-a");
    expect(await storage.heartbeatTabLock("c1", "tab-a")).toBe(true);
    expect(await storage.heartbeatTabLock("c1", "tab-b")).toBe(false);
  });

  it("does not let a suspended old owner overwrite a newer owner", async () => {
    await storage.acquireTabLock("c1", "tab-a");
    const key = "cfpt:lock:c1";
    const lock = stores.local[key] as { nonce: string; at: number };
    stores.local[key] = { ...lock, at: Date.now() - 60_000 };

    expect(await storage.acquireTabLock("c1", "tab-b")).toBe(true);
    expect(await storage.heartbeatTabLock("c1", "tab-a")).toBe(false);
    expect(await storage.acquireTabLock("c1", "tab-c")).toBe(false);
  });

  it("release only removes its own lock", async () => {
    await storage.acquireTabLock("c1", "tab-a");
    await storage.releaseTabLock("c1", "tab-b");
    expect(await storage.acquireTabLock("c1", "tab-c")).toBe(false);
    await storage.releaseTabLock("c1", "tab-a");
    expect(await storage.acquireTabLock("c1", "tab-c")).toBe(true);
  });
});

describe("conversation ownership", () => {
  it("moves the run and transfers the driver lock to the permanent id", async () => {
    const state = newRunState("pending:abc", 1);
    await storage.saveRun(state);
    await storage.acquireTabLock("pending:abc", "tab-a");

    const migrated = await storage.adoptConversationOwnership(state, "real-id", "tab-a");

    expect(migrated?.conversationId).toBe("real-id");
    expect(await storage.loadRun("pending:abc")).toBeNull();
    expect(await storage.loadRun("real-id")).toEqual(migrated);
    expect(await storage.acquireTabLock("pending:abc", "tab-b")).toBe(true);
    expect(await storage.acquireTabLock("real-id", "tab-b")).toBe(false);
  });

  it("does not migrate when another tab owns the permanent id", async () => {
    const state = newRunState("pending:abc", 1);
    await storage.saveRun(state);
    await storage.acquireTabLock("pending:abc", "tab-a");
    await storage.acquireTabLock("real-id", "tab-b");

    const migrated = await storage.adoptConversationOwnership(state, "real-id", "tab-a");

    expect(migrated).toBeNull();
    expect(await storage.loadRun("pending:abc")).toEqual(state);
    expect(await storage.loadRun("real-id")).toBeNull();
    expect(await storage.acquireTabLock("pending:abc", "tab-c")).toBe(false);
    expect(await storage.acquireTabLock("real-id", "tab-c")).toBe(false);
  });
});
