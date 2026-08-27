const ACTION_FENCE = "chatfreept_action";
const MAX_ACTION_BYTES = 256_000;
const ACTION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export const GITHUB_ACTIONS = [
  "get_me",
  "get_repo",
  "list_tree",
  "get_file",
  "create_repository",
  "create_branch",
  "put_file",
  "delete_file",
  "create_issue",
  "update_issue",
  "add_issue_comment",
  "create_label",
  "add_labels",
  "create_pull_request",
  "update_pull_request",
  "merge_pull_request",
  "get_commit_status",
  "list_workflow_runs",
  "list_workflow_jobs",
  "get_workflow_job_logs",
] as const;

export type GitHubActionName = (typeof GITHUB_ACTIONS)[number];

export interface GitHubActionRequest {
  v: 1;
  id: string;
  action: GitHubActionName;
  args: Record<string, unknown>;
}

export interface GitHubActionResult {
  v: 1;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

export type GitHubActionParseResult =
  | { ok: true; request: GitHubActionRequest }
  | { ok: false; error: string };

const ACTION_SET = new Set<string>(GITHUB_ACTIONS);

export class ActionReplayGuard {
  private readonly ids = new Set<string>();

  accept(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    return true;
  }

  clear(): void {
    this.ids.clear();
  }
}

export function parseGitHubActionFence(text: string): GitHubActionParseResult {
  const payload = extractLastFence(text, ACTION_FENCE);
  if (payload === null) return { ok: false, error: "missing chatfreept_action fence" };
  if (new TextEncoder().encode(payload).byteLength > MAX_ACTION_BYTES) {
    return { ok: false, error: "action payload exceeds size limit" };
  }

  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return { ok: false, error: "action payload is not valid JSON" };
  }

  if (!isRecord(value)) return { ok: false, error: "action payload must be an object" };
  if (value["v"] !== 1) return { ok: false, error: "unsupported action protocol version" };

  const id = value["id"];
  if (typeof id !== "string" || !ACTION_ID.test(id)) {
    return { ok: false, error: "invalid action id" };
  }

  const action = value["action"];
  if (typeof action !== "string" || !ACTION_SET.has(action)) {
    return { ok: false, error: "unknown GitHub action" };
  }

  const args = value["args"];
  if (!isRecord(args)) return { ok: false, error: "action args must be an object" };

  return {
    ok: true,
    request: {
      v: 1,
      id,
      action: action as GitHubActionName,
      args,
    },
  };
}

export function formatGitHubActionResult(result: GitHubActionResult): string {
  return `\`\`\`chatfreept_result\n${JSON.stringify(result)}\n\`\`\``;
}

function extractLastFence(text: string, language: string): string | null {
  const pattern = new RegExp(`\\\\`\\\\`\\\\`${language}\\s*\\n([\\s\\S]*?)\\n?\\\\`\\\\`\\\\``, "g");
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = pattern.exec(text)) !== null) last = match[1] ?? "";
  return last;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
