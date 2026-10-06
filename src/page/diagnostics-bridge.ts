import {
  redactUrl,
  safeError,
  safeHeaders,
  summarizeBody,
  summarizeResponseText,
  summarizeUnknown,
} from "../diagnostics/sanitize";

const CONTENT_SOURCE = "cfpt-diagnostics-content";
const BRIDGE_SOURCE = "cfpt-diagnostics-bridge";
const MAX_BODY_INSPECT_BYTES = 1024 * 1024;

let channel: string | null = null;
let installed = false;
let requestSeq = 0;

interface PageBridgePayload {
  type: string;
  [key: string]: unknown;
}

interface XhrMeta {
  id: string;
  method: string;
  url: string;
  startedAt: number;
}

declare global {
  interface Window {
    __CFPT_DIAGNOSTICS_BRIDGE__?: boolean;
  }
}

function emit(payload: PageBridgePayload): void {
  if (!channel) return;
  window.postMessage({ source: BRIDGE_SOURCE, channel, payload }, "*");
}

function nextId(prefix: string): string {
  requestSeq += 1;
  return `${prefix}-${requestSeq}`;
}

function nowMs(): number {
  return Math.round(performance.now() * 100) / 100;
}

function bodyLengthAllowed(response: Response): boolean {
  const raw = response.headers.get("content-length");
  if (!raw) return true;
  const parsed = Number.parseInt(raw, 10);
  return !Number.isFinite(parsed) || parsed <= MAX_BODY_INSPECT_BYTES;
}

function shouldInspectResponse(response: Response): boolean {
  if (!bodyLengthAllowed(response)) return false;
  const contentType = response.headers.get("content-type") ?? "";
  return /json|text\/event-stream/i.test(contentType);
}

async function inspectFetchBody(response: Response, id: string): Promise<void> {
  if (!shouldInspectResponse(response)) return;
  const contentType = response.headers.get("content-type") ?? "";
  try {
    const text = await response.text();
    emit({
      type: "network-body",
      transport: "fetch",
      id,
      direction: "response",
      contentType,
      summary: summarizeResponseText(text, contentType),
    });
  } catch (error) {
    emit({ type: "network-body-error", transport: "fetch", id, error: safeError(error) });
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  return input instanceof Request ? input.method.toUpperCase() : "GET";
}

function installFetch(): void {
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const id = nextId("fetch");
    const startedAt = nowMs();
    emit({
      type: "network-request",
      transport: "fetch",
      id,
      method: requestMethod(input, init),
      url: redactUrl(requestUrl(input)),
      body: summarizeBody(init?.body),
      at: startedAt,
    });
    try {
      const response = await original(input, init);
      emit({
        type: "network-response",
        transport: "fetch",
        id,
        url: redactUrl(response.url || requestUrl(input)),
        status: response.status,
        ok: response.ok,
        redirected: response.redirected,
        headers: safeHeaders(response.headers),
        durationMs: Math.max(0, nowMs() - startedAt),
      });
      void inspectFetchBody(response.clone(), id);
      return response;
    } catch (error) {
      emit({
        type: "network-error",
        transport: "fetch",
        id,
        durationMs: Math.max(0, nowMs() - startedAt),
        error: safeError(error),
      });
      throw error;
    }
  };
}

function xhrBodySummary(xhr: XMLHttpRequest): unknown {
  try {
    if (xhr.responseType === "" || xhr.responseType === "text") {
      const contentType = xhr.getResponseHeader("content-type") ?? "";
      return summarizeResponseText(xhr.responseText ?? "", contentType);
    }
    if (xhr.responseType === "json") return summarizeUnknown(xhr.response);
    if (xhr.responseType === "arraybuffer" || xhr.responseType === "blob") {
      return summarizeUnknown(xhr.response);
    }
  } catch {
    return { kind: "unavailable" };
  }
  return { kind: xhr.responseType || "unknown" };
}

function installXhr(): void {
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  const meta = new WeakMap<XMLHttpRequest, XhrMeta>();

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ): void {
    meta.set(this, {
      id: nextId("xhr"),
      method: method.toUpperCase(),
      url: redactUrl(String(url)),
      startedAt: 0,
    });
    open.call(this, method, url, async ?? true, username ?? null, password ?? null);
  };

  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null): void {
    const info = meta.get(this);
    if (info) {
      info.startedAt = nowMs();
      emit({
        type: "network-request",
        transport: "xhr",
        id: info.id,
        method: info.method,
        url: info.url,
        body: summarizeBody(body),
        at: info.startedAt,
      });
      this.addEventListener(
        "loadend",
        () => {
          emit({
            type: "network-response",
            transport: "xhr",
            id: info.id,
            url: redactUrl(this.responseURL || info.url),
            status: this.status,
            durationMs: Math.max(0, nowMs() - info.startedAt),
            body: xhrBodySummary(this),
          });
        },
        { once: true },
      );
      for (const eventName of ["error", "abort", "timeout"] as const) {
        this.addEventListener(
          eventName,
          () =>
            emit({
              type: "network-error",
              transport: "xhr",
              id: info.id,
              event: eventName,
              durationMs: Math.max(0, nowMs() - info.startedAt),
            }),
          { once: true },
        );
      }
    }
    send.call(this, body ?? null);
  };
}

function socketDataSummary(data: unknown): unknown {
  if (typeof data === "string") return summarizeResponseText(data, "application/json");
  return summarizeUnknown(data);
}

function installWebSocket(): void {
  const NativeWebSocket = window.WebSocket;
  class DiagnosticWebSocket extends NativeWebSocket {
    private readonly diagnosticId: string;

    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.diagnosticId = nextId("ws");
      emit({
        type: "network-open",
        transport: "websocket",
        id: this.diagnosticId,
        url: redactUrl(String(url)),
      });
      this.addEventListener("open", () =>
        emit({
          type: "network-state",
          transport: "websocket",
          id: this.diagnosticId,
          state: "open",
        }),
      );
      this.addEventListener("message", (event) =>
        emit({
          type: "network-message",
          transport: "websocket",
          id: this.diagnosticId,
          direction: "receive",
          data: socketDataSummary(event.data),
        }),
      );
      this.addEventListener("close", (event) =>
        emit({
          type: "network-state",
          transport: "websocket",
          id: this.diagnosticId,
          state: "closed",
          code: event.code,
          clean: event.wasClean,
        }),
      );
      this.addEventListener("error", () =>
        emit({ type: "network-error", transport: "websocket", id: this.diagnosticId }),
      );
    }

    override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      emit({
        type: "network-message",
        transport: "websocket",
        id: this.diagnosticId,
        direction: "send",
        data: socketDataSummary(data),
      });
      super.send(data as string | Blob | BufferSource);
    }
  }
  window.WebSocket = DiagnosticWebSocket;
}

function installEventSource(): void {
  const NativeEventSource = window.EventSource;
  if (!NativeEventSource) return;
  class DiagnosticEventSource extends NativeEventSource {
    private readonly diagnosticId: string;

    constructor(url: string | URL, eventSourceInitDict?: EventSourceInit) {
      super(url, eventSourceInitDict);
      this.diagnosticId = nextId("es");
      emit({
        type: "network-open",
        transport: "eventsource",
        id: this.diagnosticId,
        url: redactUrl(String(url)),
      });
      this.addEventListener("open", () =>
        emit({
          type: "network-state",
          transport: "eventsource",
          id: this.diagnosticId,
          state: "open",
        }),
      );
      this.addEventListener("message", (event) =>
        emit({
          type: "network-message",
          transport: "eventsource",
          id: this.diagnosticId,
          direction: "receive",
          data: summarizeResponseText(event.data, "text/event-stream"),
        }),
      );
      this.addEventListener("error", () =>
        emit({ type: "network-error", transport: "eventsource", id: this.diagnosticId }),
      );
    }
  }
  window.EventSource = DiagnosticEventSource;
}

function installHistory(): void {
  const pushState = history.pushState.bind(history);
  const replaceState = history.replaceState.bind(history);

  history.pushState = (data: unknown, unused: string, url?: string | URL | null): void => {
    pushState(data, unused, url);
    emit({ type: "history", action: "pushState", url: redactUrl(location.href) });
  };
  history.replaceState = (data: unknown, unused: string, url?: string | URL | null): void => {
    replaceState(data, unused, url);
    emit({ type: "history", action: "replaceState", url: redactUrl(location.href) });
  };
}

function install(): void {
  if (installed) return;
  installed = true;
  installFetch();
  installXhr();
  installWebSocket();
  installEventSource();
  installHistory();
  emit({ type: "bridge-ready", url: redactUrl(location.href) });
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data as Record<string, unknown> | null;
  if (!data || data["source"] !== CONTENT_SOURCE) return;
  if (data["action"] === "start" && typeof data["channel"] === "string") {
    channel = data["channel"];
    install();
    emit({ type: "bridge-started", url: redactUrl(location.href) });
  } else if (data["action"] === "stop" && data["channel"] === channel) {
    emit({ type: "bridge-stopped", url: redactUrl(location.href) });
    channel = null;
  }
});

if (!window.__CFPT_DIAGNOSTICS_BRIDGE__) {
  window.__CFPT_DIAGNOSTICS_BRIDGE__ = true;
  install();
}
