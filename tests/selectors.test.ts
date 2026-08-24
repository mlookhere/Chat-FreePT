import { beforeEach, describe, expect, it } from "vitest";
import { healthCheck, query, queryLast, resolve } from "../src/content/selectors";

/**
 * Synthetic fixture reflecting chatgpt.com's known structure (composer, send button,
 * message turns). Refresh against the live site when selectors drift — the registry's
 * candidate order encodes today's DOM first.
 */
const CHATGPT_FIXTURE = `
  <main>
    <div role="presentation">
      <article data-testid="conversation-turn-1">
        <div data-message-author-role="user" data-message-id="u1">build me a thing</div>
      </article>
      <article data-testid="conversation-turn-2">
        <div data-message-author-role="assistant" data-message-id="a1">
          <div class="markdown">working on it</div>
        </div>
      </article>
      <article data-testid="conversation-turn-3">
        <div data-message-author-role="assistant" data-message-id="a2">
          <div class="markdown">done<pre><code>CHATFREEPT_STATUS: CONTINUE</code></pre></div>
        </div>
      </article>
    </div>
    <form>
      <div id="prompt-textarea" class="ProseMirror" contenteditable="true"><p></p></div>
      <button id="composer-submit-button" data-testid="send-button" aria-label="Send prompt"></button>
    </form>
  </main>
`;

beforeEach(() => {
  document.body.innerHTML = CHATGPT_FIXTURE;
});

describe("selector registry", () => {
  it("resolves the primary candidates on the reference fixture", () => {
    expect(resolve("composer")?.candidateIndex).toBe(0);
    expect(resolve("sendButton")?.candidateIndex).toBe(0);
    expect(resolve("conversationRoot")?.candidateIndex).toBe(0);
    expect(resolve("assistantMessage")?.candidateIndex).toBe(0);
    expect(resolve("userMessage")?.candidateIndex).toBe(0);
  });

  it("queryLast returns the newest assistant message", () => {
    const el = queryLast("assistantMessage");
    expect(el?.getAttribute("data-message-id")).toBe("a2");
  });

  it("falls back down the candidate list", () => {
    document.getElementById("prompt-textarea")?.removeAttribute("id");
    const res = resolve("composer");
    expect(res).not.toBeNull();
    expect(res?.candidateIndex).toBeGreaterThan(0);
  });

  it("filters text-matched candidates", () => {
    document.body.innerHTML = `<main><form>
      <div id="prompt-textarea" contenteditable="true"></div>
      <button>Cancel</button><button>Send</button>
    </form></main>`;
    const res = resolve("sendButton");
    expect(res?.element.textContent).toBe("Send");
  });

  it("reports stop button absence as no streaming", () => {
    expect(query("stopButton")).toBeNull();
    document
      .querySelector("form")
      ?.insertAdjacentHTML("beforeend", '<button data-testid="stop-button"></button>');
    expect(query("stopButton")).not.toBeNull();
  });

  it("healthCheck passes on the fixture and fails when required targets vanish", () => {
    expect(healthCheck().missing).toEqual([]);

    document.getElementById("prompt-textarea")?.remove();
    document.querySelectorAll("button").forEach((b) => b.remove());
    const report = healthCheck();
    expect(report.missing).toContain("composer");
    expect(report.missing).toContain("sendButton");
  });

  it("healthCheck reports degradation when primaries drift", () => {
    document.getElementById("prompt-textarea")?.removeAttribute("id");
    const report = healthCheck();
    expect(report.degraded.some((d) => d.id === "composer")).toBe(true);
  });
});
