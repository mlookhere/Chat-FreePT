import { beforeEach, describe, expect, it } from "vitest";
import { healthCheck, query, queryAll, queryLast, resolve } from "../src/content/selectors";

/**
 * Synthetic fixture shaped from the current chatgpt.com DOM capture: the thread owns
 * section turns, the composer is unified, and Chat FreePT mounts in the composer surface.
 */
const CHATGPT_FIXTURE = `
  <main id="main">
    <div id="thread">
      <div data-turn-id-container="request-user-1">
        <section data-testid="conversation-turn-1" data-turn="user">
          <div class="user-turn">
            <div data-message-author-role="user" data-message-id="u1">build me a thing</div>
          </div>
        </section>
      </div>
      <div data-turn-id-container="request-assistant-1">
        <section data-testid="conversation-turn-2" data-turn="assistant">
          <div class="agent-turn">
            <div data-message-author-role="assistant" data-message-id="a1">
              <div class="markdown">working on it</div>
            </div>
          </div>
        </section>
      </div>
      <div data-turn-id-container="request-assistant-2">
        <section data-testid="conversation-turn-3" data-turn="assistant">
          <div class="agent-turn">
            <div data-message-author-role="assistant" data-message-id="a2">
              <div class="markdown">done<pre><code>CHATFREEPT_STATUS: CONTINUE</code></pre></div>
            </div>
          </div>
        </section>
      </div>
      <div id="thread-bottom">
        <div data-prompt-textarea-header></div>
        <form data-type="unified-composer">
          <div data-composer-surface="true">
            <div id="prompt-textarea" class="ProseMirror" contenteditable="true"><p></p></div>
            <button data-testid="send-button" aria-label="Send prompt"></button>
          </div>
        </form>
      </div>
    </div>
  </main>
`;

beforeEach(() => {
  document.body.innerHTML = CHATGPT_FIXTURE;
});

describe("selector registry", () => {
  it("resolves primary candidates on the captured ChatGPT structure", () => {
    expect(resolve("composer")?.candidateIndex).toBe(0);
    expect(resolve("composerHeader")?.candidateIndex).toBe(0);
    expect(resolve("composerSurface")?.candidateIndex).toBe(0);
    expect(resolve("sendButton")?.candidateIndex).toBe(0);
    expect(resolve("conversationRoot")?.candidateIndex).toBe(0);
    expect(resolve("assistantMessage")?.candidateIndex).toBe(0);
    expect(resolve("userMessage")?.candidateIndex).toBe(0);
  });

  it("queryLast returns the newest assistant message", () => {
    const el = queryLast("assistantMessage");
    expect(el?.getAttribute("data-message-id")).toBe("a2");
  });

  it("queryAll returns all alert and toast matches", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div role="alert">one</div><div class="toast-banner">two</div>',
    );
    expect(queryAll("pageAlert").map((el) => el.textContent)).toEqual(["one", "two"]);
  });

  it("resolves tool indicators inside a scoped assistant turn", () => {
    const turn = queryLast("assistantMessage") as HTMLElement;
    turn.insertAdjacentHTML("beforeend", '<span data-testid="tool-call">GitHub</span>');
    expect(query("toolIndicator", turn)?.textContent).toBe("GitHub");
  });

  it("does not treat an empty-composer Send button absence as unhealthy", () => {
    document.querySelector('[data-testid="send-button"]')?.remove();
    expect(query("sendButton")).toBeNull();
    expect(healthCheck().missing).toEqual([]);
  });

  it("falls back down the composer, header, and surface candidate lists", () => {
    document.getElementById("prompt-textarea")?.removeAttribute("id");
    document.getElementById("thread-bottom")?.removeAttribute("id");

    expect(resolve("composer")?.candidateIndex).toBeGreaterThan(0);
    expect(resolve("composerHeader")?.candidateIndex).toBeGreaterThan(0);
    expect(resolve("composerSurface")?.candidateIndex).toBeGreaterThan(0);
  });

  it("falls back to the unified form when the composer-surface attribute disappears", () => {
    document
      .querySelector('[data-composer-surface="true"]')
      ?.removeAttribute("data-composer-surface");
    const surface = resolve("composerSurface");
    expect(surface?.element.tagName).toBe("FORM");
    expect(surface?.candidateIndex).toBe(3);
  });

  it("filters text-matched Send candidates", () => {
    document.querySelector('[data-testid="send-button"]')?.remove();
    const form = document.querySelector("form");
    form?.insertAdjacentHTML("beforeend", "<button>Cancel</button><button>Send</button>");
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

  it("healthCheck fails only when an automation-required target vanishes", () => {
    expect(healthCheck().missing).toEqual([]);

    document.getElementById("prompt-textarea")?.remove();
    document.querySelectorAll('[contenteditable="true"]').forEach((el) => el.remove());
    const report = healthCheck();
    expect(report.missing).toContain("composer");
    expect(report.missing).not.toContain("sendButton");
    expect(report.missing).not.toContain("composerHeader");
    expect(report.missing).not.toContain("composerSurface");
  });

  it("healthCheck reports degradation when the primary composer drifts", () => {
    document.getElementById("prompt-textarea")?.removeAttribute("id");
    const report = healthCheck();
    expect(report.degraded.some((item) => item.id === "composer")).toBe(true);
  });
});
