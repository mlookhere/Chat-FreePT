import { beforeEach, describe, expect, it } from "vitest";
import { lastAssistantMessage } from "../src/content/transcript";

function mountAssistant(attrs: string, text: string): HTMLElement {
  document.body.innerHTML = `<main><div data-message-author-role="assistant" ${attrs}></div></main>`;
  const el = document.querySelector<HTMLElement>('[data-message-author-role="assistant"]');
  if (!el) throw new Error("assistant fixture missing");
  el.textContent = text;
  return el;
}

beforeEach(() => {
  document.body.innerHTML = "<main></main>";
});

describe("assistant transcript identity", () => {
  it("uses ChatGPT's message id when available", () => {
    mountAssistant('data-message-id="abc-123"', "hello");
    expect(lastAssistantMessage()).toMatchObject({
      text: "hello",
      key: "message:abc-123",
    });
  });

  it("uses the enclosing conversation turn id when the message id is absent", () => {
    document.body.innerHTML =
      '<main><div data-testid="conversation-turn-42"><div data-message-author-role="assistant">reply</div></div></main>';
    expect(lastAssistantMessage()?.key).toBe("turn:conversation-turn-42");
  });

  it("falls back to a deterministic text fingerprint", () => {
    const el = mountAssistant("", "same reply");
    const first = lastAssistantMessage()?.key;
    expect(first).toMatch(/^text:[0-9a-f]{8}$/);

    el.textContent = "same reply";
    expect(lastAssistantMessage()?.key).toBe(first);

    el.textContent = "different reply";
    expect(lastAssistantMessage()?.key).not.toBe(first);
  });
});
