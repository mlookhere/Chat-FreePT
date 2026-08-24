import { describe, expect, it } from "vitest";
import { parseMarker } from "../src/common/marker";

const reply = (status: string, extra = ""): string =>
  `I did some work on the repo.\n\nCHATFREEPT_STATUS: ${status}\n${extra}`;

describe("parseMarker", () => {
  it("parses each status", () => {
    for (const status of ["CONTINUE", "NEEDS_INPUT", "PLAN_READY", "COMPLETE", "ERROR"]) {
      expect(parseMarker(reply(status))?.status).toBe(status);
    }
  });

  it("returns null when no marker is present", () => {
    expect(parseMarker("Just some prose about CI pipelines.")).toBeNull();
    expect(parseMarker("")).toBeNull();
  });

  it("parses key-value fields", () => {
    const marker = parseMarker(
      reply(
        "CONTINUE",
        "V: 1\nPHASE: DEVELOPING\nREPO: mlookhere/todo-app\nITEM: 3/7\nNOTE: waiting on run 42\nURL: https://github.com/x",
      ),
    );
    expect(marker).toMatchObject({
      status: "CONTINUE",
      version: 1,
      phase: "DEVELOPING",
      repo: "mlookhere/todo-app",
      item: "3/7",
      note: "waiting on run 42",
      url: "https://github.com/x",
    });
  });

  it("takes the LAST marker when the spec is quoted earlier", () => {
    const text = [
      "The protocol says to end with:",
      "CHATFREEPT_STATUS: CONTINUE",
      "…but actually I'm blocked.",
      "CHATFREEPT_STATUS: NEEDS_INPUT",
      "NOTE: need repo access",
    ].join("\n");
    const marker = parseMarker(text);
    expect(marker?.status).toBe("NEEDS_INPUT");
    expect(marker?.note).toBe("need repo access");
  });

  it("is case-insensitive on the status keyword and tolerates spacing", () => {
    expect(parseMarker("chatfreept_status:   complete")?.status).toBe("COMPLETE");
    expect(parseMarker("CHATFREEPT_STATUS :CONTINUE")?.status).toBe("CONTINUE");
  });

  it("survives fenced-block text as innerText renders it", () => {
    const text = "done for now\nCHATFREEPT_STATUS: CONTINUE\nV: 1\nNOTE: pushed part 2/3\n```";
    const marker = parseMarker(text);
    expect(marker?.status).toBe("CONTINUE");
    expect(marker?.note).toBe("pushed part 2/3");
  });

  it("stops field parsing at the first non-field line", () => {
    const marker = parseMarker(reply("CONTINUE", "NOTE: first\nSome trailing prose\nURL: ignored"));
    expect(marker?.note).toBe("first");
    expect(marker?.url).toBeUndefined();
  });

  it("rejects malformed repo values", () => {
    const marker = parseMarker(reply("CONTINUE", "REPO: not a repo path"));
    expect(marker?.repo).toBeUndefined();
  });

  it("keeps unknown versions parseable", () => {
    const marker = parseMarker(reply("CONTINUE", "V: 2"));
    expect(marker?.version).toBe(2);
    expect(marker?.status).toBe("CONTINUE");
  });

  it("ignores unknown keys without dropping later ones", () => {
    const marker = parseMarker(reply("CONTINUE", "NOTE: hello"));
    expect(marker?.note).toBe("hello");
  });
});
