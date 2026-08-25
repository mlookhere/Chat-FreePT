import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newRunState } from "../src/common/state-machine";
import { Panel, type PanelHooks } from "../src/content/ui/panel";

const panels: Panel[] = [];

function fixture(): void {
  document.body.innerHTML = `
    <main id="main">
      <div id="thread">
        <div id="thread-bottom">
          <div data-prompt-textarea-header></div>
          <form data-type="unified-composer">
            <div data-composer-surface="true">
              <div id="prompt-textarea" class="ProseMirror" contenteditable="true"></div>
            </div>
          </form>
        </div>
      </div>
    </main>
  `;
}

function makePanel(): Panel {
  const hooks: PanelHooks = {
    onEvent: vi.fn(),
    onNewProject: vi.fn(),
    getHandoffPrompt: vi.fn(() => "handoff"),
  };
  const panel = new Panel(hooks);
  panels.push(panel);
  return panel;
}

function host(): HTMLElement {
  const element = document.getElementById("cfpt-root");
  if (!element) throw new Error("embedded Chat FreePT host missing");
  return element;
}

beforeEach(() => {
  fixture();
});

afterEach(() => {
  panels.splice(0).forEach((panel) => panel.dispose());
});

describe("embedded composer panel", () => {
  it("mounts exactly once in the ChatGPT composer header", () => {
    makePanel();
    const header = document.querySelector("[data-prompt-textarea-header]");

    expect(header?.querySelector("#cfpt-root")).toBe(host());
    expect(document.querySelectorAll("#cfpt-root")).toHaveLength(1);
    expect(host().dataset["cfptEmbedded"]).toBe("true");
  });

  it("tracks toggle and rendered status on the light-DOM host", () => {
    const panel = makePanel();
    const idle = newRunState("conversation-1", 1);

    panel.render(idle);
    expect(host().dataset["status"]).toBe("idle");
    expect(host().dataset["phase"]).toBe("idle");
    expect(host().dataset["expanded"]).toBe("false");

    panel.toggle();
    expect(host().dataset["expanded"]).toBe("true");

    panel.render({
      ...idle,
      phase: "planning",
      status: "awaiting_user",
      pauseReason: "Choose a repository name",
    });
    expect(host().dataset["state"]).toBe("attention");
    expect(host().dataset["status"]).toBe("awaiting_user");
  });

  it("re-homes the same host when ChatGPT replaces the composer header", async () => {
    makePanel();
    const first = document.querySelector("[data-prompt-textarea-header]");
    const replacement = document.createElement("div");
    replacement.setAttribute("data-prompt-textarea-header", "");
    first?.replaceWith(replacement);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(replacement.querySelector("#cfpt-root")).toBe(host());
    expect(document.querySelectorAll("#cfpt-root")).toHaveLength(1);
  });

  it("expands the embedded controls for completion instead of creating an overlay", () => {
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
    expect(document.querySelector(".cfpt-modal-backdrop")).toBeNull();
  });
});
