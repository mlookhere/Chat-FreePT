import { describe, expect, it } from "vitest";

import {
  ActionReplayGuard,
  formatGitHubActionResult,
  parseGitHubActionFence,
} from "../src/common/github-bridge";

describe("parseGitHubActionFence", () => {
  it("parses the last valid action fence", () => {
    const text = [
      "before",
      "```chatfreept_action",
      '{"v":1,"id":"old","action":"get_me","args":{}}',
      "```",
      "middle",
      "```chatfreept_action",
      '{"v":1,"id":"a-2","action":"create_repository","args":{"name":"demo"}}',
      "```",
    ].join("\n");

    expect(parseGitHubActionFence(text)).toEqual({
      ok: true,
      request: {
        v: 1,
        id: "a-2",
        action: "create_repository",
        args: { name: "demo" },
      },
    });
  });

  it.each([
    ["missing", "no action here", "missing chatfreept_action fence"],
    [
      "json",
      "```chatfreept_action\nnot-json\n```",
      "action payload is not valid JSON",
    ],
    [
      "version",
      '```chatfreept_action\n{"v":2,"id":"a","action":"get_me","args":{}}\n```',
      "unsupported action protocol version",
    ],
    [
      "id",
      '```chatfreept_action\n{"v":1,"id":"bad id","action":"get_me","args":{}}\n```',
      "invalid action id",
    ],
    [
      "action",
      '```chatfreept_action\n{"v":1,"id":"a","action":"delete_everything","args":{}}\n```',
      "unknown GitHub action",
    ],
    [
      "args",
      '```chatfreept_action\n{"v":1,"id":"a","action":"get_me","args":[]}\n```',
      "action args must be an object",
    ],
  ])("rejects invalid %s payloads", (_name, text, error) => {
    expect(parseGitHubActionFence(text)).toEqual({ ok: false, error });
  });

  it("rejects oversized payloads", () => {
    const huge = "x".repeat(256_001);
    const text = ["```chatfreept_action", huge, "```"].join("\n");
    expect(parseGitHubActionFence(text)).toEqual({
      ok: false,
      error: "action payload exceeds size limit",
    });
  });
});

describe("ActionReplayGuard", () => {
  it("accepts an action id once until cleared", () => {
    const guard = new ActionReplayGuard();
    expect(guard.accept("a")).toBe(true);
    expect(guard.accept("a")).toBe(false);
    guard.clear();
    expect(guard.accept("a")).toBe(true);
  });
});

describe("formatGitHubActionResult", () => {
  it("serializes a result without adding prose", () => {
    expect(formatGitHubActionResult({ v: 1, id: "a", ok: true, result: { login: "octo" } })).toBe(
      '```chatfreept_result\n{"v":1,"id":"a","ok":true,"result":{"login":"octo"}}\n```',
    );
  });
});
