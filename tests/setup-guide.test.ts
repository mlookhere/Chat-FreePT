import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SetupGuide } from "../src/content/ui/setup-guide";
import { installChromeMock } from "./chrome-mock";

const SESSION_KEY = "cfpt:setup-guide:v4";
let stores: ReturnType<typeof installChromeMock>;
let shadow: ShadowRoot;
let attachShadowSpy: ReturnType<typeof vi.spyOn>;
let guide: SetupGuide | undefined;

function stored(step: string): void {
  window.sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify({ active: true, step, returnUrl: "https://chatgpt.com/c/example" }),
  );
}

function sessionState(): Record<string, unknown> | null {
  const raw = window.sessionStorage.getItem(SESSION_KEY);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

function makeGuide(): SetupGuide {
  guide = new SetupGuide();
  return guide;
}

async function settle(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function customFormHtml(): string {
  return `
    <div id="modal-create-custom-connector">
      <form id="custom-form">
        <input id="custom-connector-name" aria-label="Name" />
        <div role="radiogroup" aria-label="Connection">
          <button type="button" role="radio" aria-label="Server URL" aria-checked="true">Server URL</button>
          <button type="button" role="radio" aria-label="Tunnel" aria-checked="false">Tunnel</button>
        </div>
        <input id="custom-connector-url" inputmode="url" />
        <select id="custom-connector-auth">
          <option value="NONE">No Auth</option>
          <option value="OAUTH">OAuth</option>
        </select>
        <label for="trust-checkbox">
          <input id="trust-checkbox" data-testid="trust-checkbox" type="checkbox" />
          I understand and want to continue
        </label>
        <button id="create-custom" type="submit" disabled><span>Create</span></button>
      </form>
    </div>`;
}

beforeEach(() => {
  stores = installChromeMock();
  window.sessionStorage.clear();
  document.body.innerHTML = "";
  const original = HTMLElement.prototype.attachShadow;
  attachShadowSpy = vi.spyOn(HTMLElement.prototype, "attachShadow").mockImplementation(function (
    this: HTMLElement,
    init: ShadowRootInit,
  ) {
    shadow = original.call(this, init);
    return shadow;
  });
});

afterEach(() => {
  guide?.dispose();
  guide = undefined;
  attachShadowSpy.mockRestore();
  window.sessionStorage.clear();
});

describe("setup guide tab isolation", () => {
  it("keeps walkthrough progress in this tab session instead of extension-wide storage", async () => {
    stores.local["cfpt:setup-guide:v1"] = {
      active: true,
      step: "developer-toggle",
      returnUrl: "https://chatgpt.com/c/other-tab",
    };
    document.body.innerHTML = '<button id="security">Security and login</button>';
    makeGuide();
    await settle();

    expect(shadow.querySelector(".cfpt-guide-card")?.classList.contains("cfpt-guide-hidden")).toBe(
      true,
    );
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull();
    expect(stores.local["cfpt:setup-guide:v1"]).toMatchObject({ step: "developer-toggle" });
  });

  it("automatically opens Security and login in the same tab session", async () => {
    stored("security");
    document.body.innerHTML = '<button id="security">Security and login</button>';
    const security = document.getElementById("security") as HTMLButtonElement;
    const clicked = vi.fn();
    security.addEventListener("click", clicked);
    makeGuide();
    await settle(160);

    expect(clicked).toHaveBeenCalledTimes(1);
    expect(sessionState()).toMatchObject({ step: "developer" });
  });

  it("keeps cancellation local to this tab session", async () => {
    stored("security");
    document.body.innerHTML = '<button id="security">Security and login</button>';
    makeGuide();
    await settle();

    shadow.querySelector<HTMLButtonElement>('[data-guide-action="cancel"]')?.click();
    await settle();
    expect(sessionState()).toMatchObject({ active: false });
    expect(shadow.querySelector(".cfpt-guide-ring")?.classList.contains("cfpt-guide-hidden")).toBe(
      true,
    );
  });
});

describe("setup guide settings flow", () => {
  it("scrolls settings before highlighting off-screen Developer mode", async () => {
    stored("developer");
    document.body.innerHTML = `
      <div id="modal-settings">
        <div id="settings-scroll" class="overflow-y-auto" style="overflow-y:auto">
          <div id="developer-row">
            <div>Developer mode</div>
            <div>Allows you to add unverified connectors that could modify or erase data permanently.</div>
            <button role="switch" aria-label="Developer mode" aria-checked="false"></button>
          </div>
        </div>
      </div>`;
    const scroller = document.getElementById("settings-scroll") as HTMLElement;
    const row = document.getElementById("developer-row") as HTMLElement;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1200 },
    });
    scroller.getBoundingClientRect = () =>
      ({
        top: 100,
        bottom: 500,
        height: 400,
        left: 0,
        right: 600,
        width: 600,
        x: 0,
        y: 100,
        toJSON: () => ({}),
      }) as DOMRect;
    row.getBoundingClientRect = () =>
      ({
        top: 850,
        bottom: 920,
        height: 70,
        left: 100,
        right: 550,
        width: 450,
        x: 100,
        y: 850,
        toJSON: () => ({}),
      }) as DOMRect;

    makeGuide();
    await settle();

    expect(scroller.scrollTop).not.toBe(0);
    expect(shadow.textContent).toContain("Developer mode");
  });

  it("skips the Developer switch when it is already enabled and opens Plugins", async () => {
    stored("developer-toggle");
    document.body.innerHTML = `
      <section>
        <span>Developer mode</span>
        <button role="switch" aria-label="Developer mode" aria-checked="true"></button>
      </section>`;
    makeGuide();
    await settle();

    expect(sessionState()).toMatchObject({ step: "plugin-search" });
  });

  it("turns on Developer mode automatically after Follow along", async () => {
    stored("developer-toggle");
    document.body.innerHTML = `
      <section>
        <span>Developer mode</span>
        <button id="developer-switch" role="switch" aria-label="Developer mode" aria-checked="false"></button>
      </section>`;
    const toggle = document.getElementById("developer-switch") as HTMLButtonElement;
    const clicked = vi.fn();
    toggle.addEventListener("click", () => {
      clicked();
      toggle.setAttribute("aria-checked", "true");
    });
    makeGuide();
    await settle(260);

    expect(clicked).toHaveBeenCalledTimes(1);
    expect(sessionState()).toMatchObject({ step: "plugin-search" });
  });
});

describe("setup guide custom MCP automation", () => {
  it("resumes on Plugins without any conversation composer", async () => {
    stored("plugin-risk");
    document.body.innerHTML = customFormHtml();
    makeGuide();
    await settle();

    expect(document.getElementById("prompt-textarea")).toBeNull();
    expect(shadow.textContent).toContain("Your approval required");
    expect(sessionState()).toMatchObject({ step: "plugin-risk" });
  });

  it("searches, opens Create app, and fills all safe MCP fields automatically", async () => {
    stored("plugin-search");
    document.body.innerHTML = `
      <input id="plugin-search" aria-label="Search plugins" value="GitHub" />
      <button id="create-app" aria-label="Create app"></button>`;
    const createApp = document.getElementById("create-app") as HTMLButtonElement;
    createApp.addEventListener("click", () => {
      document.body.insertAdjacentHTML("beforeend", customFormHtml());
      const auth = document.getElementById("custom-connector-auth") as HTMLSelectElement;
      auth.value = "NONE";
      document
        .getElementById("custom-form")
        ?.addEventListener("submit", (event) => event.preventDefault());
    });

    makeGuide();
    await settle(1100);

    expect((document.getElementById("plugin-search") as HTMLInputElement).value).toBe(
      "Chat FreePT GitHub MCP",
    );
    expect((document.getElementById("custom-connector-name") as HTMLInputElement).value).toBe(
      "Chat FreePT GitHub MCP",
    );
    expect((document.getElementById("custom-connector-url") as HTMLInputElement).value).toBe(
      "https://api.githubcopilot.com/mcp/x/all",
    );
    expect((document.getElementById("custom-connector-auth") as HTMLSelectElement).value).toBe(
      "OAUTH",
    );
    expect((document.getElementById("trust-checkbox") as HTMLInputElement).checked).toBe(false);
    expect(sessionState()).toMatchObject({ step: "plugin-risk" });
    expect(shadow.textContent).toContain("never approve this risk disclosure for you");
  });

  it("waits for explicit risk approval, then presses Create automatically", async () => {
    stored("plugin-risk");
    document.body.innerHTML = customFormHtml();
    const risk = document.getElementById("trust-checkbox") as HTMLInputElement;
    const create = document.getElementById("create-custom") as HTMLButtonElement;
    const createClick = vi.fn();
    risk.addEventListener("click", () => {
      create.disabled = false;
    });
    create.addEventListener("click", createClick);
    document
      .getElementById("custom-form")
      ?.addEventListener("submit", (event) => event.preventDefault());
    makeGuide();
    await settle();

    expect(risk.checked).toBe(false);
    expect(createClick).not.toHaveBeenCalled();

    risk.click();
    await settle(260);

    expect(risk.checked).toBe(true);
    expect(createClick).toHaveBeenCalledTimes(1);
    expect(sessionState()).toMatchObject({ step: "oauth" });
  });

  it("reuses an existing exact Chat FreePT GitHub MCP and skips creation", async () => {
    stored("plugin-search");
    document.body.innerHTML = `
      <input id="plugin-search" aria-label="Search plugins" value="Chat FreePT GitHub MCP" />
      <article><a aria-label="Open Chat FreePT GitHub MCP" href="/plugins/custom-chat-freept-github-mcp">Chat FreePT GitHub MCP</a></article>`;
    makeGuide();
    await settle();

    expect(sessionState()).toMatchObject({ step: "done" });
    expect(shadow.textContent).toContain("Setup complete");
  });
});
