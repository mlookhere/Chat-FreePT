const BRIDGE_SOURCE = "cfpt-chat-state-bridge";
const EVENT_VERSION = 1;

let installed = false;
let requestSeq = 0;

interface MarkerPayload {
  status: string;
  version: number;
  phase?: string;
  repo?: string;
  item?: string;
  note?: string;
  url?: string;
  text: string;
}

interface ChatStatePayload {
  version: number;
  event:
    | "generation-start"
    | "generation-complete"
    | "generation-interrupted"
    | "generation-aborted"
    | "stream-status";
  requestId?: string;
  marker?: MarkerPayload | null;
  status?: string;
  reason?: string;
}

declare global {
  interface Window {
    __CFPT_CHAT_STATE_BRIDGE__?: boolean;
  }
}

function emit(payload: Omit<ChatStatePayload, "version">): void {
  window.postMessage(
    { source: BRIDGE_SOURCE, payload: { version: EVENT_VERSION, ...payload } },
    "*",
  );
}

function nextRequestId(): string {
  requestSeq += 1;
  return `turn-${requestSeq}`;
}

function absoluteUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function pathname(input: RequestInfo | URL): string {
  try {
    return new URL(absoluteUrl(input), location.href).pathname;
  } catch {
    return "";
  }
}

function method(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  return input instanceof Request ? input.method.toUpperCase() : "GET";
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, out);
}

function protocolCandidateText(raw: string): string {
  const pieces: string[] = [raw, raw.replace(/\\n/g, "\n").replace(/\\\"/g, '"')];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const body = trimmed.slice(5).trim();
    if (!body || body === "[DONE]") continue;
    try {
      const parsed = JSON.parse(body) as unknown;
      const strings: string[] = [];
      collectStrings(parsed, strings);
      if (strings.length > 0) pieces.push(strings.join(""));
    } catch {
      // Streams can contain non-JSON control lines; raw text is still checked below.
    }
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const strings: string[] = [];
    collectStrings(parsed, strings);
    if (strings.length > 0) pieces.push(strings.join(""));
  } catch {
    // Most conversation responses are streamed rather than one JSON document.
  }
  return pieces.join("\n");
}

function markerSummary(status: string, fields: Record<string, string>): string {
  const parts = [status];
  for (const key of ["PHASE", "REPO", "ITEM", "NOTE"] as const) {
    const value = fields[key];
    if (value) parts.push(`${key.toLowerCase()}=${value}`);
  }
  return parts.join(" ");
}

function extractMarker(raw: string): MarkerPayload | null {
  const text = protocolCandidateText(raw);
  const match = lastStatusMatch(text);
  if (!match?.[1]) return null;

  const status = match[1].toUpperCase();
  const fields = parseMarkerFields(text.slice(match.index));
  const payload = buildMarkerPayload(status, fields);
  assignOptionalMarkerFields(payload, fields);
  payload.text += `\n# ${markerSummary(status, fields)}`;
  return payload;
}

function lastStatusMatch(text: string): RegExpExecArray | null {
  const statusRe = /CHATFREEPT_STATUS\s*:\s*(CONTINUE|NEEDS_INPUT|PLAN_READY|COMPLETE|ERROR)\b/gi;
  let match: RegExpExecArray | null = null;
  for (let next = statusRe.exec(text); next; next = statusRe.exec(text)) match = next;
  return match;
}

function parseMarkerFields(tail: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of tail.split(/\r?\n/).slice(1, 10)) {
    const field = /^\s*(V|PHASE|REPO|ITEM|NOTE|URL)\s*:\s*(.+?)\s*$/.exec(line);
    if (!field?.[1] || !field[2]) continue;
    fields[field[1].toUpperCase()] = field[2].replace(/\\n/g, " ").trim();
  }
  return fields;
}

function buildMarkerPayload(status: string, fields: Record<string, string>): MarkerPayload {
  const keys = ["V", "PHASE", "REPO", "ITEM", "NOTE", "URL"];
  const lines = keys.flatMap((key) => (fields[key] ? [`${key}: ${fields[key]}`] : []));
  return {
    status,
    version: Number.parseInt(fields["V"] ?? "1", 10) || 1,
    text: [`CHATFREEPT_STATUS: ${status}`, ...lines].join("\n"),
  };
}

function assignOptionalMarkerFields(payload: MarkerPayload, fields: Record<string, string>): void {
  if (fields["PHASE"]) payload.phase = fields["PHASE"];
  if (fields["REPO"]) payload.repo = fields["REPO"];
  if (fields["ITEM"]) payload.item = fields["ITEM"];
  if (fields["NOTE"]) payload.note = fields["NOTE"];
  if (fields["URL"]) payload.url = fields["URL"];
}

async function inspectConversationResponse(response: Response, requestId: string): Promise<void> {
  try {
    const raw = await response.text();
    emit({ event: "generation-complete", requestId, marker: extractMarker(raw) });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    emit({
      event: "generation-aborted",
      requestId,
      reason: name || "response-read-failed",
    });
  }
}

async function inspectStreamStatus(response: Response, requestId: string): Promise<void> {
  try {
    const body = (await response.json()) as { status?: unknown };
    if (typeof body.status === "string") {
      emit({ event: "stream-status", requestId, status: body.status.toUpperCase() });
    }
  } catch {
    // Status polling is only a fallback signal.
  }
}

function install(): void {
  if (installed) return;
  installed = true;
  const nativeFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = pathname(input);
    const verb = method(input, init);
    const requestId = nextRequestId();
    const isConversation = verb === "POST" && path === "/backend-api/f/conversation";
    const isStop = verb === "POST" && path === "/backend-api/stop_conversation";
    const isStreamStatus =
      verb === "GET" && /\/backend-api\/conversation\/[^/]+\/stream_status$/.test(path);

    if (isConversation) emit({ event: "generation-start", requestId });
    if (isStop) emit({ event: "generation-interrupted", requestId, reason: "stop_conversation" });

    try {
      const response = await nativeFetch(input, init);
      if (isConversation) void inspectConversationResponse(response.clone(), requestId);
      if (isStreamStatus) void inspectStreamStatus(response.clone(), requestId);
      return response;
    } catch (error) {
      if (isConversation) {
        const name = error instanceof Error ? error.name : "fetch-failed";
        emit({ event: "generation-aborted", requestId, reason: name });
      }
      throw error;
    }
  };
}

if (!window.__CFPT_CHAT_STATE_BRIDGE__) {
  window.__CFPT_CHAT_STATE_BRIDGE__ = true;
  install();
}
