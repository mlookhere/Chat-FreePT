# Chat FreePT

A Chrome extension that embeds into [chatgpt.com](https://chatgpt.com) and turns a single
ChatGPT conversation into an autonomous, CI-gated development loop.

You describe what you want built. Chat FreePT injects a "skill" — the CI-Pipline operating
contract, translated for ChatGPT — and then orchestrates the conversation end to end:

1. **Plan.** ChatGPT produces a master plan: milestones broken into controlling GitHub
   Issues, a repo layout, and the CI stages the project needs. The extension auto-continues
   the conversation until the plan is complete, then waits for you to press
   **Start development**.
2. **Develop.** ChatGPT — using its own **GitHub MCP connector**, not this extension — creates
   or reuses the project repository, vendors the CI-Pipline control plane into it, and works
   the plan: one Issue → one `work/<n>-slug` branch → one PR into `dev` → GitHub Actions
   gates → merge on green. No protected branches, so the loop runs unattended on free
   private repositories.
3. **Orchestrate.** The extension watches the conversation. When ChatGPT stops streaming, it
   reads a machine-readable status marker from the reply:
   - `CONTINUE` — more work remains; the extension sends "continue" automatically.
   - `NEEDS_INPUT` — ChatGPT needs a decision; the extension pauses and notifies you.
   - `PLAN_READY` — the master plan is finished; the panel offers **Start development**.
   - `COMPLETE` — everything is merged and green; a completion modal takes over the screen.

The extension never talks to GitHub and never holds credentials. ChatGPT's MCP connector owns
every repository operation; Chat FreePT is the prompt injector, conversation orchestrator,
and UI.

## Requirements

- Chrome (Manifest V3).
- A ChatGPT account with **Developer Mode connectors** enabled and a **GitHub MCP connector**
  configured with write access (Settings → Connectors → Advanced → Developer mode; connect
  GitHub's remote MCP server `https://api.githubcopilot.com/mcp/`). The skill runs a
  preflight in the conversation and stops with `NEEDS_INPUT` if the tools are missing.

## Install (unpacked)

```bash
npm ci
npm run build
```

Then Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → select `dist/`.

Open a ChatGPT conversation, click the Chat FreePT launcher in the bottom-right corner,
describe your idea, and start the plan.

## Development

This repository dogfoods the same CI-Pipline control plane the skill installs for users
(vendored `.claude/`, `ci/`, `workflow/`, `scripts/`, `flow`, `.github/`):

```bash
./scripts/bootstrap                  # once per clone: CI toolchain and git hooks
./flow new --title "..."             # Issue, branch and worktree in one step
# ...edit, run targeted tests...
./ci/run fast && ./ci/run pr         # evidence before the pull request
./flow pr <issue>
```

Extension-only commands:

```bash
npm run build          # esbuild -> dist/
npm run package        # dist/ -> artifacts/chat-freept.zip
npm run test           # vitest
npm run test:coverage  # vitest with coverage thresholds
npm run lint           # eslint
npm run typecheck      # tsc --noEmit
npm run format:check   # prettier
```

## Safety limits

Auto-continue is capped (default 50 sends per phase, configurable in options), throttled with
a configurable delay, and pauses immediately on ChatGPT error banners, missing status
markers (after one nudge), rate-limit notices, or a logged-out composer. The panel always
shows a Pause/Stop control while a run is active.
