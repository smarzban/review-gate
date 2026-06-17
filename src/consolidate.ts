import type { Finding, ReviewerOutput, FindingCluster, Severity } from "./types.js";
import { SEVERITY_RANK, GATING } from "./types.js";

// Findings from DIFFERENT models that land on the same file within a small line window are the
// "same" issue → one cluster. Agreement = how many distinct models flagged it. We cluster by
// LOCATION (file + nearby lines), not by the model's self-assigned `area`, because the same bug
// gets different area tags from different models (security vs privacy vs correctness) and we want
// those to converge, not split.
const LINE_WINDOW = Number(process.env.REVIEW_GATE_LINE_WINDOW ?? 15);

function maxSeverity(sevs: Severity[]): Severity {
  return sevs.reduce((s, x) => (SEVERITY_RANK[x] > SEVERITY_RANK[s] ? x : s), "info" as Severity);
}

export function consolidate(outputs: ReviewerOutput[]): FindingCluster[] {
  const total = new Set(outputs.map((o) => o.model)).size; // panel size = distinct models that returned
  const byFile = new Map<string, { model: string; finding: Finding }[]>();
  for (const o of outputs) {
    for (const f of o.findings) {
      const list = byFile.get(f.file) ?? [];
      list.push({ model: o.model, finding: f });
      byFile.set(f.file, list);
    }
  }

  const clusters: FindingCluster[] = [];
  for (const [file, items] of byFile) {
    items.sort((a, b) => a.finding.line - b.finding.line);
    let group: typeof items = [];
    let anchor = 0;
    const flush = () => {
      if (!group.length) return;
      const sev = maxSeverity(group.map((m) => m.finding.severity));
      const rep = [...group].sort((a, b) => SEVERITY_RANK[b.finding.severity] - SEVERITY_RANK[a.finding.severity])[0].finding;
      const count = new Set(group.map((m) => m.model)).size;
      clusters.push({
        key: `${file}::${group[0].finding.line}`,
        representative: rep,
        members: group,
        agreement: { count, total },
        severity: sev,
        // Needs the agent's eye when models DISAGREE on a gating issue (one saw it, others
        // didn't). Unanimous gating findings don't need adjudication — they just block.
        contested: GATING.has(sev) && count < total,
      });
      group = [];
    };
    for (const it of items) {
      if (group.length && it.finding.line - anchor > LINE_WINDOW) flush();
      if (!group.length) anchor = it.finding.line;
      group.push(it);
    }
    flush();
  }

  clusters.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.key.localeCompare(b.key));
  return clusters;
}
