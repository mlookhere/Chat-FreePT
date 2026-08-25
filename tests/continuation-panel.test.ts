import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newRunState } from "../src/common/state-machine";
import { Panel, type PanelHooks } from "../src/content/ui/panel";
import { installChromeMock } from "./chrome-mock";

let shadow: ShadowRoot;
let attachShadowSpy: ReturnType<typeof vi.spyOn>;
let panel: Panel | undefined;

function fixture(): void {
  document.body.innerHTML = `
    <div id="thread-bottom">
      <div data-prompt-textarea-header></div>
      <form data-type="unified-composer">
        <div data-composer-surface="true">
          <div id="prompt-textarea" contenteditable="true"></div>
        </div>
      </form>
    </div>
  `;
}

function makePanel(onEvent = vi.fn()): { panel: Panel; onEvent: ReturnType<typeof vi.fn> } {
  const hooks: PanelHooks = {
    onEvent,
    getHandoffPrompt: vi.fn(() => "handoff"),
  };
  panel = new Panel(hooks);
  return { panel, onEvent };
}

beforeEach(() => {
  const stores = installChromeMock();
  stores.local["cfpt:onboarding:v1"] = {
    launcherTipSuppressed: true,
    setupShown: true,
  };
  fixture();

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
  panel?.dispose();
  panel = undefined;
  attachShadowSpy.mockRestore();
});

describe("panel continuation controls", () => {
  it("dispatches the auto-continue toggle from the shared controls", () => {
    const { panel: current, onEvent } = makePanel();
    current.render({ ...newRunState("c1", 1), phase: "planning", status: "streaming" });

    const toggle = shadow.querySelector<HTMLInputElement>('[data-action="auto-continue"]');
    expect(toggle?.checked).toBe(true);
    toggle?.click();

    expect(onEvent).toHaveBeenCalledWith({
      type: "USER_SET_AUTO_CONTINUE",
      enabled: false,
    });
  });

  it("opens the queue editor and dispatches the next user message", () => {
    const { panel: current, onEvent } = makePanel();
    current.render({ ...newRunState("c1", 1), phase: "developing", status: "streaming" });

    shadow.querySelector<HTMLButtonElement>('[data-action="showqueue"]')?.click();
    const editor = shadow.querySelector<HTMLElement>('[data-ref="queue-editor"]');
    const input = shadow.querySelector<HTMLTextAreaElement>('[data-ref="queue-next"]');
    expect(editor?.classList.contains("cfpt-hidden")).toBe(false);

    if (input) input.value = "  Run the accessibility checks next.  ";
    shadow.querySelector<HTMLButtonElement>('[data-action="savequeue"]')?.click();

    expect(onEvent).toHaveBeenCalledWith({
      type: "USER_QUEUE_NEXT",
      text: "Run the accessibility checks next.",
    });
  });

  it("re-renders queued state with edit and clear controls", () => {
    const { panel: current, onEvent } = makePanel();
    const state = {
      ...newRunState("c1", 1),
      phase: "planning" as const,
      status: "cooldown" as const,
      queuedUserText: "Check the release artifact.",
    };

    current.render(state);
    expect(shadow.textContent).toContain("Queued next:");
    expect(shadow.textContent).toContain("Check the release artifact.");
    expect(shadow.querySelector('[data-action="showqueue"]')?.textContent).toContain("Edit");

    shadow.querySelector<HTMLButtonElement>('[data-action="clearqueue"]')?.click();
    expect(onEvent).toHaveBeenCalledWith({ type: "USER_CLEAR_QUEUE" });
  });

  it("derives the manual-continue view from machine state, not pause text", () => {
    const { panel: current } = makePanel();
    current.render({
      ...newRunState("c1", 1),
      phase: "developing",
      status: "awaiting_user",
      autoContinueEnabled: false,
      lastMarker: { status: "CONTINUE", version: 1, raw: "CONTINUE" },
      pauseReason: "Copy can change without changing semantics.",
    });

    expect(shadow.textContent).toContain("Auto-continue is off");
    expect(shadow.querySelector('[data-ref="reply"]')).toBeNull();
  });

  it("dispatches New project through the machine event channel", () => {
    const { panel: current, onEvent } = makePanel();
    current.render({
      ...newRunState("c1", 1),
      phase: "complete",
      status: "complete",
    });

    shadow.querySelector<HTMLButtonElement>('[data-action="newproject"]')?.click();
    expect(onEvent).toHaveBeenCalledWith({ type: "USER_NEW_PROJECT" });
  });

  it("does not expose queue controls outside planning or development", () => {
    const { panel: current } = makePanel();
    current.render(newRunState("c1", 1));

    expect(shadow.textContent).toContain("Auto-continue");
    expect(shadow.querySelector('[data-action="auto-continue"]')).not.toBeNull();
    expect(shadow.querySelector('[data-action="showqueue"]')).toBeNull();
  });
});
