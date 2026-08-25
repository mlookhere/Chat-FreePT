import { describe, expect, it } from "vitest";
import {
  buildContinuePrompt,
  buildDevelopPrompt,
  buildHandoffPrompt,
  buildMcpPreflight,
  buildPlanPrompt,
  buildUserReply,
  COMPACT_CONTRACT,
  MARKER_BLOCK,
  NUDGE_PROMPT,
  renderTemplate,
} from "../src/common/prompts";
import { parseMarker } from "../src/common/marker";
import { newRunState } from "../src/common/state-machine";
import { DEFAULT_SETTINGS } from "../src/common/types";

const planInput = {
  idea: "A CLI that prints fortune cookies",
  repoMode: "new" as const,
  repoName: "",
  templateRepo: "mlookhere/CI-Pipline",
};

describe("renderTemplate", () => {
  it("substitutes placeholders", () => {
    expect(renderTemplate("a {{X}} c", { X: "b" })).toBe("a b c");
  });

  it("throws on unresolved placeholders", () => {
    expect(() => renderTemplate("a {{MISSING}} c", {})).toThrow(/MISSING/);
  });
});

describe("plan prompt", () => {
  it("contains the idea, preflight, vendor recipe, contract, and marker spec", () => {
    const prompt = buildPlanPrompt(planInput);
    expect(prompt).toContain(planInput.idea);
    expect(prompt).toContain("GitHub MCP preflight");
    expect(prompt).toContain("mlookhere/CI-Pipline");
    expect(prompt).toContain("Operating contract (CI-Pipline)");
    expect(prompt).toContain("CHATFREEPT_STATUS");
    expect(prompt).toContain("PLAN_READY");
  });

  it("varies repository instructions by mode", () => {
    expect(buildPlanPrompt(planInput)).toContain(
      "Create a new PRIVATE repository under my account",
    );
    expect(buildPlanPrompt({ ...planInput, repoName: "cookie-cli" })).toContain(
      'named "cookie-cli"',
    );
    expect(buildPlanPrompt({ ...planInput, repoMode: "existing", repoName: "me/mine" })).toContain(
      "Use my existing repository me/mine",
    );
  });

  it("uses mode-aware GitHub capability requirements", () => {
    const newRepo = buildMcpPreflight("new", "cookie-cli");
    expect(newRepo).toContain("NEW-REPOSITORY mode");
    expect(newRepo).toContain("repository-creation capability");
    expect(newRepo).toContain("label_write");

    const existing = buildMcpPreflight("existing", "me/mine");
    expect(existing).toContain("EXISTING-REPOSITORY mode for me/mine");
    expect(existing).toMatch(/Do NOT\s+require repository creation/);
    expect(existing).toContain("only for labels that are actually missing");
  });

  it("uses current Developer Mode setup and does not require default-branch mutation", () => {
    const prompt = buildPlanPrompt(planInput);
    expect(prompt).toContain("Settings → Security and login → Developer mode");
    expect(prompt).toContain("https://chatgpt.com/plugins");
    expect(prompt).toContain("https://api.githubcopilot.com/mcp/");
    expect(prompt).toContain("Repository default-branch mutation is NOT required");
    expect(prompt).toContain("Do NOT require changing the repository default branch");
    expect(prompt).not.toContain("set dev as the default branch");
  });

  it("does not itself parse as a status marker sent by the assistant", () => {
    // The prompt necessarily quotes the CHATFREEPT_STATUS syntax; the parser must not
    // treat the placeholder form as a real status.
    const prompt = buildPlanPrompt(planInput);
    const marker = parseMarker(prompt);
    expect(marker).toBeNull();
  });
});

describe("develop prompt", () => {
  it("contains the per-item loop, pacing, and completion self-audit", () => {
    const prompt = buildDevelopPrompt(DEFAULT_SETTINGS);
    expect(prompt).toContain("work/<issue-number>-<slug>");
    expect(prompt).toContain("Refs #<issue>");
    expect(prompt).toContain("self-audit");
    expect(prompt).toContain("COMPLETE");
    expect(prompt).toContain(String(Math.round(DEFAULT_SETTINGS.sendDelayMs / 1000)));
  });
});

describe("continue / nudge / reply / handoff", () => {
  it("plain continue is the settings message", () => {
    expect(buildContinuePrompt(DEFAULT_SETTINGS, false)).toBe(DEFAULT_SETTINGS.continueMessage);
  });

  it("refresh variant appends the compact contract", () => {
    const prompt = buildContinuePrompt(DEFAULT_SETTINGS, true);
    expect(prompt).toContain(DEFAULT_SETTINGS.continueMessage);
    expect(prompt).toContain(COMPACT_CONTRACT);
  });

  it("nudge demands only the status block", () => {
    expect(NUDGE_PROMPT).toContain("chatfreept");
  });

  it("user replies re-arm the marker", () => {
    expect(buildUserReply("use sqlite")).toContain("use sqlite");
    expect(buildUserReply("use sqlite")).toContain("CHATFREEPT status block");
  });

  it("handoff embeds repo and phase and the contract", () => {
    const state = { ...newRunState("c1", 0), repo: "o/r", phase: "developing" as const };
    const prompt = buildHandoffPrompt(state);
    expect(prompt).toContain("o/r");
    expect(prompt).toContain("DEVELOPING");
    expect(prompt).toContain("Operating contract");
  });
});

describe("marker block", () => {
  it("appears exactly once per prompt", () => {
    for (const prompt of [
      buildPlanPrompt(planInput),
      buildDevelopPrompt(DEFAULT_SETTINGS),
      buildHandoffPrompt(newRunState("c1", 0)),
    ]) {
      const count = prompt.split("Status marker (mandatory)").length - 1;
      expect(count).toBe(1);
    }
    expect(MARKER_BLOCK).toContain("Never omit the block");
  });
});
