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
agreed, I don't need to read it." · **doubt theater** — a panel surfaced real gating findings and you
dismissed *every one* with a tidy justification, confirming none (that's rubber-stamping dismissals,
not adjudicating — re-read the code). · **skipping your orchestrator review comment**, or posting an
**Approve that contradicts a BLOCK verdict** (a contradiction is not a sign-off — fix the adjudication
or the decision). **All of these mean you have not finished — a perfunctory pass is a failed sign-off.**

**Principle:** you orchestrate the *reviewing* — flexible judgment. The deterministic spine
(`consolidate` + `decide`) owns the *verdict* and the *trust boundary*. The verdict is computed by
code from structured findings, and a gating finding can be dismissed ONLY with a written
justification — so a prompt-injected diff or a steered agent cannot flip the gate or bury a finding.

**Reviewers are untrusted, read-only.** Each is a model running in Claude Code's harness with
read-only tools (Read/Grep/Glob + git read), told *"review this PR"* — it explores the checked-out
branch itself. Only you and the spine (trusted) act: persist, comment, set the merge status.

Run the spine with the **`review-gate`** command — it's on your `PATH` once this plugin is installed,
so call it from any directory: `review-gate <prompt|run|scan|consolidate|decide> …`. It also *serves
its own reviewer prompts*: `review-gate prompt <name>` prints that prompt **plus its output contract**
to stdout, so you never need a filesystem path to the prompt files.

## Models
The lineage table and per-backend behaviour are the **canonical roster** — fetch it with
`review-gate prompt backends` (shared with repo-audit, so it never drifts). For the gate, run the
**holistic pass on all four** lineages: recall on *flaky* findings (e.g. "logout doesn't clear") comes
from independent diverse shots, not one model. Drop/keep models per cost; the gate degrades gracefully
if a backend is unavailable.

## Procedure

1. **Check out the PR branch** in an isolated worktree the reviewers will explore:
   `git worktree add /tmp/rg-wt <head-ref>`. Note the base ref (e.g. `origin/main`). (For an
   uncommitted local diff, just use the working tree + its diff.)

2. **Build each reviewer prompt** = the reviewer instructions + the output contract + a one-line
   scope: `review-gate prompt <holistic|lens-…> > /tmp/rg-<id>.txt` (this emits the reviewer prompt
   AND its output contract), then append: *"Review THIS PR — the change is `git diff <base>...HEAD`. Run it, read the changed files
   and relevant call-sites, then review. Output ONLY the JSON array."* No diff/file blobs — the
   model reads the repo.

3. **Run the reviews** — `review-gate run <reviewerId> <backend> <model> /tmp/rg-wt /tmp/rg-<id>.txt`:
   - **Deterministic scan first (cheap, $0, no LLM):** `review-gate scan /tmp/rg-wt <base>` → a ReviewerOutput
     `{reviewer:"tools", model:"deterministic"}`; merge its `output` into `/tmp/rg-outputs.json` like
     any reviewer. These are **exact tool detections** (conflict markers, focused tests, committed
     secrets/artifacts) — facts, not opinions; they are **not** sent to the models. Run it alongside
     the model pass; if it returns a blocking finding (e.g. a committed secret), you may **fast-fail**
     the gate before paying for the models.
   - **holistic × all four models** (the core pass) — e.g. `review-gate run holistic ollama kimi-k2.7-code:cloud …`,
     `… ollama glm-5.2:cloud …`, `… claude claude-opus-4-8 …`, `… codex gpt-5.5 …`.
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
     | `lens-simplify` | the change adds notable new abstraction, indirection, a new pattern, or complex logic, and you want a dedicated "is this the *simplest correct* form?" shot — **mostly advisory** (findings are usually low/info; `medium`+ only when complexity concretely risks a bug or burdens central code) |

     Most PRs fire **0–2** lenses. `lens-subtle-correctness` self-scopes to whichever of its three
     sections apply (returns `[]` if none); `lens-simplify` returns `[]` when the change adds no
     needless complexity. Run a fired lens on 1–2 diverse models, not all four.

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

4. **Consolidate:** `review-gate consolidate /tmp/rg-outputs.json > /tmp/rg-clusters.json` — clusters by location
   across models, with an agreement count and a `contested` flag.

5. **Adjudicate** (your only input to the verdict — treat it as such). Read **every** cluster, and
   for every gating cluster **open the code and confirm the finding for yourself** before you act on
   it — `contested` clusters most of all. Emit `/tmp/rg-adjudications.json`
   (`[{key, decision, justification?}]`) for any cluster you **dismiss** or explicitly confirm. A
   gating dismissal MUST carry a non-empty `justification` — and that justification must state **what
   you checked in the code** that proves the finding is not real, not merely why it sounds unlikely. A
   dismissal you cannot back with a code-level reason is a finding you must let block. Unlisted
   clusters default to: gating → blocks, low/info → advisory.
   - **Classify each gating finding against the code — and don't rubber-stamp in *either* direction.**
     A fresh reviewer can be wrong for lack of your context *and* right despite your confidence; re-read
     the change itself before deciding. A finding is either **not real** under code/conventions the
     model couldn't see — dismiss it, with a justification stating what in the code makes it safe — or
     it is **real**, and then it blocks until fixed. A real gating issue someone would rather *accept*
     than fix is **not yours to silently dismiss**: the gate fails safe toward blocking, so leave it
     blocking and surface it for the PR owner's explicit sign-off — never clear it with a "trade-off"
     justification, which is exactly the silent-dismissal hole the spine exists to prevent.
   - **Deterministic (tool) findings are facts — the spine will NOT honor a dismissal of one.** A
     tool gating finding always blocks; an adjudication can't clear it (so a prompt-injected or steered
     agent can't dismiss a committed secret with a string). To clear one, **fix it in code, or tune the
     scanner's config/allowlist** so it stops firing. An attempted override is surfaced loudly in the
     comment as **"⚠️ Deterministic findings — override NOT honored"** but the finding stays blocking.

6. **Decide.** Assemble `/tmp/rg-meta.json` = `{reviewers}` — **every** reviewer×model pass that actually
   ran, `[{reviewer, model}, …]`, **including clean votes** (a reviewer that found nothing never reaches a
   cluster, so the spine can't recover it — list it here or it goes uncredited). This fills the gate
   comment's **"Reviewed by"** line.

   Then run: `review-gate decide /tmp/rg-clusters.json /tmp/rg-adjudications.json /tmp/rg-meta.json > /tmp/rg-decision.json`
   → `{verdict, blocking, dismissed, prComment}`, all deterministic.

7. **Act (trusted — you, not a reviewer).** Post **two** fresh comments on every run (a visible run
   history; never edit a prior run's), then persist + set status:
   1. **The gate findings comment** — post `prComment` exactly as emitted, as one `gh pr comment`
      (verdict + the "Reviewed by" roster + findings). One per run, never per-model/per-finding.
   2. **Your orchestrator review comment** — a *separate* `gh pr comment`, in your own words, **REQUIRED
      every run**. State, in plain markdown: **what the PR implements**, **what it does NOT cover / what
      you're deferring** (unaddressed advisory items, gaps, follow-ups), and an explicit **Decision: ✅
      Approve** or **🔴 Request changes**. That decision **MUST agree with `verdict`** — if it doesn't,
      you misjudged: fix your adjudication or your decision, never post a contradiction. This is YOUR
      sign-off; it is not a reviewer's and it never overrides the deterministic verdict.

   Persist the dismissal log under `.review-gate/`, and let the CI required-check use `verdict` to
   block/allow the merge.

8. **Clean up** the worktree: `git worktree remove /tmp/rg-wt`.

## Done when (the gold-standard gate)
You have signed off ONLY when all of these hold — otherwise you are not finished:
- [ ] The deterministic `scan` ran and its findings are in the pool.
- [ ] The full panel ran, OR every missing model is surfaced with the coverage lost named.
- [ ] The panel is not thin (≥3 models), OR a thin panel is flagged and the verdict marked low-confidence.
- [ ] Every gating cluster was read **in the code**, not just by title.
- [ ] Every dismissal carries a code-checked justification — you confirmed the finding is not real.
- [ ] The lens decision was **written out** (step 3) — every trigger row evaluated, each fired or skipped with a reason. Holistic-only on a PR that matched a trigger is NOT done.
- [ ] **Two fresh comments** are posted this run (never editing a prior run's): the gate `prComment` (verdict + **reviewer/model roster** + findings) AND a separate **orchestrator review comment** (what the PR implements · what it doesn't cover / deferred · an explicit **Approve / Request-changes** that AGREES with `verdict`). The verdict reflects what you actually verified.

If any box is unchecked, keep working. A `pass` you are not certain of is not a `pass`.

## Runner facts (learned the hard way — don't relearn them)
- Backends (see `src/runner.ts` → `buildCommand`): `ollama` → `ollama launch claude --model <m>:cloud
  -- -p … --output-format json --allowedTools <ro>`; `claude` → native `claude --model <m> -p … 
  --output-format json --allowedTools <ro>`; `codex` → `codex exec -C <repo> -m <m> -c
  model_reasoning_effort="high" -c sandbox_mode="read-only" "<prompt>"`.
- For ollama/claude, collect findings from the JSON envelope's `result`; for codex, from the final
  `codex` block of the trace. No diff blob, no event-stream scraping.
- **Output salvage (`parseFindings`):** reasoning-heavy models (opus, glm) often narrate around the
  array. The runner parses the whole message authoritatively first, then takes the **UNION of valid
  findings across ALL ```json fences** — never just one. Picking a single fence is gameable in both
  directions (an example/empty fence could mask the answer; a trailing decoy could mask a real
  critical), so the union lets a real finding in *any* fence survive; a first-`[`…last-`]` slice is the
  last resort. A *whole-message* `[]`/“no issues” is a 0-finding vote, but a non-empty array that
  validates to zero findings (or a *carved-out* empty `[]` amid prose) is garbage — never an
  authoritative clean pass. A pure-prose reply with no array stays a surfaced non-vote (never silently
  dropped).
- The `--` after `ollama launch claude` is required (separates ollama-launch flags from claude's).
- **Cost guards (each `run` is a full agent loop = many model requests, not one):** ollama/claude carry
  `--max-turns` (default 25, `REVIEW_GATE_MAX_TURNS`) so a non-converging model can't spin a runaway
  request loop — on Ollama Cloud's GPU-time billing that once burned ~245 requests + a 38-min hang. The
  runner also enforces a **hard wall-clock timeout** (`REVIEW_GATE_TIMEOUT_MS`, default 10m) that
  force-settles even if the child orphans a grandchild holding the pipe. Hitting either ⇒ that reviewer
  fails (surfaced warning, lost vote) — not a runaway. The roster is all "high"-tier Ollama models now
  (deepseek's "extra high" tier was the heaviest/least-convergent and drove that runaway — swapped out
  for `glm-5.2`, a "high" tier that leads SWE-bench Pro).
- Thinking: not needed as a flag for ollama/claude (Claude Code's harness doesn't starve the answer
  the way omp did); bump the opus reviewer via a `Think hard` prompt line. codex effort is set high.
- omp is OUT (agentic mode requests `max_tokens` > the ollama models' output cap → HTTP 400); opencode
  works but needs event-stream extraction. This path avoids both.
