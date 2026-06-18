import { spawn } from "node:child_process";
import type { Finding, ReviewerOutput } from "./types.js";

// The deterministic tier: cheap, exact scanners that run on the changeset and emit findings in the
// SAME `Finding` shape as the model reviewers (with `source: "tool"`), so they flow through the
// existing spine (consolidate + decide) unchanged. Unlike the model reviewers, these are TRUSTED —
// a tool finding is a fact, not an opinion; a dismissed one is surfaced loudly for audit (decide.ts).

/** One added/modified line in a unified diff, with its line number in the NEW file. */
export interface AddedLine { file: string; line: number; text: string; }
/** The changeset a scanner inspects: changed file paths + the lines this change adds. */
export interface Changeset { files: string[]; addedLines: AddedLine[]; }

/** Parse `git diff` output into a Changeset. Tracks the new-file line number across hunks so each
 *  added line carries an accurate location; removed lines don't advance it. Header detection is
 *  STATEFUL: `+++ `/`--- ` count as file headers only in the per-file header section (before the
 *  first `@@`), so an added content line that begins with `++ ` (serialized as `+++ `) inside a hunk
 *  is parsed as content, not a phantom file header. Deleted files are skipped. */
export function parseDiff(diff: string): Changeset {
  const files: string[] = [];
  const addedLines: AddedLine[] = [];
  let file = "";
  let newLine = 0;
  let inHunk = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git")) { inHunk = false; file = ""; continue; }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { newLine = Number(hunk[1]); inHunk = true; continue; }
    if (!inHunk) {
      if (raw.startsWith("+++ ")) {
        const p = raw.slice(4).trim();
        file = p === "/dev/null" ? "" : p.replace(/^[a-z]\//, ""); // strip a/ b/ (or mnemonic w/ c/ …)
        if (file) files.push(file);
      }
      continue; // index / ---/ extended headers (new file mode, rename …) — ignore
    }
    if (raw.startsWith("\\")) {
      // git's "\ No newline at end of file" marker — not a real line, must not advance the counter
    } else if (raw.startsWith("+")) {
      if (file) addedLines.push({ file, line: newLine, text: raw.slice(1) });
      newLine++;
    } else if (raw.startsWith("-")) {
      // removed line — does not advance the new-file line counter
    } else {
      newLine++; // context line
    }
  }
  return { files, addedLines };
}

const mk = (
  severity: Finding["severity"], area: string, title: string,
  file: string, line: number, rationale: string, suggestion: string,
): Finding => ({
  title: `[${area}] ${title}`, severity, file, line, area, rationale, suggestion,
  confidence: "high", source: "tool",
});

const START_MARKER = /^(?:<<<<<<<|>>>>>>>) /; // conflict start/end markers — unambiguous
const SEP_MARKER = /^=======$/;                // bare separator — also a markdown setext H2 underline
// Statement-anchored focused-test detection (fdescribe/fit/fcontext, or (describe|context|it|test)
// [.chain]*.only at line start). Anchoring + test-file scoping (TEST_FILE) excludes mentions in
// strings, comments, and unrelated method calls like `model.fit(...)` in application code.
const FOCUSED_TEST = /^\s*(?:f(?:describe|context|it)\b|(?:describe|context|it|test)(?:\.\w+)*\.only\b)/;
const DEBUGGER = /^\s*debugger\b/; // anchored — won't match `"debugger"` inside a string
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)__tests__\//;
const JS_FILE = /\.[cm]?[jt]sx?$/; // `debugger` is a statement only in JS/TS — don't flag it elsewhere

const CONFLICT_R = "An unresolved merge-conflict marker is in the source — the file will not parse or compile.";
const FOCUSED_R = "A focused test (.only / fit / fdescribe) makes the suite run only this test — the rest silently do not run in CI.";
const DEBUGGER_R = "A `debugger;` left in source halts execution under a debugger — a WIP leftover.";

/** git-hygiene scanner: conflict markers, focused tests, debugger leftovers (content), and committed
 *  secrets/artifacts (path). Pure — needs no external tool, so it always runs. The focused-test rule
 *  is a heuristic: statement-anchored, scoped to test files, and ADVISORY (low) — it must never block
 *  a clean PR. A bare `=======` counts only where the file also has a conflict START marker (so a
 *  markdown setext underline is not a false "critical"). Committed node_modules collapses to one
 *  finding (a real check-in is thousands of files). */
export function gitHygiene(cs: Changeset): Finding[] {
  const out: Finding[] = [];
  let nodeModulesReported = false;
  for (const file of cs.files) {
    const base = file.split("/").pop() ?? file;
    if (/(^|\/)node_modules\//.test(file)) {
      if (nodeModulesReported) continue;
      nodeModulesReported = true;
      out.push(mk("high", "hygiene", "node_modules committed", "node_modules/", 0,
        "Vendored dependencies are committed to the repo.",
        "Remove node_modules from the change and add it to .gitignore."));
    } else if (/^\.env(\.|$)/.test(base) && !/\.(example|sample|template)(\.|$)/.test(base)) {
      out.push(mk("high", "hygiene", "environment file committed", file, 0,
        "A .env file may contain secrets and should not be committed.",
        "Remove it from the change, rotate any exposed secrets, and add it to .gitignore."));
    }
  }
  const filesWithStart = new Set(cs.addedLines.filter((a) => START_MARKER.test(a.text)).map((a) => a.file));
  for (const a of cs.addedLines) {
    if (START_MARKER.test(a.text) || (SEP_MARKER.test(a.text) && filesWithStart.has(a.file))) {
      out.push(mk("critical", "hygiene", "merge conflict marker committed", a.file, a.line, CONFLICT_R,
        "Resolve the conflict and remove the <<<<<<< / ======= / >>>>>>> markers."));
    }
    if (TEST_FILE.test(a.file) && FOCUSED_TEST.test(a.text)) {
      out.push(mk("low", "test-coverage", "focused test left in", a.file, a.line, FOCUSED_R,
        "Remove the .only / f- prefix so the full suite runs."));
    }
    if (JS_FILE.test(a.file) && DEBUGGER.test(a.text)) {
      out.push(mk("medium", "hygiene", "debugger statement left in", a.file, a.line, DEBUGGER_R,
        "Remove the debugger statement."));
    }
  }
  return out;
}

/** A scanner inspects the changeset (and may shell out to a tool) and returns findings, plus an
 *  optional warning when it was SKIPPED (e.g. its tool isn't installed) — a skip never fails the
 *  gate. `gitHygiene` is pure; tool adapters run an external binary via the injected `run`, so tests
 *  need no real tool. */
export interface ScanResult { findings: Finding[]; warning?: string; }
export interface ScanInput { repoDir: string; changeset: Changeset; run: ToolRunner; signal?: AbortSignal; }
export interface Scanner { id: string; scan(input: ScanInput): Promise<ScanResult>; }

/** Runs an external tool. `missing:true` ⇒ the binary wasn't on PATH (ENOENT) → the adapter degrades
 *  to skip-with-warning instead of failing. Injectable so tests use a fixture, never a real tool. */
export interface ToolResult { stdout: string; stderr: string; code: number; missing: boolean; }
export type ToolRunner = (bin: string, args: string[], repoDir: string, signal?: AbortSignal) => Promise<ToolResult>;

/** The pure git-hygiene scanner wrapped in the async Scanner shape. Never calls a tool. */
export const gitHygieneScanner: Scanner = {
  id: "git-hygiene",
  scan: async ({ changeset }) => ({ findings: gitHygiene(changeset) }),
};

type GitleaksHit = { Description?: string; File?: string; StartLine?: number; RuleID?: string };
/** Map gitleaks JSON → critical secret findings, scoped to the changed files. Defensive on shape. */
function parseGitleaks(stdout: string, cs: Changeset): Finding[] {
  let hits: GitleaksHit[];
  try { const p = JSON.parse(stdout || "[]"); hits = Array.isArray(p) ? p : []; } catch { return []; }
  const changed = new Set(cs.files);
  return hits
    .filter((h) => typeof h.File === "string" && changed.has(h.File))
    .map((h) => mk("critical", "security", `secret: ${h.RuleID ?? "detected"}`, h.File!, Number(h.StartLine) || 0,
      `gitleaks matched ${h.RuleID ?? "a secret rule"}${h.Description ? ` (${h.Description})` : ""} — a credential committed in source.`,
      "Remove the secret, rotate it, and load it from config/env at runtime."));
}

/** secrets adapter — gitleaks. Scopes hits to the changeset; skips (warning) if gitleaks is absent.
 *  A committed secret is critical and, as a tool finding, non-dismissible by the spine. */
export const secretsScanner: Scanner = {
  id: "secrets",
  async scan({ repoDir, changeset, run, signal }) {
    if (!changeset.files.length) return { findings: [] };
    const r = await run("gitleaks",
      ["detect", "--no-banner", "--no-git", "--report-format", "json", "--report-path", "/dev/stdout", "--source", repoDir],
      repoDir, signal);
    if (r.missing) return { findings: [], warning: "secrets: gitleaks not on PATH — skipped (install gitleaks to enable secret scanning)" };
    return { findings: parseGitleaks(r.stdout, changeset) };
  },
};

const MANIFEST = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|package\.json|requirements\.txt|poetry\.lock|Pipfile\.lock|go\.(mod|sum)|Cargo\.lock|Gemfile\.lock|composer\.lock)$/;

/** Map osv-scanner JSON → high dependency findings, restricted to the changed manifests. A new/changed
 *  dependency's CVE is in scope even though the vulnerable code isn't in the diff. Defensive on shape. */
function parseOsv(stdout: string, manifests: string[]): Finding[] {
  let parsed: any;
  try { parsed = JSON.parse(stdout || "{}"); } catch { return []; }
  const results: any[] = Array.isArray(parsed?.results) ? parsed.results : [];
  const out: Finding[] = [];
  for (const res of results) {
    const path = typeof res?.source?.path === "string" ? res.source.path : "";
    const file = manifests.find((m) => path === m || path.endsWith("/" + m) || path.endsWith(m));
    if (!file) continue; // only report vulns for the manifests this PR actually changed
    for (const pkg of Array.isArray(res?.packages) ? res.packages : []) {
      const name = pkg?.package?.name ?? "dependency";
      const version = pkg?.package?.version ? `@${pkg.package.version}` : "";
      for (const v of Array.isArray(pkg?.vulnerabilities) ? pkg.vulnerabilities : []) {
        out.push(mk("high", "dependency", `${v?.id ?? "vulnerability"}: ${name}`, file, 0,
          `Known vulnerability in ${name}${version}${v?.summary ? ` — ${v.summary}` : ""}.`,
          `Upgrade ${name} to a patched version (see ${v?.id ?? "the advisory"}).`));
      }
    }
  }
  return out;
}

/** deps adapter — osv-scanner. Fires only when a manifest/lockfile changed; reports CVEs against the
 *  changed manifests; skips (warning) if osv-scanner is absent. */
export const depsScanner: Scanner = {
  id: "deps",
  async scan({ repoDir, changeset, run, signal }) {
    const manifests = changeset.files.filter((f) => MANIFEST.test(f));
    if (!manifests.length) return { findings: [] };
    const r = await run("osv-scanner", ["--format", "json", "--recursive", repoDir], repoDir, signal);
    if (r.missing) return { findings: [], warning: "deps: osv-scanner not on PATH — skipped (install osv-scanner to enable dependency CVE scanning)" };
    return { findings: parseOsv(r.stdout, manifests) };
  },
};

/** Pure scanners only — the safe default (no subprocess; keeps the library/tests fast). */
export const DEFAULT_SCANNERS: Scanner[] = [gitHygieneScanner];
/** Default + external-tool adapters (each skips gracefully if its tool is absent). Used by the CLI. */
export const ALL_SCANNERS: Scanner[] = [gitHygieneScanner, secretsScanner, depsScanner];

// Force deterministic, parseable plumbing output regardless of the user/CI git config — color.ui=always
// or an external diff driver would otherwise wrap lines in ANSI, yielding an empty parse and a SILENT
// empty scan. The authoritative changed-file list comes from --name-only (catches renames, empty, and
// binary files that have no `+++` header); the patch is only for content rules + line numbers.
const GIT_BASE = ["-c", "color.ui=false", "-c", "core.quotePath=false", "-c", "diff.noprefix=false"];
// `--end-of-options` makes git treat the range token as a revision, never an option, so a baseRef
// like `--output=…` can't inject a git flag (it errors as a bad revision → the warning path).
export const diffArgs = (baseRef: string): string[] => [...GIT_BASE, "diff", "--no-color", "--no-ext-diff", "--end-of-options", `${baseRef}...HEAD`];
export const namesArgs = (baseRef: string): string[] => [...GIT_BASE, "diff", "--name-only", "--no-color", "--no-ext-diff", "--diff-filter=ACMR", "--end-of-options", `${baseRef}...HEAD`];

/** Parse a positive-integer env override; fall back to `def` for missing/non-numeric/non-positive
 *  values so a bad override can't silently disable a safety cap (NaN) or fire a timer immediately. */
export const envNum = (v: string | undefined, def: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
};

// Bound the git subprocess so a hung/pathologically-slow diff degrades to the (fail-closed) error
// path instead of stalling the whole gate — mirrors runner.ts's spawnCall.
const GIT_TIMEOUT_MS = envNum(process.env.REVIEW_GATE_GIT_TIMEOUT_MS, 60_000);
const GIT_MAX_BYTES = envNum(process.env.REVIEW_GATE_GIT_MAX_BYTES, 64 * 1024 * 1024); // cap diff size → no OOM

const spawnGit = (args: string[], repoDir: string, signal?: AbortSignal): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: repoDir, stdio: ["ignore", "pipe", "pipe"], signal });
    let out = "", err = "", bytes = 0, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, GIT_TIMEOUT_MS);
    // SIGKILL escalation kept ref'd (cleared on close) so a SIGTERM-ignoring child can't outlive us.
    const killTimer = setTimeout(() => child.kill("SIGKILL"), GIT_TIMEOUT_MS + 5_000);
    const done = () => { clearTimeout(timer); clearTimeout(killTimer); };
    child.stdout.on("data", (d) => {
      bytes += d.length;
      if (bytes > GIT_MAX_BYTES) { done(); child.kill("SIGKILL"); return reject(new Error(`git output exceeded ${GIT_MAX_BYTES} bytes`)); }
      out += d;
    });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { done(); reject(e); });
    child.on("close", (code) => {
      done();
      if (timedOut) return reject(new Error(`git timed out after ${GIT_TIMEOUT_MS}ms`));
      code === 0 ? resolve(out) : reject(new Error(`git exited ${code}: ${err.trim().slice(0, 200)}`));
    });
  });

// Default ToolRunner: spawn a tool, RESOLVE (never reject) with its result — a nonzero exit is normal
// for scanners (gitleaks exit 1 = leaks found). ENOENT ⇒ missing (graceful skip). Bounded like git.
const spawnTool: ToolRunner = (bin, args, repoDir, signal) =>
  new Promise((resolve) => {
    let out = "", err = "", bytes = 0, timedOut = false, settled = false;
    const child = spawn(bin, args, { cwd: repoDir, stdio: ["ignore", "pipe", "pipe"], signal });
    const done = () => { clearTimeout(timer); clearTimeout(killTimer); };
    const finish = (r: ToolResult) => { if (settled) return; settled = true; done(); resolve(r); };
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, GIT_TIMEOUT_MS);
    const killTimer = setTimeout(() => child.kill("SIGKILL"), GIT_TIMEOUT_MS + 5_000);
    child.stdout.on("data", (d) => { bytes += d.length; if (bytes > GIT_MAX_BYTES) child.kill("SIGKILL"); else out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e: NodeJS.ErrnoException) => finish({ stdout: "", stderr: e.message, code: -1, missing: e.code === "ENOENT" }));
    child.on("close", (code) => finish({ stdout: out, stderr: err, code: timedOut ? -1 : code ?? -1, missing: false }));
  });

/** Injectable git fetches (real git by default) so tests run with NO git/network. */
export type DiffCall = (repoDir: string, baseRef: string, signal?: AbortSignal) => Promise<string>;
export type NamesCall = (repoDir: string, baseRef: string, signal?: AbortSignal) => Promise<string>;
const spawnDiff: DiffCall = (repoDir, baseRef, signal) => spawnGit(diffArgs(baseRef), repoDir, signal);
const spawnNames: NamesCall = (repoDir, baseRef, signal) => spawnGit(namesArgs(baseRef), repoDir, signal);

/** Run the deterministic scanners over the changeset between `baseRef` and HEAD. Returns one
 *  `ReviewerOutput` (reviewer "tools", model "deterministic") that joins the model outputs in the
 *  pool. Returns null + a warning on failure so the gate never dies on a scan hiccup. */
export async function runScan(
  repoDir: string, baseRef: string,
  opts: { diff?: DiffCall; names?: NamesCall; scanners?: Scanner[]; run?: ToolRunner } = {},
): Promise<{ output: ReviewerOutput | null; warning?: string }> {
  // FAIL CLOSED: a deterministic backstop that can't run must NOT silently pass — otherwise an
  // attacker disables it (oversized diff, hostile ref) and committed secrets slip through. On any
  // failure, emit a gating tool finding (which the spine won't let anyone dismiss) + the warning.
  const failClosed = (reason: string) => ({
    output: {
      reviewer: "tools", model: "deterministic",
      findings: [mk("high", "hygiene", "deterministic scan failed — failing closed", "<scan>", 0,
        `The deterministic scan could not complete (${reason}). A scan that cannot run is treated as blocking, not a pass.`,
        "Investigate the failure (oversized/pathological diff, git error, timeout, or an unsafe baseRef) and re-run.")],
    } as ReviewerOutput,
    warning: `tools: ${reason}`,
  });

  // Refuse an option-shaped baseRef before spawning git — defence-in-depth alongside --end-of-options.
  if (!baseRef || /^-/.test(baseRef)) return failClosed(`refusing unsafe baseRef "${baseRef}" (looks like a git option)`);

  const diff = opts.diff ?? spawnDiff;
  const names = opts.names ?? spawnNames;
  const scanners = opts.scanners ?? DEFAULT_SCANNERS;
  const run = opts.run ?? spawnTool;
  const ac = new AbortController();
  try {
    const [patch, nameList] = await Promise.all([diff(repoDir, baseRef, ac.signal), names(repoDir, baseRef, ac.signal)]);
    const parsed = parseDiff(patch);
    // --name-only is authoritative for the file list (renames/empty/binary); union with the patch's.
    const files = [...new Set([...nameList.split("\n").map((s) => s.trim()).filter(Boolean), ...parsed.files])];
    const changeset: Changeset = { files, addedLines: parsed.addedLines };
    const results = await Promise.all(scanners.map((s) => s.scan({ repoDir, changeset, run, signal: ac.signal })));
    const findings = results.flatMap((r) => r.findings);
    const warnings = results.map((r) => r.warning).filter((w): w is string => Boolean(w));
    return { output: { reviewer: "tools", model: "deterministic", findings }, warning: warnings.length ? warnings.join("; ") : undefined };
  } catch (e) {
    ac.abort(); // a sibling git child (e.g. the slow full diff) shouldn't linger after the other fails
    return failClosed(e instanceof Error ? e.message : String(e));
  }
}
