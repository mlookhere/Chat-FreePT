import { describe, expect, it } from "vitest";
import { chatGptPageMode } from "../src/content/page-mode";
import { freshConversationUrl } from "../src/content/navigation";

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

describe("max-length handoff destination", () => {
  it("keeps a new chat in the same custom GPT after reaching the length limit", () => {
    expect(
      freshConversationUrl(
        "https://chatgpt.com/g/g-example-gpt/c/11111111-1111-4111-8111-111111111111",
      ),
    ).toBe("https://chatgpt.com/g/g-example-gpt");
  });

  it("opens the ordinary composer for a regular ChatGPT conversation", () => {
    expect(freshConversationUrl("https://chatgpt.com/c/11111111-1111-4111-8111-111111111111")).toBe(
      "https://chatgpt.com/",
    );
  });
});
