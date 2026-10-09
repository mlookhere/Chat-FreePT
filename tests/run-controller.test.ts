import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./chrome-mock";

const mocks = vi.hoisted(() => ({
  insertPrompt: vi.fn(),
  clickSend: vi.fn(),
  composerIsEmpty: vi.fn(),
  healthCheck: vi.fn(),
  queryGuideTarget: vi.fn(),
  scanPageSignals: vi.fn(),
  lastAssistantMessage: vi.fn(),
  lastUserMessageText: vi.fn(),
  lastMessageRole: vi.fn(),
  toolCallIndicatorVisible: vi.fn(),
  saveRun: vi.fn(),
  chatStateListeners: [] as Array<
    (event: {
      version: number;
      event:
        | "generation-start"
        | "generation-complete"
        | "generation-interrupted"
        | "generation-aborted"
        | "stream-status";
      requestId?: string;
      marker?: { status: string; version: number; text: string } | null;
      status?: string;
      reason?: string;
    }) => void
  >,
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
    recoverFromWake: ReturnType<typeof vi.fn>;
    isStreaming: () => boolean;
  }>,
}));

vi.mock("../src/content/chat-state", () => ({
  subscribeChatState: (listener: (typeof mocks.chatStateListeners)[number]) => {
    mocks.chatStateListeners.push(listener);
    return () => {
      const index = mocks.chatStateListeners.indexOf(listener);
      if (index >= 0) mocks.chatStateListeners.splice(index, 1);
    };
  },
}));

vi.mock("../src/content/composer", () => ({
  insertPrompt: mocks.insertPrompt,
  clickSend: mocks.clickSend,
  composerIsEmpty: mocks.composerIsEmpty,
}));

vi.mock("../src/content/selectors", () => ({
  healthCheck: mocks.healthCheck,
  queryGuideTarget: mocks.queryGuideTarget,
}));

vi.mock("../src/content/page-signals", () => ({
  scanPageSignals: mocks.scanPageSignals,
}));

vi.mock("../src/common/storage", () => ({
  saveRun: mocks.saveRun,
}));

vi.mock("../src/content/transcript", () => ({
  lastAssistantMessage: mocks.lastAssistantMessage,
  lastMessageRole: mocks.lastMessageRole,
  lastUserMessageText: mocks.lastUserMessageText,
  toolCallIndicatorVisible: mocks.toolCallIndicatorVisible,
}));

vi.mock("../src/content/stream-watch", () => ({
  StreamWatcher: class {
    readonly callbacks: (typeof mocks.watchers)[number]["callbacks"];
    streaming = false;
    start = vi.fn();
    stop = vi.fn();
    expectReply = vi.fn();
    cancelExpectedReply = vi.fn();
    recoverFromWake = vi.fn();

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
    { type: "USER_START", idea: "build it", repoMode: "existing", repoName: "owner/project" },
    settings,
  ).state;
  state = reduce(state, { type: "INSERT_OK" }, settings).state;
  return reduce(state, { type: "SEND_OK" }, settings).state;
}

function makeController(initial = newRunState("c1", Date.now())): Controller {
  return new RunController(initial, settings, {
    onChange: vi.fn(),
    onShowCompletion: vi.fn(),
  });
}

function makeAccessTraceController(trace: string[]): Controller {
  mocks.healthCheck.mockImplementation(() => {
    trace.push("health");
    return { missing: [], degraded: [] };
  });
  mocks.insertPrompt.mockImplementation(async () => {
    trace.push("insert");
    return { ok: true, strategy: "test" };
  });
  mocks.clickSend.mockImplementation(async () => {
    trace.push("send");
    return { ok: true };
  });
  return new RunController(newRunState("c1", Date.now()), settings, {
    onChange: vi.fn(),
    onShowCompletion: vi.fn(),
    withComposerAccess: async (task) => {
      trace.push("unlock");
      try {
        await task();
      } finally {
        trace.push("lock");
      }
    },
  });
}

function emitChatState(event: Parameters<(typeof mocks.chatStateListeners)[number]>[0]): void {
  for (const listener of [...mocks.chatStateListeners]) listener(event);
}

function watcher(): (typeof mocks.watchers)[number] {
  const current = mocks.watchers.at(-1);
  if (!current) throw new Error("watcher was not constructed");
  return current;
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

beforeEach(() => {
  installChromeMock();
  mocks.insertPrompt.mockReset().mockResolvedValue({ ok: true, strategy: "test" });
  mocks.clickSend.mockReset().mockResolvedValue({ ok: true });
  mocks.composerIsEmpty.mockReset().mockReturnValue(true);
  mocks.healthCheck.mockReset().mockReturnValue({ missing: [], degraded: [] });
  mocks.queryGuideTarget.mockReset().mockReturnValue(null);
  mocks.scanPageSignals.mockReset().mockReturnValue(null);
  mocks.lastAssistantMessage.mockReset().mockReturnValue(null);
  mocks.lastUserMessageText.mockReset().mockReturnValue(null);
  mocks.lastMessageRole.mockReset().mockReturnValue(null);
  mocks.toolCallIndicatorVisible.mockReset().mockReturnValue(false);
  mocks.saveRun.mockReset().mockResolvedValue(undefined);
  mocks.watchers.length = 0;
  mocks.chatStateListeners.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RunController state persistence", () => {
  it("serializes writes and flushes the final repository snapshot", async () => {
    const savedRepos: string[] = [];
    const resolvers: Array<() => void> = [];
    mocks.saveRun.mockImplementation(
      (state: { repoName: string }) =>
        new Promise<void>((resolve) => {
          savedRepos.push(state.repoName);
          resolvers.push(resolve);
        }),
    );

    const controller = makeController();
    controller.dispatch({
      type: "USER_UPDATE_DRAFT",
      repoName: "owner/first",
      idea: "first",
    });
    controller.dispatch({
      type: "USER_UPDATE_DRAFT",
      repoName: "owner/latest",
      idea: "latest",
    });
    await flushAsync();

    expect(savedRepos).toEqual(["owner/first"]);

    resolvers.shift()?.();
    await flushAsync();
    expect(savedRepos).toEqual(["owner/first", "owner/latest"]);

    const flush = controller.flushState();
    resolvers.shift()?.();
    await flushAsync();
    expect(savedRepos).toEqual(["owner/first", "owner/latest", "owner/latest"]);

    resolvers.shift()?.();
    await flush;
    controller.dispose();
  });
});

describe("RunController sends and continuation controls", () => {
  it("drives a plan prompt through insert and confirmed send", async () => {
    const controller = makeController();

    controller.dispatch({
      type: "USER_START",
      idea: "build a compact extension",
      repoMode: "existing",
      repoName: "owner/freept-test",
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

  it("keeps a pending continuation active when a legacy off event arrives", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(15_000);
    const controller = makeController(streamingState());

    watcher().callbacks.onComplete("CHATFREEPT_STATUS: Continue\nV: 1");
    expect(controller.state.status).toBe("cooldown");

    controller.dispatch({ type: "USER_SET_AUTO_CONTINUE", enabled: false });
    expect(controller.state.status).toBe("cooldown");

    await vi.advanceTimersByTimeAsync(100);
    await flushAsync();
    expect(mocks.insertPrompt).toHaveBeenCalledTimes(1);
    expect(mocks.clickSend).toHaveBeenCalledTimes(1);
    expect(controller.state.status).toBe("streaming");
    controller.dispose();
  });

  it("pause and stop suppress a pending automatic send immediately", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(16_000);
    const paused = makeController(streamingState());

    watcher().callbacks.onComplete("CHATFREEPT_STATUS: CONTINUE\nV: 1");
    expect(paused.state.status).toBe("cooldown");
    paused.dispatch({ type: "USER_PAUSE" });
    expect(paused.state.status).toBe("paused");

    await vi.advanceTimersByTimeAsync(500);
    await flushAsync();
    expect(mocks.insertPrompt).not.toHaveBeenCalled();
    expect(mocks.clickSend).not.toHaveBeenCalled();
    paused.dispose();

    mocks.insertPrompt.mockClear();
    mocks.clickSend.mockClear();
    const stopped = makeController(streamingState());
    watcher().callbacks.onComplete("CHATFREEPT_STATUS: CONTINUE\nV: 1");
    stopped.dispatch({ type: "USER_STOP" });
    expect(stopped.state.status).toBe("idle");

    await vi.advanceTimersByTimeAsync(500);
    await flushAsync();
    expect(mocks.insertPrompt).not.toHaveBeenCalled();
    expect(mocks.clickSend).not.toHaveBeenCalled();
    stopped.dispose();
  });

  it("sends queued user text once before continuous follow-up", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(17_000);
    const controller = makeController(streamingState());

    controller.dispatch({ type: "USER_QUEUE_NEXT", text: "Run the accessibility audit next." });
    watcher().callbacks.onComplete("CHATFREEPT_STATUS: CONTINUE\nV: 1");
    expect(controller.state.status).toBe("cooldown");

    await vi.advanceTimersByTimeAsync(100);
    await flushAsync();

    expect(String(mocks.insertPrompt.mock.calls[0]?.[0])).toContain(
      "Run the accessibility audit next.",
    );
    expect(mocks.clickSend).toHaveBeenCalledTimes(1);
    expect(controller.state.autoSends).toBe(0);
    expect(controller.state.queuedUserText).toBeUndefined();
    expect(controller.state.queuedUserTexts).toBeUndefined();
    expect(controller.state.status).toBe("streaming");
    controller.dispose();
  });
});

describe("RunController queued draft safety", () => {
  it("does not overwrite a draft that appeared after a message was queued", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(18_000);
    mocks.composerIsEmpty.mockReturnValue(false);
    const controller = makeController(streamingState());

    controller.dispatch({ type: "USER_QUEUE_NEXT", text: "Run the queued check." });
    watcher().callbacks.onComplete("CHATFREEPT_STATUS: CONTINUE\nV: 1");
    expect(controller.state.status).toBe("cooldown");

    await vi.advanceTimersByTimeAsync(15_100);
    await flushAsync();

    expect(mocks.composerIsEmpty).toHaveBeenCalledTimes(4);
    expect(mocks.insertPrompt).not.toHaveBeenCalled();
    expect(mocks.clickSend).not.toHaveBeenCalled();
    expect(controller.state.status).toBe("error");
    expect(controller.state.errorCode).toBe("composer-insert-failed");
    controller.dispose();
  });
});

describe("RunController native composer access", () => {
  it("unlocks the native composer before health checks and re-locks after send", async () => {
    const trace: string[] = [];
    const controller = makeAccessTraceController(trace);

    controller.dispatch({
      type: "USER_START",
      idea: "build it",
      repoMode: "existing",
      repoName: "owner/project",
    });
    await flushAsync();

    expect(trace).toEqual(["unlock", "health", "insert", "send", "lock"]);
    expect(controller.state.status).toBe("streaming");
    controller.dispose();
  });
});

describe("RunController recovery and disposal", () => {
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

  it("waits for a temporarily missing composer to restore before failing the send", async () => {
    vi.useFakeTimers();
    mocks.healthCheck
      .mockReturnValueOnce({ missing: ["composer"], degraded: [] })
      .mockReturnValueOnce({ missing: [], degraded: [] });
    const controller = makeController();

    controller.dispatch({
      type: "USER_START",
      idea: "build it",
      repoMode: "existing",
      repoName: "owner/project",
    });
    await flushAsync();
    expect(mocks.insertPrompt).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    await flushAsync();

    expect(mocks.healthCheck).toHaveBeenCalledTimes(2);
    expect(mocks.insertPrompt).toHaveBeenCalledTimes(1);
    expect(mocks.clickSend).toHaveBeenCalledTimes(1);
    expect(controller.state.status).toBe("streaming");
    controller.dispose();
  });

  it("rebases the watcher and reconciles the live reply when the page resumes", () => {
    const controller = makeController(streamingState());
    mocks.lastMessageRole.mockReturnValue("assistant");
    mocks.lastAssistantMessage.mockReturnValue({
      el: document.createElement("div"),
      text: "Done.\nCHATFREEPT_STATUS: CONTINUE\nV: 1",
      key: "message:wake-reply",
    });

    window.dispatchEvent(new Event("pageshow"));

    expect(watcher().recoverFromWake).toHaveBeenCalledTimes(1);
    expect(controller.state.status).toBe("cooldown");
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

    controller.dispatch({
      type: "USER_START",
      idea: "build it",
      repoMode: "existing",
      repoName: "owner/project",
    });
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

describe("RunController network lifecycle", () => {
  it("uses network completion with a marker even when transcript selectors see nothing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(35_000);
    const controller = makeController(streamingState());

    emitChatState({
      version: 1,
      event: "generation-complete",
      requestId: "turn-1",
      marker: {
        status: "CONTINUE",
        version: 1,
        text: "CHATFREEPT_STATUS: CONTINUE\nV: 1",
      },
    });

    expect(controller.state.status).toBe("cooldown");
    expect(controller.state.lastProcessedAssistantKey).toBe("network:turn-1");
    expect(controller.state.lastLifecycleSignal).toBe("generation-complete");
    controller.dispose();
  });
});

describe("RunController permission recovery", () => {
  it("clicks the GitHub MCP permission Continue control instead of pausing", () => {
    const controller = makeController(streamingState());
    const button = document.createElement("button");
    button.textContent = "Continue";
    const click = vi.spyOn(button, "click");
    mocks.queryGuideTarget.mockImplementation((id: string) =>
      id === "githubPermissionContinueButton" ? button : null,
    );

    emitChatState({
      version: 1,
      event: "generation-interrupted",
      requestId: "turn-permission",
      reason: "stop_conversation",
    });

    expect(click).toHaveBeenCalledTimes(1);
    expect(controller.state.status).toBe("streaming");
    expect(controller.state.lastLifecycleSignal).toBe("permission-continued");
    controller.dispose();
  });

  it("recovers a just-paused interruption when the GitHub permission control appears later", async () => {
    vi.useFakeTimers();
    const controller = makeController(streamingState());

    emitChatState({
      version: 1,
      event: "generation-interrupted",
      requestId: "turn-permission-delayed",
      reason: "stop_conversation",
    });
    expect(controller.state.status).toBe("paused");

    const button = document.createElement("button");
    button.textContent = "Continue";
    const click = vi.spyOn(button, "click");
    mocks.queryGuideTarget.mockImplementation((id: string) =>
      id === "githubPermissionContinueButton" ? button : null,
    );

    await vi.advanceTimersByTimeAsync(2_000);
    expect(click).toHaveBeenCalledTimes(1);
    expect(controller.state.status).toBe("streaming");
    expect(controller.state.lastLifecycleSignal).toBe("permission-continued");
    controller.dispose();
  });

  it("recovers when the user handles the permission prompt before the heartbeat", () => {
    const controller = makeController(streamingState());

    emitChatState({
      version: 1,
      event: "generation-interrupted",
      requestId: "turn-user-permission",
      reason: "stop_conversation",
    });
    expect(controller.state.status).toBe("paused");

    emitChatState({
      version: 1,
      event: "generation-start",
      requestId: "turn-user-permission-resumed",
    });

    expect(controller.state.status).toBe("streaming");
    expect(controller.state.lastLifecycleSignal).toBe("generation-start");
    controller.dispose();
  });

  it("captures the latest visible user message when manually resuming", () => {
    let state = streamingState();
    state = reduce(
      state,
      { type: "STREAM_INTERRUPTED", reason: "Generation stopped in ChatGPT" },
      settings,
    ).state;
    const controller = makeController(state);
    mocks.lastUserMessageText.mockReturnValue("I approved the GitHub prompt");

    controller.dispatch({ type: "USER_RESUME" });

    expect(controller.state.lastUserText).toBe("I approved the GitHub prompt");
    expect(controller.state.status).toBe("cooldown");
    expect(controller.state.lastLifecycleSignal).toBe("interruption-resumed");
    controller.dispose();
  });
});

describe("RunController interrupted network lifecycle", () => {
  it("treats ChatGPT stop_conversation as a transient pause and automatically continues", async () => {
    vi.useFakeTimers();
    const controller = makeController(streamingState());

    emitChatState({
      version: 1,
      event: "generation-interrupted",
      requestId: "turn-stop",
      reason: "stop_conversation",
    });

    expect(controller.state.status).toBe("paused");
    expect(controller.state.pauseReason).toContain("stopped");
    expect(controller.state.lastLifecycleSignal).toBe("generation-interrupted");

    await vi.advanceTimersByTimeAsync(2_600);
    await flushAsync();

    expect(mocks.insertPrompt).toHaveBeenCalledTimes(1);
    expect(mocks.clickSend).toHaveBeenCalledTimes(1);
    expect(controller.state.status).toBe("streaming");
    controller.dispose();
  });

  it("uses COMPLETE stream_status only as a delayed missing-marker fallback", async () => {
    vi.useFakeTimers();
    const controller = makeController(streamingState());

    emitChatState({
      version: 1,
      event: "stream-status",
      requestId: "status-1",
      status: "COMPLETE",
    });
    expect(controller.state.status).toBe("streaming");

    await vi.advanceTimersByTimeAsync(1_500);
    await flushAsync();

    expect(controller.state.nudges).toBe(1);
    expect(mocks.insertPrompt).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
});

describe("RunController manual network lifecycle", () => {
  it("resumes a manual user turn from awaiting_user using the network start signal", () => {
    let state = streamingState();
    state = reduce(
      state,
      {
        type: "REPLY_COMPLETE",
        marker: { status: "NEEDS_INPUT", version: 1, raw: "NEEDS_INPUT" },
        text: "",
      },
      settings,
    ).state;
    const controller = makeController(state);
    expect(controller.state.status).toBe("awaiting_user");

    emitChatState({ version: 1, event: "generation-start", requestId: "manual-1" });
    expect(controller.state.status).toBe("streaming");

    emitChatState({
      version: 1,
      event: "generation-complete",
      requestId: "manual-1",
      marker: {
        status: "CONTINUE",
        version: 1,
        text: "CHATFREEPT_STATUS: CONTINUE\nV: 1",
      },
    });
    expect(controller.state.status).toBe("cooldown");
    controller.dispose();
  });

  it("cancels a pending cooldown when a user edits or sends a manual turn", () => {
    vi.useFakeTimers();
    const controller = makeController(streamingState());
    watcher().callbacks.onComplete("CHATFREEPT_STATUS: CONTINUE\nV: 1");
    expect(controller.state.status).toBe("cooldown");

    emitChatState({ version: 1, event: "generation-start", requestId: "edit-1" });
    expect(controller.state.status).toBe("streaming");
    expect(controller.state.cooldownUntil).toBeUndefined();
    controller.dispose();
  });

  it("pauses on an aborted turn even without a preceding stop request", () => {
    const controller = makeController(streamingState());
    emitChatState({
      version: 1,
      event: "generation-aborted",
      requestId: "turn-abort",
      reason: "AbortError",
    });
    expect(controller.state.status).toBe("paused");
    expect(controller.state.nudges).toBe(0);
    controller.dispose();
  });

  it("ignores a later aborted clone after an explicit stop", () => {
    const controller = makeController(streamingState());

    emitChatState({
      version: 1,
      event: "generation-interrupted",
      requestId: "turn-2",
      reason: "stop_conversation",
    });
    emitChatState({
      version: 1,
      event: "generation-aborted",
      requestId: "turn-2",
      reason: "AbortError",
    });

    expect(controller.state.status).toBe("paused");
    expect(controller.state.nudges).toBe(0);
    controller.dispose();
  });
});

describe("RunController runtime reconciliation", () => {
  it("self-heals a missed completion event and auto-continues from the live marker", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(40_000);
    const controller = makeController(streamingState());
    mocks.lastMessageRole.mockReturnValue("assistant");
    mocks.lastAssistantMessage.mockReturnValue({
      el: document.createElement("div"),
      text: "Finished.\nCHATFREEPT_STATUS: CONTINUE\nV: 1",
      key: "message:new-reply",
    });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(controller.state.status).toBe("cooldown");

    await vi.advanceTimersByTimeAsync(100);
    await flushAsync();

    expect(mocks.insertPrompt).toHaveBeenCalledTimes(1);
    expect(mocks.clickSend).toHaveBeenCalledTimes(1);
    expect(controller.state.autoSends).toBe(1);
    controller.dispose();
  });

  it("never consumes the pre-send assistant turn as the expected reply", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(45_000);
    const initial = {
      ...streamingState(),
      replyBaselineAssistantKey: "message:old-reply",
    };
    const controller = makeController(initial);
    mocks.lastMessageRole.mockReturnValue("assistant");
    mocks.lastAssistantMessage.mockReturnValue({
      el: document.createElement("div"),
      text: "Old.\nCHATFREEPT_STATUS: CONTINUE\nV: 1",
      key: "message:old-reply",
    });

    await vi.advanceTimersByTimeAsync(6_000);
    await flushAsync();

    expect(controller.state.status).toBe("streaming");
    expect(mocks.insertPrompt).not.toHaveBeenCalled();
    expect(mocks.clickSend).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("settles a fresh marker-less reply through the existing recovery nudge path", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
    const controller = makeController(streamingState());
    mocks.lastMessageRole.mockReturnValue("assistant");
    mocks.lastAssistantMessage.mockReturnValue({
      el: document.createElement("div"),
      text: "I finished, but forgot the protocol footer.",
      key: "message:no-marker",
    });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(controller.state.status).toBe("streaming");

    await vi.advanceTimersByTimeAsync(2_000);
    await flushAsync();

    expect(controller.state.nudges).toBe(1);
    expect(mocks.insertPrompt).toHaveBeenCalledTimes(1);
    expect(mocks.clickSend).toHaveBeenCalledTimes(1);
    expect(controller.state.status).toBe("streaming");
    controller.dispose();
  });

  it("repairs an expired persisted cooldown immediately", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(60_000);
    const initial = {
      ...streamingState(),
      phase: "developing" as const,
      status: "cooldown" as const,
      cooldownUntil: 59_000,
    };

    const controller = makeController(initial);
    await flushAsync();

    expect(mocks.insertPrompt).toHaveBeenCalledTimes(1);
    expect(mocks.clickSend).toHaveBeenCalledTimes(1);
    expect(controller.state.autoSends).toBe(1);
    expect(controller.state.status).toBe("streaming");
    controller.dispose();
  });
});

describe("RunController interrupted reload recovery", () => {
  function staleInterruptedState(queued = true): ReturnType<typeof newRunState> {
    let state = streamingState();
    if (queued) {
      state = reduce(
        state,
        { type: "USER_QUEUE_NEXT", text: "make the transition seamless" },
        settings,
      ).state;
    }
    state = reduce(
      state,
      { type: "STREAM_INTERRUPTED", reason: "Generation stopped in ChatGPT" },
      settings,
    ).state;
    return { ...state, status: "streaming" };
  }

  it("sends the queued message once after reloading a phantom stream", async () => {
    vi.useFakeTimers();
    const controller = makeController(staleInterruptedState());

    await vi.advanceTimersByTimeAsync(2_600);
    await flushAsync();

    expect(String(mocks.insertPrompt.mock.calls[0]?.[0])).toContain("make the transition seamless");
    expect(mocks.clickSend).toHaveBeenCalledTimes(1);
    expect(controller.state.queuedUserTexts).toBeUndefined();
    expect(controller.state.status).toBe("streaming");

    await vi.advanceTimersByTimeAsync(3_000);
    await flushAsync();
    expect(mocks.clickSend).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("does not recover over a real active generation", async () => {
    vi.useFakeTimers();
    const controller = makeController(staleInterruptedState());
    watcher().streaming = true;

    await vi.advanceTimersByTimeAsync(3_000);
    await flushAsync();

    expect(mocks.insertPrompt).not.toHaveBeenCalled();
    expect(mocks.clickSend).not.toHaveBeenCalled();
    expect(controller.state.lastLifecycleSignal).toBe("generation-start");
    controller.dispose();
  });

  it("lets a fresh assistant marker win over reload recovery", async () => {
    vi.useFakeTimers();
    mocks.lastMessageRole.mockReturnValue("assistant");
    mocks.lastAssistantMessage.mockReturnValue({
      el: document.createElement("div"),
      text: "Need a choice.\nCHATFREEPT_STATUS: NEEDS_INPUT\nV: 1",
      key: "message:fresh-after-reload",
    });
    const controller = makeController(staleInterruptedState());

    await vi.advanceTimersByTimeAsync(3_000);
    await flushAsync();

    expect(controller.state.status).toBe("awaiting_user");
    expect(controller.state.lastMarker?.status).toBe("NEEDS_INPUT");
    expect(mocks.insertPrompt).not.toHaveBeenCalled();
    expect(mocks.clickSend).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("falls back to normal auto-continue when no queued message exists", async () => {
    vi.useFakeTimers();
    const controller = makeController(staleInterruptedState(false));

    await vi.advanceTimersByTimeAsync(2_600);
    await flushAsync();

    expect(mocks.insertPrompt).toHaveBeenCalledTimes(1);
    expect(mocks.clickSend).toHaveBeenCalledTimes(1);
    expect(controller.state.autoSends).toBe(1);
    controller.dispose();
  });
});

describe("RunController max-length interruption handoff", () => {
  it("detects the full-chat alert while interrupted rather than auto-resuming", async () => {
    vi.useFakeTimers();
    const handoff = vi.fn();
    const interrupted = reduce(
      streamingState(),
      { type: "STREAM_INTERRUPTED", reason: "Generation stopped in ChatGPT" },
      settings,
    ).state;
    mocks.scanPageSignals.mockReturnValue("conversation-full");
    const controller = new RunController(interrupted, settings, {
      onChange: vi.fn(),
      onShowCompletion: vi.fn(),
      onConversationHandoff: handoff,
    });

    await vi.advanceTimersByTimeAsync(2_100);
    await flushAsync();

    expect(handoff).toHaveBeenCalledTimes(1);
    expect(controller.state.handoffStarted).toBe(true);
    expect(controller.state.status).toBe("paused");
    expect(mocks.insertPrompt).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    await flushAsync();
    expect(handoff).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("never rolls over from a deliberate user pause", async () => {
    vi.useFakeTimers();
    const handoff = vi.fn();
    const paused = reduce(streamingState(), { type: "USER_PAUSE" }, settings).state;
    mocks.scanPageSignals.mockReturnValue("conversation-full");
    const controller = new RunController(paused, settings, {
      onChange: vi.fn(),
      onShowCompletion: vi.fn(),
      onConversationHandoff: handoff,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await flushAsync();
    expect(handoff).not.toHaveBeenCalled();
    expect(controller.state.status).toBe("paused");
    controller.dispose();
  });
});

describe("RunController stale stream isolation", () => {
  it("keeps NEEDS_INPUT stable when stale start and stuck signals arrive", () => {
    const controller = makeController(streamingState());

    watcher().callbacks.onComplete("CHATFREEPT_STATUS: NEEDS_INPUT\nNOTE: wait for approval");
    expect(controller.state.status).toBe("awaiting_user");

    watcher().callbacks.onStart();
    watcher().callbacks.onStuck();

    expect(controller.state.status).toBe("awaiting_user");
    expect(controller.state.errorCode).toBeUndefined();
    controller.dispose();
  });

  it("keeps Testing stable when stale watcher signals arrive", () => {
    const controller = makeController(streamingState());

    watcher().callbacks.onComplete(
      "CHATFREEPT_STATUS: Testing\nNOTE: verify the extension in Chrome",
    );
    expect(controller.state.status).toBe("awaiting_user");
    expect(controller.state.phase).toBe("testing");

    watcher().callbacks.onStart();
    watcher().callbacks.onStuck();

    expect(controller.state.status).toBe("awaiting_user");
    expect(controller.state.phase).toBe("testing");
    expect(controller.state.errorCode).toBeUndefined();
    controller.dispose();
  });
});
