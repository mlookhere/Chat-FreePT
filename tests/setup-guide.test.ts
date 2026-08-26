import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SetupGuide } from "../src/content/ui/setup-guide";
import { installChromeMock } from "./chrome-mock";

const SESSION_KEY = "cfpt:setup-guide:v2";
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

  it("highlights Security and login, then advances in the same tab session", async () => {
    stored("security");
    document.body.innerHTML = '<button id="security">Security and login</button>';
    makeGuide();
    await settle();

    const ring = shadow.querySelector(".cfpt-guide-ring");
    expect(shadow.querySelectorAll(".cfpt-guide-ring")).toHaveLength(1);
    expect(ring?.classList.contains("cfpt-guide-hidden")).toBe(false);
    expect(shadow.textContent).toContain("1 · Security and login");

    document.getElementById("security")?.click();
    await settle(100);
    expect(sessionState()).toMatchObject({ step: "developer" });
    expect(ring?.classList.contains("cfpt-guide-hidden")).toBe(true);
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
    expect(shadow.querySelector(".cfpt-guide-card")?.classList.contains("cfpt-guide-hidden")).toBe(
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

    expect(scroller.scrollTop).toBeGreaterThan(0);
    expect(shadow.textContent).toContain("Developer mode is lower on this page");
  });

  it("skips Developer mode when the semantic switch is already enabled", async () => {
    stored("developer-toggle");
    document.body.innerHTML = `
      <section>
        <span>Developer mode</span>
        <button role="switch" aria-label="Developer mode" aria-checked="true"></button>
      </section>`;
    makeGuide();
    await settle();

    expect(sessionState()).toMatchObject({ step: "plugins" });
    expect(shadow.textContent).toContain("4 · Open Plugins");
  });

  it("advances after a disabled Developer mode switch becomes enabled", async () => {
    stored("developer-toggle");
    document.body.innerHTML = `
      <section>
        <span>Developer mode</span>
        <button id="developer-switch" role="switch" aria-label="Developer mode" aria-checked="false"></button>
      </section>`;
    const toggle = document.getElementById("developer-switch");
    toggle?.addEventListener("click", () => toggle.setAttribute("aria-checked", "true"));
    makeGuide();
    await settle();

    expect(shadow.textContent).toContain("3 · Enable Developer mode");
    toggle?.click();
    await settle(150);
    expect(sessionState()).toMatchObject({ step: "plugins" });
  });
});

describe("setup guide plugin flow", () => {
  it("searches for the exact custom GitHub MCP app before offering Create app", async () => {
    stored("plugin-search");
    document.body.innerHTML = `
      <input id="plugin-search" aria-label="Search plugins" value="GitHub" />
      <button aria-label="Create app"></button>`;
    makeGuide();
    await settle();

    shadow.querySelector<HTMLButtonElement>('[data-guide-action="search-plugin"]')?.click();
    await settle(300);

    expect((document.getElementById("plugin-search") as HTMLInputElement).value).toBe("GitHub MCP");
    expect(sessionState()).toMatchObject({ step: "plugin-add" });
    expect(shadow.textContent).toContain("Create the app");
  });

  it("skips custom app creation when an existing GitHub MCP result is present", async () => {
    stored("plugin-add");
    document.body.innerHTML = `
      <input id="plugin-search" aria-label="Search plugins" value="GitHub MCP" />
      <article><a aria-label="Open GitHub MCP" href="/plugins/custom-github-mcp">GitHub MCP</a></article>`;
    makeGuide();
    await settle();

    expect(sessionState()).toMatchObject({ step: "chat-plus" });
  });

  it("fills the exact GitHub MCP server URL using native input events", async () => {
    stored("plugin-server");
    document.body.innerHTML = `
      <label for="server-url">Server URL</label>
      <input id="server-url" type="url" />`;
    const input = document.getElementById("server-url") as HTMLInputElement;
    const inputEvent = vi.fn();
    const changeEvent = vi.fn();
    input.addEventListener("input", inputEvent);
    input.addEventListener("change", changeEvent);
    makeGuide();
    await settle();

    shadow.querySelector<HTMLButtonElement>('[data-guide-action="fill-url"]')?.click();
    await settle();
    expect(input.value).toBe("https://api.githubcopilot.com/mcp/");
    expect(inputEvent).toHaveBeenCalledTimes(1);
    expect(changeEvent).toHaveBeenCalledTimes(1);
    expect(sessionState()).toMatchObject({ step: "plugin-auth" });
  });
});
