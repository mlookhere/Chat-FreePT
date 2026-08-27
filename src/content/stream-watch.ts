import { log } from "../common/log";
import { parseMarker } from "../common/marker";
import type { Settings } from "../common/types";
import { query } from "./selectors";
import { conversationRootEl, lastAssistantMessage, toolCallIndicatorVisible } from "./transcript";

export interface StreamCallbacks {
  onStart: () => void;
  onComplete: (text: string) => void;
  onStuck: () => void;
}

type WatchState = "idle" | "waiting" | "streaming" | "settling";

const TICK_MS = 800;
const MARKER_FAST_PATH_MS = 1200;
const SUSPEND_GAP_MS = TICK_MS * 4;

/**
 * Streaming detection composed from independent signals: an explicit expectation after
 * this extension sends, the stop button, assistant-turn mutations, and settled marker
 * text. No single ChatGPT DOM affordance is trusted as the only source of truth.
 */
export class StreamWatcher {
  private state: WatchState = "idle";
  private lastMutationAt = 0;
  private settleStartedAt = 0;
  private streamStartedAt = 0;
  private lastTickAt = 0;
  private stuckReported = false;
  private replyObserved = false;
  private baselineElement: HTMLElement | null = null;
  private baselineText = "";
  private timer: ReturnType<typeof setInterval> | undefined;
  private observer: MutationObserver | undefined;

  constructor(
    private readonly callbacks: StreamCallbacks,
    private readonly settings: Settings,
  ) {}

  start(): void {
    this.stop();
    this.observer = new MutationObserver(() => {
      this.lastMutationAt = Date.now();
    });
    this.observer.observe(conversationRootEl(), {
      childList: true,
      characterData: true,
      subtree: true,
    });
    this.lastTickAt = Date.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.observer?.disconnect();
    this.observer = undefined;
    this.reset();
  }

  /** Arm before clicking Send so a missing stop button cannot strand the reply lifecycle. */
  expectReply(): void {
    const message = lastAssistantMessage();
    this.baselineElement = message?.el ?? null;
    this.baselineText = message?.text ?? "";
    this.state = "waiting";
    this.streamStartedAt = 0;
    this.lastMutationAt = Date.now();
    this.settleStartedAt = 0;
    this.stuckReported = false;
    this.replyObserved = false;
  }

  /** Sending failed, so the armed reply must not consume a later unrelated assistant turn. */
  cancelExpectedReply(): void {
    this.reset();
  }

  isStreaming(): boolean {
    return query("stopButton") !== null;
  }

  /** Rebase elapsed-time watchdogs after browser/PC suspend so sleep never counts as generation. */
  recoverFromWake(): void {
    const now = Date.now();
    this.recoverTiming(now, this.isStreaming());
    this.lastTickAt = now;
  }

  private tick(): void {
    const now = Date.now();
    const stopVisible = this.isStreaming();
    if (this.lastTickAt > 0 && now - this.lastTickAt > SUSPEND_GAP_MS) {
      this.recoverTiming(now, stopVisible);
      this.lastTickAt = now;
      return;
    }
    this.lastTickAt = now;

    switch (this.state) {
      case "idle":
        this.tickIdle(now, stopVisible);
        break;
      case "waiting":
        this.tickWaiting(now, stopVisible);
        break;
      case "streaming":
        this.tickStreaming(now, stopVisible);
        break;
      case "settling":
        this.tickSettling(now, stopVisible);
        break;
    }
  }

  private tickIdle(now: number, stopVisible: boolean): void {
    if (stopVisible) this.observeReplyStart(now, true);
  }

  private tickWaiting(now: number, stopVisible: boolean): void {
    if (stopVisible || this.assistantTurnChanged()) {
      this.observeReplyStart(now, stopVisible);
    }
  }

  private tickStreaming(now: number, stopVisible: boolean): void {
    this.checkStuck(now);
    if (!stopVisible) this.enterSettling(now);
  }

  private tickSettling(now: number, stopVisible: boolean): void {
    this.checkStuck(now);
    if (stopVisible) {
      this.state = "streaming";
      return;
    }

    const quietSince = Math.max(this.lastMutationAt, this.settleStartedAt);
    const quietFor = now - quietSince;
    const threshold = toolCallIndicatorVisible()
      ? this.settings.toolQuietMs
      : this.settings.quietMs;
    const message = lastAssistantMessage();
    const markerReady =
      quietFor > MARKER_FAST_PATH_MS && message !== null && parseMarker(message.text) !== null;

    if (markerReady || quietFor > threshold) this.complete(message?.text ?? "", markerReady);
  }

  private complete(text: string, markerReady: boolean): void {
    log.debug(`reply complete (${markerReady ? "marker fast-path" : "quiescence"})`);
    this.reset();
    this.callbacks.onComplete(text);
  }

  private assistantTurnChanged(): boolean {
    const message = lastAssistantMessage();
    if (!message) return false;
    if (!this.baselineElement) return true;
    return message.el !== this.baselineElement || message.text !== this.baselineText;
  }

  private observeReplyStart(now: number, stopVisible: boolean): void {
    if (!this.replyObserved) {
      this.replyObserved = true;
      this.streamStartedAt = now;
      this.stuckReported = false;
      this.callbacks.onStart();
    }
    if (stopVisible) {
      this.state = "streaming";
      return;
    }
    this.enterSettling(now);
  }

  private enterSettling(now: number): void {
    this.state = "settling";
    this.settleStartedAt = now;
    this.lastMutationAt = now;
  }

  private recoverTiming(now: number, stopVisible: boolean): void {
    if (this.state === "idle") return;
    log.debug("stream watcher resumed after a timer gap; rebasing elapsed time");
    this.stuckReported = false;
    this.lastMutationAt = now;
    if (this.replyObserved) this.streamStartedAt = now;

    if (this.state === "waiting") return;
    if (stopVisible) {
      this.state = "streaming";
      this.settleStartedAt = 0;
      return;
    }
    this.state = "settling";
    this.settleStartedAt = now;
  }

  private checkStuck(now: number): void {
    if (
      !this.stuckReported &&
      this.replyObserved &&
      this.streamStartedAt > 0 &&
      now - this.streamStartedAt > this.settings.maxStreamMinutes * 60_000
    ) {
      this.stuckReported = true;
      this.callbacks.onStuck();
    }
  }

  private reset(): void {
    this.state = "idle";
    this.lastMutationAt = 0;
    this.settleStartedAt = 0;
    this.streamStartedAt = 0;
    this.lastTickAt = 0;
    this.stuckReported = false;
    this.replyObserved = false;
    this.baselineElement = null;
    this.baselineText = "";
  }
}
