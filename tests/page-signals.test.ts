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

  it("detects the real ChatGPT max-length banner with its Start new chat button", () => {
    append(`
      <aside role="alert" class="relative isolate flex w-full overflow-hidden rounded-md">
        <div class="flex h-full w-full gap-3 items-start">
          <div class="flex min-w-0 grow flex-col">
            <div class="flex min-w-0 flex-col">
              <div class="min-w-0 flex-1">
                You've reached the maximum length for this conversation, but you can keep talking by starting a new chat.
              </div>
            </div>
            <div class="flex gap-2">
              <button type="button">Start new chat</button>
            </div>
          </div>
        </div>
      </aside>
    `);
    expect(scanPageSignals()).toBe("conversation-full");
  });

  it("does not treat a quoted max-length notice inside a chat message as a page signal", () => {
    append(`
      <div data-message-author-role="assistant">
        You've reached the maximum length for this conversation, but you can keep talking by starting a new chat.
      </div>
    `);
    expect(scanPageSignals()).toBeNull();
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
