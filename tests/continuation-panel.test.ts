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
  stores.local["cfpt:onboarding:v1"] = { setupShown: true };
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
  it("shows continuous mode without an off toggle", () => {
    const { panel: current, onEvent } = makePanel();
    current.render({ ...newRunState("c1", 1), phase: "planning", status: "streaming" });

    expect(shadow.textContent).toContain("Continuous mode");
    expect(shadow.textContent).toContain("keeps the project moving automatically");
    expect(shadow.querySelector('[data-action="auto-continue"]')).toBeNull();
    expect(onEvent).not.toHaveBeenCalled();
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
});

describe("panel Ultra Code queue and checkpoint", () => {
  it("renders ordered queue controls and dispatches reorder/remove/clear", () => {
    const { panel: current, onEvent } = makePanel();
    const state = {
      ...newRunState("c1", 1),
      phase: "planning" as const,
      status: "cooldown" as const,
      queuedUserTexts: ["Check the release artifact.", "Verify the package."],
    };

    current.render(state);
    expect(shadow.textContent).toContain("Message queue · 2");
    expect(shadow.textContent).toContain("Check the release artifact.");
    expect(shadow.textContent).toContain("Verify the package.");

    shadow.querySelector<HTMLButtonElement>('[data-action="queue-down"][data-index="0"]')?.click();
    expect(onEvent).toHaveBeenCalledWith({
      type: "USER_MOVE_QUEUE",
      index: 0,
      direction: 1,
    });

    shadow
      .querySelector<HTMLButtonElement>('[data-action="queue-remove"][data-index="1"]')
      ?.click();
    expect(onEvent).toHaveBeenCalledWith({ type: "USER_REMOVE_QUEUE", index: 1 });

    shadow.querySelector<HTMLButtonElement>('[data-action="clearqueue"]')?.click();
    expect(onEvent).toHaveBeenCalledWith({ type: "USER_CLEAR_QUEUE" });
  });

  it("shows the durable Ultra Code checkpoint", () => {
    const { panel: current } = makePanel();
    current.render({
      ...newRunState("c1", 1),
      repo: "owner/project",
      phase: "developing",
      status: "streaming",
      queuedUserTexts: ["one", "two"],
      lastLifecycleSignal: "generation-start",
      lastMarker: {
        status: "CONTINUE",
        version: 1,
        raw: "CONTINUE",
        item: "3/7 — tests",
        url: "https://github.com/owner/project/pull/42",
      },
    });

    expect(shadow.textContent).toContain("Ultra Code checkpoint");
    expect(shadow.textContent).toContain("owner/project");
    expect(shadow.textContent).toContain("3/7 — tests");
    expect(shadow.textContent).toContain("Marker: Continue");
    expect(shadow.textContent).toContain("Queue: 2");
    expect(shadow.textContent).toContain("Generation started");
    expect(shadow.innerHTML).toContain("https://github.com/owner/project/pull/42");
  });

});

describe("panel checkpoint language and terminal states", () => {
  it("renders protocol status updates as normal language", () => {
    const { panel: current } = makePanel();
    current.render({
      ...newRunState("c1", 1),
      repo: "owner/project",
      repoName: "owner/project",
      repoMode: "existing",
      phase: "plan_ready",
      status: "awaiting_user",
      lastLifecycleSignal: "generation-interrupted",
      lastMarker: {
        status: "NEEDS_INPUT",
        version: 1,
        raw: "NEEDS_INPUT",
      },
    });

    expect(shadow.textContent).toContain("Plan ready");
    expect(shadow.textContent).toContain("Marker: Needs input");
    expect(shadow.textContent).toContain("Last lifecycle: Generation interrupted");
    expect(shadow.textContent).not.toContain("plan_ready");
    expect(shadow.textContent).not.toContain("NEEDS_INPUT");
    expect(shadow.textContent).not.toContain("generation-interrupted");
  });

  it("renders testing as an intentional human checkpoint", () => {
    const { panel: current } = makePanel();
    current.render({
      ...newRunState("c1", 1),
      repo: "owner/project",
      repoName: "owner/project",
      phase: "testing",
      status: "awaiting_user",
      lastMarker: { status: "TESTING", version: 1, raw: "Testing" },
      pauseReason: "Please verify the extension in Chrome.",
    });

    expect(shadow.textContent).toContain("Ready for testing");
    expect(shadow.textContent).toContain("Please verify the extension in Chrome.");
    expect(shadow.querySelector('[data-ref="reply"]')).not.toBeNull();
    expect(shadow.textContent).not.toContain("TESTING");
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

    expect(shadow.textContent).toContain("Continuous mode");
    expect(shadow.querySelector('[data-action="auto-continue"]')).toBeNull();
    expect(shadow.querySelector('[data-action="showqueue"]')).toBeNull();
  });
});
