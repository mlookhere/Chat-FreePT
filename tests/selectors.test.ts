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
        <form data-type="unified-composer">
          <div data-composer-surface="true">
            <div class="left-controls">
              <button data-testid="composer-plus-btn" aria-label="Add files">+</button>
            </div>
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

describe("core selector resolution", () => {
  it("resolves primary candidates on the current composer structure", () => {
    expect(resolve("composer")?.candidateIndex).toBe(0);
    expect(resolve("composerHeader")?.candidateIndex).toBe(0);
    expect(resolve("composerSurface")?.candidateIndex).toBe(0);
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

  it("treats an empty-composer Send button absence as healthy", () => {
    document.querySelector('[data-testid="send-button"]')?.remove();
    expect(query("sendButton")).toBeNull();
    expect(healthCheck().missing).toEqual([]);
  });
});

describe("selector fallbacks and health", () => {
  it("falls back down the composer, header, and surface candidates", () => {
    document.getElementById("prompt-textarea")?.removeAttribute("id");
    document.getElementById("thread-bottom")?.removeAttribute("id");
    expect(resolve("composer")?.candidateIndex).toBeGreaterThan(0);
    expect(resolve("composerHeader")?.candidateIndex).toBeGreaterThan(0);
    expect(resolve("composerSurface")?.candidateIndex).toBeGreaterThan(0);
  });

  it("falls back to the unified form when the surface attribute disappears", () => {
    document
      .querySelector('[data-composer-surface="true"]')
      ?.removeAttribute("data-composer-surface");
    const surface = resolve("composerSurface");
    expect(surface?.element.tagName).toBe("FORM");
    expect(surface?.candidateIndex).toBe(3);
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
    document.getElementById("prompt-textarea")?.removeAttribute("id");
    expect(healthCheck().degraded.some((item) => item.id === "composer")).toBe(true);
  });
});

describe("composer and guided-setup targets", () => {
  it("resolves the native composer + button", () => {
    expect(queryGuideTarget("composerPlusButton")?.dataset["testid"]).toBe("composer-plus-btn");
  });

  it("resolves Security and login, Developer mode row, and its switch", () => {
    document.body.innerHTML = `
      <nav><button>Security and login</button></nav>
      <section class="developer-row">
        <div><strong>Developer mode</strong><span>Elevated Risk</span></div>
        <button role="switch" aria-checked="false" aria-label="Developer mode"></button>
      </section>`;

    expect(queryGuideTarget("settingsSecurity")?.textContent).toContain("Security and login");
    expect(queryGuideTarget("developerModeRow")?.classList.contains("developer-row")).toBe(true);
    expect(queryGuideTarget("developerModeToggle")?.getAttribute("role")).toBe("switch");
  });

  it("resolves every field in the New Plugin form", () => {
    document.body.innerHTML = `
      <button aria-label="Add plugin">+</button>
      <label for="plugin-name">Name</label><input id="plugin-name" />
      <label for="server-url">Server URL</label><input id="server-url" type="url" />
      <label for="auth">Authentication</label><select id="auth"><option>OAuth</option></select>
      <label><span>I understand the risks and want to continue</span><input id="risk" type="checkbox" /></label>
      <button>Create</button>`;

    expect(queryGuideTarget("pluginAddButton")?.getAttribute("aria-label")).toBe("Add plugin");
    expect(queryGuideTarget("pluginNameInput")?.id).toBe("plugin-name");
    expect(queryGuideTarget("pluginServerInput")?.id).toBe("server-url");
    expect(queryGuideTarget("pluginAuthControl")?.id).toBe("auth");
    expect(queryGuideTarget("pluginRiskCheckbox")?.id).toBe("risk");
    expect(queryGuideTarget("pluginCreateButton")?.textContent).toBe("Create");
  });

  it("resolves Developer mode and GitHub MCP choices in the conversation menu", () => {
    document.body.innerHTML = `
      <div role="menu">
        <button role="menuitem">Developer mode</button>
        <button role="menuitem">GitHub MCP</button>
      </div>`;
    expect(queryGuideTarget("conversationDeveloperMode")?.textContent).toBe("Developer mode");
    expect(queryGuideTarget("conversationGitHubMcp")?.textContent).toBe("GitHub MCP");
  });
});
