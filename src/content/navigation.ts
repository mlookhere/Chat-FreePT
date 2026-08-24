const CONV_RE = /\/c\/([0-9a-f-]{20,})/i;
const POLL_MS = 500;

export function conversationIdFromUrl(href: string): string | null {
  return CONV_RE.exec(href)?.[1] ?? null;
}

/**
 * The page's React router calls the page-world History object, which an isolated-world
 * content script cannot patch — so navigation is detected by polling location plus the
 * events that do cross worlds.
 */
export function watchNavigation(onChange: (href: string) => void): () => void {
  let last = location.href;
  const check = (): void => {
    if (location.href !== last) {
      last = location.href;
      onChange(last);
    }
  };
  const timer = setInterval(check, POLL_MS);
  window.addEventListener("popstate", check);
  window.addEventListener("hashchange", check);
  return () => {
    clearInterval(timer);
    window.removeEventListener("popstate", check);
    window.removeEventListener("hashchange", check);
  };
}
