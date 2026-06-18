# review-gate

A multi-model code-review **gate**. An agent orchestrates *holistic* reviews across diverse models;
a thin **deterministic spine** owns the verdict, the no-silent-dismissal rule, and the single PR
comment. Designed so a prompt-injected diff or a steered agent **cannot flip the gate**.

> Distilled from a bake-off against a 30-reviewer specialist panel: a clean *holistic* prompt across
> a few diverse models matched or beat the specialists at far lower cost, and the durable value was
> the deterministic spine — not the specialization. This keeps the spine, drops the fan-out.

## How it works

```
PR ─► agent checks out the branch (worktree)
   ─► reviewers (UNTRUSTED, read-only): each is a diverse model in Claude Code's harness,
        told "review this PR" — it explores the repo itself (git diff, read, grep) → findings JSON
        holistic × N diverse models  +  conditional lenses fired by trigger (tests, security, …)
   ─► consolidate  (cluster by location, agreement across models)
   ─► agent adjudicates contested clusters  ─► spine enforces no-silent-dismissal
   ─► decide  ─► verdict (block/pass) + ONE PR comment
   ─► CI required-check uses the verdict to block/allow merge
```

The agent does the flexible reviewing; the spine (`consolidate` + `decide`, pure code) owns the
verdict and the trust boundary. A gating finding can be dismissed **only with a written
justification**. There's no diff blob — each reviewer reads the actual checked-out branch.

## CLI

```bash
npm run cli -- run <reviewerId> <backend> <model> <repoDir> <promptFile>   # one reviewer (untrusted)
npm run cli -- consolidate <outputs.json>                                  # cluster + agreement
npm run cli -- decide <clusters.json> [adjudications.json]                 # deterministic verdict + PR comment
```

`<backend>` is `ollama` | `claude` | `codex`, giving **4 lineages**: `ollama` runs Claude Code on an
open model (kimi-k2.7-code:cloud, deepseek-v4-pro:cloud), `claude` the Anthropic closed lineage
(opus, high thinking), `codex` the OpenAI closed lineage (gpt-5.5, high effort). All explore the repo
and review *this PR*; ollama/claude return a clean JSON envelope, codex a parsed final message. See
`src/runner.ts` and `SKILL.md`.

## Layout
- **`HANDOFF.md`** — decisions, lessons, current state & open items. **Read first** to continue this work.
- `src/` — the spine: `runner.ts` (backend dispatch), `consolidate.ts`, `decide.ts`, `cli.ts`, `types.ts`.
- `prompts/` — `holistic.md` + 7 conditional `lens-*.md` (fired by trigger) + the shared `output-contract.md`.
- `SKILL.md` — the agent orchestration procedure.
- `ci/` — example required-check wiring.
- `tests/` — `npm test` (no network).
