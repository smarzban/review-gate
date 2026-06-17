import { describe, it, expect } from "vitest";
import { consolidate } from "../src/consolidate.js";
import type { ReviewerOutput, Finding } from "../src/types.js";

const f = (file: string, line: number, severity: Finding["severity"], title = "t"): Finding =>
  ({ title, severity, file, line, rationale: "r", suggestion: "s" });
const out = (model: string, findings: Finding[]): ReviewerOutput => ({ reviewer: "holistic", model, findings });

describe("consolidate", () => {
  it("merges nearby findings from different models into one cluster with agreement count", () => {
    const clusters = consolidate([
      out("gpt", [f("App.tsx", 83, "high")]),
      out("deepseek", [f("App.tsx", 90, "high")]),  // within the line window of 83
      out("kimi", [f("App.tsx", 88, "high")]),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].agreement).toEqual({ count: 3, total: 3 });
    expect(clusters[0].contested).toBe(false); // unanimous gating → not contested
  });

  it("marks a gating finding only one model saw as contested", () => {
    const clusters = consolidate([
      out("gpt", [f("a.ts", 10, "high")]),
      out("deepseek", []),
      out("kimi", []),
    ]);
    expect(clusters[0].agreement).toEqual({ count: 1, total: 3 });
    expect(clusters[0].contested).toBe(true);
  });

  it("does not merge findings that are far apart", () => {
    const clusters = consolidate([out("gpt", [f("a.ts", 10, "high"), f("a.ts", 200, "high")])]);
    expect(clusters).toHaveLength(2);
  });

  it("takes the max severity as the cluster severity", () => {
    const clusters = consolidate([out("gpt", [f("a.ts", 5, "medium")]), out("deepseek", [f("a.ts", 6, "critical")])]);
    expect(clusters[0].severity).toBe("critical");
  });

  it("never marks a low/info finding contested (advisory only)", () => {
    const clusters = consolidate([out("gpt", [f("a.ts", 5, "low")]), out("deepseek", []), out("kimi", [])]);
    expect(clusters[0].contested).toBe(false);
  });

  it("sorts clusters by severity descending", () => {
    const clusters = consolidate([out("gpt", [f("a.ts", 5, "low"), f("b.ts", 5, "critical")])]);
    expect(clusters[0].severity).toBe("critical");
  });
});
