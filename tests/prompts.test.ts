import { describe, expect, it } from "vitest";
import {
  buildContinuePrompt,
  buildDevelopPrompt,
  buildHandoffPrompt,
  buildMcpPreflight,
  buildNudgePrompt,
  buildPlanPrompt,
  buildUserReply,
  COMPACT_CONTRACT,
  MARKER_BLOCK,
  renderTemplate,
  repositoryLockBlock,
  ULTRA_CODE_COMPACT,
  ULTRA_CODE_CONTRACT,
} from "../src/common/prompts";
import { parseMarker } from "../src/common/marker";
import { newRunState } from "../src/common/state-machine";
import { DEFAULT_SETTINGS } from "../src/common/types";

const REPO = "owner/cookie-cli";
const planInput = {
  idea: "A CLI that prints fortune cookies",
  repo: REPO,
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

describe("repository-scoped prompts", () => {
  it("keeps planning on the selected repo without repetitive lock language", () => {
    const prompt = buildPlanPrompt(planInput);
    expect(prompt).toContain(planInput.idea);
    expect(prompt).toContain("Use **" + REPO + "** for this project");
    expect(prompt).toContain("mlookhere/CI-Pipline");
    expect(prompt).toContain("Operating contract (CI-Pipline)");
    expect(prompt).toContain("Plan ready");
    expect(prompt).not.toContain("permanently bound");
    expect(prompt).not.toContain("NEEDS_INPUT");
    expect(prompt).not.toContain("PLAN_READY");
  });

  it("preflights the selected repo without setup boilerplate or raw status tokens", () => {
    const prompt = buildMcpPreflight(REPO);
    expect(prompt).toContain(REPO);
    expect(prompt).toContain("dev and main explicitly");
    expect(prompt).toContain("ask for human input");
    expect(prompt).not.toContain("NEEDS_INPUT");
    expect(prompt).not.toContain("Developer mode");
    expect(prompt).not.toContain("Chat FreePT GitHub MCP");
  });

  it("uses main as production and dev as integration", () => {
    const plan = buildPlanPrompt(planInput);
    const develop = buildDevelopPrompt(DEFAULT_SETTINGS, REPO);
    expect(plan).toContain("dev is integration; main is production");
    expect(develop).toContain("PR into dev");
    expect(plan).not.toContain("master is production");
  });

  it("does not itself parse as an assistant status marker", () => {
    expect(parseMarker(buildPlanPrompt(planInput))).toBeNull();
  });
});

describe("develop and follow-up prompts", () => {
  it("develop prompt is continuous and includes testing as the human checkpoint", () => {
    const prompt = buildDevelopPrompt(DEFAULT_SETTINGS, REPO);
    expect(prompt).toContain(repositoryLockBlock(REPO));
    expect(prompt).toContain("work/<issue-number>-<slug>");
    expect(prompt).toContain("Refs #<issue>");
    expect(prompt).toContain("self-audit");
    expect(prompt).toContain(ULTRA_CODE_CONTRACT);
    expect(prompt).toContain("Use Testing only when");
    expect(prompt).toContain("Do not wait for me unless genuine human intervention is needed");
  });

  it("follow-up prompts use a compact repo reminder instead of the full repository block", () => {
    const plain = buildContinuePrompt(DEFAULT_SETTINGS, false, REPO);
    expect(plain).toContain(REPO);
    expect(plain).toContain(DEFAULT_SETTINGS.continueMessage);
    expect(plain).toContain(ULTRA_CODE_COMPACT);
    expect(plain).not.toContain("## Repository");

    const refresh = buildContinuePrompt(DEFAULT_SETTINGS, true, REPO);
    expect(refresh).toContain(COMPACT_CONTRACT);
    expect(refresh).toContain(ULTRA_CODE_CONTRACT);
    expect(refresh).toContain(REPO);
  });

  it("nudge and user replies stay concise while preserving repo context", () => {
    expect(buildNudgePrompt(REPO)).toContain(REPO);
    expect(buildNudgePrompt(REPO)).toContain("only");
    expect(buildUserReply("use sqlite", REPO)).toContain("use sqlite");
    expect(buildUserReply("use sqlite", REPO)).toContain(REPO);
    expect(buildUserReply("use sqlite", REPO)).toContain(ULTRA_CODE_COMPACT);
    expect(buildUserReply("use sqlite", REPO)).toContain("Chat FreePT status block");
  });

  it("handoff states that it exists because the old conversation reached max length", () => {
    const state = { ...newRunState("c1", 0), repo: REPO, phase: "developing" as const };
    const prompt = buildHandoffPrompt(state);
    expect(prompt).toContain(REPO);
    expect(prompt).toContain("Phase: Developing");
    expect(prompt).toContain("maximum length");
    expect(prompt).toContain("Operating contract");
    expect(prompt).toContain(ULTRA_CODE_CONTRACT);
  });
});

describe("marker block", () => {
  it("appears exactly once in full protocol prompts", () => {
    const state = { ...newRunState("c1", 0), repo: REPO };
    for (const prompt of [
      buildPlanPrompt(planInput),
      buildDevelopPrompt(DEFAULT_SETTINGS, REPO),
      buildHandoffPrompt(state),
    ]) {
      expect(prompt.split("## Status marker").length - 1).toBe(1);
    }
    expect(MARKER_BLOCK).toContain("Never omit the block");
  });

  it("uses normal-language status values", () => {
    expect(MARKER_BLOCK).toContain("Needs input");
    expect(MARKER_BLOCK).toContain("Plan ready");
    expect(MARKER_BLOCK).toContain("Testing");
    expect(MARKER_BLOCK).not.toContain("NEEDS_INPUT");
    expect(MARKER_BLOCK).not.toContain("PLAN_READY");
  });
});
