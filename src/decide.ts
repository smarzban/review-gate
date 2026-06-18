import type { FindingCluster, Adjudication, Decision, Verdict, Severity } from "./types.js";
import { SEVERITY_RANK, GATING } from "./types.js";

// The deterministic spine: clusters + the agent's adjudications → a land verdict, plus the single
// PR comment. The ONLY model judgment that enters here is an Adjudication, and even that is
// constrained: a gating finding can be dismissed ONLY with a non-empty justification (no silent
// dismissal). Everything else — what blocks, the report shaping, the verdict — is pure code, so a
// prompt-injected diff or a sloppy/steered agent cannot flip the gate or quietly bury a finding.

export function decide(clusters: FindingCluster[], adjudications: Adjudication[] = []): Decision {
  const adj = new Map(adjudications.map((a) => [a.key, a]));
  const blocking: FindingCluster[] = [];
  const dismissed: { cluster: FindingCluster; justification: string }[] = [];

  for (const c of clusters) {
    if (!GATING.has(c.severity)) continue; // low/info are advisory — never block
    const a = adj.get(c.key);
    if (a?.decision === "dismissed") {
      const j = (a.justification ?? "").trim();
      if (j) { dismissed.push({ cluster: c, justification: j }); continue; }
      // unjustified dismissal of a gating finding ⇒ NOT honored; it still blocks.
    }
    blocking.push(c);
  }

  const verdict: Verdict = blocking.length > 0 ? "block" : "pass";
  return { verdict, blocking, dismissed, report: renderReport(clusters, dismissed), prComment: renderComment(verdict, clusters, blocking, dismissed) };
}

const ICON: Record<Severity, string> = { critical: "🔴", high: "🔴", medium: "🟠", low: "⚪", info: "⚪" };

function line(c: FindingCluster): string {
  const f = c.representative;
  const ag = agreementLabel(c);
  const area = f.area ? ` _(${f.area})_` : "";
  return `- ${ICON[c.severity]} **[${c.severity.toUpperCase()}]** ${f.title} — \`${f.file}:${f.line}\` · ${ag}${area}\n` +
    `  ${f.rationale}\n  _Fix:_ ${f.suggestion}`;
}

function bySeverity(clusters: FindingCluster[]): FindingCluster[] {
  return [...clusters].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.key.localeCompare(b.key));
}

// A cluster is deterministic when a TOOL (a scanner) produced any of its findings — a fact, not an
// opinion. Dismissing one is surfaced loudly and separately so the override is auditable.
const isDeterministic = (c: FindingCluster): boolean =>
  c.representative.source === "tool" || c.members.some((m) => m.finding.source === "tool");

// Model agreement is a model-only signal. A tool-detected cluster with no model corroboration shows
// "tool" (not "0/N models", which would imply models looked and disagreed); a mixed one adds "+ tool".
function agreementLabel(c: FindingCluster): string {
  const tool = isDeterministic(c);
  if (c.agreement.count === 0 && tool) return "tool";
  const base = `${c.agreement.count}/${c.agreement.total} models`;
  return tool ? `${base} + tool` : base;
}

const dismissedLine = (x: { cluster: FindingCluster; justification: string }, label: string): string =>
  `- **[${x.cluster.severity.toUpperCase()}]** ${x.cluster.representative.title} — ` +
  `\`${x.cluster.representative.file}:${x.cluster.representative.line}\`\n  _${label}:_ ${x.justification}`;

export function renderReport(clusters: FindingCluster[], dismissed: { cluster: FindingCluster; justification: string }[]): string {
  const lines = bySeverity(clusters).map(line);
  const fmt = (x: { cluster: FindingCluster; justification: string }) => `- [${x.cluster.severity}] ${x.cluster.representative.title} — ${x.justification}`;
  const overridden = dismissed.filter((x) => isDeterministic(x.cluster));
  const ordinary = dismissed.filter((x) => !isDeterministic(x.cluster));
  const section = (title: string, items: typeof dismissed) => (items.length ? `\n## ${title}\n${items.map(fmt).join("\n")}` : "");
  return [`# Review (${clusters.length} clusters)`, ...lines,
    section("Deterministic findings overridden", overridden), section("Dismissed", ordinary)].filter(Boolean).join("\n");
}

export function renderComment(verdict: Verdict, clusters: FindingCluster[], blocking: FindingCluster[], dismissed: { cluster: FindingCluster; justification: string }[]): string {
  const counts: Record<string, number> = {};
  for (const c of clusters) counts[c.severity] = (counts[c.severity] ?? 0) + 1;
  const tally = (["critical", "high", "medium", "low", "info"] as Severity[]).map((s) => `${counts[s] ?? 0} ${s}`).join(" · ");
  const head = verdict === "block"
    ? `🚫 **BLOCK** — ${blocking.length} blocking finding(s) must be resolved or justified.`
    : `✅ **PASS** — no blocking findings.`;

  const parts = ["## Review Gate", head, `\nFindings: ${clusters.length} total — ${tally}.`];

  const blk = bySeverity(blocking);
  if (blk.length) parts.push("\n### Must fix\n" + blk.map(line).join("\n"));

  const advisory = bySeverity(clusters.filter((c) => !GATING.has(c.severity)));
  if (advisory.length) parts.push("\n### Advisory (non-blocking)\n" + advisory.map(line).join("\n"));

  const overridden = dismissed.filter((x) => isDeterministic(x.cluster));
  const ordinary = dismissed.filter((x) => !isDeterministic(x.cluster));
  if (overridden.length) {
    parts.push(`\n### ⚠️ Deterministic findings overridden (${overridden.length})\n` +
      "Exact tool detections the reviewer dismissed — each must carry a code-checked justification. Verify them.\n" +
      overridden.map((x) => dismissedLine(x, "Override")).join("\n"));
  }
  if (ordinary.length) {
    parts.push("\n### Dismissed (with justification)\n" + ordinary.map((x) => dismissedLine(x, "Dismissed")).join("\n"));
  }
  return parts.join("\n");
}
