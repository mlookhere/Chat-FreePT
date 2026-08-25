import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newRunState } from "../src/common/state-machine";
import { Panel, type PanelHooks } from "../src/content/ui/panel";
import { PANEL_CSS } from "../src/content/ui/styles";
import { installChromeMock } from "./chrome-mock";

const panels: Panel[] = [];
let stores: ReturnType<typeof installChromeMock>;

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

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  stores = installChromeMock();
  fixture();
});

afterEach(() => {
  panels.splice(0).forEach((panel) => panel.dispose());
});

describe("composer airplane launcher", () => {
  it("mounts exactly once inside the ChatGPT composer surface", () => {
    makePanel();
    const surface = document.querySelector('[data-composer-surface="true"]');
    const header = document.querySelector("[data-prompt-textarea-header]");

    expect(surface?.querySelector("#cfpt-root")).toBe(host());
    expect(header?.querySelector("#cfpt-root")).toBeNull();
    expect(document.querySelectorAll("#cfpt-root")).toHaveLength(1);
    expect(host().dataset["cfptEmbedded"]).toBe("true");
    expect(host().dataset["cfptLauncher"]).toBe("airplane");
  });

  it("uses a compact launcher instead of the old full-width dock", () => {
    expect(PANEL_CSS).toContain(".cfpt-launcher");
    expect(PANEL_CSS).toContain(".cfpt-airplane");
    expect(PANEL_CSS).not.toContain(".cfpt-dock");
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

  it("re-homes the same host when ChatGPT replaces the composer surface", async () => {
    makePanel();
    const first = document.querySelector('[data-composer-surface="true"]');
    const replacement = document.createElement("div");
    replacement.setAttribute("data-composer-surface", "true");
    replacement.innerHTML = '<div id="prompt-textarea" contenteditable="true"></div>';
    first?.replaceWith(replacement);

    await settle();

    expect(replacement.querySelector("#cfpt-root")).toBe(host());
    expect(document.querySelectorAll("#cfpt-root")).toHaveLength(1);
  });

  it("expands the composer controls for completion instead of creating a completion overlay", () => {
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

describe("first-run onboarding", () => {
  it("shows the launcher tip first, highlights the airplane, then shows setup", async () => {
    const panel = makePanel();
    await settle();

    expect(host().dataset["onboarding"]).toBe("tip");
    expect(host().dataset["highlighted"]).toBe("true");

    await panel.acknowledgeLauncherTip(true);
    expect(host().dataset["onboarding"]).toBe("setup");
    expect(host().dataset["highlighted"]).toBe("false");
    expect(stores.local["cfpt:onboarding:v1"]).toEqual({
      launcherTipSuppressed: true,
      setupShown: false,
    });

    await panel.acknowledgeSetup();
    expect(host().dataset["onboarding"]).toBe("done");
    expect(stores.local["cfpt:onboarding:v1"]).toEqual({
      launcherTipSuppressed: true,
      setupShown: true,
    });
  });

  it("does not show either onboarding surface again after suppression and setup completion", async () => {
    stores.local["cfpt:onboarding:v1"] = {
      launcherTipSuppressed: true,
      setupShown: true,
    };

    makePanel();
    await settle();

    expect(host().dataset["onboarding"]).toBe("done");
    expect(host().dataset["highlighted"]).toBe("false");
  });

  it("shows the launcher tip again when the user did not check don't-show-again", async () => {
    const panel = makePanel();
    await settle();
    await panel.acknowledgeLauncherTip(false);
    await panel.acknowledgeSetup();
    panel.dispose();

    fixture();
    makePanel();
    await settle();

    expect(stores.local["cfpt:onboarding:v1"]).toEqual({
      launcherTipSuppressed: false,
      setupShown: true,
    });
    expect(host().dataset["onboarding"]).toBe("tip");
    expect(host().dataset["highlighted"]).toBe("true");
  });

  it("goes directly to the one-time setup dialog when only the launcher tip is suppressed", async () => {
    stores.local["cfpt:onboarding:v1"] = {
      launcherTipSuppressed: true,
      setupShown: false,
    };

    makePanel();
    await settle();

    expect(host().dataset["onboarding"]).toBe("setup");
    expect(host().dataset["highlighted"]).toBe("false");
  });
});
