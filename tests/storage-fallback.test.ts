import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./chrome-mock";
import { extensionStorage, loadSettings, saveRun } from "../src/common/storage";
import { newRunState } from "../src/common/state-machine";
import { DEFAULT_SETTINGS } from "../src/common/types";

let nativeStorage: typeof chrome.storage;
let nativeMessaging: typeof chrome.runtime.sendMessage;

beforeEach(() => {
  installChromeMock();
  nativeStorage = chrome.storage;
  nativeMessaging = chrome.runtime.sendMessage;
});

afterEach(() => {
  Object.defineProperty(chrome, "storage", { configurable: true, value: nativeStorage });
  chrome.runtime.sendMessage = nativeMessaging;
  vi.restoreAllMocks();
});

describe("storage context recovery", () => {
  it("uses native storage when present without service-worker messaging", async () => {
    const send = vi.fn();
    chrome.runtime.sendMessage = send as typeof chrome.runtime.sendMessage;
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(send).not.toHaveBeenCalled();
  });

  it("delegates settings reads to the worker when chrome.storage is missing", async () => {
    Object.defineProperty(chrome, "storage", { configurable: true, value: undefined });
    chrome.runtime.sendMessage = vi.fn(async () => ({
      ok: true,
      value: { "cfpt:settings": { continueMessage: " keep going " } },
    })) as typeof chrome.runtime.sendMessage;

    expect((await loadSettings()).continueMessage).toBe("keep going");
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "cfpt-storage",
      area: "sync",
      operation: "get",
      payload: "cfpt:settings",
    });
  });

  it("retains conversation data through worker-backed writes", async () => {
    Object.defineProperty(chrome, "storage", { configurable: true, value: undefined });
    const send = vi.fn(async () => ({ ok: true, value: {} }));
    chrome.runtime.sendMessage = send as typeof chrome.runtime.sendMessage;
    await saveRun(newRunState("native-reply", 123));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "cfpt-storage",
      area: "local",
      operation: "set",
      payload: expect.objectContaining({ "cfpt:run:native-reply": expect.any(Object) }),
    }));
  });

  it("fails closed without native storage or a responding service", async () => {
    Object.defineProperty(chrome, "storage", { configurable: true, value: undefined });
    chrome.runtime.sendMessage = vi.fn(async () => undefined) as typeof chrome.runtime.sendMessage;
    await expect(extensionStorage("local", "get", "cfpt:run:1")).rejects.toThrow(/Extension context invalidated/);
  });
});
