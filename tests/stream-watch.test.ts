import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/common/types";
import { StreamWatcher } from "../src/content/stream-watch";

const SETTINGS = {
  ...DEFAULT_SETTINGS,
  quietMs: 1_600,
  toolQuietMs: 3_200,
  maxStreamMinutes: 1,
};

let watcher: StreamWatcher | null = null;

function assistant(id: string, text: string): HTMLElement {
  const el = document.createElement("div");
  el.dataset["messageAuthorRole"] = "assistant";
  el.dataset["messageId"] = id;
  el.textContent = text;
  return el;
}

function main(): HTMLElement {
  return document.querySelector("main") as HTMLElement;
}

async function advance(ms: number): Promise<void> {
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "<main></main>";
});

afterEach(() => {
  watcher?.stop();
  watcher = null;
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("StreamWatcher", () => {
  it("starts and completes from a new assistant turn without a stop button", async () => {
    main().appendChild(assistant("old", "previous reply"));
    const onStart = vi.fn();
    const onComplete = vi.fn();
    const onStuck = vi.fn();
    watcher = new StreamWatcher({ onStart, onComplete, onStuck }, SETTINGS);
    watcher.start();
    watcher.expectReply();

    main().appendChild(
      assistant(
        "new",
        "Finished the next step.\nCHATFREEPT_STATUS: CONTINUE\nV: 1\nPHASE: DEVELOPING",
      ),
    );
    await advance(3_200);

    expect(document.querySelector('[data-testid="stop-button"]')).toBeNull();
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0]?.[0]).toContain("CHATFREEPT_STATUS: CONTINUE");
    expect(onStuck).not.toHaveBeenCalled();
  });

  it("does not treat the baseline assistant turn as a new reply", async () => {
    main().appendChild(assistant("old", "previous reply"));
    const onStart = vi.fn();
    const onComplete = vi.fn();
    watcher = new StreamWatcher({ onStart, onComplete, onStuck: vi.fn() }, SETTINGS);
    watcher.start();
    watcher.expectReply();

    await advance(8_000);

    expect(onStart).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("still uses the stop button as an independent reply-start signal", async () => {
    const onStart = vi.fn();
    const onComplete = vi.fn();
    watcher = new StreamWatcher({ onStart, onComplete, onStuck: vi.fn() }, SETTINGS);
    watcher.start();

    const stop = document.createElement("button");
    stop.dataset["testid"] = "stop-button";
    main().appendChild(stop);
    await advance(800);
    expect(onStart).toHaveBeenCalledTimes(1);

    main().appendChild(
      assistant("new", "Done.\nCHATFREEPT_STATUS: CONTINUE\nV: 1\nPHASE: DEVELOPING"),
    );
    stop.remove();
    await advance(3_200);

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("cancels an armed expectation after a failed send", async () => {
    main().appendChild(assistant("old", "previous reply"));
    const onStart = vi.fn();
    const onComplete = vi.fn();
    watcher = new StreamWatcher({ onStart, onComplete, onStuck: vi.fn() }, SETTINGS);
    watcher.start();
    watcher.expectReply();
    watcher.cancelExpectedReply();

    main().appendChild(
      assistant("unrelated", "Later manual reply.\nCHATFREEPT_STATUS: CONTINUE\nV: 1"),
    );
    await advance(4_000);

    expect(onStart).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("reports a stuck armed reply even when the stop button never appears", async () => {
    const onStuck = vi.fn();
    watcher = new StreamWatcher(
      { onStart: vi.fn(), onComplete: vi.fn(), onStuck },
      { ...SETTINGS, maxStreamMinutes: 0.001 },
    );
    watcher.start();
    watcher.expectReply();

    await advance(1_600);

    expect(onStuck).toHaveBeenCalledTimes(1);
  });
});
