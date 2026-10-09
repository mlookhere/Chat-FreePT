import { describe, expect, it } from "vitest";
import { parseMarker } from "../src/common/marker";

const reply = (status: string, extra = ""): string =>
  `I did some work on the repo.\n\nCHATFREEPT_STATUS: ${status}\n${extra}`;

describe("parseMarker", () => {
  it("parses human-readable status values into internal states", () => {
    const cases = [
      ["Continue", "CONTINUE"],
      ["Needs input", "NEEDS_INPUT"],
      ["Plan ready", "PLAN_READY"],
      ["Testing", "TESTING"],
      ["Complete", "COMPLETE"],
      ["Error", "ERROR"],
    ] as const;
    for (const [display, internal] of cases) {
      expect(parseMarker(reply(display))?.status).toBe(internal);
    }
  });

  it("keeps legacy underscore markers compatible", () => {
    expect(parseMarker(reply("NEEDS_INPUT"))?.status).toBe("NEEDS_INPUT");
    expect(parseMarker(reply("PLAN_READY"))?.status).toBe("PLAN_READY");
  });

  it("returns null when no marker is present", () => {
    expect(parseMarker("Just some prose about CI pipelines.")).toBeNull();
    expect(parseMarker("")).toBeNull();
  });

  it("parses key-value fields", () => {
    const marker = parseMarker(
      reply(
        "Continue",
        "V: 1\nPHASE: Developing\nREPO: mlookhere/todo-app\nITEM: 3/7\nNOTE: waiting on run 42\nURL: https://github.com/x",
      ),
    );
    expect(marker).toMatchObject({
      status: "CONTINUE",
      version: 1,
      phase: "Developing",
      repo: "mlookhere/todo-app",
      item: "3/7",
      note: "waiting on run 42",
      url: "https://github.com/x",
    });
    expect(marker?.raw).toContain("Continue");
  });

  it("takes the LAST marker when the spec is quoted earlier", () => {
    const text = [
      "The protocol says to end with:",
      "CHATFREEPT_STATUS: Continue",
      "…but actually I'm blocked.",
      "CHATFREEPT_STATUS: Needs input",
      "NOTE: need repo access",
    ].join("\n");
    const marker = parseMarker(text);
    expect(marker?.status).toBe("NEEDS_INPUT");
    expect(marker?.note).toBe("need repo access");
    expect(marker?.raw).not.toContain("NEEDS_INPUT");
  });

  it("is case-insensitive and tolerates status separators", () => {
    expect(parseMarker("chatfreept_status:   complete")?.status).toBe("COMPLETE");
    expect(parseMarker("CHATFREEPT_STATUS :CONTINUE")?.status).toBe("CONTINUE");
    expect(parseMarker("CHATFREEPT_STATUS: needs-input")?.status).toBe("NEEDS_INPUT");
  });

  it("survives fenced-block text as innerText renders it", () => {
    const text = "done for now\nCHATFREEPT_STATUS: Continue\nV: 1\nNOTE: pushed part 2/3\n```";
    const marker = parseMarker(text);
    expect(marker?.status).toBe("CONTINUE");
    expect(marker?.note).toBe("pushed part 2/3");
  });

  it("stops field parsing at the first non-field line", () => {
    const marker = parseMarker(reply("Continue", "NOTE: first\nSome trailing prose\nURL: ignored"));
    expect(marker?.note).toBe("first");
    expect(marker?.url).toBeUndefined();
  });

  it("rejects malformed repo values", () => {
    const marker = parseMarker(reply("Continue", "REPO: not a repo path"));
    expect(marker?.repo).toBeUndefined();
  });

  it("keeps unknown versions parseable", () => {
    const marker = parseMarker(reply("Continue", "V: 2"));
    expect(marker?.version).toBe(2);
    expect(marker?.status).toBe("CONTINUE");
  });

  it("ignores unknown keys without dropping later ones", () => {
    const marker = parseMarker(reply("Continue", "NOTE: hello"));
    expect(marker?.note).toBe("hello");
  });
});
