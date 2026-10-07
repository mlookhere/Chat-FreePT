const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]+$/;

/** Normalize owner/name or a root GitHub repository URL to owner/name. */
export function normalizeRepositoryInput(input: string): string | null {
  const value = input.trim();
  if (!value) return null;

  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (!/^(?:www\.)?github\.com$/i.test(url.hostname)) return null;
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length !== 2) return null;
      return normalizeParts(parts[0] ?? "", parts[1] ?? "");
    } catch {
      return null;
    }
  }

  const parts = value.split("/");
  if (parts.length !== 2) return null;
  return normalizeParts(parts[0] ?? "", parts[1] ?? "");
}

function normalizeParts(ownerRaw: string, repoRaw: string): string | null {
  const owner = ownerRaw.trim();
  const repo = repoRaw.trim().replace(/\.git$/i, "");
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) return null;
  return `${owner}/${repo}`;
}
