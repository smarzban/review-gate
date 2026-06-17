---
name: review-gate
description: Multi-model PR review GATE. An agent orchestrates "review this PR" passes across
  diverse models (each explores the repo itself); a thin deterministic spine owns the verdict,
  the no-silent-dismissal rule, and the single PR comment. Use to gate a PR/diff.
---
# Review Gate — orchestrator

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
   - **holistic × all four models** (the core pass) — e.g. `run holistic ollama kimi-k2.7-code:cloud …`,
     `… ollama deepseek-v4-pro:cloud …`, `… claude claude-opus-4-8 …`, `… codex gpt-5.5 …`.
     For the `claude`/opus reviewer, append a `Think hard about lifecycle/edge cases.` line to its
     prompt (high thinking). codex effort is set high by the runner.
   - **lens-test-coverage** and **lens-privacy-retention**, each on 1–2 models (they backfill what
     holistic under-weights — tests, retention/clearing).
   - Run them as parallel background subprocesses (modest concurrency — a few at a time). Collect each
     call's `output` (skip `null`s) into `/tmp/rg-outputs.json`. **Surface every `warning`** — a
     skipped/failed model means a thinner panel; don't hide it.

4. **Consolidate:** `consolidate /tmp/rg-outputs.json > /tmp/rg-clusters.json` — clusters by location
   across models, with an agreement count and a `contested` flag.

5. **Adjudicate** (your only input to the verdict). Review every cluster, especially `contested`
   ones. Emit `/tmp/rg-adjudications.json` (`[{key, decision, justification?}]`) for any cluster you
   **dismiss** (a gating dismissal MUST carry a non-empty `justification`) or explicitly confirm.
   Unlisted clusters default to: gating → blocks, low/info → advisory.

6. **Decide:** `decide /tmp/rg-clusters.json /tmp/rg-adjudications.json > /tmp/rg-decision.json` →
   `{verdict, blocking, dismissed, prComment}`, all deterministic.

7. **Act (trusted — you, not a reviewer).** Persist the dismissal log under `.review-gate/`, post
   **`prComment` as exactly one** `gh pr comment`, and let the CI required-check use `verdict` to
   block/allow the merge. One comment, never per-model/per-finding.

8. **Clean up** the worktree: `git worktree remove /tmp/rg-wt`.

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
