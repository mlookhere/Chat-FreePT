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
          <form data-chatgpt-composer data-composer-placement="home">
            <div class="composer-mode-surface">
              <div class="relative">
                <div data-composer-body style="border-radius: 26px; pointer-events: auto">
                  <div data-composer-footer>
                    <div class="left-controls">
                      <button data-testid="composer-plus-btn" aria-label="Add files">+</button>
                    </div>
                  </div>
                  <div data-composer-input>
                    <div id="prompt-textarea" class="ProseMirror" contenteditable="true"></div>
                  </div>
                  <button id="composer-submit-button" type="submit" aria-label="Send prompt"></button>
                </div>
              </div>
            </div>
          </form>
        </div>
      </div>
    </main>`;
}

function makePanel(overrides: Partial<PanelHooks> = {}): Panel {
  const hooks: PanelHooks = {
    onEvent: vi.fn(),
    getHandoffPrompt: vi.fn(() => "handoff"),
    ...overrides,
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

function launcherShadow(): ShadowRoot {
  for (const root of shadows) {
    if (root.querySelector(".cfpt-launcher")) return root;
  }
  throw new Error("Chat FreePT launcher shadow missing");
}

function launcherButton(): HTMLButtonElement {
  const button = launcherShadow().querySelector<HTMLButtonElement>(".cfpt-launcher");
  if (!button) throw new Error("Chat FreePT launcher button missing");
  return button;
}

function nativeSurface(): HTMLElement {
  const surface = document.querySelector<HTMLElement>("[data-composer-body]");
  if (!surface) throw new Error("native composer surface missing");
  return surface;
}

function nativeForm(): HTMLFormElement {
  const form = document.querySelector<HTMLFormElement>("form[data-chatgpt-composer]");
  if (!form) throw new Error("native composer form missing");
  return form;
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

  it("owns a Chat FreePT tooltip instead of using a browser-native title", () => {
    onboardingDone();
    makePanel().render(newRunState("conversation-1", 1));
    const button = launcherButton();
    const tooltip = launcherShadow().querySelector<HTMLElement>(".cfpt-launcher-tooltip");

    expect(button.hasAttribute("title")).toBe(false);
    expect(button.getAttribute("aria-describedby")).toBe("cfpt-launcher-tooltip");
    expect(tooltip?.getAttribute("role")).toBe("tooltip");
    expect(tooltip?.textContent).toBe("Chat FreePT");
    expect(PANEL_CSS).toContain(".cfpt-launcher:hover + .cfpt-launcher-tooltip");
    expect(PANEL_CSS).toContain("border-radius: 8px");
    expect(PANEL_CSS).toContain("pointer-events: none");
  });

  it("mounts the extended surface in the exact native composer-body slot", () => {
    onboardingDone();
    const panel = makePanel();
    panel.render(newRunState("conversation-1", 1));

    expect(overlayHost().parentElement).toBe(nativeSurface().parentElement);
    expect(overlayHost().previousElementSibling).toBe(nativeSurface());
    expect(nativeSurface().contains(overlayHost())).toBe(false);
    expect(nativeForm().contains(overlayHost())).toBe(true);
    expect(host().dataset["cfptLauncher"]).toBe("airplane");
  });

  it("re-homes the same launcher beside a replacement + button", async () => {
    onboardingDone();
    makePanel();
    const replacement = document.createElement("div");
    replacement.setAttribute("data-composer-body", "");
    replacement.innerHTML = `
      <div data-composer-footer>
        <div class="left-controls"><button data-testid="composer-plus-btn" aria-label="Add files">+</button></div>
      </div>
      <div data-composer-input><div id="prompt-textarea" contenteditable="true"></div></div>`;
    nativeSurface().replaceWith(replacement);
    await settle();

    const plus = replacement.querySelector('[data-testid="composer-plus-btn"]');
    expect(plus?.nextElementSibling).toBe(host());
    expect(document.querySelectorAll("#cfpt-root")).toHaveLength(1);
  });

  it("uses inline composer styles rather than a viewport overlay", () => {
    expect(PANEL_CSS).toContain(".cfpt-takeover-backdrop");
    expect(PANEL_CSS).toContain('data-cfpt-host="overlay"][data-expanded="true"]');
    expect(PANEL_CSS).toContain('data-cfpt-host="launcher"');
    expect(PANEL_CSS).toContain("position: relative");
    expect(PANEL_CSS).toContain("--color-text-composer-reference");
    expect(PANEL_CSS).toContain("--color-border-strong");
    expect(PANEL_CSS).toContain("--cfpt-field-surface");
    expect(PANEL_CSS).not.toContain("position: fixed");
    expect(PANEL_CSS).not.toContain(".cfpt-dock");
  });
});

describe("composer takeover lifecycle", () => {
  it("visually replaces the native bar and restores its exact inline state on close", () => {
    onboardingDone();
    const panel = makePanel();
    panel.render(newRunState("conversation-1", 1));
    nativeComposer().focus();
    expect(document.activeElement).toBe(nativeComposer());

    panel.toggle(true);
    expect(nativeForm().dataset["cfptTakeover"]).toBe("true");
    expect(nativeSurface().dataset["cfptNativeHidden"]).toBe("true");
    expect(nativeSurface().style.position).toBe("absolute");
    expect(nativeSurface().style.opacity).toBe("0");
    expect(nativeSurface().style.pointerEvents).toBe("none");
    expect(nativeSurface().style.visibility).toBe("hidden");
    expect(nativeSurface().inert).toBe(true);
    expect(nativeSurface().dataset["cfptNativeGuarded"]).toBe("true");
    expect(overlayHost().dataset["expanded"]).toBe("true");
    expect(host().dataset["expanded"]).toBe("true");
    expect(document.activeElement).not.toBe(nativeComposer());

    panel.toggle(false);
    expect(nativeSurface().style.position).toBe("");
    expect(nativeSurface().style.opacity).toBe("");
    expect(nativeSurface().style.pointerEvents).toBe("auto");
    expect(nativeSurface().style.visibility).toBe("");
    expect(nativeSurface().inert).toBe(false);
    expect(nativeSurface().dataset["cfptNativeHidden"]).toBeUndefined();
    expect(nativeForm().dataset["cfptTakeover"]).toBeUndefined();
  });

  it("restores pre-existing native inline styles exactly", () => {
    onboardingDone();
    nativeSurface().style.position = "relative";
    nativeSurface().style.opacity = "0.8";
    nativeSurface().style.pointerEvents = "auto";
    const panel = makePanel();
    panel.render(newRunState("conversation-1", 1));

    panel.toggle(true);
    panel.toggle(false);

    expect(nativeSurface().style.position).toBe("relative");
    expect(nativeSurface().style.opacity).toBe("0.8");
    expect(nativeSurface().style.pointerEvents).toBe("auto");
  });

  it("does not leak launcher events into ChatGPT composer controls", () => {
    onboardingDone();
    makePanel().render(newRunState("conversation-1", 1));
    const nativeHandler = vi.fn();
    host().parentElement?.addEventListener("pointerover", nativeHandler);
    host().parentElement?.addEventListener("mouseover", nativeHandler);
    host().parentElement?.addEventListener("pointerdown", nativeHandler);
    host().parentElement?.addEventListener("mousedown", nativeHandler);
    host().parentElement?.addEventListener("click", nativeHandler);

    launcherButton().dispatchEvent(new Event("pointerover", { bubbles: true, composed: true }));
    launcherButton().dispatchEvent(new MouseEvent("mouseover", { bubbles: true, composed: true }));
    launcherButton().dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
    launcherButton().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true }));
    launcherButton().dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));

    expect(nativeHandler).not.toHaveBeenCalled();
  });

  it("does not surface a transient missing-composer warning until a real insert error exists", () => {
    onboardingDone();
    const panel = makePanel();
    nativeComposer().remove();
    panel.render({
      ...newRunState("conversation-1", 1),
      phase: "developing",
      status: "streaming",
    });
    panel.toggle(true);

    expect(overlayShadow().textContent).not.toContain("page structure changed");

    panel.render({
      ...newRunState("conversation-1", 1),
      phase: "developing",
      status: "error",
      errorCode: "composer-insert-failed",
      pauseReason: "Could not write into the composer",
    });
    expect(overlayShadow().textContent).toContain("page structure changed");
  });
});

describe("integrated composer interaction", () => {
  it("restores the native composer from the integrated close control", () => {
    onboardingDone();
    const panel = makePanel();
    panel.render(newRunState("conversation-1", 1));
    panel.toggle(true);

    overlayShadow().querySelector<HTMLButtonElement>('[data-action="close"]')?.click();
    expect(host().dataset["expanded"]).toBe("false");
    expect(overlayHost().dataset["expanded"]).toBe("false");
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

  it("keeps typing and paste inside Chat FreePT before ChatGPT capture handlers", () => {
    onboardingDone();
    const documentKeydown = vi.fn();
    const documentPaste = vi.fn();
    document.addEventListener("keydown", documentKeydown, true);
    document.addEventListener("paste", documentPaste, true);
    const panel = makePanel();
    panel.render(newRunState("conversation-1", 1));
    panel.toggle(true);

    const repo = overlayShadow().querySelector<HTMLInputElement>('[data-ref="reponame"]');
    const idea = overlayShadow().querySelector<HTMLTextAreaElement>('[data-ref="idea"]');
    if (!repo || !idea) throw new Error("planning inputs missing");

    repo.focus();
    repo.value = "owner/repo";
    repo.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, composed: true }));
    idea.focus();
    idea.value = "build this";
    idea.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true, composed: true }));

    expect(repo.value).toBe("owner/repo");
    expect(idea.value).toBe("build this");
    expect(overlayShadow().activeElement).toBe(idea);
    expect(documentKeydown).not.toHaveBeenCalled();
    expect(documentPaste).not.toHaveBeenCalled();
    expect(nativeSurface().inert).toBe(true);
    document.removeEventListener("keydown", documentKeydown, true);
    document.removeEventListener("paste", documentPaste, true);
  });

  it("temporarily unlocks the parked native composer only for automation", () => {
    onboardingDone();
    const panel = makePanel();
    panel.render(newRunState("conversation-1", 1));
    panel.toggle(true);

    expect(nativeSurface().inert).toBe(true);
    expect(nativeSurface().style.visibility).toBe("hidden");

    panel.setNativeAutomationAccess(true);
    expect(nativeSurface().inert).toBe(false);
    expect(nativeSurface().style.visibility).toBe("");
    expect(nativeSurface().dataset["cfptNativeHidden"]).toBe("true");
    nativeComposer().focus();
    expect(document.activeElement).toBe(nativeComposer());

    panel.setNativeAutomationAccess(false);
    expect(nativeSurface().inert).toBe(true);
    expect(nativeSurface().style.visibility).toBe("hidden");
  });
});

describe("conversation repository setup", () => {
  it("normalizes a repository URL and starts planning against that exact repo", () => {
    onboardingDone();
    const onEvent = vi.fn();
    const panel = makePanel({ onEvent });
    panel.render(newRunState("conversation-1", 1));
    panel.toggle(true);

    const repo = overlayShadow().querySelector<HTMLInputElement>('[data-ref="reponame"]');
    const idea = overlayShadow().querySelector<HTMLTextAreaElement>('[data-ref="idea"]');
    if (!repo || !idea) throw new Error("repository setup inputs missing");
    repo.value = "https://github.com/Owner/weather-board.git";
    idea.value = "Build a tiny weather dashboard";
    overlayShadow().querySelector<HTMLButtonElement>('[data-action="start"]')?.click();

    expect(onEvent).toHaveBeenCalledWith({
      type: "USER_START",
      idea: "Build a tiny weather dashboard",
      repoMode: "existing",
      repoName: "Owner/weather-board",
    });
  });

  it("rejects an invalid repository before starting", () => {
    onboardingDone();
    const onEvent = vi.fn();
    const panel = makePanel({ onEvent });
    panel.render(newRunState("conversation-1", 1));
    panel.toggle(true);

    const repo = overlayShadow().querySelector<HTMLInputElement>('[data-ref="reponame"]');
    const idea = overlayShadow().querySelector<HTMLTextAreaElement>('[data-ref="idea"]');
    if (!repo || !idea) throw new Error("repository setup inputs missing");
    repo.value = "weather-board";
    idea.value = "Build it";
    overlayShadow().querySelector<HTMLButtonElement>('[data-action="start"]')?.click();

    expect(onEvent).not.toHaveBeenCalled();
    expect(overlayShadow().textContent).toContain("Enter a valid owner/repo");
  });

  it("renders a locked repository read-only and explains how to switch", () => {
    onboardingDone();
    const panel = makePanel();
    panel.render({ ...newRunState("conversation-1", 1), repo: "owner/project" });
    panel.toggle(true);

    const repo = overlayShadow().querySelector<HTMLInputElement>('[data-ref="reponame"]');
    expect(repo?.value).toBe("owner/project");
    expect(repo?.readOnly).toBe(true);
    expect(overlayShadow().textContent).toContain("start a new ChatGPT conversation");
  });

  it("opens repository-first setup without Developer Mode instructions", () => {
    onboardingDone();
    const panel = makePanel();
    panel.render(newRunState("conversation-1", 1));
    panel.toggle(true);
    overlayShadow().querySelector<HTMLButtonElement>('[data-action="setup-open"]')?.click();

    expect(overlayShadow().textContent).toContain("Choose the GitHub repository first");
    expect(overlayShadow().textContent).toContain("create a private repository on GitHub");
    expect(overlayShadow().innerHTML).toContain("https://github.com/new");
    expect(overlayShadow().textContent).not.toContain("Developer mode");
    expect(overlayShadow().textContent).not.toContain("Chat FreePT GitHub MCP");
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

  it("uses repository-first onboarding", async () => {
    onboardingDone();
    const panel = makePanel();
    panel.render(newRunState("conversation-1", 1));
    panel.toggle(true);
    overlayShadow().querySelector<HTMLButtonElement>('[data-action="setup-open"]')?.click();

    expect(overlayShadow().textContent).toContain("One conversation · one repository");
    expect(overlayShadow().textContent).toContain("NEEDS_INPUT");
    expect(overlayShadow().querySelector('[aria-modal="true"]')).toBeNull();
    expect(overlayShadow().textContent).not.toContain("Follow along");
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
    expect(nativeForm().dataset["cfptTakeover"]).toBe("true");
    expect(nativeSurface().dataset["cfptNativeHidden"]).toBe("true");
  });
});
