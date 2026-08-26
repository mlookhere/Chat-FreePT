import { describe, expect, it } from "vitest";
import { chatGptPageMode } from "../src/content/page-mode";

describe("ChatGPT page mode", () => {
  it("treats Plugins as a setup route without a composer", () => {
    expect(chatGptPageMode("https://chatgpt.com/plugins")).toBe("plugins");
    expect(chatGptPageMode("https://chatgpt.com/plugins/custom/github-mcp")).toBe("plugins");
    expect(
      chatGptPageMode(
        "https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins",
      ),
    ).toBe("plugins");
  });

  it("treats Library and Scheduled as expected utility pages", () => {
    expect(chatGptPageMode("https://chatgpt.com/library")).toBe("utility");
    expect(chatGptPageMode("https://chatgpt.com/library?entry_point=sidebar")).toBe("utility");
    expect(chatGptPageMode("https://chatgpt.com/scheduled")).toBe("utility");
  });

  it("keeps normal and conversation URLs in composer mode", () => {
    expect(chatGptPageMode("https://chatgpt.com/")).toBe("composer");
    expect(chatGptPageMode("https://chatgpt.com/c/abc-123")).toBe("composer");
  });
});
