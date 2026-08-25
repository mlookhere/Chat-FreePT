import { log } from "../common/log";
import { query, require_ } from "./selectors";

export interface InsertResult {
  ok: boolean;
  strategy?: string;
  error?: string;
}

const NEVER_CANCEL = (): boolean => false;

function normalized(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, "");
}

export function composerText(): string {
  const el = query("composer") as HTMLElement | null;
  return el?.textContent ?? "";
}

export function composerIsEmpty(): boolean {
  return normalized(composerText()).length === 0;
}

function focusComposer(el: HTMLElement): void {
  el.focus();
  const selection = window.getSelection();
  if (selection) {
    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    selection.addRange(range);
  }
}

function clearComposer(el: HTMLElement): void {
  if (normalized(el.textContent).length === 0) return;
  focusComposer(el);
  document.execCommand("selectAll", false);
  document.execCommand("delete", false);
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 50));
  });
}

/**
 * Primary strategy: a synthetic paste. ProseMirror's paste handler parses multi-line
 * plain text into proper paragraph nodes and updates the real editor state, and it never
 * touches the user's actual clipboard.
 */
function pasteInsert(el: HTMLElement, text: string): boolean {
  try {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    const event = new ClipboardEvent("paste", {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(event);
    return true;
  } catch (err) {
    log.debug("pasteInsert unavailable", err);
    return false;
  }
}

/** Fallback: execCommand drives the beforeinput path ProseMirror also understands. */
function execInsert(el: HTMLElement, text: string): boolean {
  try {
    focusComposer(el);
    return document.execCommand("insertText", false, text);
  } catch (err) {
    log.debug("execInsert failed", err);
    return false;
  }
}

/** Last resort: write paragraph nodes directly and tell React via an input event. */
function domInsert(el: HTMLElement, text: string): boolean {
  try {
    el.textContent = "";
    for (const line of text.split("\n")) {
      const p = document.createElement("p");
      if (line === "") {
        p.appendChild(document.createElement("br"));
      } else {
        p.textContent = line;
      }
      el.appendChild(p);
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    return true;
  } catch (err) {
    log.debug("domInsert failed", err);
    return false;
  }
}

const STRATEGIES: [string, (el: HTMLElement, text: string) => boolean][] = [
  ["paste", pasteInsert],
  ["execCommand", execInsert],
  ["dom", domInsert],
];

export async function insertPrompt(
  text: string,
  isCancelled: () => boolean = NEVER_CANCEL,
): Promise<InsertResult> {
  if (isCancelled()) return { ok: false, error: "insert cancelled" };

  let el: HTMLElement;
  try {
    el = (await require_("composer", 8000)) as HTMLElement;
  } catch {
    return { ok: false, error: "composer not found" };
  }
  if (isCancelled()) return { ok: false, error: "insert cancelled" };

  const want = normalized(text).length;
  for (const [name, strategy] of STRATEGIES) {
    if (isCancelled()) return { ok: false, error: "insert cancelled" };
    focusComposer(el);
    clearComposer(el);
    await nextFrame();
    if (isCancelled()) return { ok: false, error: "insert cancelled" };
    if (!strategy(el, text)) continue;
    await nextFrame();
    if (isCancelled()) return { ok: false, error: "insert cancelled" };
    const got = normalized(el.textContent).length;
    if (got >= Math.floor(want * 0.98)) {
      log.debug(`insertPrompt ok via ${name} (${got}/${want} chars)`);
      return { ok: true, strategy: name };
    }
    log.debug(`insertPrompt via ${name} incomplete (${got}/${want} chars)`);
  }
  return { ok: false, error: "no insertion strategy stuck" };
}

function sendButtonReady(): HTMLButtonElement | null {
  const btn = query("sendButton") as HTMLButtonElement | null;
  if (!btn) return null;
  if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return null;
  return btn;
}

function waitFor<T>(
  probe: () => T | null,
  timeoutMs: number,
  pollMs = 150,
  isCancelled: () => boolean = NEVER_CANCEL,
): Promise<T | null> {
  return new Promise((resolve) => {
    const started = Date.now();
    const attempt = (): void => {
      if (isCancelled()) {
        resolve(null);
        return;
      }
      const value = probe();
      if (value !== null) {
        resolve(value);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        resolve(null);
        return;
      }
      setTimeout(attempt, pollMs);
    };
    attempt();
  });
}

export interface SendResult {
  ok: boolean;
  error?: string;
}

/**
 * Click send and confirm the message actually left the composer. A model-picker popover
 * or upload menu can silently swallow the click, so one Escape-and-retry is built in.
 */
export async function clickSend(
  isStreaming: () => boolean,
  isCancelled: () => boolean = NEVER_CANCEL,
): Promise<SendResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (isCancelled()) return { ok: false, error: "send cancelled" };
    const btn = await waitFor(sendButtonReady, 8000, 150, isCancelled);
    if (isCancelled()) return { ok: false, error: "send cancelled" };
    if (!btn) return { ok: false, error: "send button never became ready" };
    btn.click();
    const confirmed = await waitFor(
      () => (composerIsEmpty() || isStreaming() ? true : null),
      5000,
      150,
      isCancelled,
    );
    if (isCancelled()) return { ok: false, error: "send cancelled" };
    if (confirmed) return { ok: true };
    log.warn("send click did not take; escaping popovers and retrying once");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    (query("composer") as HTMLElement | null)?.focus();
  }
  return { ok: false, error: "send click did not take after retry" };
}
