import { normalizeRepositoryInput } from "./repository";
import { normalizeSettings } from "./settings";
import type { RunState, Settings } from "./types";

const SETTINGS_KEY = "cfpt:settings";

/**
 * In content scripts, Chrome may temporarily omit chrome.storage while runtime
 * messaging is still available. Delegate only FreePT storage keys to the worker.
 * Never fall back to page localStorage: run and lock state must stay extension-owned.
 */
export async function extensionStorage(
  area: "sync" | "local",
  operation: "get" | "set" | "remove",
  payload: string | string[] | Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const native = globalThis.chrome?.storage?.[area];
  const method = native?.[operation];
  if (typeof method === "function") {
    if (operation === "get") return (await native.get(payload as string | string[])) as Record<string, unknown>;
    if (operation === "set") await native.set(payload as Record<string, unknown>);
    if (operation === "remove") await native.remove(payload as string | string[]);
    return {};
  }
  if (typeof globalThis.chrome?.runtime?.sendMessage !== "function") {
    throw new Error("Extension context invalidated: Chrome storage and messaging unavailable. Reload ChatGPT.");
  }
  const response = (await chrome.runtime.sendMessage({
    type: "cfpt-storage",
    area,
    operation,
    payload,
  })) as { ok?: boolean; value?: Record<string, unknown>; error?: string } | undefined;
  if (!response?.ok) {
    throw new Error(`Extension context invalidated: FreePT storage service unavailable (${response?.error ?? "no response"}). Reload ChatGPT.`);
  }
  return response.value ?? {};
}
const RUN_PREFIX = "cfpt:run:";

export async function loadSettings(): Promise<Settings> {
  const found = await extensionStorage("sync", "get", SETTINGS_KEY);
  return normalizeSettings(found[SETTINGS_KEY]);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await extensionStorage("sync", "set", { [SETTINGS_KEY]: normalizeSettings(settings) });
}

export function runKey(conversationId: string): string {
  return `${RUN_PREFIX}${conversationId}`;
}

export async function loadRun(conversationId: string): Promise<RunState | null> {
  const key = runKey(conversationId);
  const found = await extensionStorage("local", "get", key);
  const state = found[key] as RunState | undefined;
  return state && state.v === 1 ? normalizeRunRepositoryState(state) : null;
}

export async function saveRun(state: RunState): Promise<void> {
  const normalized = normalizeRunRepositoryState(state);
  await extensionStorage("local", "set", { [runKey(normalized.conversationId)]: normalized });
}

function normalizeRunRepositoryState(state: RunState): RunState {
  const continuous = { ...state, autoContinueEnabled: true };
  const lockedRepo = continuous.repo ? normalizeRepositoryInput(continuous.repo) : null;
  if (lockedRepo) {
    return { ...continuous, repo: lockedRepo, repoName: lockedRepo, repoMode: "existing" };
  }

  const draftRepo = normalizeRepositoryInput(continuous.repoName);
  if (draftRepo) return { ...continuous, repoName: draftRepo, repoMode: "existing" };
  return continuous;
}

export async function deleteRun(conversationId: string): Promise<void> {
  await extensionStorage("local", "remove", runKey(conversationId));
}

const LOCK_PREFIX = "cfpt:lock:";
const LOCK_STALE_MS = 15000;

interface TabLock {
  nonce: string;
  at: number;
}

function lockKey(conversationId: string): string {
  return `${LOCK_PREFIX}${conversationId}`;
}

/** One tab drives a conversation at a time; a lock is stale after 15s without heartbeat. */
export async function acquireTabLock(conversationId: string, nonce: string): Promise<boolean> {
  const key = lockKey(conversationId);
  const found = await extensionStorage("local", "get", key);
  const lock = found[key] as TabLock | undefined;
  if (lock && lock.nonce !== nonce && Date.now() - lock.at < LOCK_STALE_MS) return false;
  await extensionStorage("local", "set", { [key]: { nonce, at: Date.now() } satisfies TabLock });
  return true;
}

/** Refresh only a lock this tab still owns; never overwrite a newer owner after suspension. */
export async function heartbeatTabLock(conversationId: string, nonce: string): Promise<boolean> {
  const key = lockKey(conversationId);
  const found = await extensionStorage("local", "get", key);
  const lock = found[key] as TabLock | undefined;
  if (!lock || lock.nonce !== nonce) return false;
  await extensionStorage("local", "set", { [key]: { nonce, at: Date.now() } satisfies TabLock });
  return true;
}

export async function releaseTabLock(conversationId: string, nonce: string): Promise<void> {
  const key = lockKey(conversationId);
  const found = await extensionStorage("local", "get", key);
  const lock = found[key] as TabLock | undefined;
  if (lock && lock.nonce === nonce) await extensionStorage("local", "remove", key);
}

/**
 * A run started on a brand-new chat is keyed `pending:<uuid>` until ChatGPT assigns the
 * conversation its real /c/<uuid> URL; this rewrites the storage key in place.
 */
export async function migrateRunKey(state: RunState, newConversationId: string): Promise<RunState> {
  const old = state.conversationId;
  const next = normalizeRunRepositoryState({ ...state, conversationId: newConversationId });
  await saveRun(next);
  if (old !== newConversationId) await extensionStorage("local", "remove", runKey(old));
  return next;
}

/**
 * Move a pending run to its permanent conversation id without creating a second driver.
 * The caller already owns the old-id lock and must pause its old-id heartbeat while this
 * transfer runs.
 */
export async function adoptConversationOwnership(
  state: RunState,
  newConversationId: string,
  nonce: string,
): Promise<RunState | null> {
  const oldConversationId = state.conversationId;
  if (oldConversationId === newConversationId) return state;

  const acquired = await acquireTabLock(newConversationId, nonce);
  if (!acquired) return null;

  let migrated: RunState;
  try {
    migrated = await migrateRunKey(state, newConversationId);
  } catch (error) {
    await releaseTabLock(newConversationId, nonce);
    throw error;
  }

  await releaseTabLock(oldConversationId, nonce);
  return migrated;
}
