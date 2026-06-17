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
