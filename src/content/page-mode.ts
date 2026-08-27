export type ChatGptPageMode = "composer" | "plugins" | "utility";

const UTILITY_PATH_PREFIXES = ["/library", "/scheduled"];

/**
 * ChatGPT has first-party pages where the conversation composer is intentionally absent.
 * Treating those pages as selector failures creates false warnings and blocks the setup guide.
 */
export function chatGptPageMode(href: string): ChatGptPageMode {
  let url: URL;
  try {
    url = new URL(href, "https://chatgpt.com");
  } catch {
    return "composer";
  }

  if (url.pathname === "/plugins" || url.pathname.startsWith("/plugins/")) return "plugins";
  if (
    UTILITY_PATH_PREFIXES.some(
      (prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`),
    )
  ) {
    return "utility";
  }
  return "composer";
}
