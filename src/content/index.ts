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
  saveRun,
} from "../common/storage";
import type { RunState, Settings } from "../common/types";
import type { ContentRequest } from "../common/types";
import { conversationIdFromUrl, watchNavigation } from "./navigation";
import { RunController } from "./run-controller";
import { require_ } from "./selectors";
import { Panel } from "./ui/panel";

const HEARTBEAT_MS = 5000;
const TAKEOVER_RETRY_MS = 5000;
const tabNonce = crypto.randomUUID();

let panel: Panel | null = null;
let controller: RunController | null = null;
let currentConvId = "";
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let takeoverTimer: ReturnType<typeof setTimeout> | undefined;

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

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    const conversationId = currentConvId;
    void heartbeatTabLock(conversationId, tabNonce)
      .then((owned) => {
        if (!owned) loseOwnership(conversationId);
      })
      .catch((error) => log.warn("tab lock heartbeat failed", error));
  }, HEARTBEAT_MS);
}

function startController(state: RunState, settings: Settings): void {
  stopTakeoverRetry();
  startHeartbeat();
  const ctl = new RunController(state, settings, {
    onChange: (next) => panel?.render(next),
    onShowModal: () => {
      if (controller) panel?.showCompletionModal(controller.state);
    },
  });
  controller = ctl;
  panel?.render(state);

  if (isActive(state)) {
    log.info("resuming active run", state.phase, state.status);
    setTimeout(() => {
      if (controller === ctl) ctl.reconcile();
    }, 2000);
  }
}

function enterPassive(state: RunState): void {
  controller?.dispose();
  controller = null;
  stopHeartbeat();
  panel?.render(state, true);
  scheduleTakeover(state.conversationId);
}

function scheduleTakeover(conversationId: string): void {
  stopTakeoverRetry();
  takeoverTimer = setTimeout(() => void tryTakeover(conversationId), TAKEOVER_RETRY_MS);
}

async function tryTakeover(conversationId: string): Promise<void> {
  takeoverTimer = undefined;
  if (controller || conversationId !== currentConvId) return;

  let acquired = false;
  try {
    acquired = await acquireTabLock(conversationId, tabNonce);
    if (!acquired) {
      scheduleTakeover(conversationId);
      return;
    }

    const [settings, stored] = await Promise.all([loadSettings(), loadRun(conversationId)]);
    if (controller || conversationId !== currentConvId) {
      await releaseTabLock(conversationId, tabNonce);
      return;
    }

    const state = stored ?? newRunState(conversationId, Date.now());
    startController(state, settings);
    log.info("took over conversation after previous tab became inactive");
  } catch (error) {
    if (acquired) await releaseTabLock(conversationId, tabNonce);
    log.warn("conversation ownership retry failed", error);
    if (!controller && conversationId === currentConvId) scheduleTakeover(conversationId);
  }
}

function loseOwnership(conversationId: string): void {
  if (!controller || conversationId !== currentConvId) return;
  const state = controller.state;
  log.warn("conversation ownership moved to another tab; becoming passive");
  enterPassive(state);
}

async function initConversation(convId: string): Promise<void> {
  controller?.dispose();
  controller = null;
  stopHeartbeat();
  stopTakeoverRetry();
  currentConvId = convId;

  const settings = await loadSettings();
  const state = (await loadRun(convId)) ?? newRunState(convId, Date.now());
  const locked = await acquireTabLock(convId, tabNonce);
  if (!locked) {
    log.warn("another tab is driving this conversation; staying passive");
    enterPassive(state);
    return;
  }

  startController(state, settings);
}

async function onNavigate(href: string): Promise<void> {
  const urlConv = conversationIdFromUrl(href);

  if (urlConv && currentConvId.startsWith("pending:") && controller) {
    const pendingId = currentConvId;
    const ctl = controller;
    stopHeartbeat();

    let migrated;
    try {
      migrated = await adoptConversationOwnership(ctl.state, urlConv, tabNonce);
    } catch (error) {
      log.warn("failed to adopt permanent conversation id", error);
      startHeartbeat();
      return;
    }

    if (!migrated) {
      ctl.dispose();
      controller = null;
      await releaseTabLock(pendingId, tabNonce);
      currentConvId = urlConv;
      const state = (await loadRun(urlConv)) ?? newRunState(urlConv, Date.now());
      log.warn("another tab owns the permanent conversation id; staying passive");
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
  if (controller && isActive(controller.state)) {
    controller.dispatch({ type: "USER_PAUSE" });
  }
  await releaseTabLock(currentConvId, tabNonce);
  await initConversation(urlConv ?? `pending:${crypto.randomUUID()}`);
}

async function boot(): Promise<void> {
  try {
    await require_("composer", 45000, 500);
  } catch {
    log.warn("composer never appeared; Chat FreePT idle (logged out or layout change?)");
    return;
  }

  panel = new Panel({
    onEvent: (event) => controller?.dispatch(event),
    onNewProject: () => {
      if (!controller) return;
      const fresh = newRunState(currentConvId, Date.now());
      controller.state = fresh;
      void saveRun(fresh).catch((err) => log.warn("state save failed", err));
      panel?.render(fresh);
    },
    getHandoffPrompt: () => (controller ? buildHandoffPrompt(controller.state) : ""),
  });

  chrome.runtime.onMessage.addListener((message: ContentRequest) => {
    if (message.type === "toggle-panel") panel?.toggle();
  });

  window.addEventListener("pagehide", () => {
    stopTakeoverRetry();
    stopHeartbeat();
    void releaseTabLock(currentConvId, tabNonce);
  });

  watchNavigation((href) => void onNavigate(href));
  await initConversation(conversationKeyFromLocation());
  log.info("Chat FreePT ready");
}

void boot();
