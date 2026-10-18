import { handleStorageRequest } from "./storage-broker";
import type { BgRequest, ContentRequest } from "../common/types";

/**
 * Deliberately thin: MV3 kills service workers at will, so no orchestration state lives
 * here. All logic runs in the content script; this worker only renders notifications and
 * the toolbar badge, and relays the toolbar click.
 */
chrome.runtime.onMessage.addListener((message: BgRequest, sender) => {
  switch (message.type) {
    case "notify": {
      void chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: message.title,
        message: message.message,
      });
      break;
    }
    case "badge": {
      const tabId = sender.tab?.id;
      void chrome.action.setBadgeBackgroundColor({ color: "#10a37f" });
      if (tabId !== undefined) {
        void chrome.action.setBadgeText({ text: message.text, tabId });
      } else {
        void chrome.action.setBadgeText({ text: message.text });
      }
      break;
    }
  }
});

chrome.action.onClicked.addListener((tab) => {
  const url = tab.url ?? "";
  if (tab.id !== undefined && /https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(url)) {
    const message: ContentRequest = { type: "toggle-panel" };
    void chrome.tabs.sendMessage(tab.id, message).catch(() => {
      void chrome.runtime.openOptionsPage();
    });
  } else {
    void chrome.runtime.openOptionsPage();
  }
});

/** Keep the response channel open while the privileged worker completes the request. */
chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  if (!message || typeof message !== "object" ||
      (message as { type?: string }).type !== "cfpt-storage") return false;
  void handleStorageRequest(message, sender.tab?.url ?? "")
    .then(respond, () => respond({ ok: false, error: "storage service failed" }));
  return true;
});
