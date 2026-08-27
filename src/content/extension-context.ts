const INVALIDATED_CONTEXT_RE = /extension context invalidated/i;

export function isExtensionContextInvalidated(error: unknown): boolean {
  if (error instanceof Error) return INVALIDATED_CONTEXT_RE.test(error.message);
  return typeof error === "string" && INVALIDATED_CONTEXT_RE.test(error);
}

export interface ExtensionContextGuard {
  readonly invalidated: boolean;
  invalidate(): void;
  handle(error: unknown): boolean;
}

/**
 * Chrome leaves already-injected content scripts alive when an extension is reloaded or
 * disabled, but their chrome.* context is dead. Treat that state as terminal and dispose
 * the stale instance exactly once instead of retrying extension APIs forever.
 */
export function createExtensionContextGuard(onInvalidated: () => void): ExtensionContextGuard {
  let invalidated = false;
  const invalidate = (): void => {
    if (invalidated) return;
    invalidated = true;
    onInvalidated();
  };

  return {
    get invalidated(): boolean {
      return invalidated;
    },
    invalidate,
    handle(error: unknown): boolean {
      if (!isExtensionContextInvalidated(error)) return false;
      invalidate();
      return true;
    },
  };
}
