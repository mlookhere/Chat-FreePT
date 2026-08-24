import type { RunState, Settings } from "./types";
import { DEFAULT_SETTINGS } from "./types";

const SETTINGS_KEY = "cfpt:settings";
const RUN_PREFIX = "cfpt:run:";

export async function loadSettings(): Promise<Settings> {
  const found = await chrome.storage.sync.get(SETTINGS_KEY);
  const stored = found[SETTINGS_KEY] as Partial<Settings> | undefined;
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
}

export function runKey(conversationId: string): string {
  return `${RUN_PREFIX}${conversationId}`;
}

export async function loadRun(conversationId: string): Promise<RunState | null> {
  const key = runKey(conversationId);
  const found = await chrome.storage.local.get(key);
  const state = found[key] as RunState | undefined;
  return state && state.v === 1 ? state : null;
}

export async function saveRun(state: RunState): Promise<void> {
  await chrome.storage.local.set({ [runKey(state.conversationId)]: state });
}

export async function deleteRun(conversationId: string): Promise<void> {
  await chrome.storage.local.remove(runKey(conversationId));
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
  const found = await chrome.storage.local.get(key);
  const lock = found[key] as TabLock | undefined;
  if (lock && lock.nonce !== nonce && Date.now() - lock.at < LOCK_STALE_MS) return false;
  await chrome.storage.local.set({ [key]: { nonce, at: Date.now() } satisfies TabLock });
  return true;
}

export async function heartbeatTabLock(conversationId: string, nonce: string): Promise<void> {
  await chrome.storage.local.set({
    [lockKey(conversationId)]: { nonce, at: Date.now() } satisfies TabLock,
  });
}

export async function releaseTabLock(conversationId: string, nonce: string): Promise<void> {
  const key = lockKey(conversationId);
  const found = await chrome.storage.local.get(key);
  const lock = found[key] as TabLock | undefined;
  if (lock && lock.nonce === nonce) await chrome.storage.local.remove(key);
}

/**
 * A run started on a brand-new chat is keyed `pending:<uuid>` until ChatGPT assigns the
 * conversation its real /c/<uuid> URL; this rewrites the storage key in place.
 */
export async function migrateRunKey(state: RunState, newConversationId: string): Promise<RunState> {
  const old = state.conversationId;
  const next: RunState = { ...state, conversationId: newConversationId };
  await chrome.storage.local.set({ [runKey(newConversationId)]: next });
  if (old !== newConversationId) await chrome.storage.local.remove(runKey(old));
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
