import { spawn } from "node:child_process";
import { envNum } from "./scan.js";
import type { Finding, ReviewerOutput } from "./types.js";

// Each reviewer is a model running in an AGENT HARNESS, pointed at the checked-out PR branch, told
// "review this PR" — it explores the repo itself (git diff, read, grep). Three backends give us
// FOUR distinct lineages without changing the orchestration:
//   - ollama  → `ollama launch claude --model <m>:cloud` : Claude Code harness driving an OPEN
//               ollama model (kimi, deepseek). Clean JSON envelope (`result`).
//   - claude  → native `claude --model <m>` : the Anthropic closed lineage (e.g. opus). Same envelope.
//   - codex   → `codex exec -m <m>` : the OpenAI closed lineage (gpt-5.5), high reasoning effort.
// Settled empirically (the bake-off): native repo exploration + model diversity + clean collection,
// avoiding omp's max_tokens block and opencode's event-stream scraping.
export type Backend = "ollama" | "claude" | "codex";

export const LAUNCHER = process.env.REVIEW_GATE_LAUNCHER ?? "ollama";
export const CLAUDE_BIN = process.env.REVIEW_GATE_CLAUDE ?? "claude";
export const CODEX_BIN = process.env.REVIEW_GATE_CODEX ?? "codex";

// Read-only tool surface for the Claude-harness backends: inspect, never mutate; git read-only.
export const DEFAULT_ALLOWED_TOOLS = [
  "Read", "Grep", "Glob",
  "Bash(git diff:*)", "Bash(git show:*)", "Bash(git log:*)", "Bash(git status:*)", "Bash(git ls-files:*)",
].join(",");

export function buildCommand(
  backend: Backend, model: string, prompt: string, repoDir: string,
  allowedTools = DEFAULT_ALLOWED_TOOLS,
): { bin: string; args: string[] } {
  switch (backend) {
    case "ollama": // `--` separates ollama-launch's flags from the args passed to claude
      return { bin: LAUNCHER, args: ["launch", "claude", "--model", model, "--",
        "-p", prompt, "--output-format", "json", "--allowedTools", allowedTools] };
    case "claude":
      return { bin: CLAUDE_BIN, args: ["--model", model,
        "-p", prompt, "--output-format", "json", "--allowedTools", allowedTools] };
    case "codex": // high reasoning effort; read-only sandbox; prompt as arg (no stdin)
      return { bin: CODEX_BIN, args: ["exec", "-C", repoDir, "-m", model,
        "-c", 'model_reasoning_effort="high"', "-c", 'sandbox_mode="read-only"', prompt] };
  }
}

const TIMEOUT_MS = envNum(process.env.REVIEW_GATE_TIMEOUT_MS, 600_000); // agent loop; envNum so a bad override can't fire the kill timers immediately

const stripCodeFence = (text: string): string =>
  text.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```$/, "").trim();

/** Parse a findings array out of a model's text. Accepts a bare array, a `{findings:[…]}` wrapper, a
 *  ```json fence, or an array embedded in prose (slice first `[` … last `]`). Drops malformed rows. */
export function parseFindings(text: string): Finding[] | null {
  const t = stripCodeFence(text);
  let parsed: unknown;
  let viaSlice = false;
  try {
    parsed = JSON.parse(t);
  } catch {
    const i = t.indexOf("["), j = t.lastIndexOf("]");
    if (i < 0 || j <= i) return null;
    try { parsed = JSON.parse(t.slice(i, j + 1)); viaSlice = true; } catch { return null; }
  }
  const arr = Array.isArray(parsed) ? parsed
    : (parsed && typeof parsed === "object" && Array.isArray((parsed as any).findings)) ? (parsed as any).findings
    : null;
  if (!arr) return null;
  // An empty array CARVED OUT of surrounding prose ("No issues. [] but auth broken at line 7.") is
  // ambiguous — it must not pass as an authoritative clean result. Only a bare/wrapped [] parsed from
  // the whole reply counts as empty; a sliced empty falls through to the caller's strict empty check.
  if (viaSlice && arr.length === 0) return null;
  const out: Finding[] = [];
  for (const f of arr) {
    if (!f || typeof f !== "object") continue;
    const r = f as Record<string, unknown>;
    const sev = String(r.severity ?? "").toLowerCase();
    if (!["critical", "high", "medium", "low", "info"].includes(sev)) continue;
    if (typeof r.title !== "string" || typeof r.file !== "string") continue;
    out.push({
      title: r.title, severity: sev as Finding["severity"], file: r.file,
      line: Number.isFinite(Number(r.line)) ? Number(r.line) : 0,
      area: typeof r.area === "string" ? r.area : undefined,
      rationale: typeof r.rationale === "string" ? r.rationale : "",
      suggestion: typeof r.suggestion === "string" ? r.suggestion : "",
      confidence: ["high", "med", "low"].includes(String(r.confidence)) ? (r.confidence as Finding["confidence"]) : undefined,
      source: "model", // ALWAYS model — a model-supplied `source` is ignored, so it can't forge a non-dismissible "tool" fact
    });
  }
  return out;
}

// A reviewer that found nothing should emit `[]` — but a model sometimes completes successfully and
// says so in PROSE ("No issues found."). parseFindings sees no array there and returns null, which
// would wrongly count a CLEAN reviewer as a failed one (inflating the thin-panel signal). This
// recognizes ONLY an unambiguous, whole-message "no issues" declaration as an empty result. It is
// deliberately fail-SAFE: extra substance, a location/object reference, or a hedge ("…but…") all
// fail to match, so a finding the model neglected to format is NEVER silently swallowed — it stays a
// non-vote (a surfaced failure), not a forged clean pass.
// A reviewer that found nothing should emit `[]`. Some still answer in PROSE ("No issues found."),
// which parseFindings can't see — so a CLEAN reviewer gets miscounted as a failed one. We recognize an
// empty result with an EXACT whitelist of whole-message declarations, NOT a fuzzy regex: a regex over
// untrusted model output proved adversarially leaky (a scoped "no critical issues", a non-ASCII finding
// after "no issues", a comma-joined hedge, a buried `[]` all slipped through). Exact-match can't be
// gamed — anything carrying extra substance simply isn't in the set, so it stays a surfaced non-vote.
const EMPTY_PHRASES = new Set([
  "[]",
  "no issues", "no issues found", "no issue found", "no issues identified",
  "no findings", "no finding", "no findings found", "no findings identified",
  "no problems", "no problem found", "no problems found",
  "no bugs", "no bug found", "no bugs found",
  "no concerns", "no defects", "no errors", "no vulnerabilities", "no vulnerabilities found",
  "nothing to report", "nothing found", "nothing of note",
  "looks good", "looks good to me", "lgtm", "all good", "all clear",
  "none", "none found", "none identified",
]);
export function isAffirmativelyEmpty(text: string): boolean {
  const t = stripCodeFence(text).toLowerCase();
  if (!t || t.length > 200) return false;                                  // blank (suspect) or too much to be a clean "nothing"
  const core = t
    .replace(/^(i\s+(found|see|identified|noticed)\s+)/, "")               // drop a leading "I found "
    .replace(/[.!?,;:\s]+$/, "")                                           // trailing punctuation / whitespace
    .replace(/\s+in\s+(this|the)\s+(change|changes|pr|diff|code|patch|codebase)$/, "") // drop a trailing scope phrase
    .replace(/[.!?,;:\s]+$/, "")
    .trim();
  return EMPTY_PHRASES.has(core);
}

/** Claude Code `--output-format json` → one envelope object; `result` is the final assistant text. */
export function parseClaudeResult(stdout: string): { findings: Finding[] | null; isError: boolean; resultText: string } {
  let env: any;
  try { env = JSON.parse(stdout); } catch { return { findings: null, isError: true, resultText: "" }; }
  const resultText = typeof env?.result === "string" ? env.result : "";
  return { findings: parseFindings(resultText), isError: env?.is_error === true, resultText };
}

/** codex exec prints an agentic trace plus the final message; the final assistant block is the last
 *  line that is exactly `codex`, up to the trailing `tokens used` footer (or EOF). */
export function parseCodexFinal(stdout: string): string {
  const lines = stdout.split("\n");
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) { if (lines[i].trim() === "codex") { start = i + 1; break; } }
  const body = (start >= 0 ? lines.slice(start) : lines);
  const end = body.findIndex((l) => l.trim() === "tokens used");
  return (end >= 0 ? body.slice(0, end) : body).join("\n").trim();
}

/** Injectable call (real backend by default) so tests run with NO network. Returns raw stdout. */
export type ModelCall = (backend: Backend, model: string, prompt: string, repoDir: string, timeoutMs: number) => Promise<string>;

const MAX_OUTPUT_BYTES = envNum(process.env.REVIEW_GATE_MAX_OUTPUT_BYTES, 64 * 1024 * 1024); // envNum so NaN can't disable the cap

const spawnCall: ModelCall = (backend, model, prompt, repoDir, timeoutMs) =>
  new Promise((resolve, reject) => {
    const { bin, args } = buildCommand(backend, model, prompt, repoDir);
    // stdin ignored (headless); cwd = the checked-out PR branch so the reviewer explores it.
    const child = spawn(bin, args, { cwd: repoDir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", bytes = 0, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    // SIGKILL escalation kept ref'd (cleared on close) so a SIGTERM-ignoring child can't outlive us.
    const killTimer = setTimeout(() => child.kill("SIGKILL"), timeoutMs + 5_000);
    const done = () => { clearTimeout(timer); clearTimeout(killTimer); };
    child.stdout.on("data", (d) => {
      bytes += d.length;
      if (bytes > MAX_OUTPUT_BYTES) { done(); child.kill("SIGKILL"); return reject(new Error(`${backend}(${model}) output exceeded ${MAX_OUTPUT_BYTES} bytes`)); }
      out += d;
    });
    child.stderr.on("data", (d) => { if (err.length < MAX_OUTPUT_BYTES) err += d; }); // cap stderr too — no OOM lever
    child.on("error", (e) => { done(); reject(e); });
    child.on("close", (code) => {
      done();
      if (code === 0) return resolve(out); // a clean exit wins even if the timer fired at the same instant
      if (timedOut) return reject(new Error(`${backend}(${model}) timed out after ${timeoutMs}ms`));
      reject(new Error(`${backend}(${model}) exited ${code}: ${err.trim().slice(0, 200)}`));
    });
  });

/** Run ONE reviewer on ONE model+backend, in `repoDir` (the model explores the checked-out branch).
 *  Returns null + a warning on any failure so a dead/flaky model never throws the whole gate down. */
export async function runReview(
  reviewer: string, backend: Backend, model: string, repoDir: string, prompt: string,
  opts: { call?: ModelCall; timeoutMs?: number } = {},
): Promise<{ output: ReviewerOutput | null; warning?: string }> {
  const call = opts.call ?? spawnCall;
  const tag = `${reviewer}/${backend}:${model}`;
  try {
    const stdout = await call(backend, model, prompt, repoDir, opts.timeoutMs ?? TIMEOUT_MS);
    let resultText: string;
    if (backend === "codex") {
      resultText = parseCodexFinal(stdout);
    } else {
      const r = parseClaudeResult(stdout);
      if (r.isError) return { output: null, warning: `${tag}: harness reported is_error` };
      resultText = r.resultText;
    }
    let findings = parseFindings(resultText);
    // A completed run whose ENTIRE reply is an unambiguous "no issues" is a 0-findings vote, not a
    // failure — so a clean reviewer isn't mistaken for a dead one. Anything ambiguous stays null.
    if (findings === null && isAffirmativelyEmpty(resultText)) findings = [];
    if (findings === null) return { output: null, warning: `${tag}: unparseable output` };
    return { output: { reviewer, model: `${backend}:${model}`, findings } };
  } catch (e) {
    return { output: null, warning: `${tag}: ${e instanceof Error ? e.message : String(e)}` };
  }
}
