---
name: review-gate
description: Use when gating a pull request or diff before it merges — when asked to review a PR,
  sign off on a change, decide whether a PR can land, or act as a merge gate / required check.
  Keywords - multi-model PR review, block/pass verdict, code review sign-off, no-silent-dismissal.
---
# Review Gate — orchestrator

## You are the signing authority
When this PR lands, its quality is **yours**. The spine computes the verdict only from what you
collect and adjudicate — so a real bug no model surfaced because you ran a thin panel, a cluster you
waved through without reading it, or a finding you dismissed on a plausible-sounding argument you
never checked against the code, is **your** miss, not the tool's. Your job is not to run the steps;
it is to be certain a **gold-standard** PR is landing. "Probably fine" is not sign-off.

**Non-negotiable obligations:**
- Run the **full panel** — all four models on the holistic pass. If a model fails, surface the
  warning AND name the coverage you lost; never let a failure pass silently.
- **Read the code behind every gating cluster yourself** (critical/high/medium) before it informs the
  verdict. Open the file, trace the change — do not adjudicate from a finding's title.
- **Dismiss a gating finding only after you have verified in the code that it is not real.** The spine
  requires a written justification; you require a *correct, code-checked* one.
- **A thin panel is a degraded review.** Fewer than 3 models: say so loudly, treat any `pass` as
  low-confidence, and re-run before signing off — never quietly pass on 2/4.
- **Consider the lenses honestly** (step 3) — skipping a warranted lens to save time is a miss.

**Red flags — STOP and do the work:**
"3 of 4 ran, good enough" · "no highs, ship it" · "the justification sounds reasonable" (did you open
the file?) · "holistic was thin but lenses cost time" · "it's a small PR, skim it" · "the models
agreed, I don't need to read it." **All of these mean you have not finished — a perfunctory pass is a
failed sign-off.**

**Principle:** you orchestrate the *reviewing* — flexible judgment. The deterministic spine
(`consolidate` + `decide`) owns the *verdict* and the *trust boundary*. The verdict is computed by
code from structured findings, and a gating finding can be dismissed ONLY with a written
justification — so a prompt-injected diff or a steered agent cannot flip the gate or bury a finding.

**Reviewers are untrusted, read-only.** Each is a model running in Claude Code's harness with
read-only tools (Read/Grep/Glob + git read), told *"review this PR"* — it explores the checked-out
branch itself. Only you and the spine (trusted) act: persist, comment, set the merge status.

Run the CLI with `npm --prefix <this-dir> run cli -- <cmd>`.

## Models — 4 lineages via 3 backends (each explores the repo)
| backend | model | lineage |
|---|---|---|
| `ollama` | `kimi-k2.7-code:cloud` | open (Moonshot) |
| `ollama` | `deepseek-v4-pro:cloud` | open (DeepSeek) |
| `claude` | `claude-opus-4-8` | closed (Anthropic) — append a `Think hard` line for high thinking |
| `codex`  | `gpt-5.5` | closed (OpenAI) — high reasoning effort (set by the runner) |

`ollama`/`claude` run Claude Code's agent loop (clean JSON envelope); `codex` runs `codex exec`
(final-message parsing). All four are *given the repo and told "review this PR."* Recall on *flaky*
findings (e.g. "logout doesn't clear") comes from **independent diverse shots** — run the holistic
pass on all four; don't rely on one. Drop/keep models per cost; the gate degrades gracefully if one
is unavailable.

## Procedure

1. **Check out the PR branch** in an isolated worktree the reviewers will explore:
   `git worktree add /tmp/rg-wt <head-ref>`. Note the base ref (e.g. `origin/main`). (For an
   uncommitted local diff, just use the working tree + its diff.)

2. **Build each reviewer prompt** = the reviewer instructions + the output contract + a one-line
   scope: `cat prompts/<holistic|lens-…>.md prompts/output-contract.md > /tmp/rg-<id>.txt`, then
   append: *"Review THIS PR — the change is `git diff <base>...HEAD`. Run it, read the changed files
   and relevant call-sites, then review. Output ONLY the JSON array."* No diff/file blobs — the
   model reads the repo.

3. **Run the reviews** — `run <reviewerId> <backend> <model> /tmp/rg-wt /tmp/rg-<id>.txt`:
   - **Deterministic scan first (cheap, $0, no LLM):** `scan /tmp/rg-wt <base>` → a ReviewerOutput
     `{reviewer:"tools", model:"deterministic"}`; merge its `output` into `/tmp/rg-outputs.json` like
     any reviewer. These are **exact tool detections** (conflict markers, focused tests, committed
     secrets/artifacts) — facts, not opinions; they are **not** sent to the models. Run it alongside
     the model pass; if it returns a blocking finding (e.g. a committed secret), you may **fast-fail**
     the gate before paying for the models.
   - **holistic × all four models** (the core pass) — e.g. `run holistic ollama kimi-k2.7-code:cloud …`,
     `… ollama deepseek-v4-pro:cloud …`, `… claude claude-opus-4-8 …`, `… codex gpt-5.5 …`.
     For the `claude`/opus reviewer, append a `Think hard about lifecycle/edge cases.` line to its
     prompt (high thinking). codex effort is set high by the runner.
   - **Lenses are CONDITIONAL, not always-on** — a targeted backfill on 1–2 models, fired ONLY when
     (a) holistic came back **thin on that dimension** (a silence you don't trust — e.g. zero test
     findings on a PR that clearly needs tests), OR (b) the PR is **high-stakes for that dimension**
     and you want a dedicated independent shot. Holistic ×4 already covers the core; with ≥3 diverse
     shots the common dimensions usually come through — then **skip the lens**; re-running it is a
     tax, not a backfill. Fire by trigger:

     | lens | fire when |
     |---|---|
     | `lens-tests` | tests are thin/weak, or behavior changed with little/no test change |
     | `lens-spec` | a spec / acceptance criteria / ticket exists — **append it to the prompt** (returns `[]` without one) |
     | `lens-security` | a sensitive surface — auth, input handling, crypto, deserialization, **shelling out to a subprocess, or parsing untrusted input** (its adversarial framing catches argument/option injection holistic misses) |
     | `lens-privacy` | the change stores, logs, or transmits personal/sensitive data |
     | `lens-contracts` | a public HTTP API, or an async event/message schema, changed |
     | `lens-migrations` | a DB schema migration / DDL is in the change |
     | `lens-subtle-correctness` | concurrency/async, caching, or date/time/timezone logic is touched |

     Most PRs fire **0–2** lenses. `lens-subtle-correctness` self-scopes to whichever of its three
     sections apply (returns `[]` if none). Run a fired lens on 1–2 diverse models, not all four.

     **MANDATORY before step 4 — write the lens decision out loud.** Go down the table row by row and
     state, in one line each, whether the trigger matched and whether you **fired or skipped** it. Do
     not default to holistic-only. A thick holistic panel is *not* a substitute for a lens's framing:
     in this gate's own dogfood, an orchestrator that ran holistic ×4 and never weighed the lenses
     **missed a HIGH `baseRef` argument-injection** that `lens-security` caught on the first try — the
     adversarial "assume the attacker controls every input" framing finds what "review this change"
     skims. **Silently skipping the lens evaluation is a sign-off failure, not a shortcut.**
   - Run reviewers as parallel background subprocesses (modest concurrency — a few at a time). Collect
     each call's `output` (skip `null`s) into `/tmp/rg-outputs.json`. **Surface every `warning`** — a
     skipped/failed model means a thinner panel; don't hide it.

4. **Consolidate:** `consolidate /tmp/rg-outputs.json > /tmp/rg-clusters.json` — clusters by location
   across models, with an agreement count and a `contested` flag.

5. **Adjudicate** (your only input to the verdict — treat it as such). Read **every** cluster, and
   for every gating cluster **open the code and confirm the finding for yourself** before you act on
   it — `contested` clusters most of all. Emit `/tmp/rg-adjudications.json`
   (`[{key, decision, justification?}]`) for any cluster you **dismiss** or explicitly confirm. A
   gating dismissal MUST carry a non-empty `justification` — and that justification must state **what
   you checked in the code** that proves the finding is not real, not merely why it sounds unlikely. A
   dismissal you cannot back with a code-level reason is a finding you must let block. Unlisted
   clusters default to: gating → blocks, low/info → advisory.
   - **Deterministic (tool) findings are facts — the spine will NOT honor a dismissal of one.** A
     tool gating finding always blocks; an adjudication can't clear it (so a prompt-injected or steered
     agent can't dismiss a committed secret with a string). To clear one, **fix it in code, or tune the
     scanner's config/allowlist** so it stops firing. An attempted override is surfaced loudly in the
     comment as **"⚠️ Deterministic findings — override NOT honored"** but the finding stays blocking.

6. **Decide:** `decide /tmp/rg-clusters.json /tmp/rg-adjudications.json > /tmp/rg-decision.json` →
   `{verdict, blocking, dismissed, prComment}`, all deterministic.

7. **Act (trusted — you, not a reviewer).** Persist the dismissal log under `.review-gate/`, post
   **`prComment` as exactly one** `gh pr comment`, and let the CI required-check use `verdict` to
   block/allow the merge. One comment, never per-model/per-finding.

8. **Clean up** the worktree: `git worktree remove /tmp/rg-wt`.

## Done when (the gold-standard gate)
You have signed off ONLY when all of these hold — otherwise you are not finished:
- [ ] The deterministic `scan` ran and its findings are in the pool.
- [ ] The full panel ran, OR every missing model is surfaced with the coverage lost named.
- [ ] The panel is not thin (≥3 models), OR a thin panel is flagged and the verdict marked low-confidence.
- [ ] Every gating cluster was read **in the code**, not just by title.
- [ ] Every dismissal carries a code-checked justification — you confirmed the finding is not real.
- [ ] The lens decision was **written out** (step 3) — every trigger row evaluated, each fired or skipped with a reason. Holistic-only on a PR that matched a trigger is NOT done.
- [ ] Exactly **one** PR comment (`prComment`) is posted; the verdict reflects what you actually verified.

If any box is unchecked, keep working. A `pass` you are not certain of is not a `pass`.

## Runner facts (learned the hard way — don't relearn them)
- Backends (see `src/runner.ts` → `buildCommand`): `ollama` → `ollama launch claude --model <m>:cloud
  -- -p … --output-format json --allowedTools <ro>`; `claude` → native `claude --model <m> -p … 
  --output-format json --allowedTools <ro>`; `codex` → `codex exec -C <repo> -m <m> -c
  model_reasoning_effort="high" -c sandbox_mode="read-only" "<prompt>"`.
- For ollama/claude, collect findings from the JSON envelope's `result`; for codex, from the final
  `codex` block of the trace. No diff blob, no event-stream scraping.
- The `--` after `ollama launch claude` is required (separates ollama-launch flags from claude's).
- Claude-harness tools are **read-only** (Read/Grep/Glob + git read); codex uses a read-only sandbox.
- Thinking: not needed as a flag for ollama/claude (Claude Code's harness doesn't starve the answer
  the way omp did); bump the opus reviewer via a `Think hard` prompt line. codex effort is set high.
- omp is OUT (agentic mode requests `max_tokens` > the ollama models' output cap → HTTP 400); opencode
  works but needs event-stream extraction. This path avoids both.
