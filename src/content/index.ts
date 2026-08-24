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
import type { ContentRequest } from "../common/types";
import { conversationIdFromUrl, watchNavigation } from "./navigation";
import { RunController } from "./run-controller";
import { require_ } from "./selectors";
import { Panel } from "./ui/panel";

const HEARTBEAT_MS = 5000;
const tabNonce = crypto.randomUUID();

let panel: Panel | null = null;
let controller: RunController | null = null;
let currentConvId = "";
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

function conversationKeyFromLocation(): string {
  return conversationIdFromUrl(location.href) ?? `pending:${crypto.randomUUID()}`;
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    void heartbeatTabLock(currentConvId, tabNonce);
  }, HEARTBEAT_MS);
}

async function initConversation(convId: string): Promise<void> {
  controller?.dispose();
  controller = null;
  stopHeartbeat();
  currentConvId = convId;

  const settings = await loadSettings();
  const state = (await loadRun(convId)) ?? newRunState(convId, Date.now());

  const locked = await acquireTabLock(convId, tabNonce);
  if (!locked) {
    log.warn("another tab is driving this conversation; staying passive");
    panel?.render(state);
    return;
  }
  startHeartbeat();

  const ctl = new RunController(state, settings, {
    onChange: (s) => panel?.render(s),
    onShowModal: () => {
      if (controller) panel?.showCompletionModal(controller.state);
    },
  });
  controller = ctl;
  panel?.render(state);

  // Picking up a run mid-flight after a reload: re-derive position from the live DOM.
  if (isActive(state)) {
    log.info("resuming active run", state.phase, state.status);
    setTimeout(() => ctl.reconcile(), 2000);
  }
}

async function onNavigate(href: string): Promise<void> {
  const urlConv = conversationIdFromUrl(href);

  // A brand-new chat just got its permanent id — transfer both state and driver ownership.
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
      panel?.render(state);
      log.warn("another tab owns the permanent conversation id; staying passive");
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

  // Real conversation switch: pause anything active, release ownership, then initialize.
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
    void releaseTabLock(currentConvId, tabNonce);
  });

  watchNavigation((href) => void onNavigate(href));
  await initConversation(conversationKeyFromLocation());
  log.info("Chat FreePT ready");
}

void boot();
