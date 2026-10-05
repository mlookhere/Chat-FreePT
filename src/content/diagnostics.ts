import { parseMarker } from "../common/marker";
import type { Effect, MachineEvent } from "../common/state-machine";
import type { Marker, RunState } from "../common/types";
import {
  hashText,
  redactUrl,
  safeError,
  summarizeString,
  summarizeUnknown,
} from "../diagnostics/sanitize";
import { healthCheck, queryAll, resolve, type TargetId } from "./selectors";
import { lastAssistantMessage, lastMessageRole, toolCallIndicatorVisible } from "./transcript";

const CONTENT_SOURCE = "cfpt-diagnostics-content";
const BRIDGE_SOURCE = "cfpt-diagnostics-bridge";
const SNAPSHOT_MS = 1000;
const SNAPSHOT_HEARTBEAT_MS = 10000;
const DOM_SETTLE_MS = 80;
const MAX_RECORDS = 30000;
const TRIM_BATCH = 2000;
const PAGE_SCRIPT_ID = "cfpt-diagnostics-page-bridge";

export interface DiagnosticsStatus {
  recording: boolean;
  records: number;
  dropped: number;
  startedAt?: string;
}

export interface ControllerDiagnosticEvent {
  kind: string;
  event?: MachineEvent;
  effect?: Effect;
  detail?: Record<string, unknown>;
}

interface DiagnosticRecord {
  seq: number;
  time: string;
  elapsedMs: number;
  type: string;
  [key: string]: unknown;
}

interface DiagnosticsExport {
  version: 1;
  product: "Chat FreePT";
  kind: "state-diagnostics";
  sessionId: string;
  startedAt: string;
  exportedAt: string;
  summary: Record<string, unknown>;
  records: DiagnosticRecord[];
}

interface RecorderHooks {
  getRunState: () => RunState | null;
  onStatus?: (status: DiagnosticsStatus) => void;
}

export class DiagnosticsRecorder {
  private readonly sessionId = crypto.randomUUID();
  private readonly channel = crypto.randomUUID();
  private records: DiagnosticRecord[] = [];
  private active = false;
  private startedAtMs = 0;
  private dropped = 0;
  private seq = 0;
  private snapshotTimer: ReturnType<typeof setInterval> | undefined;
  private domTimer: ReturnType<typeof setTimeout> | undefined;
  private observer: MutationObserver | null = null;
  private lastSnapshotHash = "";
  private lastSnapshotAt = 0;
  private readonly pageMessage = (event: MessageEvent): void => this.onPageMessage(event);
  private readonly uiEvent = (event: Event): void => this.onUiEvent(event);
  private readonly visibilityEvent = (): void =>
    this.record("lifecycle", { event: "visibilitychange", visibility: document.visibilityState });
  private readonly focusEvent = (): void =>
    this.record("lifecycle", { event: "focus", hasFocus: document.hasFocus() });
  private readonly blurEvent = (): void =>
    this.record("lifecycle", { event: "blur", hasFocus: document.hasFocus() });
  private readonly onlineEvent = (): void =>
    this.record("lifecycle", { event: "online", online: navigator.onLine });
  private readonly offlineEvent = (): void =>
    this.record("lifecycle", { event: "offline", online: navigator.onLine });
  private readonly pageShowEvent = (event: PageTransitionEvent): void =>
    this.record("lifecycle", { event: "pageshow", persisted: event.persisted });
  private readonly pageHideEvent = (event: PageTransitionEvent): void =>
    this.record("lifecycle", { event: "pagehide", persisted: event.persisted });
  private readonly popStateEvent = (): void =>
    this.record("navigation", { event: "popstate", route: redactUrl(location.href) });
  private readonly hashChangeEvent = (): void =>
    this.record("navigation", { event: "hashchange", route: redactUrl(location.href) });
  private readonly errorEvent = (event: ErrorEvent): void =>
    this.record("error", {
      event: "window-error",
      filename: event.filename ? redactUrl(event.filename) : undefined,
      line: event.lineno,
      column: event.colno,
      error: safeError(event.error ?? event.message),
    });
  private readonly rejectionEvent = (event: PromiseRejectionEvent): void =>
    this.record("error", { event: "unhandled-rejection", error: safeError(event.reason) });
  private readonly storageChanged = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => this.onStorageChange(changes, areaName);

  constructor(private readonly hooks: RecorderHooks) {}

  get status(): DiagnosticsStatus {
    const status: DiagnosticsStatus = {
      recording: this.active,
      records: this.records.length,
      dropped: this.dropped,
    };
    if (this.startedAtMs > 0) status.startedAt = new Date(this.startedAtMs).toISOString();
    return status;
  }

  start(): void {
    if (this.active) return;
    this.records = [];
    this.dropped = 0;
    this.seq = 0;
    this.startedAtMs = Date.now();
    this.lastSnapshotHash = "";
    this.lastSnapshotAt = 0;
    this.active = true;
    this.installListeners();
    this.injectPageBridge();
    this.record("session", {
      event: "start",
      route: redactUrl(location.href),
      userAgent: summarizeString(navigator.userAgent),
    });
    this.captureSnapshot("start", true);
    this.snapshotTimer = setInterval(() => this.captureSnapshot("poll"), SNAPSHOT_MS);
    this.notifyStatus();
  }

  stop(): void {
    if (!this.active) return;
    this.captureSnapshot("stop", true);
    this.record("session", { event: "stop" });
    this.active = false;
    this.uninstallListeners();
    this.postBridgeControl("stop");
    this.notifyStatus();
  }

  dispose(): void {
    if (this.active) this.stop();
    if (this.snapshotTimer !== undefined) clearInterval(this.snapshotTimer);
    this.snapshotTimer = undefined;
    if (this.domTimer !== undefined) clearTimeout(this.domTimer);
    this.domTimer = undefined;
  }

  exportFile(): void {
    const payload = this.buildExport();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `chat-freept-diagnostics-${safeTimestamp(payload.exportedAt)}.json`;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  buildExport(): DiagnosticsExport {
    if (this.active) this.captureSnapshot("export", true);
    const exportedAt = new Date().toISOString();
    return {
      version: 1,
      product: "Chat FreePT",
      kind: "state-diagnostics",
      sessionId: this.sessionId,
      startedAt: new Date(this.startedAtMs || Date.now()).toISOString(),
      exportedAt,
      summary: this.buildSummary(exportedAt),
      records: [...this.records],
    };
  }

  recordControllerEvent(event: ControllerDiagnosticEvent): void {
    if (!this.active) return;
    this.record("extension", sanitizeControllerEvent(event));
    if (event.kind === "state-transition") this.captureSnapshot("state-transition", true);
  }

  captureSnapshot(reason: string, force = false): void {
    if (!this.active) return;
    const snapshot = buildSemanticSnapshot(this.hooks.getRunState());
    const fingerprint = hashText(JSON.stringify(snapshot));
    const now = Date.now();
    const heartbeatDue = now - this.lastSnapshotAt >= SNAPSHOT_HEARTBEAT_MS;
    if (!force && fingerprint === this.lastSnapshotHash && !heartbeatDue) return;
    this.lastSnapshotHash = fingerprint;
    this.lastSnapshotAt = now;
    this.record("snapshot", { reason, fingerprint, state: snapshot });
  }

  private installListeners(): void {
    window.addEventListener("message", this.pageMessage);
    document.addEventListener("click", this.uiEvent, true);
    document.addEventListener("change", this.uiEvent, true);
    document.addEventListener("input", this.uiEvent, true);
    document.addEventListener("submit", this.uiEvent, true);
    document.addEventListener("keydown", this.uiEvent, true);
    document.addEventListener("visibilitychange", this.visibilityEvent);
    window.addEventListener("focus", this.focusEvent);
    window.addEventListener("blur", this.blurEvent);
    window.addEventListener("online", this.onlineEvent);
    window.addEventListener("offline", this.offlineEvent);
    window.addEventListener("pageshow", this.pageShowEvent);
    window.addEventListener("pagehide", this.pageHideEvent);
    window.addEventListener("popstate", this.popStateEvent);
    window.addEventListener("hashchange", this.hashChangeEvent);
    window.addEventListener("error", this.errorEvent);
    window.addEventListener("unhandledrejection", this.rejectionEvent);
    chrome.storage.onChanged?.addListener(this.storageChanged);
    this.installMutationObserver();
  }

  private uninstallListeners(): void {
    window.removeEventListener("message", this.pageMessage);
    document.removeEventListener("click", this.uiEvent, true);
    document.removeEventListener("change", this.uiEvent, true);
    document.removeEventListener("input", this.uiEvent, true);
    document.removeEventListener("submit", this.uiEvent, true);
    document.removeEventListener("keydown", this.uiEvent, true);
    document.removeEventListener("visibilitychange", this.visibilityEvent);
    window.removeEventListener("focus", this.focusEvent);
    window.removeEventListener("blur", this.blurEvent);
    window.removeEventListener("online", this.onlineEvent);
    window.removeEventListener("offline", this.offlineEvent);
    window.removeEventListener("pageshow", this.pageShowEvent);
    window.removeEventListener("pagehide", this.pageHideEvent);
    window.removeEventListener("popstate", this.popStateEvent);
    window.removeEventListener("hashchange", this.hashChangeEvent);
    window.removeEventListener("error", this.errorEvent);
    window.removeEventListener("unhandledrejection", this.rejectionEvent);
    chrome.storage.onChanged?.removeListener(this.storageChanged);
    this.observer?.disconnect();
    this.observer = null;
    if (this.snapshotTimer !== undefined) clearInterval(this.snapshotTimer);
    this.snapshotTimer = undefined;
    if (this.domTimer !== undefined) clearTimeout(this.domTimer);
    this.domTimer = undefined;
  }

  private installMutationObserver(): void {
    this.observer = new MutationObserver((mutations) => {
      this.record("dom", summarizeMutations(mutations));
      if (this.domTimer !== undefined) clearTimeout(this.domTimer);
      this.domTimer = setTimeout(() => this.captureSnapshot("dom-settled"), DOM_SETTLE_MS);
    });
    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
  }

  private onUiEvent(event: Event): void {
    const target = event.target instanceof Element ? event.target : null;
    const payload: Record<string, unknown> = {
      event: event.type,
      target: describeElement(target),
    };
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      payload["input"] = {
        type: target.type || target.tagName.toLowerCase(),
        length: target.value.length,
        checked: "checked" in target ? target.checked : undefined,
      };
    } else if (target instanceof HTMLSelectElement) {
      payload["input"] = { type: "select", selectedIndex: target.selectedIndex };
    }
    if (event instanceof KeyboardEvent) payload["key"] = safeKey(event.key);
    this.record("ui", payload);
  }

  private onStorageChange(
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void {
    if (!this.active) return;
    const items = Object.entries(changes)
      .filter(([key]) => key.startsWith("cfpt:"))
      .map(([key, change]) => ({
        key,
        oldValue: summarizeUnknown(change.oldValue),
        newValue: summarizeUnknown(change.newValue),
      }));
    if (items.length > 0) this.record("storage", { area: areaName, changes: items });
  }

  private onPageMessage(event: MessageEvent): void {
    if (!this.active || event.source !== window) return;
    const data = event.data as Record<string, unknown> | null;
    if (
      !data ||
      data["source"] !== BRIDGE_SOURCE ||
      data["channel"] !== this.channel ||
      !data["payload"] ||
      typeof data["payload"] !== "object"
    ) {
      return;
    }
    const payload = data["payload"] as Record<string, unknown>;
    const type = typeof payload["type"] === "string" ? payload["type"] : "page-event";
    this.record(type.startsWith("network") ? "network" : "page", payload);
    if (type === "history") this.captureSnapshot("history", true);
  }

  private injectPageBridge(): void {
    const existing = document.getElementById(PAGE_SCRIPT_ID);
    if (existing) {
      this.postBridgeControl("start");
      return;
    }
    const script = document.createElement("script");
    script.id = PAGE_SCRIPT_ID;
    script.src = chrome.runtime.getURL("diagnostics-bridge.js");
    script.async = false;
    script.addEventListener("load", () => this.postBridgeControl("start"), { once: true });
    script.addEventListener(
      "error",
      () => this.record("page", { type: "bridge-load-error", src: "diagnostics-bridge.js" }),
      { once: true },
    );
    (document.head ?? document.documentElement).appendChild(script);
  }

  private postBridgeControl(action: "start" | "stop"): void {
    window.postMessage({ source: CONTENT_SOURCE, action, channel: this.channel }, "*");
  }

  private record(type: string, payload: Record<string, unknown>): void {
    if (!this.active && !(type === "session" && payload["event"] === "stop")) return;
    if (this.records.length >= MAX_RECORDS) {
      this.records.splice(0, TRIM_BATCH);
      this.dropped += TRIM_BATCH;
    }
    this.seq += 1;
    this.records.push({
      seq: this.seq,
      time: new Date().toISOString(),
      elapsedMs: Math.max(0, Date.now() - this.startedAtMs),
      type,
      ...payload,
    });
    this.notifyStatus();
  }

  private notifyStatus(): void {
    this.hooks.onStatus?.(this.status);
  }

  private buildSummary(exportedAt: string): Record<string, unknown> {
    const byType: Record<string, number> = {};
    const endpoints = new Set<string>();
    for (const record of this.records) {
      byType[record.type] = (byType[record.type] ?? 0) + 1;
      const url = record["url"];
      if (record.type === "network" && typeof url === "string") endpoints.add(url);
    }
    return {
      recording: this.active,
      events: this.records.length,
      dropped: this.dropped,
      byType,
      endpoints: Array.from(endpoints).slice(0, 200),
      route: redactUrl(location.href),
      durationMs: Math.max(0, Date.parse(exportedAt) - this.startedAtMs),
      finalState: buildSemanticSnapshot(this.hooks.getRunState()),
      note: "Free-form chat text, typed text, cookies, authorization material, tokens, and query values are omitted or summarized.",
    };
  }
}

function buildSemanticSnapshot(run: RunState | null): Record<string, unknown> {
  const assistant = lastAssistantMessage();
  const marker = assistant ? parseMarker(assistant.text) : null;
  return {
    route: redactUrl(location.href),
    document: {
      readyState: document.readyState,
      visibility: document.visibilityState,
      hasFocus: document.hasFocus(),
      online: navigator.onLine,
    },
    selectors: selectorSnapshot(),
    transcript: {
      assistantCount: queryAll("assistantMessage").length,
      userCount: queryAll("userMessage").length,
      lastRole: lastMessageRole(),
      toolVisible: toolCallIndicatorVisible(),
      lastAssistant: assistant
        ? {
            key: summarizeString(assistant.key),
            text: summarizeString(assistant.text),
            marker: sanitizeMarker(marker),
          }
        : null,
    },
    run: sanitizeRunState(run),
  };
}

function selectorSnapshot(): Record<string, unknown> {
  const ids: TargetId[] = ["composer", "sendButton", "stopButton", "toolIndicator", "pageAlert"];
  const states: Record<string, unknown> = {};
  for (const id of ids) states[id] = targetState(id);
  return { health: healthCheck(), targets: states };
}

function targetState(id: TargetId): Record<string, unknown> {
  const resolution = resolve(id);
  const element = resolution?.element;
  if (!(element instanceof HTMLElement)) return { present: Boolean(element) };
  return {
    present: true,
    candidateIndex: resolution?.candidateIndex ?? 0,
    tag: element.tagName.toLowerCase(),
    disabled: element instanceof HTMLButtonElement ? element.disabled : undefined,
    ariaBusy: element.getAttribute("aria-busy"),
    ariaDisabled: element.getAttribute("aria-disabled"),
    visible: isVisible(element),
  };
}

function isVisible(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && !element.hidden;
}

function sanitizeRunState(run: RunState | null): unknown {
  if (!run) return null;
  return {
    conversationId: summarizeString(run.conversationId),
    phase: run.phase,
    status: run.status,
    repoMode: run.repoMode,
    repoName: summarizeString(run.repoName),
    repo: run.repo ? summarizeString(run.repo) : undefined,
    lastMarker: sanitizeMarker(run.lastMarker ?? null),
    planSummary: run.planSummary ? summarizeString(run.planSummary) : undefined,
    pauseReason: run.pauseReason ? summarizeString(run.pauseReason) : undefined,
    errorCode: run.errorCode,
    autoContinueEnabled: run.autoContinueEnabled,
    queuedUserText: run.queuedUserText ? summarizeString(run.queuedUserText) : undefined,
    autoSends: run.autoSends,
    nudges: run.nudges,
    repliesSinceContract: run.repliesSinceContract,
    cooldownUntil: run.cooldownUntil,
    lastProcessedAssistantKey: run.lastProcessedAssistantKey
      ? summarizeString(run.lastProcessedAssistantKey)
      : undefined,
    replyBaselineAssistantKey: run.replyBaselineAssistantKey
      ? summarizeString(run.replyBaselineAssistantKey)
      : undefined,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    logTail: run.log.slice(-12).map((entry) => ({
      at: entry.at,
      kind: entry.kind,
      text: summarizeString(entry.text),
    })),
  };
}

function sanitizeMarker(marker: Marker | null): unknown {
  if (!marker) return null;
  return {
    status: marker.status,
    version: marker.version,
    phase: marker.phase,
    repo: marker.repo ? summarizeString(marker.repo) : undefined,
    item: marker.item ? summarizeString(marker.item) : undefined,
    note: marker.note ? summarizeString(marker.note) : undefined,
    url: marker.url ? redactUrl(marker.url) : undefined,
  };
}

function sanitizeControllerEvent(event: ControllerDiagnosticEvent): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: event.kind };
  if (event.event) {
    out["event"] = {
      type: event.event.type,
      detail: machineEventDetail(event.event),
    };
  }
  if (event.effect) {
    out["effect"] = {
      do: event.effect.do,
      kind: "kind" in event.effect ? event.effect.kind : undefined,
      ms: "ms" in event.effect ? event.effect.ms : undefined,
      text:
        "text" in event.effect && event.effect.text
          ? summarizeString(event.effect.text)
          : undefined,
    };
  }
  if (event.detail) out["detail"] = summarizeDetail(event.detail);
  return out;
}

function machineEventDetail(event: MachineEvent): Record<string, unknown> {
  if ("marker" in event) {
    return {
      marker: sanitizeMarker(event.marker),
      assistantKey: event.assistantKey ? summarizeString(event.assistantKey) : undefined,
      text: summarizeString(event.text),
    };
  }
  if ("text" in event && typeof event.text === "string")
    return { text: summarizeString(event.text) };
  if ("idea" in event) {
    return {
      idea: summarizeString(event.idea),
      repoMode: event.repoMode,
      repoName: summarizeString(event.repoName),
    };
  }
  if ("detail" in event) return { detail: summarizeString(event.detail) };
  if ("signal" in event) return { signal: event.signal };
  if ("enabled" in event) return { enabled: event.enabled };
  if ("baselineAssistantKey" in event && event.baselineAssistantKey) {
    return { baselineAssistantKey: summarizeString(event.baselineAssistantKey) };
  }
  return {};
}

function summarizeDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (typeof value === "string" && /url|route/i.test(key)) out[key] = redactUrl(value);
    else if (typeof value === "string") out[key] = summarizeString(value);
    else if (value === null || typeof value === "number" || typeof value === "boolean")
      out[key] = value;
    else out[key] = summarizeUnknown(value);
  }
  return out;
}

function summarizeMutations(mutations: MutationRecord[]): Record<string, unknown> {
  const attributes = new Set<string>();
  const targets: Record<string, unknown>[] = [];
  let added = 0;
  let removed = 0;
  let text = 0;
  for (const mutation of mutations) {
    added += mutation.addedNodes.length;
    removed += mutation.removedNodes.length;
    if (mutation.type === "characterData") text += 1;
    if (mutation.attributeName) attributes.add(mutation.attributeName);
    if (targets.length < 12 && mutation.target instanceof Element) {
      targets.push(describeElement(mutation.target));
    }
  }
  return {
    mutations: mutations.length,
    added,
    removed,
    characterData: text,
    attributes: Array.from(attributes).slice(0, 30),
    targets,
  };
}

function describeElement(element: Element | null): Record<string, unknown> | null {
  if (!element) return null;
  return {
    tag: element.tagName.toLowerCase(),
    id: safeDomToken(element.id),
    testId: safeDomToken(element.getAttribute("data-testid") ?? ""),
    role: safeDomToken(element.getAttribute("role") ?? ""),
    type: safeDomToken(element.getAttribute("type") ?? ""),
    ariaLabel: element.getAttribute("aria-label")
      ? summarizeString(element.getAttribute("aria-label") ?? "")
      : undefined,
    classCount: element.classList.length,
  };
}

function safeDomToken(value: string): string | undefined {
  if (!value) return undefined;
  return value.length <= 80 && /^[\w:.-]+$/.test(value) ? value : `[hash:${hashText(value)}]`;
}

function safeKey(key: string): string {
  return ["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key)
    ? key
    : "[other]";
}

function safeTimestamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}
