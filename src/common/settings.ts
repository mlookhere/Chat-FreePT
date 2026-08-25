import { DEFAULT_SETTINGS, type Settings } from "./types";

export const SETTINGS_LIMITS = {
  autoContinueCap: { min: 1, max: 500 },
  sendDelayMs: { min: 2_000, max: 600_000 },
  quietMs: { min: 1_000, max: 60_000 },
  toolQuietMs: { min: 1_000, max: 120_000 },
  maxStreamMinutes: { min: 1, max: 180 },
  contractRefreshEvery: { min: 1, max: 100 },
} as const;

type NumericSetting = keyof typeof SETTINGS_LIMITS;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function normalizedNumber(
  source: Record<string, unknown>,
  key: NumericSetting,
  fallback: number,
): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const { min, max } = SETTINGS_LIMITS[key];
  return Math.min(max, Math.max(min, value));
}

function normalizedString(
  source: Record<string, unknown>,
  key: "continueMessage" | "templateRepo",
  fallback: string,
): string {
  const value = source[key];
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizedBoolean(
  source: Record<string, unknown>,
  key: "notificationsEnabled",
  fallback: boolean,
): boolean {
  const value = source[key];
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeSettings(value: unknown): Settings {
  const source = asRecord(value);
  return {
    v: DEFAULT_SETTINGS.v,
    continueMessage: normalizedString(
      source,
      "continueMessage",
      DEFAULT_SETTINGS.continueMessage,
    ),
    autoContinueCap: normalizedNumber(
      source,
      "autoContinueCap",
      DEFAULT_SETTINGS.autoContinueCap,
    ),
    sendDelayMs: normalizedNumber(source, "sendDelayMs", DEFAULT_SETTINGS.sendDelayMs),
    quietMs: normalizedNumber(source, "quietMs", DEFAULT_SETTINGS.quietMs),
    toolQuietMs: normalizedNumber(source, "toolQuietMs", DEFAULT_SETTINGS.toolQuietMs),
    maxStreamMinutes: normalizedNumber(
      source,
      "maxStreamMinutes",
      DEFAULT_SETTINGS.maxStreamMinutes,
    ),
    contractRefreshEvery: normalizedNumber(
      source,
      "contractRefreshEvery",
      DEFAULT_SETTINGS.contractRefreshEvery,
    ),
    notificationsEnabled: normalizedBoolean(
      source,
      "notificationsEnabled",
      DEFAULT_SETTINGS.notificationsEnabled,
    ),
    templateRepo: normalizedString(source, "templateRepo", DEFAULT_SETTINGS.templateRepo),
  };
}
