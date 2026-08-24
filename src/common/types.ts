/** Conversation-level lifecycle. `plan_ready` waits for the user to press Start development. */
export type Phase = "idle" | "planning" | "plan_ready" | "developing" | "complete" | "stopped";

/** What the extension is doing right now inside a phase. */
export type RunStatus =
  | "idle"
  | "inserting"
  | "sending"
  | "streaming"
  | "cooldown"
  | "awaiting_user"
  | "paused"
  | "error"
  | "complete";

export type MarkerStatus = "CONTINUE" | "NEEDS_INPUT" | "PLAN_READY" | "COMPLETE" | "ERROR";

/** Parsed from the fenced `chatfreept` block at the tail of the last assistant message. */
export interface Marker {
  status: MarkerStatus;
  version: number;
  phase?: string;
  repo?: string;
  item?: string;
  note?: string;
  url?: string;
  /** The exact text the marker was parsed from, for the activity log. */
  raw: string;
}

export type PageSignal = "rate-limit" | "logged-out" | "network-error" | "conversation-full";

export type ErrorCode =
  | "composer-insert-failed"
  | "send-failed"
  | "stream-stuck"
  | "rate-limited"
  | "logged-out"
  | "network-error"
  | "marker-missing"
  | "cap-reached"
  | "selector-broken"
  | "conversation-full";

export type RepoMode = "new" | "existing";

export interface ActivityEntry {
  at: number;
  kind: "info" | "send" | "marker" | "warn" | "error";
  text: string;
}

export interface RunState {
  v: 1;
  conversationId: string;
  phase: Phase;
  status: RunStatus;
  idea: string;
  repoMode: RepoMode;
  /** Repo the user named (existing mode) or suggested name (new mode). May be empty. */
  repoName: string;
  /** owner/name once ChatGPT reports it in a marker. */
  repo?: string;
  lastMarker?: Marker;
  planSummary?: string;
  pauseReason?: string;
  errorCode?: ErrorCode;
  /** Auto-sends used in the current phase (cap enforced per phase). */
  autoSends: number;
  /** Marker-recovery nudges since the last successful marker parse. Max 1. */
  nudges: number;
  /** Assistant replies since the last full-contract injection (refresh every N). */
  repliesSinceContract: number;
  startedAt: number;
  updatedAt: number;
  log: ActivityEntry[];
}

export interface Settings {
  v: 1;
  continueMessage: string;
  autoContinueCap: number;
  sendDelayMs: number;
  /** Quiet time after the last mutation before a reply counts as finished. */
  quietMs: number;
  /** Quiet time while a tool-call indicator is visible (MCP calls stall token output). */
  toolQuietMs: number;
  maxStreamMinutes: number;
  /** Re-inject the compact operating contract every N auto-continues. */
  contractRefreshEvery: number;
  notificationsEnabled: boolean;
  /** owner/name of the repo holding the CI-Pipline control plane template. */
  templateRepo: string;
}

export const DEFAULT_SETTINGS: Settings = {
  v: 1,
  continueMessage: "continue. (End with your CHATFREEPT status block.)",
  autoContinueCap: 50,
  sendDelayMs: 8000,
  quietMs: 3000,
  toolQuietMs: 10000,
  maxStreamMinutes: 20,
  contractRefreshEvery: 12,
  notificationsEnabled: true,
  templateRepo: "mlookhere/CI-Pipline",
};

/** Messages from content script to the background service worker. */
export type BgRequest =
  { type: "notify"; title: string; message: string } | { type: "badge"; text: string };

/** Messages from the background service worker to the content script. */
export type ContentRequest = { type: "toggle-panel" };
