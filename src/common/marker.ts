import type { Marker, MarkerStatus } from "./types";

const STATUSES: readonly MarkerStatus[] = [
  "CONTINUE",
  "NEEDS_INPUT",
  "PLAN_READY",
  "COMPLETE",
  "ERROR",
];

const STATUS_LINE = /CHATFREEPT_STATUS\s*:\s*(CONTINUE|NEEDS_INPUT|PLAN_READY|COMPLETE|ERROR)\b/gi;
const FIELD_LINE = /^\s*(V|PHASE|REPO|ITEM|NOTE|URL)\s*:\s*(.+?)\s*$/i;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/**
 * Parse the Chat FreePT status marker from an assistant message.
 *
 * The protocol asks for a fenced code block whose first line is
 * `CHATFREEPT_STATUS: <STATUS>` followed by optional `KEY: value` lines, but the parser
 * works from the message's plain text so it also survives the block being rendered as a
 * paragraph. The assistant sometimes quotes the protocol spec earlier in a reply, so the
 * LAST status line wins.
 */
export function parseMarker(text: string): Marker | null {
  if (!text) return null;
  let last: RegExpExecArray | null = null;
  STATUS_LINE.lastIndex = 0;
  for (let match = STATUS_LINE.exec(text); match !== null; match = STATUS_LINE.exec(text)) {
    last = match;
  }
  if (!last) return null;

  const status = last[1]?.toUpperCase() as MarkerStatus | undefined;
  if (!status || !STATUSES.includes(status)) return null;

  const tail = text.slice(last.index);
  const lines = tail.split("\n").slice(1);
  const marker: Marker = { status, version: 1, raw: firstLine(tail) };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed === "```") continue;
    const field = FIELD_LINE.exec(line);
    if (!field) break;
    const key = field[1]?.toUpperCase();
    const value = field[2] ?? "";
    switch (key) {
      case "V": {
        const version = Number.parseInt(value, 10);
        if (Number.isFinite(version)) marker.version = version;
        break;
      }
      case "PHASE":
        marker.phase = value;
        break;
      case "REPO":
        if (REPO_RE.test(value)) marker.repo = value;
        break;
      case "ITEM":
        marker.item = value;
        break;
      case "NOTE":
        marker.note = value;
        break;
      case "URL":
        marker.url = value;
        break;
    }
  }
  marker.raw = summarize(marker);
  return marker;
}

function firstLine(text: string): string {
  const idx = text.indexOf("\n");
  return idx === -1 ? text : text.slice(0, idx);
}

function summarize(marker: Marker): string {
  const parts: string[] = [marker.status];
  if (marker.phase) parts.push(`phase=${marker.phase}`);
  if (marker.repo) parts.push(`repo=${marker.repo}`);
  if (marker.item) parts.push(`item=${marker.item}`);
  if (marker.note) parts.push(`note=${marker.note}`);
  return parts.join(" ");
}
