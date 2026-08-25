import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDevelopPrompt, buildPlanPrompt } from "../src/common/prompts";
import { DEFAULT_SETTINGS } from "../src/common/types";

const PLAN_INPUT = {
  idea: "Build a small app",
  repoMode: "new" as const,
  repoName: "example-app",
  templateRepo: "mlookhere/CI-Pipline",
};

describe("branch contract", () => {
  it("uses dev for integration and main for production everywhere", () => {
    const config = JSON.parse(readFileSync(".claude-workflow.json", "utf8")) as {
      branches: { integration: string; production: string };
    };
    const releaseWorkflow = readFileSync(".github/workflows/ci-release.yml", "utf8");
    const planPrompt = buildPlanPrompt(PLAN_INPUT);
    const developPrompt = buildDevelopPrompt(DEFAULT_SETTINGS);

    expect(config.branches).toEqual({ integration: "dev", production: "main" });
    expect(releaseWorkflow).toContain("branches: [main]");
    expect(releaseWorkflow).not.toContain("branches: [master]");

    expect(planPrompt).toContain("dev is integration; main is production");
    expect(planPrompt).toContain("release — PR dev into main");
    expect(developPrompt).toContain("dev → main");

    expect(planPrompt).not.toContain("master is production");
    expect(planPrompt).not.toContain("PR dev into master");
    expect(developPrompt).not.toContain("dev → master");
  });
});
