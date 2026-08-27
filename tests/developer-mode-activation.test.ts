import { beforeEach, describe, expect, it, vi } from "vitest";
import { activateDeveloperModeSetup } from "../src/content/developer-mode-activation";

const SESSION_KEY = "cfpt:setup-guide:v4";

function pendingSetup(): void {
  window.sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      active: true,
      step: "done",
      returnUrl: "https://chatgpt.com/c/example",
    }),
  );
}

function storedState(): Record<string, unknown> | null {
  const raw = window.sessionStorage.getItem(SESSION_KEY);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

beforeEach(() => {
  document.body.innerHTML = "";
  window.sessionStorage.clear();
});

describe("activateDeveloperModeSetup", () => {
  it("does nothing when no setup handoff is pending", async () => {
    expect(await activateDeveloperModeSetup(5, 1)).toBe("not-needed");
  });

  it("opens Plus, chooses Developer mode, selects the exact app, then completes setup", async () => {
    pendingSetup();
    document.body.innerHTML = `
      <form data-type="unified-composer">
        <button id="plus" type="button" data-testid="composer-plus-btn">+</button>
      </form>`;

    const plus = document.getElementById("plus") as HTMLButtonElement;
    const plusClicks = vi.fn();
    const developerClicks = vi.fn();
    const appClicks = vi.fn();

    plus.addEventListener("click", () => {
      plusClicks();
      if (document.getElementById("developer-mode")) return;
      const developer = document.createElement("button");
      developer.id = "developer-mode";
      developer.textContent = "Developer mode";
      developer.addEventListener("click", () => {
        developerClicks();
        const app = document.createElement("button");
        app.id = "chat-freept-app";
        app.textContent = "Chat FreePT GitHub MCP";
        app.addEventListener("click", () => {
          appClicks();
          app.setAttribute("aria-checked", "true");
        });
        document.body.appendChild(app);
      });
      document.body.appendChild(developer);
    });

    expect(await activateDeveloperModeSetup(100, 1)).toBe("activated");
    expect(plusClicks).toHaveBeenCalledTimes(1);
    expect(developerClicks).toHaveBeenCalledTimes(1);
    expect(appClicks).toHaveBeenCalledTimes(1);
    expect(storedState()).toMatchObject({ active: false, step: "done" });
  });

  it("reopens Plus when switching modes closes the first menu", async () => {
    pendingSetup();
    document.body.innerHTML = `
      <form data-type="unified-composer">
        <button id="plus" type="button" data-testid="composer-plus-btn">+</button>
      </form>`;

    const plus = document.getElementById("plus") as HTMLButtonElement;
    let plusClicks = 0;
    plus.addEventListener("click", () => {
      plusClicks += 1;
      if (plusClicks === 1) {
        const developer = document.createElement("button");
        developer.textContent = "Developer mode";
        developer.addEventListener("click", () => developer.remove());
        document.body.appendChild(developer);
        return;
      }
      const app = document.createElement("button");
      app.textContent = "Chat FreePT GitHub MCP";
      document.body.appendChild(app);
    });

    expect(await activateDeveloperModeSetup(100, 1)).toBe("activated");
    expect(plusClicks).toBe(2);
    expect(storedState()).toMatchObject({ active: false });
  });

  it("does not silently complete setup when the dedicated app is unavailable", async () => {
    pendingSetup();
    document.body.innerHTML = `
      <form data-type="unified-composer">
        <button id="plus" type="button" data-testid="composer-plus-btn">+</button>
      </form>
      <button id="developer-mode">Developer mode</button>`;

    expect(await activateDeveloperModeSetup(5, 1)).toBe("missing-app");
    expect(storedState()).toMatchObject({ active: true, step: "done" });
  });

  it("does not click an app that ChatGPT already reports as selected", async () => {
    pendingSetup();
    document.body.innerHTML = `
      <form data-type="unified-composer">
        <button id="plus" type="button" data-testid="composer-plus-btn">+</button>
      </form>
      <button id="developer-mode">Developer mode</button>
      <button id="app" aria-checked="true">Chat FreePT GitHub MCP</button>`;

    const app = document.getElementById("app") as HTMLButtonElement;
    const click = vi.fn();
    app.addEventListener("click", click);

    expect(await activateDeveloperModeSetup(20, 1)).toBe("activated");
    expect(click).not.toHaveBeenCalled();
    expect(storedState()).toMatchObject({ active: false });
  });
});
