import { beforeEach, describe, expect, it } from "vitest";
import {
  healthCheck,
  query,
  queryAll,
  queryGuideTarget,
  queryLast,
  resolve,
} from "../src/content/selectors";

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
            <div data-message-author-role="assistant" data-message-id="a1">working on it</div>
          </div>
        </section>
      </div>
      <div data-turn-id-container="request-assistant-2">
        <section data-testid="conversation-turn-3" data-turn="assistant">
          <div class="agent-turn">
            <div data-message-author-role="assistant" data-message-id="a2">
              done<pre><code>CHATFREEPT_STATUS: CONTINUE</code></pre>
            </div>
          </div>
        </section>
      </div>
      <div id="thread-bottom">
        <div data-prompt-textarea-header></div>
        <form data-chatgpt-composer data-composer-placement="home">
          <div class="composer-mode-surface">
            <div class="relative">
              <div data-composer-body>
                <div data-composer-footer>
                  <div class="left-controls">
                    <button data-testid="composer-plus-btn" aria-label="Add files">+</button>
                  </div>
                </div>
                <div data-composer-input>
                  <div id="prompt-textarea" class="ProseMirror" role="textbox" contenteditable="true"><p></p></div>
                </div>
                <button data-testid="send-button" type="submit" aria-label="Send prompt"></button>
              </div>
            </div>
          </div>
        </form>
      </div>
    </div>
  </main>
`;

beforeEach(() => {
  document.body.innerHTML = CHATGPT_FIXTURE;
});

describe("core selector resolution", () => {
  it("resolves primary candidates on the current composer structure", () => {
    expect(resolve("composer")?.candidateIndex).toBe(0);
    expect(resolve("composerHeader")?.candidateIndex).toBe(0);
    expect(resolve("composerSurface")?.candidateIndex).toBe(0);
    expect(resolve("composerForm")?.candidateIndex).toBe(0);
    expect(resolve("sendButton")?.candidateIndex).toBe(0);
    expect(resolve("conversationRoot")?.candidateIndex).toBe(0);
    expect(resolve("assistantMessage")?.candidateIndex).toBe(0);
    expect(resolve("userMessage")?.candidateIndex).toBe(0);
  });

  it("returns the newest assistant message", () => {
    expect(queryLast("assistantMessage")?.getAttribute("data-message-id")).toBe("a2");
  });

  it("returns all alert and toast matches", () => {
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

  it("still resolves the structural composer while FreePT guards editability", () => {
    const composer = document.getElementById("prompt-textarea");
    composer?.setAttribute("contenteditable", "false");
    composer?.setAttribute("aria-disabled", "true");

    expect(resolve("composer")?.candidateIndex).toBe(0);
    expect(query("composer")).toBe(composer);
    expect(healthCheck().missing).not.toContain("composer");
  });

  it("treats an empty-composer Send button absence as healthy", () => {
    document.querySelector('[data-testid="send-button"]')?.remove();
    expect(query("sendButton")).toBeNull();
    expect(healthCheck().missing).toEqual([]);
  });
});

describe("selector fallbacks and health", () => {
  it("falls back down the composer, header, and surface candidates", () => {
    document.querySelector("[data-composer-input]")?.removeAttribute("data-composer-input");
    document.querySelector("form[data-chatgpt-composer]")?.removeAttribute("data-chatgpt-composer");
    document.getElementById("prompt-textarea")?.removeAttribute("id");
    document.getElementById("thread-bottom")?.removeAttribute("id");
    expect(resolve("composer")?.candidateIndex).toBeGreaterThan(0);
    expect(resolve("composerHeader")?.candidateIndex).toBeGreaterThan(0);
    expect(resolve("composerSurface")?.candidateIndex).toBeGreaterThan(0);
  });

  it("falls back to the current ChatGPT form when the composer body disappears", () => {
    document.querySelector("[data-composer-body]")?.removeAttribute("data-composer-body");
    const surface = resolve("composerSurface");
    expect(surface?.element.tagName).toBe("FORM");
    expect(surface?.element.hasAttribute("data-chatgpt-composer")).toBe(true);
    expect(surface?.candidateIndex).toBe(6);
  });

  it("filters text-matched Send candidates", () => {
    document.querySelector('[data-testid="send-button"]')?.remove();
    document
      .querySelector("form")
      ?.insertAdjacentHTML("beforeend", "<button>Cancel</button><button>Send</button>");
    expect(resolve("sendButton")?.element.textContent).toBe("Send");
  });

  it("reports stop button absence as no streaming", () => {
    expect(query("stopButton")).toBeNull();
    document
      .querySelector("form")
      ?.insertAdjacentHTML("beforeend", '<button data-testid="stop-button"></button>');
    expect(query("stopButton")).not.toBeNull();
  });

  it("fails health only when an automation-required target vanishes", () => {
    document.getElementById("prompt-textarea")?.remove();
    document.querySelectorAll('[contenteditable="true"]').forEach((el) => el.remove());
    const report = healthCheck();
    expect(report.missing).toContain("composer");
    expect(report.missing).not.toContain("sendButton");
    expect(report.missing).not.toContain("composerHeader");
    expect(report.missing).not.toContain("composerSurface");
  });

  it("reports degradation when the primary composer drifts", () => {
    document.querySelector("[data-composer-input]")?.removeAttribute("data-composer-input");
    document.querySelector("form[data-chatgpt-composer]")?.removeAttribute("data-chatgpt-composer");
    document.getElementById("prompt-textarea")?.removeAttribute("id");
    expect(healthCheck().degraded.some((item) => item.id === "composer")).toBe(true);
  });
});

describe("GitHub permission recovery target", () => {
  it("finds Continue only inside nearby GitHub MCP permission copy", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div role="dialog">
        <p>Allow GitHub FreePT MCP access so ChatGPT can continue?</p>
        <button>Cancel</button>
        <button><span>Continue</span></button>
      </div>`,
    );
    expect(queryGuideTarget("githubPermissionPrompt")?.getAttribute("role")).toBe("dialog");
    expect(queryGuideTarget("githubPermissionContinueButton")?.textContent?.trim()).toBe(
      "Continue",
    );
  });

  it("does not match an unrelated Continue dialog", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div role="dialog"><p>Continue deleting this item?</p><button>Continue</button></div>',
    );
    expect(queryGuideTarget("githubPermissionPrompt")).toBeNull();
    expect(queryGuideTarget("githubPermissionContinueButton")).toBeNull();
  });
});

describe("composer launcher target", () => {
  it("resolves the native composer + button", () => {
    expect(queryGuideTarget("composerPlusButton")?.dataset["testid"]).toBe("composer-plus-btn");
  });
});
