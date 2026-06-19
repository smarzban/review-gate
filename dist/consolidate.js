import { SEVERITY_RANK, GATING } from "./types.js";
// Findings from DIFFERENT models that land on the same file within a small line window are the
// "same" issue → one cluster. Agreement = how many distinct models flagged it. We cluster by
// LOCATION (file + nearby lines), not by the model's self-assigned `area`, because the same bug
// gets different area tags from different models (security vs privacy vs correctness) and we want
// those to converge, not split.
const LINE_WINDOW = Number(process.env.REVIEW_GATE_LINE_WINDOW ?? 15);
function maxSeverity(sevs) {
    return sevs.reduce((s, x) => (SEVERITY_RANK[x] > SEVERITY_RANK[s] ? x : s), "info");
}
// A tool (deterministic) output joins the same pool but is NOT a model reviewer — it must not count
// toward the model-agreement denominator/numerator, or it inflates `total` and falsely flips
// unanimous model findings to `contested`.
const isToolOutput = (o) => o.reviewer === "tools" || o.model === "deterministic" ||
    (o.findings.length > 0 && o.findings.every((f) => f.source === "tool"));
export function consolidate(outputs) {
    const total = new Set(outputs.filter((o) => !isToolOutput(o)).map((o) => o.model)).size; // MODEL panel size
    const byFile = new Map();
    for (const o of outputs) {
        for (const f of o.findings) {
            const list = byFile.get(f.file) ?? [];
            list.push({ model: o.model, finding: f });
            byFile.set(f.file, list);
        }
    }
    const clusters = [];
    const clusterKey = (file, f) => f.line > 0 ? `${file}::${f.line}` : `${file}::0::${f.title.replace(/[^a-z0-9]+/gi, "-")}`;
    const pushCluster = (group, file) => {
        if (!group.length)
            return;
        const sev = maxSeverity(group.map((m) => m.finding.severity));
        const rep = [...group].sort((a, b) => SEVERITY_RANK[b.finding.severity] - SEVERITY_RANK[a.finding.severity])[0].finding;
        const count = new Set(group.filter((m) => m.finding.source !== "tool").map((m) => m.model)).size;
        clusters.push({
            key: clusterKey(file, group[0].finding),
            representative: rep,
            members: group,
            agreement: { count, total },
            severity: sev,
            // Needs the agent's eye when models DISAGREE on a gating issue (one saw it, others didn't).
            // Unanimous gating findings just block; a tool-only finding (count 0) is a fact, not
            // disagreement — it blocks too, but isn't flagged for "is this real?" scrutiny.
            contested: GATING.has(sev) && count > 0 && count < total,
        });
    };
    for (const [file, items] of byFile) {
        // File-level findings (line 0, e.g. path-based tool findings) aren't line-located — cluster them
        // by title so they don't merge with, and mask, a nearby lined model finding.
        const fileLevel = items.filter((m) => m.finding.line === 0);
        const lined = items.filter((m) => m.finding.line > 0).sort((a, b) => a.finding.line - b.finding.line);
        const byTitle = new Map();
        for (const m of fileLevel) {
            const g = byTitle.get(m.finding.title) ?? [];
            g.push(m);
            byTitle.set(m.finding.title, g);
        }
        for (const group of byTitle.values())
            pushCluster(group, file);
        let group = [];
        let anchor = 0;
        for (const it of lined) {
            if (group.length && it.finding.line - anchor > LINE_WINDOW) {
                pushCluster(group, file);
                group = [];
            }
            if (!group.length)
                anchor = it.finding.line;
            group.push(it);
        }
        pushCluster(group, file);
    }
    clusters.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.key.localeCompare(b.key));
    return clusters;
}
