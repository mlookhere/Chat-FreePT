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
3. **Orchestrate.** The extension watches the conversation through ChatGPT lifecycle signals
   plus a self-healing runtime reconciliation loop. Once a completed assistant turn is
   confirmed, it reads a machine-readable status marker from the reply:
   - `CONTINUE` — more work remains; the extension sends "continue" automatically.
   - `NEEDS_INPUT` — ChatGPT needs a decision; the extension pauses and notifies you.
   - `PLAN_READY` — the master plan is finished; the panel offers **Start development**.
   - `COMPLETE` — everything is merged and green; a completion modal takes over the screen.

The extension never talks to GitHub and never holds credentials. ChatGPT's MCP connector owns
every repository operation; Chat FreePT is the prompt injector, conversation orchestrator,
and UI.

## Requirements

- Chrome (Manifest V3).
- A ChatGPT account/workspace where Developer Mode can use a write-capable custom MCP app.
- The dedicated custom app must be configured as:
  - **Name:** `Chat FreePT GitHub MCP`
  - **Server URL:** `https://api.githubcopilot.com/mcp/x/all`
  - **Authentication:** OAuth

Chat FreePT's **Follow along** setup guides the ChatGPT-side flow through **Settings → Security
and login → Developer mode → Plugins**, then returns to the originating conversation and
selects **Developer mode** plus the exact **Chat FreePT GitHub MCP** app before setup is marked
complete. The extension may fill safe app-configuration fields, but it never approves
ChatGPT's elevated-risk acknowledgement and never completes or bypasses GitHub OAuth on the
user's behalf.

The injected skill performs its own GitHub capability preflight in the conversation and stops
with `NEEDS_INPUT` if the required repository, branch/file, Issue/label, PR/merge, or Actions
capabilities are unavailable.

## Install (unpacked)

```bash
npm ci
npm run build
```

Then Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → select `dist/`.

For release-candidate testing, use the extension ZIP produced by the successful release gate
instead of rebuilding locally. Extract `chat-freept.zip` to a folder first, then use **Load
unpacked** on that extracted folder so the browser is testing the exact CI-built package.

Open a ChatGPT conversation and click the Chat FreePT airplane launcher beside the native
composer **Plus** control. Describe your idea and start the plan.

## New repository guide

From an idle Chat FreePT panel, choose **New repo guide** for a four-step walkthrough. It
collects the project idea and optional repository name, explains the exact GitHub MCP
capabilities that are checked before mutation, shows how Chat FreePT vendors and adapts the
CI-Pipline, and finishes with **Create repo + start planning**.

The final button uses the normal Chat FreePT `USER_START` flow in new-repository mode; the
guide does not create a parallel automation path. ChatGPT must create a private repository,
seed `main` and `dev`, install the required labels and control Issue, and verify that Actions
actually run before planning can be considered ready. Missing capabilities stop with
`NEEDS_INPUT` rather than silently skipping setup.

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

## State diagnostics

When auto-continue or another ChatGPT lifecycle transition behaves incorrectly, open the
Chat FreePT airplane panel and use **State diagnostics → Start recording** before reproducing
the problem. After the failure, choose **Stop recording → Export JSON**.

The export is one chronological timeline containing semantic DOM snapshots, UI/lifecycle
events, selector health, Chat FreePT reducer events/state transitions/effects, storage changes,
and page-world fetch/XHR/WebSocket/EventSource metadata. It also records safe response-state
signals such as status/end-turn fields when they can be parsed.

Diagnostics are off by default and session-scoped. The exporter stores hashes, lengths,
field names, route shapes, and safe enums instead of raw chat/prompt text. Query values,
cookies, authorization headers, OAuth material, tokens, passwords, and credentials are
omitted or redacted.

For a useful auto-continue capture:

1. Start recording before sending the message that should trigger the next continuation.
2. Leave the Chat FreePT panel open or closed as normal; do not open DevTools or alter the page.
3. Wait until the assistant visibly finishes and the expected continuation does not send.
4. Stop recording immediately and export the JSON.
5. Attach that JSON when reporting the failure. The shared sequence numbers let DOM, network,
   and extension-state decisions be compared in exact order.

## Safety limits

Auto-continue is capped (default 50 sends per phase, configurable in options), throttled with
a configurable delay, and pauses immediately on ChatGPT error banners, missing status
markers (after one nudge), rate-limit notices, or a logged-out composer. The panel always
shows a Pause/Stop control while a run is active.
