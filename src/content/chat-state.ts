const BRIDGE_SOURCE = "cfpt-chat-state-bridge";
const SCRIPT_ID = "cfpt-chat-state-bridge-script";

export interface ChatStateEvent {
  version: number;
  event:
    | "generation-start"
    | "generation-complete"
    | "generation-interrupted"
    | "generation-aborted"
    | "stream-status";
  requestId?: string;
  marker?: {
    status: string;
    version: number;
    phase?: string;
    repo?: string;
    item?: string;
    note?: string;
    url?: string;
    text: string;
  } | null;
  status?: string;
  reason?: string;
}

type Listener = (event: ChatStateEvent) => void;

const listeners = new Set<Listener>();
let listenerInstalled = false;

function onMessage(event: MessageEvent): void {
  if (event.source !== window || !event.data || typeof event.data !== "object") return;
  const envelope = event.data as Record<string, unknown>;
  if (envelope["source"] !== BRIDGE_SOURCE) return;
  const payload = envelope["payload"];
  if (!payload || typeof payload !== "object") return;
  const value = payload as ChatStateEvent;
  if (value.version !== 1 || typeof value.event !== "string") return;
  for (const listener of listeners) listener(value);
}

export function ensureChatStateBridge(): void {
  if (!listenerInstalled) {
    window.addEventListener("message", onMessage);
    listenerInstalled = true;
  }
  if (document.getElementById(SCRIPT_ID)) return;
  const script = document.createElement("script");
  script.id = SCRIPT_ID;
  script.src = chrome.runtime.getURL("chat-state-bridge.js");
  script.async = false;
  (document.head ?? document.documentElement).appendChild(script);
}

export function subscribeChatState(listener: Listener): () => void {
  ensureChatStateBridge();
  listeners.add(listener);
  return () => listeners.delete(listener);
}
