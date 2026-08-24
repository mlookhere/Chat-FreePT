import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./chrome-mock";

const mocks = vi.hoisted(() => ({
  insertPrompt: vi.fn(),
  clickSend: vi.fn(),
  composerIsEmpty: vi.fn(),
  healthCheck: vi.fn(),
  scanPageSignals: vi.fn(),
  lastAssistantMessage: vi.fn(),
  watchers: [] as Array<{
    callbacks: {
      onStart: () => void;
      onComplete: (text: string) => void;
      onStuck: () => void;
    };
    streaming: boolean;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    expectReply: ReturnType<typeof vi.fn>;
    cancelExpectedReply: ReturnType<typeof vi.fn>;
    isStreaming: () => boolean;
  }>,
}));

vi.mock("../src/content/composer", () => ({
  insertPrompt: mocks.insertPrompt,
  clickSend: mocks.clickSend,
  composerIsEmpty: mocks.composerIsEmpty,
}));

vi.mock("../src/content/selectors", () => ({
  healthCheck: mocks.healthCheck,
}));

vi.mock("../src/content/page-signals", () => ({
  scanPageSignals: mocks.scanPageSignals,
}));

vi.mock("../src/content/transcript", () => ({
  lastAssistantMessage: mocks.lastAssistantMessage,
}));

vi.mock("../src/content/stream-watch", () => ({
  StreamWatcher: class {
    readonly callbacks: (typeof mocks.watchers)[number]["callbacks"];
    streaming = false;
    start = vi.fn();
    stop = vi.fn();
    expectReply = vi.fn();
    cancelExpectedReply = vi.fn();

    constructor(callbacks: (typeof mocks.watchers)[number]["callbacks"]) {
      this.callbacks = callbacks;
      mocks.watchers.push(this);
    }

    isStreaming(): boolean {
      return this.streaming;
    }
  },
}));

installChromeMock();
const { RunController } = await import("../src/content/run-controller");
const { newRunState, reduce } = await import("../src/common/state-machine");
const { DEFAULT_SETTINGS } = await import("../src/common/types");

type Controller = InstanceType<typeof RunController>;
type Settings = typeof DEFAULT_SETTINGS;

const settings: Settings = {
  ...DEFAULT_SETTINGS,
  sendDelayMs: 100,
  quietMs: 50,
  toolQuietMs: 100,
};

function streamingState(): ReturnType<typeof newRunState> {
  let state = newRunState("c1", Date.now());
  state = reduce(
    state,
    { type: "USER_START", idea: "build it", repoMode: "new", repoName: "" },
    settings,
  ).state;
  state = reduce(state, { type: "INSERT_OK" }, settings).state;
  return reduce(state, { type: "SEND_OK" }, settings).state;
}

function makeController(initial = newRunState("c1", Date.now())): Controller {
  return new RunController(initial, settings, {
    onChange: vi.fn(),
    onShowModal: vi.fn(),
  });
}

function watcher(): (typeof mocks.watchers)[number] {
  const current = mocks.watchers.at(-1);
  if (!current) throw new Error("watcher was not constructed");
  return current;
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  installChromeMock();
  mocks.insertPrompt.mockReset().mockResolvedValue({ ok: true, strategy: "test" });
  mocks.clickSend.mockReset().mockResolvedValue({ ok: true });
  mocks.composerIsEmpty.mockReset().mockReturnValue(true);
  mocks.healthCheck.mockReset().mockReturnValue({ missing: [], degraded: [] });
  mocks.scanPageSignals.mockReset().mockReturnValue(null);
  mocks.lastAssistantMessage.mockReset().mockReturnValue(null);
  mocks.watchers.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RunController orchestration", () => {
  it("drives a plan prompt through insert and confirmed send", async () => {
    const controller = makeController();

    controller.dispatch({
      type: "USER_START",
      idea: "build a compact extension",
      repoMode: "new",
      repoName: "freept-test",
    });
    await flushAsync();

    expect(mocks.insertPrompt).toHaveBeenCalledTimes(1);
    expect(String(mocks.insertPrompt.mock.calls[0]?.[0])).toContain("build a compact extension");
    expect(mocks.clickSend).toHaveBeenCalledTimes(1);
    expect(watcher().expectReply).toHaveBeenCalledTimes(1);
    expect(controller.state.status).toBe("streaming");
    controller.dispose();
  });

  it("turns CONTINUE into one delayed follow-up send", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const controller = makeController(streamingState());

    watcher().callbacks.onComplete("CHATFREEPT_STATUS: CONTINUE\nV: 1");
    expect(controller.state.status).toBe("cooldown");
    expect(controller.state.cooldownUntil).toBe(10_100);

    await vi.advanceTimersByTimeAsync(100);
    await flushAsync();

    expect(mocks.insertPrompt).toHaveBeenCalledTimes(1);
    expect(mocks.clickSend).toHaveBeenCalledTimes(1);
    expect(controller.state.autoSends).toBe(1);
    expect(controller.state.status).toBe("streaming");

    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.clickSend).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("accepts a user reply after NEEDS_INPUT and re-enters streaming", async () => {
    const controller = makeController(streamingState());

    watcher().callbacks.onComplete("CHATFREEPT_STATUS: NEEDS_INPUT\nNOTE: choose a database");
    expect(controller.state.status).toBe("awaiting_user");

    controller.dispatch({ type: "USER_REPLY", text: "Use SQLite." });
    await flushAsync();

    expect(String(mocks.insertPrompt.mock.calls[0]?.[0])).toContain("Use SQLite.");
    expect(mocks.clickSend).toHaveBeenCalledTimes(1);
    expect(controller.state.status).toBe("streaming");
    controller.dispose();
  });

  it("pauses an active run when a page signal is detected", async () => {
    vi.useFakeTimers();
    mocks.scanPageSignals.mockReturnValue("rate-limit");
    const controller = makeController(streamingState());

    await vi.advanceTimersByTimeAsync(5_000);

    expect(controller.state.status).toBe("error");
    expect(controller.state.errorCode).toBe("rate-limited");
    controller.dispose();
  });

  it("cancels a pending cooldown when disposed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const initial = {
      ...streamingState(),
      status: "cooldown" as const,
      cooldownUntil: 20_100,
    };
    const controller = makeController(initial);

    controller.dispose();
    await vi.advanceTimersByTimeAsync(500);

    expect(mocks.insertPrompt).not.toHaveBeenCalled();
    expect(mocks.clickSend).not.toHaveBeenCalled();
  });

  it("does not send after disposal while insertion is in flight", async () => {
    let finishInsert: ((value: { ok: boolean; strategy?: string }) => void) | undefined;
    mocks.insertPrompt.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishInsert = resolve;
        }),
    );
    const controller = makeController();

    controller.dispatch({ type: "USER_START", idea: "build it", repoMode: "new", repoName: "" });
    await flushAsync();
    expect(mocks.insertPrompt).toHaveBeenCalledTimes(1);

    controller.dispose();
    finishInsert?.({ ok: true, strategy: "test" });
    await flushAsync();

    expect(mocks.clickSend).not.toHaveBeenCalled();
    expect(watcher().expectReply).not.toHaveBeenCalled();
  });

  it("preserves a user draft and fails safely instead of auto-continuing over it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    mocks.composerIsEmpty.mockReturnValue(false);
    const initial = {
      ...streamingState(),
      phase: "developing" as const,
      status: "cooldown" as const,
      cooldownUntil: 90_000,
    };
    const controller = makeController(initial);

    controller.dispatch({ type: "COOLDOWN_ELAPSED" });
    await vi.advanceTimersByTimeAsync(15_000);
    await flushAsync();

    expect(mocks.composerIsEmpty).toHaveBeenCalledTimes(4);
    expect(mocks.insertPrompt).not.toHaveBeenCalled();
    expect(mocks.clickSend).not.toHaveBeenCalled();
    expect(controller.state.status).toBe("error");
    expect(controller.state.errorCode).toBe("composer-insert-failed");
    controller.dispose();
  });
});
