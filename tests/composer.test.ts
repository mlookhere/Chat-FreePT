import { beforeEach, describe, expect, it, vi } from "vitest";
import { clickSend, insertPrompt } from "../src/content/composer";

beforeEach(() => {
  document.body.innerHTML = `
    <main>
      <div id="prompt-textarea" contenteditable="true"></div>
      <button data-testid="send-button">Send</button>
    </main>
  `;
});

describe("composer cancellation", () => {
  it("does not click Send when the operation was cancelled", async () => {
    const button = document.querySelector(
      '[data-testid="send-button"]',
    ) as HTMLButtonElement;
    const clicked = vi.fn();
    button.addEventListener("click", clicked);

    const result = await clickSend(() => false, () => true);

    expect(result).toEqual({ ok: false, error: "send cancelled" });
    expect(clicked).not.toHaveBeenCalled();
  });

  it("does not overwrite a draft when insertion was cancelled", async () => {
    const composer = document.querySelector("#prompt-textarea") as HTMLElement;
    composer.textContent = "keep my draft";

    const result = await insertPrompt("replace this", () => true);

    expect(result).toEqual({ ok: false, error: "insert cancelled" });
    expect(composer.textContent).toBe("keep my draft");
  });

  it("clicks a ready Send button on an active operation", async () => {
    const button = document.querySelector(
      '[data-testid="send-button"]',
    ) as HTMLButtonElement;
    const clicked = vi.fn();
    button.addEventListener("click", clicked);

    const result = await clickSend(() => false);

    expect(result).toEqual({ ok: true });
    expect(clicked).toHaveBeenCalledTimes(1);
  });
});
