import { queryGuideTarget, type GuideTargetId } from "./selectors";

const SETUP_KEY_PREFIX = "cfpt:setup-guide:";
const APP_NAME = "Chat FreePT GitHub MCP";
const COMPOSER_PLUS_TARGET: GuideTargetId = "composerPlusButton";
const DEVELOPER_MODE_TARGET: GuideTargetId = "conversationDeveloperMode";
const APP_TARGET: GuideTargetId = "conversationGitHubMcp";
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_POLL_MS = 50;
const APP_REOPEN_DELAY_MS = 900;

type GuideElement = HTMLElement | null;

interface StoredGuide {
  active?: boolean;
  step?: string;
  returnUrl?: string;
}

interface PendingSetup {
  key: string;
  state: StoredGuide;
}

export type DeveloperModeActivationResult =
  | "not-needed"
  | "activated"
  | "missing-plus"
  | "missing-developer-mode"
  | "missing-app";

/**
 * Finishes the documented ChatGPT Developer mode flow after the setup guide returns
 * from Plugins/OAuth. This deliberately runs before Panel/SetupGuide mounts so users
 * do not see a false "setup complete" state before the app is attached to the chat.
 */
export async function activateDeveloperModeSetup(
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
): Promise<DeveloperModeActivationResult> {
  const pending = findPendingSetup();
  if (!pending) return "not-needed";

  const plus = await waitForTarget(COMPOSER_PLUS_TARGET, timeoutMs, pollMs);
  if (!plus) return "missing-plus";
  plus.click();

  const developerMode = await waitForTarget(DEVELOPER_MODE_TARGET, timeoutMs, pollMs);
  if (!developerMode) return "missing-developer-mode";
  developerMode.click();

  let app = await waitForExactApp(Math.min(APP_REOPEN_DELAY_MS, timeoutMs), pollMs);
  if (!app) {
    // Some ChatGPT layouts close the Plus menu after switching into Developer mode.
    plus.click();
    app = await waitForExactApp(timeoutMs, pollMs);
  }
  if (!app) return "missing-app";

  if (!isSelected(app)) app.click();
  finishPendingSetup(pending);
  return "activated";
}

function findPendingSetup(): PendingSetup | null {
  for (let index = 0; index < window.sessionStorage.length; index += 1) {
    const key = window.sessionStorage.key(index);
    if (!key?.startsWith(SETUP_KEY_PREFIX)) continue;

    const state = parseStoredGuide(window.sessionStorage.getItem(key));
    if (state?.active === true && state.step === "done") return { key, state };
  }
  return null;
}

function parseStoredGuide(raw: string | null): StoredGuide | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredGuide;
  } catch {
    return null;
  }
}

function finishPendingSetup(pending: PendingSetup): void {
  window.sessionStorage.setItem(
    pending.key,
    JSON.stringify({ ...pending.state, active: false, step: "done" }),
  );
}

function isSelected(element: HTMLElement): boolean {
  return (
    element.getAttribute("aria-checked") === "true" ||
    element.getAttribute("aria-selected") === "true" ||
    element.getAttribute("data-state") === "checked" ||
    element.getAttribute("data-state") === "on"
  );
}

async function waitForExactApp(timeoutMs: number, pollMs: number): Promise<GuideElement> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const found = queryGuideTarget(APP_TARGET);
    if (found && (found.textContent ?? "").trim() === APP_NAME) return found;
    await delay(pollMs);
  }
  return null;
}

async function waitForTarget(
  id: GuideTargetId,
  timeoutMs: number,
  pollMs: number,
): Promise<GuideElement> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const found = queryGuideTarget(id);
    if (found) return found;
    await delay(pollMs);
  }
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
