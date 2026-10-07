import { describe, expect, it } from "vitest";
import { normalizeRepositoryInput } from "../src/common/repository";

describe("normalizeRepositoryInput", () => {
  it("accepts owner/name", () => {
    expect(normalizeRepositoryInput("  OpenAI/project  ")).toBe("OpenAI/project");
  });

  it("accepts a root GitHub URL and strips .git", () => {
    expect(normalizeRepositoryInput("https://github.com/OpenAI/project.git")).toBe(
      "OpenAI/project",
    );
  });

  it.each([
    "",
    "project-only",
    "owner/repo/extra",
    "https://gitlab.com/owner/repo",
    "https://github.com/owner/repo/issues",
  ])("rejects unsupported repository input %s", (value) => {
    expect(normalizeRepositoryInput(value)).toBeNull();
  });
});
