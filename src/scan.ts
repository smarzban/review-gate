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
    if (raw.startsWith("+")) {
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
    } else if (/^\.env(\.|$)/.test(base) && !/\.(example|sample|template)$/.test(base)) {
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
    if (DEBUGGER.test(a.text)) {
      out.push(mk("medium", "hygiene", "debugger statement left in", a.file, a.line, DEBUGGER_R,
        "Remove the debugger statement."));
    }
  }
  return out;
}

/** A scanner inspects the changeset and returns findings. `gitHygiene` is pure; external-tool
 *  scanners (gitleaks, osv-scanner) will join the registry behind the same shape. */
export type Scanner = (cs: Changeset) => Finding[];
export const DEFAULT_SCANNERS: Scanner[] = [gitHygiene];

// Force deterministic, parseable plumbing output regardless of the user/CI git config — color.ui=always
// or an external diff driver would otherwise wrap lines in ANSI, yielding an empty parse and a SILENT
// empty scan. The authoritative changed-file list comes from --name-only (catches renames, empty, and
// binary files that have no `+++` header); the patch is only for content rules + line numbers.
const GIT_BASE = ["-c", "color.ui=false", "-c", "core.quotePath=false"];
export const diffArgs = (baseRef: string): string[] => [...GIT_BASE, "diff", "--no-color", "--no-ext-diff", `${baseRef}...HEAD`];
export const namesArgs = (baseRef: string): string[] => [...GIT_BASE, "diff", "--name-only", "--no-color", "--no-ext-diff", "--diff-filter=ACMR", `${baseRef}...HEAD`];

// Bound the git subprocess so a hung/pathologically-slow diff degrades to the warning path (via
// runScan's catch) instead of stalling the whole gate — mirrors runner.ts's spawnCall.
const GIT_TIMEOUT_MS = Number(process.env.REVIEW_GATE_GIT_TIMEOUT_MS ?? 60_000);

const spawnGit = (args: string[], repoDir: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: repoDir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, GIT_TIMEOUT_MS);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`git timed out after ${GIT_TIMEOUT_MS}ms`));
      code === 0 ? resolve(out) : reject(new Error(`git exited ${code}: ${err.trim().slice(0, 200)}`));
    });
  });

/** Injectable git fetches (real git by default) so tests run with NO git/network. */
export type DiffCall = (repoDir: string, baseRef: string) => Promise<string>;
export type NamesCall = (repoDir: string, baseRef: string) => Promise<string>;
const spawnDiff: DiffCall = (repoDir, baseRef) => spawnGit(diffArgs(baseRef), repoDir);
const spawnNames: NamesCall = (repoDir, baseRef) => spawnGit(namesArgs(baseRef), repoDir);

/** Run the deterministic scanners over the changeset between `baseRef` and HEAD. Returns one
 *  `ReviewerOutput` (reviewer "tools", model "deterministic") that joins the model outputs in the
 *  pool. Returns null + a warning on failure so the gate never dies on a scan hiccup. */
export async function runScan(
  repoDir: string, baseRef: string,
  opts: { diff?: DiffCall; names?: NamesCall; scanners?: Scanner[] } = {},
): Promise<{ output: ReviewerOutput | null; warning?: string }> {
  const diff = opts.diff ?? spawnDiff;
  const names = opts.names ?? spawnNames;
  const scanners = opts.scanners ?? DEFAULT_SCANNERS;
  try {
    const [patch, nameList] = await Promise.all([diff(repoDir, baseRef), names(repoDir, baseRef)]);
    const parsed = parseDiff(patch);
    // --name-only is authoritative for the file list (renames/empty/binary); union with the patch's.
    const files = [...new Set([...nameList.split("\n").map((s) => s.trim()).filter(Boolean), ...parsed.files])];
    const findings = scanners.flatMap((s) => s({ files, addedLines: parsed.addedLines }));
    return { output: { reviewer: "tools", model: "deterministic", findings } };
  } catch (e) {
    return { output: null, warning: `tools: ${e instanceof Error ? e.message : String(e)}` };
  }
}
