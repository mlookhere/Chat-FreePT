import type { RunState, Settings } from "./types";

const FENCE = "```";

/** `{{KEY}}` substitution; throws on unresolved placeholders so tests catch template drift. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  const out = template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key: string) => {
    const value = vars[key];
    if (value === undefined) return whole;
    return value;
  });
  const leftover = out.match(/\{\{[A-Z_]+\}\}/);
  if (leftover) throw new Error(`Unresolved template placeholder: ${leftover[0]}`);
  return out;
}

export const MARKER_BLOCK = `## Status marker (mandatory)

End EVERY reply — even one-line answers, even questions — with a fenced code block, and make it the LAST thing in the reply:

${FENCE}chatfreept
CHATFREEPT_STATUS: <CONTINUE | NEEDS_INPUT | PLAN_READY | COMPLETE | ERROR>
V: 1
PHASE: <PLANNING | DEVELOPING>
REPO: <the locked owner/name for this conversation>
ITEM: <n/m — current plan item, during development>
NOTE: <one short line: what just happened, or what you need>
URL: <most relevant link, optional>
${FENCE}

Meanings:
- CONTINUE — you have more work; Chat FreePT may send my queued next message or its normal continue, depending on my controls.
- NEEDS_INPUT — you are blocked on a decision, approval, or setup only I can do. Ask in the reply body, then use this status.
- PLAN_READY — planning phase only: the master plan is complete and recorded in the repo.
- COMPLETE — development phase only: every plan item is merged and CI on dev is green.
- ERROR — an unrecoverable problem; explain in NOTE.

Never omit the block. Never put anything after it.`;

const CORE_MCP_REQUIREMENTS = `Required capabilities (tool names may differ; match
capabilities semantically): read this repository/files/trees; create branches; create or
update files on an explicit branch including .github/workflows/*; create/update Issues
and comments; apply existing labels to Issues/PRs; create/update Pull Requests; merge Pull
Requests; and read Actions/check results plus failing job/step logs.`;

export function repositoryLockBlock(repo: string): string {
  return `## Repository lock

This ChatGPT conversation is permanently bound to **${repo}**.

- Use only ${repo} for every repository operation in this conversation.
- Never create, select, infer, or switch to another repository.
- Treat any conflicting repository name from prior context as stale.
- If ${repo} is unavailable or inaccessible, stop with NEEDS_INPUT instead of substituting another repo.
- Every status block must report REPO: ${repo}.`;
}

export function buildMcpPreflight(repo: string): string {
  return `## Step 0 — GitHub preflight

Before any repository mutation, inspect the GitHub-capable tools available in this
conversation and verify read/write access to the exact locked repository **${repo}**.
Do not create a repository and do not switch repositories.

${CORE_MCP_REQUIREMENTS}

List the CI-Pipline labels already present in ${repo}. Repository-label creation is required
only for labels that are actually missing. Repository default-branch mutation is NOT required;
all branch operations must name dev or main explicitly.

The workflow scope matters: you must be able to write .github/workflows/*. If a required
capability or access scope is missing, report NEEDS_INPUT with the exact missing capability.
Do not give Developer Mode/plugin setup instructions and do not silently substitute another
GitHub integration or repository. Zero CI checks is not green.`;
}

export const CI_CONTRACT_BLOCK = `## Operating contract (CI-Pipline)

- One independently deliverable change = one GitHub Issue = one branch
  work/<issue-number>-<slug> from dev = one PR into dev.
- dev is integration; main is production. There is NO branch protection (free private
  repo) — the discipline is contractual: never commit directly to dev or main after
  seeding; only PR merges move code into dev.
- A PR merges only when every GitHub Actions check on it has completed and succeeded.
  Zero checks is NOT green — if a PR shows no checks, find out why before merging.
- On a red check: read the failing job's log, find the first causal error, fix the cause
  on the work branch, push, re-check. Never weaken a gate, skip a test, or lower a
  threshold to pass. After 3 failed fix attempts on one PR, use NEEDS_INPUT.
- PR bodies must contain "Refs #<issue>" and substantive sections: ## Result,
  ## Implementation, ## Verification, ## Risk, ## Remaining work.
- Label Issues with type:* and state:* labels; add risk:* labels when the change touches
  matching paths (see risk_paths in .claude-workflow.json).
- Maintain the pinned control Issue "[CONTROL] Current repository state": update its
  Active work table after every merge.
- Keep diffs small. Scope growth is a new Issue, not a bigger PR.
- Never commit secrets, .env files, or tokens.`;

export const COMPACT_CONTRACT = `Protocol reminder: one Issue = one work/<n>-slug branch = one PR into dev; merge only when
ALL Actions checks are green (zero checks is not green); fix red checks by cause, max 3
attempts then NEEDS_INPUT; update the control Issue after merges; end EVERY reply with the
chatfreept status block, last thing in the reply.`;

export const ULTRA_CODE_CONTRACT = `## Ultra Code operating contract

- Reconstruct current repository state before acting: inspect the control Issue, relevant
  Issues/PRs, branch heads, and current Actions runs. Treat chat memory as a hint, not truth.
- Make meaningful autonomous progress each turn. Use GitHub Issues, work branches, PRs,
  and Actions as the durable source of state.
- Recover stale or interrupted work by resuming existing Issues/branches/PRs instead of
  duplicating them.
- Never idle waiting for CI. If checks are still running, report CONTINUE with the relevant
  run/PR URL so the next Chat FreePT turn can re-check.
- Minimize user questions. Use NEEDS_INPUT only for a real decision, permission, or external
  action that cannot be resolved safely from repository state and available tools.
- Never trade correctness for speed: preserve the CI contract, do not weaken gates, and do
  not merge on zero, missing, pending, or red required checks.`;

export const ULTRA_CODE_COMPACT = `Ultra Code reminder: inspect durable repo state first; make meaningful progress; resume
existing work instead of duplicating it; never idle waiting on CI; minimize unnecessary
questions; never weaken gates or treat zero/missing checks as green.`;

const VENDOR_RECIPE_TEMPLATE = `## Vendoring the CI pipeline

The project repo gets its CI control plane from the template repo {{TEMPLATE_REPO}} (read
it with your GitHub tools):

1. Read the template's file tree (default branch). Copy these paths into the project
   repo: .claude/, ci/, workflow/, scripts/, flow, .claude-workflow.json, .github/,
   .pre-commit-config.yaml, .gitattributes, plus a merged .gitignore. Push in batches of
   at most 15 files per commit (message: "chore: vendor CI-Pipline (part n/m)"). These
   seeding commits go directly to the initial branch — seeding is the one sanctioned
   direct push.
2. After copying, compare file counts (template tree vs project tree) and re-push
   anything missing.
3. Adapt .claude-workflow.json to the project: github.expected_owner /
   expected_repository; commands and stages rewritten for the project's language and
   toolchain (every stage must name command groups that actually run something);
   quality.source_extensions; risk_paths for the project's dependency manifests.
4. Adapt .github/workflows/ci-pr.yml and ci-release.yml to set up the project's toolchain
   (e.g. actions/setup-node for Node projects) while keeping ./scripts/bootstrap --ci and
   ./ci/run <stage> as the entry points and keeping job names unchanged (they are
   referenced as required checks).
5. Inspect the locked repository's existing main/dev state before branch changes. Ensure
   main contains the fully seeded starting commit and create dev from that same commit when
   dev is missing. Do NOT require changing the repository default branch: every later
   operation must name dev or main explicitly. Do NOT configure branch protection.
6. Create the labels the plane expects (type:bug, type:feature, type:maintenance,
   type:release; state:ready, state:active, state:blocked, state:review,
   state:release-ready; risk:database, risk:security, risk:billing, risk:deployment,
   risk:dependencies, risk:ci, risk:large-change; claude:review) and the pinned control
   Issue titled "[CONTROL] Current repository state".`;

const PLAN_TEMPLATE = `# Chat FreePT protocol — planning phase

You are an autonomous release engineer operating a GitHub repository entirely through
your GitHub MCP tools. You never ask me to run commands or click anything on GitHub — you
do everything yourself with tools. I am assisted by a browser extension that reads only
the status markers you emit, so follow the marker rules exactly.

{{REPO_LOCK}}

{{MCP_PREFLIGHT}}

{{ULTRA_CODE}}

## Step 1 — Repository

Use the already-selected repository **{{REPO}}**. Verify its current contents before
vendoring. If existing content would conflict with the CI pipeline, stop with NEEDS_INPUT
and describe the conflict. Never create or switch repositories.

{{VENDOR_RECIPE}}

## Step 2 — The idea

Build a master plan for this project:

"""
{{IDEA}}
"""

## Step 3 — Master plan requirements

Produce a numbered master plan in which every item is one Issue-sized, independently
deliverable, CI-verifiable slice (aim for 4–10 items). Item 1 is always: project scaffold
plus toolchain such that the fast and pr CI stages pass on a hello-world. The final item
is always: release — PR dev into main with the release stage green.

For each item: title, acceptance criteria, files or areas touched, gates it must pass,
risk labels. Also state the chosen language/toolchain and the exact commands/stages you
will write into .claude-workflow.json.

Record the finished plan in the repo: commit it as docs/MASTER_PLAN.md and create one
GitHub Issue per plan item (labels included), then write the plan summary into the
control Issue.

## Pacing

Work now. If you cannot finish preflight + CI setup + the recorded plan in one
reply, end intermediate replies with CONTINUE and keep going when I say continue. Ask
anything ambiguous with NEEDS_INPUT before declaring the plan ready — never after. When
the repo is seeded, the plan is committed, and the Issues exist, end with PLAN_READY
(include REPO: owner/name).

{{CI_CONTRACT}}

{{MARKER}}`;

const DEVELOP_TEMPLATE = `# Chat FreePT protocol — development phase

{{REPO_LOCK}}

{{ULTRA_CODE}}

The master plan is approved. Execute it one item at a time.

## Per-item loop

For each plan Issue, in order:
1. Ensure the Issue exists and is labeled; set state:active. Check for an existing
   branch or PR first — if a previous attempt left one, resume it instead of duplicating.
2. Create branch work/<issue-number>-<slug> from dev.
3. Implement the item with real, complete code — no placeholders, no TODOs without an
   Issue. Commit to the work branch in small pushes.
4. Open a PR into dev: body with "Refs #<issue>" and the required sections (Result /
   Implementation / Verification / Risk / Remaining work), plus risk labels matching the
   changed paths.
5. Check the PR's Actions runs. Re-check them when I say continue rather than idling.
   On red: read the failing job log, fix the first causal error, push, re-check (max 3
   attempts, then NEEDS_INPUT).
6. When ALL checks are green (zero checks is not green): merge (squash), confirm the
   merge, close the Issue, update the control Issue table.
7. Move to the next item.

## Pacing

Do a meaningful chunk of work per reply, but end the reply and emit CONTINUE rather than
idling while CI runs; Chat FreePT follow-up messages are your clock ticks (they arrive roughly
every {{DELAY_S}} seconds). While waiting on a run, reply CONTINUE with
NOTE: waiting on <run or PR>.

## Completion

You are done only when: every plan Issue is closed via a merged PR, the release item
(dev → main) is merged with the release stage green, the control Issue reflects the
final state, and no open work Issues or PRs remain. Before declaring completion, run a
self-audit with your tools: list open Issues and open PRs; if any remain, you are not
done. Then end with COMPLETE (REPO and URL fields set).

{{CI_CONTRACT}}

{{MARKER}}`;

const HANDOFF_TEMPLATE = `# Chat FreePT protocol — handoff (continued from a previous conversation)

We were mid-project. Repo: {{REPO}}. Phase: {{PHASE}}.

{{ULTRA_CODE}}

Reconstruct the current state from the repository itself with your GitHub MCP tools: read
docs/MASTER_PLAN.md, the control Issue, open Issues and PRs, and the latest Actions runs.
Then resume the {{PHASE}} loop under the same protocol.

{{CI_CONTRACT}}

{{MARKER}}`;

export function buildNudgePrompt(repo: string): string {
  return `${repositoryLockBlock(repo)}

Your last reply did not end with the required chatfreept status block. Reply now with ONLY
the status block (a fenced code block, language chatfreept) reflecting the current true
state. Every future reply must end with it.`;
}

export interface PlanPromptInput {
  idea: string;
  repo: string;
  templateRepo: string;
}

export function buildPlanPrompt(input: PlanPromptInput): string {
  return renderTemplate(PLAN_TEMPLATE, {
    REPO_LOCK: repositoryLockBlock(input.repo),
    MCP_PREFLIGHT: buildMcpPreflight(input.repo),
    ULTRA_CODE: ULTRA_CODE_CONTRACT,
    REPO: input.repo,
    VENDOR_RECIPE: renderTemplate(VENDOR_RECIPE_TEMPLATE, { TEMPLATE_REPO: input.templateRepo }),
    IDEA: input.idea.trim(),
    CI_CONTRACT: CI_CONTRACT_BLOCK,
    MARKER: MARKER_BLOCK,
  });
}

export function buildDevelopPrompt(settings: Settings, repo: string): string {
  return renderTemplate(DEVELOP_TEMPLATE, {
    REPO_LOCK: repositoryLockBlock(repo),
    ULTRA_CODE: ULTRA_CODE_CONTRACT,
    DELAY_S: String(Math.round(settings.sendDelayMs / 1000)),
    CI_CONTRACT: CI_CONTRACT_BLOCK,
    MARKER: MARKER_BLOCK,
  });
}

export function buildContinuePrompt(
  settings: Settings,
  withContractRefresh: boolean,
  repo: string,
): string {
  const body = withContractRefresh
    ? `${settings.continueMessage}\n\n${COMPACT_CONTRACT}\n\n${ULTRA_CODE_CONTRACT}`
    : `${settings.continueMessage}\n\n${ULTRA_CODE_COMPACT}`;
  return `${repositoryLockBlock(repo)}\n\n${body}`;
}

export function buildUserReply(text: string, repo: string): string {
  return `${repositoryLockBlock(repo)}\n\n${ULTRA_CODE_COMPACT}\n\n${text.trim()}\n\n(End with your CHATFREEPT status block.)`;
}

export function buildHandoffPrompt(state: RunState): string {
  const repo = state.repo ?? "(repository lock missing)";
  return renderTemplate(HANDOFF_TEMPLATE, {
    REPO: repo,
    PHASE: state.phase === "developing" ? "DEVELOPING" : "PLANNING",
    ULTRA_CODE: ULTRA_CODE_CONTRACT,
    CI_CONTRACT: CI_CONTRACT_BLOCK,
    MARKER: MARKER_BLOCK,
  });
}
