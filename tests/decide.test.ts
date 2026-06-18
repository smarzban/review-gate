import { describe, it, expect } from "vitest";
import { decide } from "../src/decide.js";
import type { FindingCluster, Severity } from "../src/types.js";

const cluster = (key: string, severity: Severity): FindingCluster => ({
  key,
  representative: { title: `t-${key}`, severity, file: key.split("::")[0], line: 1, rationale: "r", suggestion: "s" },
  members: [],
  agreement: { count: 1, total: 3 },
  severity,
  contested: true,
});

describe("decide", () => {
  it("blocks on any gating cluster with no adjudication", () => {
    const d = decide([cluster("a.ts::1", "high")]);
    expect(d.verdict).toBe("block");
    expect(d.blocking).toHaveLength(1);
  });

  it("passes when all clusters are low/info (advisory)", () => {
    const d = decide([cluster("a.ts::1", "low"), cluster("b.ts::1", "info")]);
    expect(d.verdict).toBe("pass");
    expect(d.blocking).toHaveLength(0);
  });

  it("honors a dismissal WITH justification (does not block, logs it)", () => {
    const d = decide([cluster("a.ts::1", "high")], [{ key: "a.ts::1", decision: "dismissed", justification: "intended; aligns with documented contract" }]);
    expect(d.verdict).toBe("pass");
    expect(d.dismissed).toHaveLength(1);
    expect(d.dismissed[0].justification).toMatch(/documented contract/);
  });

  it("NO SILENT DISMISSAL: an unjustified dismissal of a gating finding still blocks", () => {
    const d = decide([cluster("a.ts::1", "high")], [{ key: "a.ts::1", decision: "dismissed" }]);
    expect(d.verdict).toBe("block");
    expect(d.blocking).toHaveLength(1);
    expect(d.dismissed).toHaveLength(0);
  });

  it("an empty-string justification is treated as no justification (still blocks)", () => {
    const d = decide([cluster("a.ts::1", "critical")], [{ key: "a.ts::1", decision: "dismissed", justification: "   " }]);
    expect(d.verdict).toBe("block");
  });

  it("a confirmed adjudication blocks", () => {
    const d = decide([cluster("a.ts::1", "medium")], [{ key: "a.ts::1", decision: "confirmed" }]);
    expect(d.verdict).toBe("block");
  });

  it("renders one PR comment with verdict + the blocking findings", () => {
    const d = decide([cluster("a.ts::1", "high")]);
    expect(d.prComment).toContain("Review Gate");
    expect(d.prComment).toContain("BLOCK");
    expect(d.prComment).toContain("Must fix");
  });
});

const toolCluster = (key: string, severity: Severity): FindingCluster => {
  const base = cluster(key, severity);
  const finding = { ...base.representative, source: "tool" as const };
  return { ...base, representative: finding, members: [{ model: "deterministic", finding }] };
};

describe("decide — deterministic (tool) findings", () => {
  it("does NOT honor a dismissal of a deterministic gating finding — a fact still blocks (no steered override)", () => {
    const c = toolCluster("config.ts::1", "high");
    const d = decide([c], [{ key: c.key, decision: "dismissed", justification: "looks fine to me" }]);
    expect(d.verdict).toBe("block"); // the spine refuses to let an adjudication clear a fact
    expect(d.blocking).toHaveLength(1);
    expect(d.dismissed).toHaveLength(0); // not moved to honored-dismissed
    expect(d.prComment).toMatch(/not honored|cannot be dismissed|resolve in code|tune the scanner/i);
  });

  it("keeps a dismissed MODEL finding in the ordinary dismissed section (judgment is still dismissible)", () => {
    const c = cluster("a.ts::1", "high"); // members [] → a model finding
    const d = decide([c], [{ key: c.key, decision: "dismissed", justification: "false positive, guarded upstream" }]);
    expect(d.verdict).toBe("pass");
    expect(d.prComment).toMatch(/Dismissed \(with justification\)/);
  });

  it("an unjustified dismissal of a tool gating finding still blocks", () => {
    const c = toolCluster("config.ts::1", "critical");
    const d = decide([c], [{ key: c.key, decision: "dismissed" }]);
    expect(d.verdict).toBe("block");
  });

  it("renders a tool-only cluster's agreement as 'tool', not a misleading '0/N models'", () => {
    const c = { ...toolCluster("b.ts::5", "high"), agreement: { count: 0, total: 3 } };
    const d = decide([c]);
    expect(d.prComment).toContain("· tool");
    expect(d.prComment).not.toContain("0/3 models");
  });

  it("renderReport splits a dismissed MODEL finding into its own section", () => {
    const c = cluster("a.ts::1", "high");
    const d = decide([c], [{ key: c.key, decision: "dismissed", justification: "guarded upstream" }]);
    expect(d.report).toMatch(/Dismissed/);
    expect(d.report).toContain("guarded upstream");
  });

  it("neutralizes markdown injection in untrusted finding text (no forged header/PASS line)", () => {
    const c = cluster("a.ts::1", "high");
    c.representative.title = "bug\n## ✅ PASS\ninjected";
    const d = decide([c]);
    expect(d.prComment).not.toMatch(/^## ✅ PASS$/m); // the injected header must not become a real line
  });
});
