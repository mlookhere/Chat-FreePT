import { beforeEach, describe, expect, it } from "vitest";
import { scanPageSignals } from "../src/content/page-signals";

function append(html: string): void {
  document.querySelector("main")?.insertAdjacentHTML("beforeend", html);
}

beforeEach(() => {
  document.body.innerHTML = "<main></main>";
});

describe("scanPageSignals", () => {
  it("detects a logged-out page", () => {
    append('<button data-testid="login-button">Log in</button>');
    expect(scanPageSignals()).toBe("logged-out");
  });

  it("detects conversation length alerts", () => {
    append(
      '<div role="alert">Maximum conversation length reached. Start a new chat to continue.</div>',
    );
    expect(scanPageSignals()).toBe("conversation-full");
  });

  it("detects usage-limit toasts", () => {
    append('<div class="toast-banner">You have reached your message limit. Try again later.</div>');
    expect(scanPageSignals()).toBe("rate-limit");
  });

  it("detects regenerate controls as network errors", () => {
    append('<button data-testid="regenerate-thread-error-button">Regenerate</button>');
    expect(scanPageSignals()).toBe("network-error");
  });

  it("returns null on a healthy composer with no alerts", () => {
    append('<div id="prompt-textarea" contenteditable="true"></div>');
    expect(scanPageSignals()).toBeNull();
  });
});
