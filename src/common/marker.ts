import type { Marker, MarkerStatus } from "./types";

const STATUS_LINE =
  /CHATFREEPT_STATUS\s*:\s*(CONTINUE|NEEDS(?:[_ -]+)INPUT|PLAN(?:[_ -]+)READY|TESTING|COMPLETE|ERROR)\b/gi;
const FIELD_LINE = /^\s*(V|PHASE|REPO|ITEM|NOTE|URL)\s*:\s*(.+?)\s*$/i;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

const STATUS_LABEL: Record<MarkerStatus, string> = {
  CONTINUE: "Continue",
  NEEDS_INPUT: "Needs input",
  PLAN_READY: "Plan ready",
  TESTING: "Testing",
  COMPLETE: "Complete",
  ERROR: "Error",
};

/**
 * Parse the Chat FreePT status marker from an assistant message.
 *
 * New prompts use human-readable values such as "Needs input" and "Plan ready".
 * Legacy underscore forms remain accepted so existing conversations keep working.
 * The LAST status line wins when the protocol is quoted earlier in a reply.
 */
export function parseMarker(text: string): Marker | null {
  if (!text) return null;
  let last: RegExpExecArray | null = null;
  STATUS_LINE.lastIndex = 0;
  for (let match = STATUS_LINE.exec(text); match !== null; match = STATUS_LINE.exec(text)) {
    last = match;
  }
  if (!last) return null;

  const status = normalizeStatus(last[1] ?? "");
  if (!status) return null;

  const tail = text.slice(last.index);
  const lines = tail.split("\n").slice(1);
  const marker: Marker = { status, version: 1, raw: firstLine(tail) };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed === "```") continue;
    const field = FIELD_LINE.exec(line);
    if (!field) break;
    applyField(marker, field[1] ?? "", field[2] ?? "");
  }
  marker.raw = summarize(marker);
  return marker;
}

function applyField(marker: Marker, key: string, value: string): void {
  switch (key.toUpperCase()) {
    case "V": {
      const version = Number.parseInt(value, 10);
      if (Number.isFinite(version)) marker.version = version;
      return;
    }
    case "PHASE":
      marker.phase = value;
      return;
    case "REPO":
      if (REPO_RE.test(value)) marker.repo = value;
      return;
    case "ITEM":
      marker.item = value;
      return;
    case "NOTE":
      marker.note = value;
      return;
    case "URL":
      marker.url = value;
  }
}

function normalizeStatus(value: string): MarkerStatus | null {
  const normalized = value.trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ").toUpperCase();
  switch (normalized) {
    case "CONTINUE":
      return "CONTINUE";
    case "NEEDS INPUT":
      return "NEEDS_INPUT";
    case "PLAN READY":
      return "PLAN_READY";
    case "TESTING":
      return "TESTING";
    case "COMPLETE":
      return "COMPLETE";
    case "ERROR":
      return "ERROR";
    default:
      return null;
  }
}

function firstLine(text: string): string {
  const idx = text.indexOf("\n");
  return idx === -1 ? text : text.slice(0, idx);
}

function summarize(marker: Marker): string {
  const parts: string[] = [STATUS_LABEL[marker.status]];
  if (marker.phase) parts.push(`phase=${marker.phase}`);
  if (marker.repo) parts.push(`repo=${marker.repo}`);
  if (marker.item) parts.push(`item=${marker.item}`);
  if (marker.note) parts.push(`note=${marker.note}`);
  return parts.join(" ");
}
