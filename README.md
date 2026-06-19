# review-gate

A multi-model code-review **gate**, packaged as a **Claude Code plugin**. An agent orchestrates
*holistic* reviews across diverse models; a thin **deterministic spine** owns the verdict, the
no-silent-dismissal rule, and the single PR comment. Designed so a prompt-injected diff or a steered
agent **cannot flip the gate**.

> Distilled from a bake-off against a 30-reviewer specialist panel: a clean *holistic* prompt across
> a few diverse models matched or beat the specialists at far lower cost, and the durable value was
> the deterministic spine — not the specialization. This keeps the spine, drops the fan-out.

The plugin bundles **two skills** — `review-gate` (per-PR merge gate) and `repo-audit` (periodic,
advisory whole-repo health audit) — plus a deterministic `review-gate` CLI placed on your `PATH`.

## Install

This repo is its own single-plugin marketplace. Inside Claude Code:

```
/plugin marketplace add smarzban/review-gate
/plugin install review-gate@smarzban
```

Non-interactive equivalent: `claude plugin marketplace add smarzban/review-gate` then
`claude plugin install review-gate@smarzban` (add `--scope project` to share with a repo's team).
The repo is **private**, so the marketplace add uses your own GitHub access.

Once installed, the `review-gate` skill triggers when you ask Claude to review / sign off on a PR,
and `repo-audit` when you ask for a whole-repo health audit. The bundled `review-gate` CLI is on the
Bash `PATH`, so the skills run it from any project directory — no path to this repo needed. The CLI
also **serves its own prompts** (`review-gate prompt <name>`), so nothing depends on where the plugin
is installed.

> No install-time build: the compiled spine is committed under `dist/` and the spine has **zero
> runtime dependencies** (pure Node + `git`/model CLIs), so plain `node` runs it. If `review-gate`
> isn't found after install, add the plugin's `bin/` to your `PATH`, or from a clone run
> `npm i && npm run build && npm link`.

## Prerequisites (user-installed; the plugin can't bundle these)

- **`node`** — the runtime the spine and the `bin/review-gate` launcher run on.
- **`gh`** + **`git`** — checkout the PR branch, post the comment.
- **Model backends** — at least one of: `ollama` (with the `:cloud` models), the `claude` CLI, the
  `codex` CLI. The gate **degrades gracefully** if a backend is missing — it just runs a thinner
  panel (and says so). See the model table in the `review-gate` skill.
- **Optional scanners** for the deterministic tier's full set: **`gitleaks`** (committed secrets) and
  **`osv-scanner`** (vulnerable deps). Without them the always-on git-hygiene scanner still runs;
  a scanner that's configured but can't complete **fails closed** (blocks), never silently passes.

## How it works

```
PR ─► agent checks out the branch (worktree)
   ─► reviewers (UNTRUSTED, read-only): each is a diverse model in Claude Code's harness,
        told "review this PR" — it explores the repo itself (git diff, read, grep) → findings JSON
        holistic × N diverse models  +  conditional lenses fired by trigger (tests, security, …)
   ─► tools (TRUSTED, deterministic): `scan` runs git-diff scanners (conflict markers, focused
        tests, committed secrets/artifacts) → findings JSON, merged into the SAME pool (not sent to models)
   ─► consolidate  (cluster by location, agreement across models)
   ─► agent adjudicates contested clusters  ─► spine enforces no-silent-dismissal
   ─► decide  ─► verdict (block/pass) + ONE PR comment
   ─► CI required-check uses the verdict to block/allow merge
```

The agent does the flexible reviewing; the spine (`consolidate` + `decide`, pure code) owns the
verdict and the trust boundary. A model gating finding can be dismissed **only with a written
justification**; a **tool**-detected fact (e.g. a committed secret) **cannot be dismissed at all** —
fix it in code or tune the scanner. There's no diff blob — each reviewer reads the checked-out branch.

## CLI

Installed (on `PATH`):

```bash
review-gate prompt <name>                                          # print a reviewer/audit prompt + its output contract
review-gate run <reviewerId> <backend> <model> <repoDir> <prompt>  # one reviewer (untrusted)
review-gate scan <repoDir> <baseRef>                               # deterministic tier (trusted, no LLM)
review-gate consolidate <outputs.json>                             # cluster + agreement
review-gate decide <clusters.json> [adjudications.json]            # deterministic verdict + PR comment
```

From a checkout during development, the same verbs run via `npm run cli -- <verb> …` (tsx, no build).

`<backend>` is `ollama` | `claude` | `codex`, giving **4 lineages**: `ollama` runs Claude Code on an
open model (kimi-k2.7-code:cloud, glm-5.2:cloud), `claude` the Anthropic closed lineage
(opus, high thinking), `codex` the OpenAI closed lineage (gpt-5.5, high effort). All explore the repo
and review *this PR*; ollama/claude return a clean JSON envelope, codex a parsed final message.

## Layout
- `.claude-plugin/` — `plugin.json` (the plugin manifest) + `marketplace.json` (this repo as its own marketplace).
- `skills/review-gate/SKILL.md` — the per-PR gate orchestration procedure (the signing authority).
- `skills/repo-audit/SKILL.md` — the advisory whole-repo health audit (code-health, docs, tests,
  observability, operability, UX → a prioritized backlog; **no verdict**, reuses `run` + `consolidate`).
- `src/` — the spine: `runner.ts` (model backends), `scan.ts` (deterministic scanners),
  `consolidate.ts`, `decide.ts`, `prompts.ts` (serves bundled prompts), `cli.ts`, `types.ts`.
- `dist/` — the committed compiled spine the installed plugin runs (`npm run build` regenerates it).
- `bin/review-gate` — the `PATH` launcher (resolves `dist/cli.js` relative to itself).
- `prompts/` — `holistic.md` + 7 conditional `lens-*.md` + `output-contract.md`, **and** the
  `audit-*.md` passes + `audit-output-contract.md`. All served by `review-gate prompt <name>`.
- `ci/` — example required-check wiring. **Dormant** — GitHub automation is deferred until the gate
  has been run manually on a few real PRs, then shadow-mode, then enforced.
- `tests/` — `npm test` (no network).

## Development
```bash
npm install        # dev deps (tsx, typescript, vitest)
npm test           # full suite, no network
npm run typecheck  # tsc --noEmit (src + tests)
npm run build      # tsc → dist/  (rebuild + commit dist/ before publishing a release)
```
