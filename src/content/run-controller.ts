import { log } from "../common/log";
import { parseMarker } from "../common/marker";
import {
  buildContinuePrompt,
  buildDevelopPrompt,
  buildPlanPrompt,
  buildUserReply,
  NUDGE_PROMPT,
} from "../common/prompts";
import type { Effect, MachineEvent } from "../common/state-machine";
import { cooldownRemainingMs, isActive, reduce } from "../common/state-machine";
import { saveRun } from "../common/storage";
import type { BgRequest, RunState, Settings } from "../common/types";
import { clickSend, composerIsEmpty, insertPrompt } from "./composer";
import { scanPageSignals } from "./page-signals";
import { healthCheck } from "./selectors";
import { StreamWatcher } from "./stream-watch";
import { lastAssistantMessage } from "./transcript";

const SIGNAL_POLL_MS = 5000;
const COMPOSER_BUSY_RETRIES = 3;
const COMPOSER_BUSY_WAIT_MS = 5000;

export class RunController {
  state: RunState;
  readonly settings: Settings;
  private readonly watcher: StreamWatcher;
  private cooldownTimer: ReturnType<typeof setTimeout> | undefined;
  private signalTimer: ReturnType<typeof setInterval> | undefined;
  private lastSignal: string | null = null;
  private readonly onChange: (state: RunState) => void;
  private readonly onShowModal: () => void;
  private disposed = false;

  constructor(
    initial: RunState,
    settings: Settings,
    hooks: { onChange: (state: RunState) => void; onShowModal: () => void },
  ) {
    this.state = initial;
    this.settings = settings;
    this.onChange = hooks.onChange;
    this.onShowModal = hooks.onShowModal;
    this.watcher = new StreamWatcher(
      {
        onStart: () => this.dispatch({ type: "STREAM_STARTED" }),
        onComplete: (text) =>
          this.dispatch({ type: "REPLY_COMPLETE", marker: parseMarker(text), text }),
        onStuck: () => this.dispatch({ type: "STREAM_STUCK" }),
      },
      settings,
    );
    this.watcher.start();
    this.signalTimer = setInterval(() => this.pollSignals(), SIGNAL_POLL_MS);
    this.restoreCooldown();
  }

  dispose(): void {
    this.disposed = true;
    this.watcher.stop();
    this.clearCooldownTimer();
    if (this.signalTimer !== undefined) clearInterval(this.signalTimer);
  }

  /** A brand-new chat gets its real /c/<uuid> id after the first reply; adopt it in place. */
  adoptConversationId(conversationId: string): void {
    this.state = { ...this.state, conversationId };
    void saveRun(this.state).catch((err) => log.warn("state save failed", err));
  }

  dispatch(event: MachineEvent): void {
    if (this.disposed) return;
    const previousStatus = this.state.status;
    const { state, effects } = reduce(this.state, event, this.settings);
    if (state === this.state) return;
    this.state = state;
    if (previousStatus === "cooldown" && state.status !== "cooldown") {
      this.clearCooldownTimer();
    }
    void saveRun(state).catch((err) => log.warn("state save failed", err));
    this.onChange(state);
    for (const effect of effects) void this.execute(effect);
  }

  /** Re-derive the machine's position from the live DOM (resume, reload, manual resume). */
  reconcile(): void {
    if (this.state.status === "cooldown") {
      this.restoreCooldown();
      return;
    }
    if (this.watcher.isStreaming()) {
      this.dispatch({ type: "STREAM_STARTED" });
      return;
    }
    const message = lastAssistantMessage();
    if (message) {
      this.dispatch({
        type: "REPLY_COMPLETE",
        marker: parseMarker(message.text),
        text: message.text,
      });
    }
  }

  private pollSignals(): void {
    if (!isActive(this.state) && this.state.status !== "awaiting_user") return;
    const signal = scanPageSignals();
    if (!signal) {
      this.lastSignal = null;
      return;
    }
    if (signal === this.lastSignal) return;
    this.lastSignal = signal;
    this.dispatch({ type: "PAGE_SIGNAL", signal });
  }

  private async execute(effect: Effect): Promise<void> {
    switch (effect.do) {
      case "insertAndSend": {
        await this.insertAndSend(effect.kind, effect.text);
        break;
      }
      case "startCooldown": {
        this.scheduleCooldown(effect.ms);
        break;
      }
      case "notify": {
        if (!this.settings.notificationsEnabled) break;
        this.sendToBackground({ type: "notify", title: effect.title, message: effect.message });
        break;
      }
      case "badge": {
        this.sendToBackground({ type: "badge", text: effect.text });
        break;
      }
      case "showModal": {
        this.onShowModal();
        break;
      }
      case "reconcile": {
        this.reconcile();
        break;
      }
    }
  }

  private restoreCooldown(): void {
    if (this.state.status !== "cooldown" || this.cooldownTimer !== undefined) return;
    this.scheduleCooldown(cooldownRemainingMs(this.state));
  }

  private scheduleCooldown(ms: number): void {
    if (this.cooldownTimer !== undefined || this.disposed) return;
    this.cooldownTimer = setTimeout(
      () => {
        this.cooldownTimer = undefined;
        this.dispatch({ type: "COOLDOWN_ELAPSED" });
      },
      Math.max(0, ms),
    );
  }

  private clearCooldownTimer(): void {
    if (this.cooldownTimer !== undefined) clearTimeout(this.cooldownTimer);
    this.cooldownTimer = undefined;
  }

  private buildPrompt(kind: string, text?: string): string {
    switch (kind) {
      case "plan":
        return buildPlanPrompt({
          idea: this.state.idea,
          repoMode: this.state.repoMode,
          repoName: this.state.repoName,
          templateRepo: this.settings.templateRepo,
        });
      case "develop":
        return buildDevelopPrompt(this.settings);
      case "continue":
        return buildContinuePrompt(this.settings, false);
      case "contract_refresh":
        return buildContinuePrompt(this.settings, true);
      case "nudge":
        return NUDGE_PROMPT;
      case "user_text":
        return buildUserReply(text ?? "");
      default:
        throw new Error(`unknown prompt kind: ${kind}`);
    }
  }

  private async insertAndSend(kind: string, text?: string): Promise<void> {
    const health = healthCheck();
    if (health.missing.length > 0) {
      this.dispatch({
        type: "INSERT_FAIL",
        detail: `page structure changed (missing: ${health.missing.join(", ")})`,
      });
      return;
    }

    // An automated send must never eat a draft the user is typing. Wait briefly for the
    // composer to clear; a user-initiated send replaces the draft deliberately.
    const automated = kind !== "plan" && kind !== "develop" && kind !== "user_text";
    if (automated) {
      let busyChecks = 0;
      while (!composerIsEmpty()) {
        busyChecks += 1;
        if (busyChecks > COMPOSER_BUSY_RETRIES) {
          this.dispatch({ type: "INSERT_FAIL", detail: "the composer has your draft in it" });
          return;
        }
        await sleep(COMPOSER_BUSY_WAIT_MS);
        if (this.disposed) return;
      }
    }

    const prompt = this.buildPrompt(kind, text);
    const inserted = await insertPrompt(prompt);
    if (!inserted.ok) {
      this.dispatch({ type: "INSERT_FAIL", detail: inserted.error ?? "unknown" });
      return;
    }
    this.dispatch({ type: "INSERT_OK" });

    this.watcher.expectReply();
    const sent = await clickSend(() => this.watcher.isStreaming());
    if (!sent.ok) {
      this.watcher.cancelExpectedReply();
      this.dispatch({ type: "SEND_FAIL", detail: sent.error ?? "unknown" });
      return;
    }
    this.dispatch({ type: "SEND_OK" });
  }

  private sendToBackground(message: BgRequest): void {
    void chrome.runtime.sendMessage(message).catch((err) => {
      log.debug("background message failed", err);
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
