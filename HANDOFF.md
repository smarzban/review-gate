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
- **85 unit tests pass** (`npm test`, no network).
- **The scanner framework was itself reviewed (holistic + lens-security + lens-subtle) and hardened.**
  It had shipped with passing tests but the lenses found **2 HIGHs + more**: the tool adapters failed
  OPEN (spawnTool resolves on timeout/cap/error → adapters parsed partial output as "clean"), and the
  hardening applied to scan.ts wasn't carried to its twins (envNum/sanitize/byte-cap in runner.ts and
  renderReport). Now: tool adapters FAIL CLOSED on a present-but-failed tool; gitleaks/osv paths are
  normalized to repo-relative before scoping (+ warn if hits reported but none matched); osv matches
  the changed manifest EXACTLY (no nested mis-attribution); HEAD pinned to a SHA so the two git reads
  agree; envNum + stderr-cap + sanitize applied consistently across runner.ts/scan.ts/decide.ts.
  **Lesson: hardening must reach every twin path, and a present-but-failed security tool must fail
  closed (like the git path) — not parse partial output as clean.**
- **Lenses validated by dogfood, and they earned it.** After 3 holistic rounds, ran `lens-security` +
  `lens-subtle-correctness` (the two whose step-3 triggers this PR matched). They found **5 issues 12
  holistic model-runs missed** — incl. a **HIGH `baseRef` argument/option-injection** (`--output=…`
  parsed as a git flag → silent-empty scan bypassing secret detection + file write; 2-model agreement)
  and that **"trusted" tool findings were dismissible with any string** (a steered agent could clear a
  committed secret). Lesson: lenses aren't redundant with a thick holistic panel — their *framing*
  (adversarial input / execution-depth) finds what "review this change" skims. Fixes: `--end-of-options`
  + leading-dash `baseRef` guard; **the spine now refuses to honor dismissals of `source:"tool"` gating
  findings** (fix-in-code/tune-the-scanner is the only escape — vindicates the original "code-checked"
  intent); stdout byte-cap (OOM DoS); ref'd SIGKILL escalation; `AbortController` to kill the sibling
  git child. SKILL: `lens-security` now lists subprocess/untrusted-input as a fire trigger.
- **Re-ran `lens-security` to confirm: the injection is closed** (gone from both models). The re-run
  then caught that the resource caps had made the scan **fail OPEN** (pad the diff → cap/timeout →
  null → no findings → pass) — a worse bypass. Now the deterministic tier **fails CLOSED**: a scan
  that can't complete (oversized diff, git error, timeout, unsafe ref) emits a *gating, non-dismissible*
  tool finding instead of nothing. Also fixed: markdown-injection in the PR comment (sanitize untrusted
  title/rationale/justification) and NaN env overrides silently disabling a cap (`envNum` validates).
  **Security lesson:** a deterministic safety backstop must fail closed, and every robustness limit you
  add (caps/timeouts) is itself an attacker lever to disable it — so the failure path must block.
- **Dogfooded: the gate reviewed its own bucket-B PR over 3 rounds.** Round 1 → 3 real *design* bugs
  (consolidate counted the tool output as a 5th "model" → inflated agreement/`contested`; `spawnDiff`
  had no `--no-color` → ANSI silently emptied the scan; file list came only from `+++` headers → a
  renamed/empty `.env` slipped the guard). Round 2 (reviewing the fixes) → *robustness* (the
  focused-test rule matched `model.fit()` and **blocked clean PRs** → now statement-anchored, test-file
  scoped, advisory-only; `parseDiff` mis-parsed `++ ` lines as headers → stateful; no git timeout).
  Round 3 → *edge cases* (unscoped `debugger` on non-JS; SIGTERM-without-SIGKILL; `\ No newline`
  off-by-one; `.env.example.local`; `diff.noprefix`). Gating count fell **4 → 3 → 2** — convergence is
  **asymptotic** (a heuristic scanner reviewing its own code always has a smaller tail), so the stop
  rule is "findings below your bar," not "zero." All findings fixed; loop stopped after round 3.
  Lessons: heuristic content rules (focused-test/debugger) must be scoped + advisory, never gating;
  the location line-window can merge two distinct nearby findings (shows only the top-severity one).
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
- **Deterministic tier — adapters in progress.** The async `Scanner` framework + injectable
  `ToolRunner` (graceful "tool not on PATH → skip+warning") is built and proven. Done: `git-hygiene`
  (pure), `secrets` (gitleaks), `deps` (osv-scanner). **Remaining** (same proven shape — ~30 lines +
  a fixture test each): `types` (eslint + `tsc --noEmit`), `ci` (actionlint), `iac` (tfsec/checkov).
  None of the tools are installed in dev, so adapters are fixture-tested only — verify live once the
  tool is on PATH. Register new adapters in `ALL_SCANNERS` (the CLI uses it).

## Pointers
- Sibling repo `../review-panel` — the over-built predecessor. Two PRs landed there from this work:
  **#1** (full-file context for diff reviewers) and **#2** (effort+size-aware opencode timeout). It's
  left on a throwaway `tmp/bakeoff` branch locally; the PRs are pushed.
- The target we validated against: `../../hippo` PR #24.
- Everything here runs with **no network in tests**; live runs need omp/ollama auth + `claude`/`codex`
  CLIs on PATH (omp itself is NOT used — only `ollama launch claude`).
