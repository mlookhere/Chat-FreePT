import { log } from "../common/log";
import { buildHandoffPrompt } from "../common/prompts";
import { isActive, newRunState } from "../common/state-machine";
import {
  acquireTabLock,
  heartbeatTabLock,
  loadRun,
  loadSettings,
  migrateRunKey,
  releaseTabLock,
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

async function initConversation(convId: string): Promise<void> {
  controller?.dispose();
  controller = null;
  if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
  currentConvId = convId;

  const settings = await loadSettings();
  const state = (await loadRun(convId)) ?? newRunState(convId, Date.now());

  const locked = await acquireTabLock(convId, tabNonce);
  if (!locked) {
    log.warn("another tab is driving this conversation; staying passive");
    panel?.render(state);
    return;
  }
  heartbeatTimer = setInterval(() => {
    void heartbeatTabLock(currentConvId, tabNonce);
  }, HEARTBEAT_MS);

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

function onNavigate(href: string): void {
  const urlConv = conversationIdFromUrl(href);

  // A brand-new chat just got its permanent id — adopt it, don't restart.
  if (urlConv && currentConvId.startsWith("pending:") && controller) {
    const pendingId = currentConvId;
    currentConvId = urlConv;
    controller.adoptConversationId(urlConv);
    void migrateRunKey(controller.state, urlConv);
    void releaseTabLock(pendingId, tabNonce);
    void acquireTabLock(urlConv, tabNonce);
    log.info("adopted conversation id", urlConv);
    return;
  }

  if (urlConv === currentConvId) return;
  if (!urlConv && currentConvId.startsWith("pending:")) return;

  // Real conversation switch: pause anything active, then re-init for the new one.
  if (controller && isActive(controller.state)) {
    controller.dispatch({ type: "USER_PAUSE" });
  }
  void releaseTabLock(currentConvId, tabNonce);
  void initConversation(urlConv ?? `pending:${crypto.randomUUID()}`);
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

  watchNavigation(onNavigate);
  await initConversation(conversationKeyFromLocation());
  log.info("Chat FreePT ready");
}

void boot();
