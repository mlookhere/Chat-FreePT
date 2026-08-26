import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newRunState } from "../src/common/state-machine";
import { Panel, type PanelHooks } from "../src/content/ui/panel";
import { PANEL_CSS } from "../src/content/ui/styles";
import { installChromeMock } from "./chrome-mock";

const panels: Panel[] = [];
const shadows: ShadowRoot[] = [];
let stores: ReturnType<typeof installChromeMock>;
let attachShadowSpy: ReturnType<typeof vi.spyOn>;

function fixture(): void {
  document.body.innerHTML = `
    <main id="main">
      <div id="thread">
        <div id="thread-bottom">
          <div data-prompt-textarea-header></div>
          <form data-type="unified-composer">
            <div data-composer-surface="true" aria-hidden="false" style="pointer-events: auto">
              <div class="left-controls">
                <button data-testid="composer-plus-btn" aria-label="Add files">+</button>
              </div>
              <div id="prompt-textarea" class="ProseMirror" contenteditable="true"></div>
            </div>
          </form>
        </div>
      </div>
    </main>`;
}

function makePanel(): Panel {
  const hooks: PanelHooks = {
    onEvent: vi.fn(),
    getHandoffPrompt: vi.fn(() => "handoff"),
  };
  const panel = new Panel(hooks);
  panels.push(panel);
  return panel;
}

function host(): HTMLElement {
  const element = document.getElementById("cfpt-root");
  if (!element) throw new Error("Chat FreePT launcher host missing");
  return element;
}

function overlayHost(): HTMLElement {
  const element = document.getElementById("cfpt-overlay-root");
  if (!element) throw new Error("Chat FreePT overlay host missing");
  return element;
}

function overlayShadow(): ShadowRoot {
  const root = shadows.at(-1);
  if (!root) throw new Error("Chat FreePT overlay shadow missing");
  return root;
}

function launcherButton(): HTMLButtonElement {
  for (const root of shadows) {
    const button = root.querySelector<HTMLButtonElement>(".cfpt-launcher");
    if (button) return button;
  }
  throw new Error("Chat FreePT launcher button missing");
}

function nativeSurface(): HTMLElement {
  const surface = document.querySelector<HTMLElement>('[data-composer-surface="true"]');
  if (!surface) throw new Error("native composer surface missing");
  return surface;
}

function nativeComposer(): HTMLElement {
  const composer = document.getElementById("prompt-textarea");
  if (!composer) throw new Error("native composer input missing");
  return composer;
}

function onboardingDone(): void {
  stores.local["cfpt:onboarding:v1"] = {
    launcherTipSuppressed: true,
    setupShown: true,
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  stores = installChromeMock();
  fixture();
  shadows.splice(0);
  const original = HTMLElement.prototype.attachShadow;
  attachShadowSpy = vi.spyOn(HTMLElement.prototype, "attachShadow").mockImplementation(function (
    this: HTMLElement,
    init: ShadowRootInit,
  ) {
    const root = original.call(this, init);
    shadows.push(root);
    return root;
  });
});

afterEach(() => {
  panels.splice(0).forEach((panel) => panel.dispose());
  attachShadowSpy.mockRestore();
  shadows.splice(0);
});

describe("native composer launcher placement", () => {
  it("mounts immediately to the right of ChatGPT's + button", () => {
    onboardingDone();
    makePanel();
    const plus = document.querySelector('[data-testid="composer-plus-btn"]');

    expect(plus?.nextElementSibling).toBe(host());
    expect(host().parentElement).toBe(plus?.parentElement);
    expect(host().dataset["fallback"]).toBe("false");
    expect(document.querySelectorAll("#cfpt-root")).toHaveLength(1);
  });

  it("keeps the expanded surface outside the native composer DOM", () => {
    onboardingDone();
    makePanel();

    expect(overlayHost().parentElement).toBe(document.body);
    expect(nativeSurface().contains(overlayHost())).toBe(false);
    expect(host().dataset["cfptLauncher"]).toBe("airplane");
  });

  it("re-homes the same launcher beside a replacement + button", async () => {
    onboardingDone();
    makePanel();
    const replacement = document.createElement("div");
    replacement.setAttribute("data-composer-surface", "true");
    replacement.innerHTML = `
      <div class="left-controls"><button data-testid="composer-plus-btn" aria-label="Add files">+</button></div>
      <div id="prompt-textarea" contenteditable="true"></div>`;
    nativeSurface().replaceWith(replacement);
    await settle();

    const plus = replacement.querySelector('[data-testid="composer-plus-btn"]');
    expect(plus?.nextElementSibling).toBe(host());
    expect(document.querySelectorAll("#cfpt-root")).toHaveLength(1);
  });

  it("uses integrated takeover styles rather than the old detached dock", () => {
    expect(PANEL_CSS).toContain(".cfpt-takeover-backdrop");
    expect(PANEL_CSS).toContain("backdrop-filter: blur(22px)");
    expect(PANEL_CSS).toContain('data-cfpt-host="launcher"');
    expect(PANEL_CSS).toContain("z-index: 2147483646");
    expect(PANEL_CSS).not.toContain(".cfpt-dock");
  });
});

describe("composer takeover lifecycle", () => {
  it("moves native focus, uses inert, and restores the exact native state on close", () => {
    onboardingDone();
    const panel = makePanel();
    panel.render(newRunState("conversation-1", 1));
    nativeComposer().focus();
    expect(document.activeElement).toBe(nativeComposer());

    panel.toggle(true);
    expect(nativeSurface().style.pointerEvents).toBe("none");
    expect(nativeSurface().inert).toBe(true);
    expect(nativeSurface().getAttribute("aria-hidden")).toBe("false");
    expect(nativeSurface().dataset["cfptTakeover"]).toBe("true");
    expect(document.activeElement).not.toBe(nativeComposer());
    expect(host().dataset["expanded"]).toBe("true");

    panel.toggle(false);
    expect(nativeSurface().style.pointerEvents).toBe("auto");
    expect(nativeSurface().inert).toBe(false);
    expect(nativeSurface().getAttribute("aria-hidden")).toBe("false");
    expect(nativeSurface().dataset["cfptTakeover"]).toBeUndefined();
  });

  it("restores a composer that was already inert before takeover", () => {
    onboardingDone();
    nativeSurface().inert = true;
    const panel = makePanel();
    panel.render(newRunState("conversation-1", 1));

    panel.toggle(true);
    panel.toggle(false);
    expect(nativeSurface().inert).toBe(true);
  });

  it("does not leak launcher events into ChatGPT composer controls", () => {
    onboardingDone();
    makePanel().render(newRunState("conversation-1", 1));
    const nativeHandler = vi.fn();
    host().parentElement?.addEventListener("pointerdown", nativeHandler);
    host().parentElement?.addEventListener("mousedown", nativeHandler);
    host().parentElement?.addEventListener("click", nativeHandler);

    launcherButton().dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
    launcherButton().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true }));
    launcherButton().dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));

    expect(nativeHandler).not.toHaveBeenCalled();
  });

  it("closes when the user clicks outside the integrated panel", () => {
    onboardingDone();
    const panel = makePanel();
    panel.render(newRunState("conversation-1", 1));
    panel.toggle(true);

    overlayShadow().querySelector<HTMLElement>(".cfpt-takeover-backdrop")?.click();
    expect(host().dataset["expanded"]).toBe("false");
    expect(nativeSurface().style.pointerEvents).toBe("auto");
  });

  it("closes on Escape", () => {
    onboardingDone();
    const panel = makePanel();
    panel.render(newRunState("conversation-1", 1));
    panel.toggle(true);

    const body = overlayShadow().querySelector<HTMLElement>(".cfpt-body");
    body?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(host().dataset["expanded"]).toBe("false");
  });

  it("keeps planning input focus outside ChatGPT's composer focus handlers", () => {
    onboardingDone();
    const nativeFocus = vi.fn();
    nativeSurface().addEventListener("focusin", nativeFocus);
    const panel = makePanel();
    panel.render(newRunState("conversation-1", 1));
    panel.toggle(true);

    const idea = overlayShadow().querySelector<HTMLTextAreaElement>('[data-ref="idea"]');
    idea?.focus();
    expect(overlayShadow().activeElement).toBe(idea);
    expect(nativeFocus).not.toHaveBeenCalled();
  });
});

describe("first-run and plan-aware setup", () => {
  it("keeps the working launcher-tip then setup sequence", async () => {
    const panel = makePanel();
    await settle();
    expect(host().dataset["onboarding"]).toBe("tip");
    expect(host().dataset["highlighted"]).toBe("true");

    await panel.acknowledgeLauncherTip(true);
    expect(host().dataset["onboarding"]).toBe("setup");
    expect(host().dataset["highlighted"]).toBe("false");

    await panel.acknowledgeSetup();
    expect(host().dataset["onboarding"]).toBe("done");
    expect(stores.local["cfpt:onboarding:v1"]).toEqual({
      launcherTipSuppressed: true,
      setupShown: true,
    });
  });

  it("offers an opt-in follow-along path and a separate Free path", async () => {
    onboardingDone();
    const panel = makePanel();
    panel.render(newRunState("conversation-1", 1));
    panel.toggle(true);
    overlayShadow().querySelector<HTMLButtonElement>('[data-action="setup-open"]')?.click();

    expect(overlayShadow().textContent).toContain("Follow along");
    expect(overlayShadow().textContent).toContain("Using ChatGPT Free?");
    expect(overlayShadow().textContent).toContain("fill the GitHub MCP name");
    overlayShadow().querySelector<HTMLButtonElement>('[data-action="free-setup"]')?.click();
    expect(overlayShadow().textContent).toContain("Prepare GitHub manually first");
    expect(overlayShadow().textContent).toContain("Existing repo");
    expect(overlayShadow().textContent).toContain("NEEDS_INPUT");
  });

  it("does not re-show onboarding after suppression and completion", async () => {
    onboardingDone();
    makePanel();
    await settle();

    expect(host().dataset["onboarding"]).toBe("done");
    expect(host().dataset["highlighted"]).toBe("false");
  });

  it("expands the same composer takeover for completion", () => {
    onboardingDone();
    const panel = makePanel();
    const complete = {
      ...newRunState("conversation-1", 1),
      phase: "complete" as const,
      status: "complete" as const,
      repo: "owner/project",
    };
    panel.render(complete);
    panel.showCompletionModal(complete);

    expect(host().dataset["expanded"]).toBe("true");
    expect(nativeSurface().dataset["cfptTakeover"]).toBe("true");
  });
});
