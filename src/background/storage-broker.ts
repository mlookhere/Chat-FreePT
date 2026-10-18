/** Extension-only storage RPC for content scripts without a chrome.storage namespace. */
export interface StorageRequest {
  type: "cfpt-storage";
  area: "local" | "sync";
  operation: "get" | "set" | "remove";
  payload: string | string[] | Record<string, unknown>;
}

export interface StorageResponse {
  ok: boolean;
  value?: Record<string, unknown>;
  error?: string;
}

function allowedSender(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname === "chatgpt.com" || parsed.hostname === "chat.openai.com")
    );
  } catch {
    return false;
  }
}

function requestKeys(request: Partial<StorageRequest>): unknown[] {
  const payload = request.payload;
  if (request.operation === "set") {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
    return Object.keys(payload);
  }
  return Array.isArray(payload) ? payload : [payload];
}

function allowedKey(area: StorageRequest["area"], key: unknown): boolean {
  return (
    typeof key === "string" &&
    key.startsWith("cfpt:") &&
    key.length <= 230 &&
    (area === "local" || key === "cfpt:settings")
  );
}

export function validStorageRequest(value: unknown, senderUrl: string): value is StorageRequest {
  if (!allowedSender(senderUrl) || !value || typeof value !== "object") return false;
  const request = value as Partial<StorageRequest>;
  if (request.type !== "cfpt-storage") return false;
  if (request.area !== "local" && request.area !== "sync") return false;
  if (request.operation !== "get" && request.operation !== "set" && request.operation !== "remove")
    return false;
  if (request.area === "sync" && request.operation === "remove") return false;

  const keys = requestKeys(request);
  return (
    keys.length > 0 && keys.length <= 50 && keys.every((key) => allowedKey(request.area!, key))
  );
}

export async function handleStorageRequest(
  message: unknown,
  senderUrl: string,
): Promise<StorageResponse> {
  if (!validStorageRequest(message, senderUrl))
    return { ok: false, error: "invalid storage request" };
  try {
    const store = chrome.storage?.[message.area];
    if (!store) return { ok: false, error: "browser storage unavailable" };
    if (message.operation === "get") {
      const value = await store.get(message.payload as string | string[]);
      return { ok: true, value };
    }
    if (message.operation === "set") {
      await store.set(message.payload as Record<string, unknown>);
    } else {
      await store.remove(message.payload as string | string[]);
    }
    return { ok: true, value: {} };
  } catch {
    return { ok: false, error: "storage operation failed" };
  }
}
