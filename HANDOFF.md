# HANDOFF — review-gate

Read this first if you're picking up this work. It captures **why** the gate is shaped the way it
is (the decisions and the dead-ends behind them), the **current state**, and **what's open** — so you
don't relearn the saga. For *what it is / how to run it*, read `README.md` then `SKILL.md`.

## TL;DR
A multi-model PR review **gate**. An agent orchestrates *"review this PR"* passes across **4 diverse
model lineages**, each running in an **agent harness that explores the checked-out branch itself**
(no diff blob); a thin **deterministic spine** (`consolidate` + `decide`) clusters findings by
location, computes cross-model agreement, enforces **no-silent-dismissal**, and emits **one** PR
comment + a `block`/`pass` verdict. Built + unit-tested (26 tests) + proven live on a real PR.

## How we got here (the decisions, and why)
This was distilled from a long bake-off. The conclusions that shaped the design:

1. **Holistic ≫ specialists ≫ combined-mega-prompt.** A 30-reviewer specialist panel (the sibling
   repo `../review-panel`) was *over-built*: huge duplication, one strong model did most of the work,
   and it **missed** a real privacy bug (logout-not-cleared) because reviewers were **diff-anchored**.
   A single combined "all lenses in one prompt" reviewer did *worse* (diluted, missed the bleed). A
   clean **holistic "review this PR" prompt across a few diverse models** matched/beat both at far
   lower cost. → The gate is holistic + a *few* conditional lenses, not a big fan-out.

2. **Reviewers must see the whole repo, not a diff.** The specialist miss was because reviewers only
   saw diff hunks. The fix: reviewers **explore the actual checked-out branch** (git diff + read).

3. **The runner saga (don't repeat it).** We tried, in order:
   - **opencode** — works, has read tools, but NDJSON event-stream output needs fragile salvage
     (prose-preamble / empty-content failures dropped models) and a shared session-DB lock contends
     under concurrency.
   - **omp** — clean `--mode text`, BUT: `--mode json` explodes to **100s of MB** on long reasoning
     (re-emits full partials); reasoning models return **empty** unless `--thinking low` (they burn
     the ~8K output cap on thinking); and **agentic/tools mode is blocked on ollama** (it requests
     `max_tokens` > the model's output cap → HTTP 400). So omp can't let the model explore the repo.
   - **`ollama launch claude --model <m>:cloud`** ← **the winner.** Claude Code's mature agent loop
     driven by a diverse ollama model: native repo exploration, `--output-format json` → a clean
     `result` field (no scraping), no max_tokens block, `--no-session` ≈ no DB contention.
   - **Don't scrape a TUI pane** to collect results (herdr panes): terminal scrollback (~1000 lines)
     truncates long reviews and the rendering mangles JSON. Panes are for *human visibility*, not
     data collection. Collect via `-p`/`--output-format json` → stdout, always.

4. **Flaky findings need diverse breadth, not depth.** "Logout doesn't clear" was caught by some
   models/runs and not others. No single model reliably caught it. The 4-model panel caught it **3/4**
   and the race **4/4**. → Recall on flaky findings = independent diverse shots, which is the panel.

5. **The spine must be deterministic code, not agent judgment** — that's the trust boundary. The
   verdict is computed from structured findings; a gating finding can be dismissed **only with a
   written justification** (no-silent-dismissal). So a prompt-injected diff or a steered agent can't
   flip the gate or bury a finding. Reviewers are read-only; only the orchestrator + spine act.

## The model panel (4 lineages, 3 backends) — see `src/runner.ts buildCommand`
| backend | model | lineage | notes |
|---|---|---|---|
| `ollama` | `kimi-k2.7-code:cloud` | open (Moonshot) | Claude Code via `ollama launch claude` |
| `ollama` | `deepseek-v4-pro:cloud` | open (DeepSeek) | same |
| `claude` | `claude-opus-4-8` | closed (Anthropic) | native `claude`; append a `Think hard` line for high thinking |
| `codex` | `gpt-5.5` | closed (OpenAI) | `codex exec`, `model_reasoning_effort="high"`, read-only sandbox |

Thinking is NOT a problem to force here (unlike omp): Claude Code doesn't starve the answer; opus
gets depth via the `Think hard` prompt line, codex via the effort flag, ollama models use their own.

## Lenses are conditional (SKILL step 3)
Run a lens ONLY when holistic is **thin** on a dimension, or for a **high-stakes** PR. There are now
**7 conditional lenses** keyed to triggers — `lens-tests`, `lens-spec`, `lens-security`,
`lens-privacy`, `lens-contracts`, `lens-migrations`, `lens-subtle-correctness` (grouped from the
30-agent panel's dimensions; see SKILL step 3 for the trigger table). With ≥3 diverse holistic shots
the core dimensions usually come through → fire a lens as **targeted backfill, not a tax**. Most PRs
fire 0–2. (Confirmed in the live run: holistic ×4 gave test-coverage 4/4 and a privacy high; lenses
would've been redundant.)

## Current state (what's done / verified)
- **Built + committed.** Spine (`consolidate`, `decide`, `types`), runner (`runner.ts`, 3 backends),
  deterministic tier (`scan.ts`), prompts (`holistic` + 7 conditional lenses + `output-contract`),
  `cli.ts`, `SKILL.md`, `README.md`, CI example.
- **Deterministic tier (bucket B) — started.** `scan.ts` runs git-diff scanners that emit findings
  in the same `Finding` shape (with `source: "tool"`), joined into the pool and flowing through the
  spine unchanged. `git-hygiene` (conflict markers, focused tests, committed `.env`/node_modules)
  is built; gitleaks/osv-scanner/eslint/actionlint/IaC adapters slot in behind the same `Scanner`
  interface (none installed here yet → they'll use the graceful skip+warning path). Tool findings
  are facts: dismissible only with a code-checked justification, rendered loudly in an "overridden"
  section by `decide`. CLI: `scan <repoDir> <baseRef>`.
- **40 unit tests pass** (`npm test`, no network).
- **Proven live on PR #24** of `../../hippo` (chat-history-localstorage): 4 models → 22 findings → 6
  clusters → **BLOCK** (race 4/4, logout/privacy 2/4, tests 4/4 + 3 advisories). All 3 backends ran
  cleanly as parallel subprocesses. The verdict comment was posted to that PR.

## What's open / next (not done yet)
- **Shadow-mode rollout, then enforce.** Do NOT let the gate hard-block merges on day one. Run it
  advisory (post the comment, don't fail the check) for a handful of real PRs; watch for false
  positives (erodes trust) and false negatives (misses). Flip to an enforcing required-check only
  after it's calibrated. (CI wiring in `ci/github-action.yml` is illustrative, not wired up.)
- **Incremental re-review / convergence loop** — on the author's next push, re-run only the reviewers
  whose hunks changed; cap rounds. Not implemented (the spine is single-round today).
- **Lens conditional logic is documented in SKILL but executed by the orchestrator's judgment** — no
  code enforces "skip lenses when holistic is thick." Fine (it's an orchestration decision).
- **No persistence of the dismissal log / round cache** to `.review-gate/` yet (SKILL says to; not
  automated).
- **Deterministic tier — finish the adapters.** `scan.ts` + `git-hygiene` are in; add `secrets`
  (gitleaks), `deps` (osv-scanner + license), `types` (eslint/tsc), `ci` (actionlint), `iac`
  (tfsec/checkov) behind the same `Scanner` shape, each fixture-tested with a graceful "tool not on
  PATH → skip + warning" path. Scope hits to changed line ranges (avoid pre-existing noise).

## Pointers
- Sibling repo `../review-panel` — the over-built predecessor. Two PRs landed there from this work:
  **#1** (full-file context for diff reviewers) and **#2** (effort+size-aware opencode timeout). It's
  left on a throwaway `tmp/bakeoff` branch locally; the PRs are pushed.
- The target we validated against: `../../hippo` PR #24.
- Everything here runs with **no network in tests**; live runs need omp/ollama auth + `claude`/`codex`
  CLIs on PATH (omp itself is NOT used — only `ollama launch claude`).
