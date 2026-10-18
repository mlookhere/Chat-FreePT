import { normalizeSettings, SETTINGS_LIMITS } from "../common/settings";
import { loadSettings, saveSettings } from "../common/storage";
import type { Settings } from "../common/types";

/**
 * Options pages are extension pages (not ChatGPT tabs); they cannot use the
 * content-script RPC broker. Prefer synced settings, then native local storage.
 */
async function readOptionsSettings(): Promise<Settings> {
  const area = chrome.storage?.sync ?? chrome.storage?.local;
  if (!area) return loadSettings();
  const found = await area.get("cfpt:settings");
  return normalizeSettings(found["cfpt:settings"]);
}

async function writeOptionsSettings(settings: Settings): Promise<void> {
  const area = chrome.storage?.sync ?? chrome.storage?.local;
  if (!area) return saveSettings(settings);
  await area.set({ "cfpt:settings": normalizeSettings(settings) });
}

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element #${id}`);
  return found as T;
}

function setBounds(id: string, min: number, max: number): void {
  const input = el<HTMLInputElement>(id);
  input.min = String(min);
  input.max = String(max);
}

function render(settings: Settings): void {
  el<HTMLTextAreaElement>("continueMessage").value = settings.continueMessage;
  el<HTMLInputElement>("sendDelaySec").value = String(Math.round(settings.sendDelayMs / 1000));
  el<HTMLInputElement>("quietSec").value = String(Math.round(settings.quietMs / 1000));
  el<HTMLInputElement>("templateRepo").value = settings.templateRepo;
  el<HTMLInputElement>("notificationsEnabled").checked = settings.notificationsEnabled;
}

function configureBounds(): void {
  setBounds(
    "sendDelaySec",
    SETTINGS_LIMITS.sendDelayMs.min / 1000,
    SETTINGS_LIMITS.sendDelayMs.max / 1000,
  );
  setBounds("quietSec", SETTINGS_LIMITS.quietMs.min / 1000, SETTINGS_LIMITS.quietMs.max / 1000);
}

async function init(): Promise<void> {
  configureBounds();
  let settings = await readOptionsSettings();
  render(settings);

  el<HTMLButtonElement>("save").addEventListener("click", () => {
    void (async () => {
      const next = normalizeSettings({
        ...settings,
        continueMessage: el<HTMLTextAreaElement>("continueMessage").value,
        sendDelayMs: el<HTMLInputElement>("sendDelaySec").valueAsNumber * 1000,
        quietMs: el<HTMLInputElement>("quietSec").valueAsNumber * 1000,
        templateRepo: el<HTMLInputElement>("templateRepo").value,
        notificationsEnabled: el<HTMLInputElement>("notificationsEnabled").checked,
      });
      await writeOptionsSettings(next);
      settings = next;
      render(settings);

      const status = el<HTMLSpanElement>("status");
      status.textContent = "Saved";
      setTimeout(() => {
        status.textContent = "";
      }, 2000);
    })();
  });
}

void init();
