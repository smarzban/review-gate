// The data model for the gate. Deliberately small: a reviewer produces Findings; the spine
// clusters them, computes cross-model agreement, takes the agent's adjudication of contested
// clusters, and emits a deterministic verdict + one PR comment.

export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Confidence = "high" | "med" | "low";

/** A single issue from one model's review. `area` is the concern label (security, privacy, …)
 *  the model self-tags; it's advisory only and never used for the gate decision. */
export interface Finding {
  title: string;
  severity: Severity;
  file: string;
  line: number;
  area?: string;
  rationale: string;
  suggestion: string;
  confidence?: Confidence;
}

/** One model's full review (a holistic pass or a targeted lens). `reviewer` is the prompt id
 *  used ("holistic", "lens:test-coverage", …); `model` is the actual model that ran. */
export interface ReviewerOutput {
  reviewer: string;
  model: string;
  findings: Finding[];
}

/** Findings from different MODELS that land on the same file + nearby lines are clustered.
 *  `agreement.count` = distinct models that flagged it; `total` = models whose review we have.
 *  A cluster is `contested` when models disagree (count < total) OR only one model saw it on a
 *  gating-severity issue — those require the agent to adjudicate. */
export interface FindingCluster {
  key: string;                 // file::lineBucket
  representative: Finding;      // highest-severity member, for display
  members: { model: string; finding: Finding }[];
  agreement: { count: number; total: number };
  severity: Severity;          // max severity across members
  contested: boolean;
}

export type AdjudicationDecision = "confirmed" | "dismissed";

/** The agent's call on a contested cluster. Dismissing a GATING finding (critical/high/medium)
 *  REQUIRES a non-empty justification — the spine treats an unjustified dismissal as still
 *  blocking (no silent dismissal). This is the one place model judgment enters the verdict. */
export interface Adjudication {
  key: string;
  decision: AdjudicationDecision;
  justification?: string;
}

export type Verdict = "pass" | "block";

export interface Decision {
  verdict: Verdict;
  blocking: FindingCluster[];
  dismissed: { cluster: FindingCluster; justification: string }[];
  report: string;     // human-readable, severity-sorted
  prComment: string;  // the single consolidated PR comment
}

/** Severity rank: higher = worse. Gating = critical/high/medium. */
export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4, high: 3, medium: 2, low: 1, info: 0,
};
export const GATING: ReadonlySet<Severity> = new Set<Severity>(["critical", "high", "medium"]);
