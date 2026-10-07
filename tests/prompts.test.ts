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

describe("repository-locked prompts", () => {
  it("binds planning to the selected repository and exact-repo preflight", () => {
    const prompt = buildPlanPrompt(planInput);
    expect(prompt).toContain(planInput.idea);
    expect(prompt).toContain(`permanently bound to **${REPO}**`);
    expect(prompt).toContain(`exact locked repository **${REPO}**`);
    expect(prompt).toContain("mlookhere/CI-Pipline");
    expect(prompt).toContain("Operating contract (CI-Pipline)");
    expect(prompt).toContain("PLAN_READY");
    expect(prompt).not.toContain("Create a new PRIVATE repository");
  });

  it("preflights the exact repo without Developer Mode setup instructions", () => {
    const prompt = buildMcpPreflight(REPO);
    expect(prompt).toContain(REPO);
    expect(prompt).toContain("Do not create a repository");
    expect(prompt).toContain("do not switch repositories");
    expect(prompt).toContain("NEEDS_INPUT");
    expect(prompt).not.toContain("Settings → Security and login");
    expect(prompt).not.toContain("Developer mode");
    expect(prompt).not.toContain("Chat FreePT GitHub MCP");
  });

  it("uses main as production and dev as integration", () => {
    const plan = buildPlanPrompt(planInput);
    const develop = buildDevelopPrompt(DEFAULT_SETTINGS, REPO);
    expect(plan).toContain("dev is integration; main is production");
    expect(plan).toContain("release — PR dev into main");
    expect(develop).toContain("dev → main");
    expect(plan).not.toContain("master is production");
  });

  it("does not itself parse as an assistant status marker", () => {
    expect(parseMarker(buildPlanPrompt(planInput))).toBeNull();
  });
});

describe("develop and follow-up prompts", () => {
  it("develop prompt includes the locked repo and per-item loop", () => {
    const prompt = buildDevelopPrompt(DEFAULT_SETTINGS, REPO);
    expect(prompt).toContain(repositoryLockBlock(REPO));
    expect(prompt).toContain("work/<issue-number>-<slug>");
    expect(prompt).toContain("Refs #<issue>");
    expect(prompt).toContain("self-audit");
    expect(prompt).toContain(String(Math.round(DEFAULT_SETTINGS.sendDelayMs / 1000)));
  });

  it("continue always reinforces the locked repo", () => {
    const plain = buildContinuePrompt(DEFAULT_SETTINGS, false, REPO);
    expect(plain).toContain(repositoryLockBlock(REPO));
    expect(plain).toContain(DEFAULT_SETTINGS.continueMessage);

    const refresh = buildContinuePrompt(DEFAULT_SETTINGS, true, REPO);
    expect(refresh).toContain(COMPACT_CONTRACT);
    expect(refresh).toContain(REPO);
  });

  it("nudge and user replies reinforce the locked repo", () => {
    expect(buildNudgePrompt(REPO)).toContain(REPO);
    expect(buildNudgePrompt(REPO)).toContain("ONLY");
    expect(buildUserReply("use sqlite", REPO)).toContain("use sqlite");
    expect(buildUserReply("use sqlite", REPO)).toContain(REPO);
    expect(buildUserReply("use sqlite", REPO)).toContain("CHATFREEPT status block");
  });

  it("handoff embeds the locked repo and phase", () => {
    const state = { ...newRunState("c1", 0), repo: REPO, phase: "developing" as const };
    const prompt = buildHandoffPrompt(state);
    expect(prompt).toContain(REPO);
    expect(prompt).toContain("DEVELOPING");
    expect(prompt).toContain("Operating contract");
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
      expect(prompt.split("Status marker (mandatory)").length - 1).toBe(1);
    }
    expect(MARKER_BLOCK).toContain("Never omit the block");
  });

  it("requires the locked repository in every marker", () => {
    expect(MARKER_BLOCK).toContain("locked owner/name");
    expect(MARKER_BLOCK).toContain("queued next message");
  });
});
