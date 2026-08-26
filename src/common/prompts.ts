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
REPO: <owner/name, once known>
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

export const DEVELOPER_MODE_SETUP_BLOCK = `If a required capability is missing, read-only,
or rejected by authorization, STOP and report the exact missing capability classes. Then
tell me to configure GitHub's official remote MCP in ChatGPT:

1. Start Chat FreePT's GitHub setup and choose Follow along. The extension should open
   Settings → Security and login, enable Developer mode when the host permits it, and open
   Plugins automatically. If ChatGPT presents an additional security confirmation, I must
   approve it myself.
2. In https://chatgpt.com/plugins, create or reuse the dedicated custom app named
   Chat FreePT GitHub MCP. Use Server URL
   https://api.githubcopilot.com/mcp/x/all and OAuth. GitHub documents /x/all as the remote
   endpoint exposing all available MCP toolsets, which is appropriate for this release-engineering
   workflow because repository, Issue, label, pull-request, Git and Actions capabilities are required.
3. The extension may fill the safe fields and press Create after I explicitly check
   ChatGPT's custom-MCP risk acknowledgement. It must never check that acknowledgement for me
   or bypass GitHub OAuth. Complete the GitHub authorization myself.
4. Return to this conversation and resume. Do not require a separate composer attachment
   or a Developer mode → GitHub MCP menu item when the current ChatGPT UI does not expose
   one; instead, run this capability preflight again and trust the tools actually available.
5. If the remote MCP still does not expose the required repository/workflow write
   capabilities after OAuth, report the exact missing capability classes rather than
   substituting the ordinary GitHub plugin or pretending setup succeeded.

Do not ask me to run shell commands or click GitHub controls. End with NEEDS_INPUT so I can
finish only the explicit ChatGPT/GitHub consent step and then resume.`;

const CORE_MCP_REQUIREMENTS = `Core capabilities required in both modes (tool names may
differ; match capabilities semantically): read repositories/files/trees; create branches;
create or update files on an explicit branch including .github/workflows/*; create/update
Issues and comments; apply existing labels to Issues/PRs; create/update Pull Requests; merge
Pull Requests; and read Actions/check results plus failing job/step logs.`;

export function buildMcpPreflight(repoMode: "new" | "existing", repoName: string): string {
  const modeRequirements =
    repoMode === "new"
      ? `This is NEW-REPOSITORY mode. In addition to the core capabilities, you MUST have a
repository-creation capability (for example create_repository) and a repository-label
creation capability (for example label_write with method=create, create_label, or an
equivalent). A new repo has none of the CI-Pipline labels yet, so label creation is mandatory.`
      : `This is EXISTING-REPOSITORY mode for ${repoName || "the repository I name"}. Do NOT
require repository creation. First verify read/write access and list the CI-Pipline labels
already present. Repository-label creation is required only for labels that are actually
missing; if every required label already exists, lack of create_label/label_write is not a
blocker.`;

  return `## Step 0 — GitHub MCP preflight

Before any repository mutation, inspect all GitHub-capable tools available in this
conversation. Do not assume one connector or exact tool names; several ChatGPT apps can
expose equivalent operations.

${CORE_MCP_REQUIREMENTS}

${modeRequirements}

Repository default-branch mutation is NOT required. Do not block because there is no
update-repository/default-branch tool; all Chat FreePT branch operations must name their
base/head explicitly.

The workflow scope matters: you must be able to write .github/workflows/*. If that write is
rejected, or any required capability above is missing, never silently skip it: zero CI checks
is not green.

${DEVELOPER_MODE_SETUP_BLOCK}`;
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
5. Seed branches explicitly. For a new repo, discover the platform-created initial branch
   after initialization (normally main), then ensure main contains the fully seeded commit
   and create dev from that same commit. For an existing repo, inspect main/dev before
   creating or modifying either. Do NOT require changing the repository default branch:
   every later operation must name dev or main explicitly. If a safe default-branch
   mutation tool is available you may set main after both branches exist, but its absence
   is never a blocker. Do NOT configure branch protection.
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

{{MCP_PREFLIGHT}}

## Step 1 — Repository

{{REPO_INSTRUCTIONS}}

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

Work now. If you cannot finish preflight + repository setup + the recorded plan in one
reply, end intermediate replies with CONTINUE and keep going when I say continue. Ask
anything ambiguous with NEEDS_INPUT before declaring the plan ready — never after. When
the repo is seeded, the plan is committed, and the Issues exist, end with PLAN_READY
(include REPO: owner/name).

{{CI_CONTRACT}}

{{MARKER}}`;

const DEVELOP_TEMPLATE = `# Chat FreePT protocol — development phase

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

Reconstruct the current state from the repository itself with your GitHub MCP tools: read
docs/MASTER_PLAN.md, the control Issue, open Issues and PRs, and the latest Actions runs.
Then resume the {{PHASE}} loop under the same protocol.

{{CI_CONTRACT}}

{{MARKER}}`;

export const NUDGE_PROMPT = `Your last reply did not end with the required chatfreept status block. Reply now with ONLY
the status block (a fenced code block, language chatfreept) reflecting the current true
state. Every future reply must end with it.`;

export interface PlanPromptInput {
  idea: string;
  repoMode: "new" | "existing";
  repoName: string;
  templateRepo: string;
}

export function buildPlanPrompt(input: PlanPromptInput): string {
  let repoInstructions: string;
  if (input.repoMode === "existing" && input.repoName) {
    repoInstructions =
      `Use my existing repository ${input.repoName}. Verify you can read and write it. ` +
      `If it already has content that would conflict with vendoring the CI pipeline, stop ` +
      `with NEEDS_INPUT and tell me what you found.`;
  } else if (input.repoName) {
    repoInstructions =
      `Create a new PRIVATE repository named "${input.repoName}" under my account ` +
      `(discover my login with your tools). Initialize it with a README.`;
  } else {
    repoInstructions =
      `Create a new PRIVATE repository under my account (discover my login with your ` +
      `tools); derive a short kebab-case name from the idea below. Initialize it with a README.`;
  }
  return renderTemplate(PLAN_TEMPLATE, {
    MCP_PREFLIGHT: buildMcpPreflight(input.repoMode, input.repoName),
    REPO_INSTRUCTIONS: repoInstructions,
    VENDOR_RECIPE: renderTemplate(VENDOR_RECIPE_TEMPLATE, { TEMPLATE_REPO: input.templateRepo }),
    IDEA: input.idea.trim(),
    CI_CONTRACT: CI_CONTRACT_BLOCK,
    MARKER: MARKER_BLOCK,
  });
}

export function buildDevelopPrompt(settings: Settings): string {
  return renderTemplate(DEVELOP_TEMPLATE, {
    DELAY_S: String(Math.round(settings.sendDelayMs / 1000)),
    CI_CONTRACT: CI_CONTRACT_BLOCK,
    MARKER: MARKER_BLOCK,
  });
}

export function buildContinuePrompt(settings: Settings, withContractRefresh: boolean): string {
  if (!withContractRefresh) return settings.continueMessage;
  return `${settings.continueMessage}\n\n${COMPACT_CONTRACT}`;
}

export function buildUserReply(text: string): string {
  return `${text.trim()}\n\n(End with your CHATFREEPT status block.)`;
}

export function buildHandoffPrompt(state: RunState): string {
  return renderTemplate(HANDOFF_TEMPLATE, {
    REPO: state.repo || state.repoName || "(see the plan conversation)",
    PHASE: state.phase === "developing" ? "DEVELOPING" : "PLANNING",
    CI_CONTRACT: CI_CONTRACT_BLOCK,
    MARKER: MARKER_BLOCK,
  });
}
