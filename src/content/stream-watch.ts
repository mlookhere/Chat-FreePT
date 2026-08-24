import { parseMarker } from "../common/marker";
import type { Settings } from "../common/types";
import { log } from "../common/log";
import { query } from "./selectors";
import { conversationRootEl, lastAssistantMessage, toolCallIndicatorVisible } from "./transcript";

export interface StreamCallbacks {
  onStart: () => void;
  onComplete: (text: string) => void;
  onStuck: () => void;
}

type WatchState = "idle" | "streaming" | "settling";

const TICK_MS = 800;
const MARKER_FAST_PATH_MS = 1200;

/**
 * Streaming detection composed from three signals, because each alone lies:
 * the stop button (flickers during MCP tool calls), mutation quiescence (pauses during
 * long tool calls), and — strongest for our protocol — a parseable status marker in the
 * settled text.
 */
export class StreamWatcher {
  private state: WatchState = "idle";
  private lastMutationAt = 0;
  private settleStartedAt = 0;
  private streamStartedAt = 0;
  private stuckReported = false;
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
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.observer?.disconnect();
    this.observer = undefined;
    this.state = "idle";
  }

  isStreaming(): boolean {
    return query("stopButton") !== null;
  }

  private tick(): void {
    const now = Date.now();
    const stopVisible = this.isStreaming();

    switch (this.state) {
      case "idle": {
        if (stopVisible) {
          this.state = "streaming";
          this.streamStartedAt = now;
          this.stuckReported = false;
          this.callbacks.onStart();
        }
        break;
      }
      case "streaming": {
        if (
          !this.stuckReported &&
          now - this.streamStartedAt > this.settings.maxStreamMinutes * 60_000
        ) {
          this.stuckReported = true;
          this.callbacks.onStuck();
        }
        if (!stopVisible) {
          this.state = "settling";
          this.settleStartedAt = now;
        }
        break;
      }
      case "settling": {
        if (stopVisible) {
          this.state = "streaming";
          break;
        }
        const quietSince = Math.max(this.lastMutationAt, this.settleStartedAt);
        const quietFor = now - quietSince;
        const threshold = toolCallIndicatorVisible()
          ? this.settings.toolQuietMs
          : this.settings.quietMs;

        const message = lastAssistantMessage();
        const markerReady =
          quietFor > MARKER_FAST_PATH_MS && message !== null && parseMarker(message.text) !== null;

        if (markerReady || quietFor > threshold) {
          this.state = "idle";
          const text = message?.text ?? "";
          log.debug(`reply complete (${markerReady ? "marker fast-path" : "quiescence"})`);
          this.callbacks.onComplete(text);
        }
        break;
      }
    }
  }
}
