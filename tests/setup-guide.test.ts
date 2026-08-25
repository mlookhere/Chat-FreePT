import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SetupGuide } from "../src/content/ui/setup-guide";
import { installChromeMock } from "./chrome-mock";

let stores: ReturnType<typeof installChromeMock>;
let shadow: ShadowRoot;
let attachShadowSpy: ReturnType<typeof vi.spyOn>;
let guide: SetupGuide | undefined;

function stored(step: string): void {
  stores.local["cfpt:setup-guide:v1"] = {
    active: true,
    step,
    returnUrl: "https://chatgpt.com/c/example",
  };
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
});

describe("opt-in setup guide", () => {
  it("highlights only Security and login, then clears it for the next step", async () => {
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
    expect(stores.local["cfpt:setup-guide:v1"]).toMatchObject({ step: "developer" });
    expect(ring?.classList.contains("cfpt-guide-hidden")).toBe(true);
  });

  it("advances only after the Developer mode switch becomes enabled", async () => {
    stored("developer-toggle");
    document.body.innerHTML = `
      <section>
        <span>Developer mode</span>
        <button id="developer-switch" role="switch" aria-checked="false"></button>
      </section>`;
    const toggle = document.getElementById("developer-switch");
    toggle?.addEventListener("click", () => toggle.setAttribute("aria-checked", "true"));
    makeGuide();
    await settle();

    expect(shadow.textContent).toContain("3 · Enable Developer mode");
    toggle?.click();
    await settle(150);
    expect(stores.local["cfpt:setup-guide:v1"]).toMatchObject({ step: "plugins" });
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
    expect(stores.local["cfpt:setup-guide:v1"]).toMatchObject({ step: "plugin-auth" });
  });

  it("removes the current highlight and persistence when cancelled", async () => {
    stored("security");
    document.body.innerHTML = '<button id="security">Security and login</button>';
    makeGuide();
    await settle();

    shadow.querySelector<HTMLButtonElement>('[data-guide-action="cancel"]')?.click();
    await settle();
    expect(stores.local["cfpt:setup-guide:v1"]).toMatchObject({ active: false });
    expect(shadow.querySelector(".cfpt-guide-ring")?.classList.contains("cfpt-guide-hidden")).toBe(
      true,
    );
    expect(shadow.querySelector(".cfpt-guide-card")?.classList.contains("cfpt-guide-hidden")).toBe(
      true,
    );
  });
});
