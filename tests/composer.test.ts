import { beforeEach, describe, expect, it, vi } from "vitest";
import { clickSend, insertPrompt } from "../src/content/composer";

let composer: HTMLDivElement;
let sendButton: HTMLButtonElement;

beforeEach(() => {
  composer = document.createElement("div");
  composer.id = "prompt-textarea";
  composer.contentEditable = "true";

  sendButton = document.createElement("button");
  sendButton.dataset.testid = "send-button";
  sendButton.textContent = "Send";

  const main = document.createElement("main");
  main.append(composer, sendButton);
  document.body.replaceChildren(main);
});

describe("composer cancellation", () => {
  it("does not click Send when the operation was cancelled", async () => {
    const clicked = vi.fn();
    sendButton.addEventListener("click", clicked);

    const result = await clickSend(() => false, () => true);

    expect(result).toEqual({ ok: false, error: "send cancelled" });
    expect(clicked).not.toHaveBeenCalled();
  });

  it("does not overwrite a draft when insertion was cancelled", async () => {
    composer.textContent = "keep my draft";

    const result = await insertPrompt("replace this", () => true);

    expect(result).toEqual({ ok: false, error: "insert cancelled" });
    expect(composer.textContent).toBe("keep my draft");
  });

  it("clicks a ready Send button on an active operation", async () => {
    const clicked = vi.fn();
    sendButton.addEventListener("click", clicked);

    const result = await clickSend(() => false);

    expect(result).toEqual({ ok: true });
    expect(clicked).toHaveBeenCalledTimes(1);
  });
});
