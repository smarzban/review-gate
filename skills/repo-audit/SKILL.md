---
name: repo-audit
description: Use when auditing a whole codebase's health periodically — at a milestone, release, or
  after several PRs; when asked to assess overall tech debt, code health, doc or test-suite quality,
  observability, cost, or dependency rot across the entire repo (not a single PR/diff). Advisory
  backlog, not a merge gate.
---
# Repo Audit — orchestrator

A **periodic, whole-repo health audit** — run at a milestone / release / every few PRs. It is the
*advisory* sibling of the per-PR `review-gate`: where the gate blocks a diff, this surveys the whole
codebase and hands the team a **prioritized backlog**. It does **not** block anything and has no
verdict — so there is no trust boundary to enforce (nothing it says can stop a merge), and no
adjudication/dismissal machinery: the team simply decides what to act on.

**What's different from review-gate**
- **Whole repo, not a diff.** Reviewers explore the entire codebase, not "this PR."
- **Advisory, not gating.** Output is a prioritized list to triage, not block/pass.
- **Cross-cutting dimensions a per-PR review can't see** — duplication across modules, dead code, doc
  drift, observability gaps, cloud cost, dependency rot. These only make sense whole-repo + periodic.
- **Severity = impact/priority** for the backlog, not a merge blocker.

**Reuses review-gate's machinery** — the same `review-gate` CLI (on your `PATH` once this plugin is
installed): the `run` verb (a model explores the repo with a prompt), `consolidate` (cluster findings
by location across models), and `prompt` (which serves the `audit-*` prompts too), plus the same
`Finding` JSON shape. It does **not** use `decide` (no verdict).

## Audit passes — a menu; run those relevant to the project
| pass | covers | run when |
|---|---|---|
| `audit-code-health` | dead code, duplication, complexity, naming, layering/architecture drift, deprecated patterns | always |
| `audit-docs` | stale/misleading docs & comments, missing public-API docs, README/changelog drift, onboarding gaps | always |
| `audit-tests` | suite quality — tautological/over-mocked/assertion-free tests, gaps in critical paths, flake | always |
| `audit-observability` | logging/metrics/traces adequacy, sensitive data in logs, error context | services / back-ends |
| `audit-operability` | cloud cost, IaC posture (exposure, IAM), dependency rot & supply-chain trust | has infra / deps |
| `audit-ux` | user-facing copy, empty/error states, i18n/locale, accessibility | has a UI |

Run each chosen pass across **2–3 diverse models** (more diversity → better recall on cross-cutting
issues; cost tolerance is higher than per-PR since this runs rarely). Holistic-first still holds —
these passes are deliberately broad within a dimension, not 30 narrow specialists.

## Procedure
1. **Pick the passes** relevant to the project (table). Always include code-health, docs, tests.
2. **Build each prompt** = `review-gate prompt <pass> > /tmp/ra-<pass>.txt` (emits the audit pass +
   its output contract), then append: *"Audit THIS repository — the whole codebase, not a diff.
   Explore it (read the structure, the key modules, tests, configs), then audit. Output ONLY the JSON
   array."*
3. **Run** each pass × 2–3 models:
   `review-gate run <pass> <backend> <model> <repoDir> /tmp/ra-<pass>.txt`. Read-only repo
   explorations; run as parallel background subprocesses. Collect each `output` (skip `null`s) into
   `/tmp/ra-outputs.json`. **Surface every `warning`.**
4. **Consolidate:** `review-gate consolidate /tmp/ra-outputs.json > /tmp/ra-clusters.json` —
   clusters by location, with cross-model agreement.
5. **Prioritize & report (no verdict).** Sort by severity (impact) then agreement; group by `area`.
   Produce a **prioritized backlog**: each item = the issue, where, how many models flagged it, the
   fix + a rough effort. Call out **quick wins** (high impact, low effort) and **cross-cutting themes**
   (the same problem across many files) — the highest-leverage output of a whole-repo audit.
6. **Hand off, don't enforce.** Save/post the backlog (a milestone issue, an `AUDIT.md`, a dashboard).
   The team triages; nothing here blocks a merge.

## Notes
- A deterministic tool tier helps here too — dead-code/duplication detectors (`jscpd`, `ts-prune`),
  `npm/osv` audit, license scan — same pattern as review-gate's `scan`. Layer it in where available.
- **Periodic, not per-PR.** Per-PR is `review-gate`'s job; run this at milestones so the backlog
  reflects *accumulated* drift, which is exactly what whole-repo health surfaces.
