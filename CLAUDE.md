# Repository engineering protocol

This repository is Chat FreePT, a Chrome MV3 extension embedded into chatgpt.com. It turns a
ChatGPT conversation into an autonomous development loop: the extension injects CI-pipeline
"skill" prompts, ChatGPT does all GitHub work itself through its GitHub MCP connector, and the
extension orchestrates the conversation (detects when streaming stops, reads a status marker,
auto-sends "continue", and shows a completion modal when the project is done).

The repository vendors the CI-Pipline control plane (`.claude/`, `ci/`, `workflow/`,
`scripts/`, `flow`, `.claude-workflow.json`, `.github/`). Do not edit vendored plane code
under `workflow/`, `ci/`, `scripts/`, or `.claude/hooks/` except to sync from upstream;
repository-specific behavior belongs in `.claude-workflow.json`, which is the consumer-owned
configuration.

## Control model

- One independently deliverable change equals one controlling GitHub Issue, one task branch
  (`work/<issue>-slug`), and one PR into `dev`.
- The Issue is current handoff truth. The PR is review truth. CI and immutable build
  evidence are acceptance truth.
- Never create handoff documents; update the controlling Issue instead.

## Layout

- `src/` — extension TypeScript. `src/content/` runs inside chatgpt.com, `src/background/`
  is the MV3 service worker, `src/options/` the options page, `src/common/` shared modules,
  `src/prompts/` the skill prompt templates.
- `tests/` — vitest unit tests (jsdom). DOM-driver tests run against fixture snapshots in
  `tests/fixtures/`.
- `scripts/build.mjs` — esbuild bundling into `dist/`; `npm run package` zips `dist/` into
  `artifacts/chat-freept.zip`.

## Engineering behavior

- Work on `work/ISSUE-slug`, never on `dev` or `master` directly.
- Trace the real execution path before editing. The chatgpt.com DOM is not ours: every
  selector lives in `src/content/selectors.ts` with ordered fallbacks, and nothing else may
  query the host page directly.
- Use the project logger (`src/common/log.ts`), never bare `console.log` — the quality gate
  rejects it in changed files.
- Do not retry the same failing command unchanged, weaken assertions, skip tests, or lower
  thresholds to make CI pass.
- Add regression coverage for behavior changes. Keep the smallest diff that fixes the stated
  defect; scope growth is a new Issue.
- Never expose credentials or tokens to prompts, logs, Issues, or artifacts. The extension
  itself must never hold GitHub credentials — ChatGPT's MCP connector owns all GitHub access.

## Gates

- During edits: targeted tests (`npx vitest run tests/<file>`).
- Before calling a change ready: `./ci/run fast`, then `./ci/run pr`.
- Pre-commit checks staged files; pre-push runs the fast gate. Neither replaces hosted CI.
  Run `./scripts/validate-workflow` after editing hooks, workflows, `ci/`, or
  `.claude-workflow.json`.

## Completion

- Claim completion only when the current commit has fresh gate evidence
  (`artifacts/ci/fast.json` for HEAD) and the Issue references that commit.
- Do not use `--no-verify`, force pushes, or direct integration/production-branch pushes.
