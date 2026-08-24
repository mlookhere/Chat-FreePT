import { loadSettings, saveSettings } from "../common/storage";
import type { Settings } from "../common/types";

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element #${id}`);
  return found as T;
}

async function init(): Promise<void> {
  const settings = await loadSettings();
  el<HTMLTextAreaElement>("continueMessage").value = settings.continueMessage;
  el<HTMLInputElement>("autoContinueCap").value = String(settings.autoContinueCap);
  el<HTMLInputElement>("sendDelaySec").value = String(Math.round(settings.sendDelayMs / 1000));
  el<HTMLInputElement>("quietSec").value = String(Math.round(settings.quietMs / 1000));
  el<HTMLInputElement>("templateRepo").value = settings.templateRepo;
  el<HTMLInputElement>("notificationsEnabled").checked = settings.notificationsEnabled;

  el<HTMLButtonElement>("save").addEventListener("click", () => {
    void (async () => {
      const next: Settings = {
        ...settings,
        continueMessage: el<HTMLTextAreaElement>("continueMessage").value.trim(),
        autoContinueCap: clamp(Number(el<HTMLInputElement>("autoContinueCap").value), 1, 500),
        sendDelayMs: clamp(Number(el<HTMLInputElement>("sendDelaySec").value), 2, 600) * 1000,
        quietMs: clamp(Number(el<HTMLInputElement>("quietSec").value), 1, 60) * 1000,
        templateRepo: el<HTMLInputElement>("templateRepo").value.trim(),
        notificationsEnabled: el<HTMLInputElement>("notificationsEnabled").checked,
      };
      await saveSettings(next);
      const status = el<HTMLSpanElement>("status");
      status.textContent = "Saved";
      setTimeout(() => {
        status.textContent = "";
      }, 2000);
    })();
  });
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

void init();
