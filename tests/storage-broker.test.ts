import { beforeEach, describe, expect, it } from "vitest";
import { installChromeMock } from "./chrome-mock";
import { handleStorageRequest, validStorageRequest } from "../src/background/storage-broker";

const sender = "https://chatgpt.com/c/123";
beforeEach(() => {
  installChromeMock();
});

describe("privileged FreePT storage broker", () => {
  it("rejects non-ChatGPT senders and unrecognized keys", async () => {
    const request = {
      type: "cfpt-storage",
      area: "local",
      operation: "get",
      payload: "cfpt:settings",
    };
    expect(validStorageRequest(request, "https://chatgpt.com.evil.test/c/123")).toBe(false);
    expect(validStorageRequest(request, "https://example.com")).toBe(false);
    expect(validStorageRequest({ ...request, payload: "private:tokens" }, sender)).toBe(false);
    expect((await handleStorageRequest({ ...request, payload: "private:tokens" }, sender)).ok).toBe(
      false,
    );
  });

  it("restricts sync area to settings and disallows deleting sync state", () => {
    const req = { type: "cfpt-storage", area: "sync", operation: "get", payload: "cfpt:run:123" };
    expect(validStorageRequest(req, sender)).toBe(false);
    expect(
      validStorageRequest({ ...req, operation: "remove", payload: "cfpt:settings" }, sender),
    ).toBe(false);
    expect(validStorageRequest({ ...req, payload: "cfpt:settings" }, sender)).toBe(true);
  });

  it("rejects bulk requests with more than 50 keys and non-object writes", () => {
    const keys = Array.from({ length: 51 }, (_, i) => `cfpt:run:${i}`);
    expect(
      validStorageRequest(
        { type: "cfpt-storage", area: "local", operation: "get", payload: keys },
        sender,
      ),
    ).toBe(false);
    expect(
      validStorageRequest(
        { type: "cfpt-storage", area: "local", operation: "set", payload: "cfpt:key" },
        sender,
      ),
    ).toBe(false);
  });

  it("round-trips local state using only extension storage", async () => {
    const set = await handleStorageRequest(
      {
        type: "cfpt-storage",
        area: "local",
        operation: "set",
        payload: { "cfpt:run:test": { v: 1, repo: "owner/repo" } },
      },
      sender,
    );
    expect(set.ok).toBe(true);
    const get = await handleStorageRequest(
      {
        type: "cfpt-storage",
        area: "local",
        operation: "get",
        payload: "cfpt:run:test",
      },
      sender,
    );
    expect(get).toEqual({ ok: true, value: { "cfpt:run:test": { v: 1, repo: "owner/repo" } } });
  });
});
