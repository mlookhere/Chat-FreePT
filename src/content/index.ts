import { log } from "../common/log";
import { buildHandoffPrompt } from "../common/prompts";
import { isActive, newRunState } from "../common/state-machine";
import {
  acquireTabLock,
  adoptConversationOwnership,
  heartbeatTabLock,
  loadRun,
  loadSettings,
  releaseTabLock,
} from "../common/storage";
import type { RunState, Settings } from "../common/types";
import type { ContentRequest } from "../common/types";
import { createExtensionContextGuard } from "./extension-context";
import { conversationIdFromUrl, watchNavigation } from "./navigation";
import { chatGptPageMode, type ChatGptPageMode } from "./page-mode";
import { RunController } from "./run-controller";
import { require_ } from "./selectors";
import { Panel } from "./ui/panel";
import { SetupGuide } from "./ui/setup-guide";

const HEARTBEAT_MS = 5000;
const TAKEOVER_RETRY_MS = 5000;
const tabNonce = crypto.randomUUID();

let panel: Panel | null = null;
let standaloneGuide: SetupGuide | null = null;
let controller: RunController | null = null;
let currentConvId = "";
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let takeoverTimer: ReturnType<typeof setTimeout> | undefined;
let stopNavigation: (() => void) | undefined;

const contextGuard = createExtensionContextGuard(() => shutdownInvalidatedContext());

function conversationKeyFromLocation(): string {
  return conversationIdFromUrl(location.href) ?? `pending:${crypto.randomUUID()}`;
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
}

function stopTakeoverRetry(): void {
  if (takeoverTimer !== undefined) clearTimeout(takeoverTimer);
  takeoverTimer = undefined;
}

function shutdownInvalidatedContext(): void {
  stopHeartbeat();
  stopTakeoverRetry();
  stopNavigation?.();
  stopNavigation = undefined;
  controller?.dispose();
  controller = null;
  panel?.dispose();
  panel = null;
  standaloneGuide?.dispose();
  standaloneGuide = null;
}

function reportAsyncFailure(message: string, error: unknown): void {
  if (contextGuard.handle(error)) return;
  log.warn(message, error);
}

async function releaseOwnedLock(conversationId: string): Promise<void> {
  if (contextGuard.invalidated || !conversationId) return;
  try {
    await releaseTabLock(conversationId, tabNonce);
  } catch (error) {
    reportAsyncFailure("tab lock release failed", error);
  }
}

function startHeartbeat(): void {
  stopHeartbeat();
  if (contextGuard.invalidated) return;
  heartbeatTimer = setInterval(() => {
    if (contextGuard.invalidated) {
      stopHeartbeat();
      return;
    }
    const conversationId = currentConvId;
    void heartbeatTabLock(conversationId, tabNonce)
      .then((owned) => {
        if (!owned) loseOwnership(conversationId);
      })
      .catch((error) => reportAsyncFailure("tab lock heartbeat failed", error));
  }, HEARTBEAT_MS);
}

function startController(state: RunState, settings: Settings): void {
  if (contextGuard.invalidated) return;
  stopTakeoverRetry();
  startHeartbeat();
  const ctl = new RunController(state, settings, {
    onChange: (next) => panel?.render(next),
    onShowModal: () => {
      if (controller) panel?.showCompletionModal(controller.state);
    },
    onContextInvalidated: () => contextGuard.invalidate(),
  });
  controller = ctl;
  panel?.render(state);

  if (isActive(state)) {
    log.info("resuming active run", state.phase, state.status);
    setTimeout(() => {
      if (controller === ctl && !contextGuard.invalidated) ctl.reconcile();
    }, 2000);
  }
}

function enterPassive(state: RunState): void {
  if (contextGuard.invalidated) return;
  controller?.dispose();
  controller = null;
  stopHeartbeat();
  panel?.render(state, true);
  scheduleTakeover(state.conversationId);
}

function scheduleTakeover(conversationId: string): void {
  stopTakeoverRetry();
  if (contextGuard.invalidated) return;
  takeoverTimer = setTimeout(() => void tryTakeover(conversationId), TAKEOVER_RETRY_MS);
}

async function tryTakeover(conversationId: string): Promise<void> {
  takeoverTimer = undefined;
  if (contextGuard.invalidated || controller || conversationId !== currentConvId) return;

  let acquired = false;
  try {
    acquired = await acquireTabLock(conversationId, tabNonce);
    if (!acquired) {
      scheduleTakeover(conversationId);
      return;
    }

    const [settings, stored] = await Promise.all([loadSettings(), loadRun(conversationId)]);
    if (contextGuard.invalidated) return;
    if (controller || conversationId !== currentConvId) {
      await releaseOwnedLock(conversationId);
      return;
    }

    const state = stored ?? newRunState(conversationId, Date.now());
    startController(state, settings);
    log.info("took over conversation after previous tab became inactive");
  } catch (error) {
    if (contextGuard.handle(error)) return;
    if (acquired) await releaseOwnedLock(conversationId);
    log.warn("conversation ownership retry failed", error);
    if (!controller && conversationId === currentConvId) scheduleTakeover(conversationId);
  }
}

function loseOwnership(conversationId: string): void {
  if (contextGuard.invalidated || !controller || conversationId !== currentConvId) return;
  const state = controller.state;
  log.info("conversation ownership moved to another tab; becoming passive");
  enterPassive(state);
}

async function initConversation(convId: string): Promise<void> {
  if (contextGuard.invalidated) return;
  controller?.dispose();
  controller = null;
  stopHeartbeat();
  stopTakeoverRetry();
  currentConvId = convId;

  const settings = await loadSettings();
  const state = (await loadRun(convId)) ?? newRunState(convId, Date.now());
  const locked = await acquireTabLock(convId, tabNonce);
  if (contextGuard.invalidated) return;
  if (!locked) {
    log.info("another tab is driving this conversation; staying passive");
    enterPassive(state);
    return;
  }

  startController(state, settings);
}

function ensureStandaloneGuide(mode: ChatGptPageMode): void {
  if (mode !== "plugins" || panel || standaloneGuide || contextGuard.invalidated) return;
  standaloneGuide = new SetupGuide();
}

function clearStandaloneGuide(): void {
  standaloneGuide?.dispose();
  standaloneGuide = null;
}

async function leaveConversationForUtilityPage(mode: ChatGptPageMode): Promise<void> {
  stopTakeoverRetry();
  controller?.dispose();
  controller = null;
  stopHeartbeat();
  const previous = currentConvId;
  currentConvId = "";
  await releaseOwnedLock(previous);
  if (contextGuard.invalidated) return;
  ensureStandaloneGuide(mode);
  log.debug(`Chat FreePT idle on expected non-composer route (${mode})`);
}

async function activateComposerPage(): Promise<void> {
  if (contextGuard.invalidated || panel) return;
  clearStandaloneGuide();
  try {
    await require_("composer", 45000, 500);
  } catch {
    const mode = chatGptPageMode(location.href);
    if (mode !== "composer") {
      ensureStandaloneGuide(mode);
      log.debug(`Chat FreePT idle on expected non-composer route (${mode})`);
      return;
    }
    log.warn("composer never appeared; Chat FreePT idle (logged out or layout change?)");
    return;
  }
  if (contextGuard.invalidated || chatGptPageMode(location.href) !== "composer" || panel) return;

  panel = new Panel({
    onEvent: (event) => controller?.dispatch(event),
    getHandoffPrompt: () => (controller ? buildHandoffPrompt(controller.state) : ""),
  });
  await initConversation(conversationKeyFromLocation());
  if (!contextGuard.invalidated) log.info("Chat FreePT ready");
}

async function onComposerNavigate(href: string): Promise<void> {
  const urlConv = conversationIdFromUrl(href);

  if (urlConv && currentConvId.startsWith("pending:") && controller) {
    const pendingId = currentConvId;
    const ctl = controller;
    stopHeartbeat();

    let migrated;
    try {
      migrated = await adoptConversationOwnership(ctl.state, urlConv, tabNonce);
    } catch (error) {
      if (contextGuard.handle(error)) return;
      log.warn("failed to adopt permanent conversation id", error);
      startHeartbeat();
      return;
    }

    if (!migrated) {
      ctl.dispose();
      controller = null;
      await releaseOwnedLock(pendingId);
      if (contextGuard.invalidated) return;
      currentConvId = urlConv;
      const state = (await loadRun(urlConv)) ?? newRunState(urlConv, Date.now());
      log.info("another tab owns the permanent conversation id; staying passive");
      enterPassive(state);
      return;
    }

    currentConvId = urlConv;
    ctl.state = migrated;
    panel?.render(migrated);
    startHeartbeat();
    log.info("adopted conversation id", urlConv);
    return;
  }

  if (urlConv === currentConvId) return;
  if (!urlConv && currentConvId.startsWith("pending:")) return;

  stopTakeoverRetry();
  controller?.dispose();
  controller = null;
  stopHeartbeat();
  await releaseOwnedLock(currentConvId);
  if (contextGuard.invalidated) return;
  await initConversation(urlConv ?? `pending:${crypto.randomUUID()}`);
}

async function onNavigate(href: string): Promise<void> {
  if (contextGuard.invalidated) return;
  const mode = chatGptPageMode(href);
  if (mode !== "composer") {
    await leaveConversationForUtilityPage(mode);
    return;
  }
  if (!panel) {
    await activateComposerPage();
    return;
  }
  await onComposerNavigate(href);
}

function installLifecycleListeners(): void {
  chrome.runtime.onMessage.addListener((message: ContentRequest) => {
    if (message.type === "toggle-panel") panel?.toggle();
  });

  window.addEventListener("pagehide", () => {
    stopTakeoverRetry();
    stopHeartbeat();
    stopNavigation?.();
    stopNavigation = undefined;
    void releaseOwnedLock(currentConvId);
  });

  stopNavigation = watchNavigation((href) => {
    void onNavigate(href).catch((error) => reportAsyncFailure("navigation handling failed", error));
  });
}

async function boot(): Promise<void> {
  installLifecycleListeners();
  const mode = chatGptPageMode(location.href);
  if (mode !== "composer") {
    ensureStandaloneGuide(mode);
    log.debug(`Chat FreePT idle on expected non-composer route (${mode})`);
    return;
  }
  await activateComposerPage();
}

void boot().catch((error) => reportAsyncFailure("Chat FreePT boot failed", error));
