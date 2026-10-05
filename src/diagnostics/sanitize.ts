const SENSITIVE_KEY_RE =
  /authorization|cookie|token|secret|password|credential|api[-_]?key|session|csrf|jwt/i;
const SEMANTIC_KEY_RE =
  /^(status|state|type|event|role|recipient|end_turn|finished|complete|is_complete|stop_reason|finish_reason)$/i;
const ID_SEGMENT_RE =
  /^(?:[0-9a-f]{20,}|[0-9a-f]{8}-[0-9a-f-]{20,}|eyJ[A-Za-z0-9._-]{16,}|[A-Za-z0-9_-]{28,})$/i;
const MAX_KEYS = 40;
const MAX_SIGNALS = 80;

export interface DiagnosticValueSummary {
  kind: string;
  length?: number;
  hash?: string;
  keys?: string[];
  entries?: string[];
}

export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function summarizeString(text: string): DiagnosticValueSummary {
  return { kind: "string", length: text.length, hash: hashText(text) };
}

export function redactUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input, "https://chatgpt.com");
  } catch {
    return "[invalid-url]";
  }
  const path = parsed.pathname
    .split("/")
    .map((segment) => (ID_SEGMENT_RE.test(segment) ? "[id]" : segment))
    .join("/");
  const keys = Array.from(parsed.searchParams.keys());
  const query = keys.length > 0 ? `?${keys.map((key) => `${encodeURIComponent(key)}=[redacted]`).join("&")}` : "";
  return `${parsed.origin}${path}${query}`;
}

export function safeError(error: unknown): { name: string; message: DiagnosticValueSummary } {
  if (error instanceof Error) {
    return { name: error.name, message: summarizeString(error.message) };
  }
  return { name: typeof error, message: summarizeString(String(error)) };
}

export function summarizeUnknown(value: unknown): DiagnosticValueSummary {
  if (value === null) return { kind: "null" };
  if (value === undefined) return { kind: "undefined" };
  if (typeof value === "string") return summarizeString(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return { kind: typeof value };
  }
  if (value instanceof URLSearchParams) {
    return { kind: "url-search-params", keys: unique(Array.from(value.keys())) };
  }
  if (typeof FormData !== "undefined" && value instanceof FormData) {
    return { kind: "form-data", keys: unique(Array.from(value.keys())) };
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return { kind: "blob", length: value.size };
  }
  if (value instanceof ArrayBuffer) return { kind: "array-buffer", length: value.byteLength };
  if (ArrayBuffer.isView(value)) return { kind: "typed-array", length: value.byteLength };
  if (Array.isArray(value)) return { kind: "array", length: value.length };
  if (typeof value === "object") {
    return { kind: "object", keys: safeKeys(value as Record<string, unknown>) };
  }
  return { kind: typeof value };
}

export function summarizeBody(value: unknown): DiagnosticValueSummary {
  if (typeof value !== "string") return summarizeUnknown(value);
  const base = summarizeString(value);
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return base;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return { ...base, kind: "json-array", length: parsed.length };
    if (parsed && typeof parsed === "object") {
      return { ...base, kind: "json-object", keys: safeKeys(parsed as Record<string, unknown>) };
    }
  } catch {
    // The raw body is intentionally never returned.
  }
  return base;
}

export function summarizeResponseText(
  text: string,
  contentType: string,
): DiagnosticValueSummary & { semanticSignals?: Record<string, unknown>[] } {
  const base = summarizeString(text);
  const semanticSignals = extractSemanticSignals(text, contentType);
  return semanticSignals.length > 0 ? { ...base, semanticSignals } : base;
}

export function safeHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (SENSITIVE_KEY_RE.test(key)) return;
    if (/content-type|content-length|x-request-id|openai-processing-ms|server-timing/i.test(key)) {
      out[key] = value.length <= 180 ? value : `[length:${value.length}]`;
    }
  });
  return out;
}

function extractSemanticSignals(text: string, contentType: string): Record<string, unknown>[] {
  const values: unknown[] = [];
  if (/text\/event-stream/i.test(contentType)) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        values.push(JSON.parse(data));
      } catch {
        // Non-JSON SSE frames are summarized only by the response hash/length.
      }
      if (values.length >= 200) break;
    }
  } else if (/json/i.test(contentType) || /^[\s]*[{[]/.test(text)) {
    try {
      values.push(JSON.parse(text));
    } catch {
      // Invalid JSON is intentionally not retained.
    }
  }
  const signals: Record<string, unknown>[] = [];
  for (const value of values) collectSignals(value, "$", signals, 0);
  return signals.slice(0, MAX_SIGNALS);
}

function collectSignals(
  value: unknown,
  path: string,
  signals: Record<string, unknown>[],
  depth: number,
): void {
  if (signals.length >= MAX_SIGNALS || depth > 6 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (let i = 0; i < Math.min(value.length, 20); i += 1) {
      collectSignals(value[i], `${path}[${i}]`, signals, depth + 1);
    }
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(key)) continue;
    const nextPath = `${path}.${key}`;
    if (SEMANTIC_KEY_RE.test(key) && isSafeScalar(child)) {
      signals.push({ path: nextPath, value: child });
    }
    collectSignals(child, nextPath, signals, depth + 1);
    if (signals.length >= MAX_SIGNALS) return;
  }
}

function isSafeScalar(value: unknown): value is string | number | boolean | null {
  if (value === null || typeof value === "number" || typeof value === "boolean") return true;
  return typeof value === "string" && value.length <= 80 && /^[\w .:/-]+$/.test(value);
}

function safeKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value)
    .filter((key) => !SENSITIVE_KEY_RE.test(key))
    .slice(0, MAX_KEYS);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values)).slice(0, MAX_KEYS);
}
