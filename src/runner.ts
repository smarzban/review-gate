import { spawn } from "node:child_process";
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

const TIMEOUT_MS = Number(process.env.REVIEW_GATE_TIMEOUT_MS ?? 600_000); // agent loop, not prompt size

/** Parse a findings array out of a model's text. Accepts a bare array, a `{findings:[…]}` wrapper, a
 *  ```json fence, or an array embedded in prose (slice first `[` … last `]`). Drops malformed rows. */
export function parseFindings(text: string): Finding[] | null {
  const t = text.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    const i = t.indexOf("["), j = t.lastIndexOf("]");
    if (i < 0 || j <= i) return null;
    try { parsed = JSON.parse(t.slice(i, j + 1)); } catch { return null; }
  }
  const arr = Array.isArray(parsed) ? parsed
    : (parsed && typeof parsed === "object" && Array.isArray((parsed as any).findings)) ? (parsed as any).findings
    : null;
  if (!arr) return null;
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
    });
  }
  return out;
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

const MAX_OUTPUT_BYTES = Number(process.env.REVIEW_GATE_MAX_OUTPUT_BYTES ?? 64 * 1024 * 1024); // cap → no OOM

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
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { done(); reject(e); });
    child.on("close", (code) => {
      done();
      if (timedOut) return reject(new Error(`${backend}(${model}) timed out after ${timeoutMs}ms`));
      if (code !== 0) return reject(new Error(`${backend}(${model}) exited ${code}: ${err.trim().slice(0, 200)}`));
      resolve(out);
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
    let findings: Finding[] | null;
    if (backend === "codex") {
      findings = parseFindings(parseCodexFinal(stdout));
    } else {
      const r = parseClaudeResult(stdout);
      if (r.isError) return { output: null, warning: `${tag}: harness reported is_error` };
      findings = r.findings;
    }
    if (findings === null) return { output: null, warning: `${tag}: unparseable output` };
    return { output: { reviewer, model: `${backend}:${model}`, findings } };
  } catch (e) {
    return { output: null, warning: `${tag}: ${e instanceof Error ? e.message : String(e)}` };
  }
}
