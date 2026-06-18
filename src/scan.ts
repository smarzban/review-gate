import { spawn } from "node:child_process";
import type { Finding, ReviewerOutput } from "./types.js";

// The deterministic tier: cheap, exact scanners that run on the changeset and emit findings in the
// SAME `Finding` shape as the model reviewers (with `source: "tool"`), so they flow through the
// existing spine (consolidate + decide) unchanged. Unlike the model reviewers, these are TRUSTED —
// a tool finding is a fact, not an opinion (see decide.ts for the stricter dismissal handling).

/** One added/modified line in a unified diff, with its line number in the NEW file. */
export interface AddedLine { file: string; line: number; text: string; }
/** The changeset a scanner inspects: changed file paths + the lines this change adds. */
export interface Changeset { files: string[]; addedLines: AddedLine[]; }

/** Parse `git diff` output into a Changeset. Tracks the new-file line number across hunks so each
 *  added line carries an accurate location; removed lines don't advance it. Deleted files skipped. */
export function parseDiff(diff: string): Changeset {
  const files: string[] = [];
  const addedLines: AddedLine[] = [];
  let file = "";
  let newLine = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      file = p === "/dev/null" ? "" : p.replace(/^b\//, "");
      if (file) files.push(file);
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("diff --git") || raw.startsWith("index ")) continue;
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { newLine = Number(hunk[1]); continue; }
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

// Content rules run against each added line; pure regex, no external tool. High-signal, low-noise.
const CONTENT_RULES: { re: RegExp; severity: Finding["severity"]; area: string; title: string; rationale: string; suggestion: string }[] = [
  {
    re: /^(?:<<<<<<<|>>>>>>>) |^=======$/, severity: "critical", area: "hygiene",
    title: "merge conflict marker committed",
    rationale: "An unresolved merge-conflict marker is in the source — the file will not parse or compile.",
    suggestion: "Resolve the conflict and remove the <<<<<<< / ======= / >>>>>>> markers.",
  },
  {
    re: /\b(?:describe|context|it|test)\.only\(|\b(?:fdescribe|fcontext|fit)\(/, severity: "medium", area: "test-coverage",
    title: "focused test left in",
    rationale: "A focused test (.only / fit / fdescribe) makes the suite run only this test — the rest silently do not run in CI.",
    suggestion: "Remove the .only / f- prefix so the full suite runs.",
  },
  {
    re: /^\s*debugger\b/, severity: "medium", area: "hygiene",
    title: "debugger statement left in",
    rationale: "A `debugger;` left in source halts execution under a debugger — a WIP leftover.",
    suggestion: "Remove the debugger statement.",
  },
];

/** git-hygiene scanner: conflict markers, focused tests, debugger leftovers (content), and committed
 *  secrets/artifacts (path). Pure — needs no external tool, so it always runs. */
export function gitHygiene(cs: Changeset): Finding[] {
  const out: Finding[] = [];
  for (const file of cs.files) {
    const base = file.split("/").pop() ?? file;
    if (/(^|\/)node_modules\//.test(file)) {
      out.push(mk("high", "hygiene", "node_modules committed", file, 0,
        "Vendored dependencies are committed to the repo.",
        "Remove node_modules from the change and add it to .gitignore."));
    } else if (/^\.env(\.|$)/.test(base) && !/\.(example|sample|template)$/.test(base)) {
      out.push(mk("high", "hygiene", "environment file committed", file, 0,
        "A .env file may contain secrets and should not be committed.",
        "Remove it from the change, rotate any exposed secrets, and add it to .gitignore."));
    }
  }
  for (const a of cs.addedLines) {
    for (const r of CONTENT_RULES) {
      if (r.re.test(a.text)) out.push(mk(r.severity, r.area, r.title, a.file, a.line, r.rationale, r.suggestion));
    }
  }
  return out;
}

/** A scanner inspects the changeset and returns findings. `gitHygiene` is pure; external-tool
 *  scanners (gitleaks, osv-scanner) will join the registry behind the same shape. */
export type Scanner = (cs: Changeset) => Finding[];
export const DEFAULT_SCANNERS: Scanner[] = [gitHygiene];

/** Injectable diff fetch (real `git diff` by default) so tests run with NO git/network. */
export type DiffCall = (repoDir: string, baseRef: string) => Promise<string>;

const spawnDiff: DiffCall = (repoDir, baseRef) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", ["diff", `${baseRef}...HEAD`], { cwd: repoDir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`git diff exited ${code}: ${err.trim().slice(0, 200)}`))));
  });

/** Run the deterministic scanners over the changeset between `baseRef` and HEAD. Returns one
 *  `ReviewerOutput` (reviewer "tools", model "deterministic") that joins the model outputs in the
 *  pool. Returns null + a warning on failure so the gate never dies on a scan hiccup. */
export async function runScan(
  repoDir: string, baseRef: string,
  opts: { diff?: DiffCall; scanners?: Scanner[] } = {},
): Promise<{ output: ReviewerOutput | null; warning?: string }> {
  const diff = opts.diff ?? spawnDiff;
  const scanners = opts.scanners ?? DEFAULT_SCANNERS;
  try {
    const cs = parseDiff(await diff(repoDir, baseRef));
    const findings = scanners.flatMap((s) => s(cs));
    return { output: { reviewer: "tools", model: "deterministic", findings } };
  } catch (e) {
    return { output: null, warning: `tools: ${e instanceof Error ? e.message : String(e)}` };
  }
}
