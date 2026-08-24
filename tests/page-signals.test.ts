import { beforeEach, describe, expect, it } from "vitest";
import { scanPageSignals } from "../src/content/page-signals";

beforeEach(() => {
  document.body.innerHTML = "<main></main>";
});

describe("scanPageSignals", () => {
  it("detects a logged-out page", () => {
    document.querySelector("main")?.insertAdjacentHTML(
      "beforeend",
      '<button data-testid="login-button">Log in</button>',
    );
    expect(scanPageSignals()).toBe("logged-out");
  });

  it("detects conversation length alerts", () => {
    document.querySelector("main")?.insertAdjacentHTML(
      "beforeend",
      '<div role="alert">Maximum conversation length reached. Start a new chat to continue.</div>',
    );
    expect(scanPageSignals()).toBe("conversation-full");
  });

  it("detects usage-limit toasts", () => {
    document.querySelector("main")?.insertAdjacentHTML(
      "beforeend",
      '<div class="toast-banner">You have reached your message limit. Try again later.</div>',
    );
    expect(scanPageSignals()).toBe("rate-limit");
  });

  it("detects regenerate controls as network errors", () => {
    document.querySelector("main")?.insertAdjacentHTML(
      "beforeend",
      '<button data-testid="regenerate-thread-error-button">Regenerate</button>',
    );
    expect(scanPageSignals()).toBe("network-error");
  });

  it("returns null on a healthy composer with no alerts", () => {
    document.querySelector("main")?.insertAdjacentHTML(
      "beforeend",
      '<div id="prompt-textarea" contenteditable="true"></div>',
    );
    expect(scanPageSignals()).toBeNull();
  });
});
