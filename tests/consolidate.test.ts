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

// Tool (deterministic) outputs join the same pool but are NOT model reviewers — they must not
// count toward the model-agreement denominator/numerator (the panel-inflation bug from the dogfood).
const toolOut = (findings: Finding[]): ReviewerOutput => ({ reviewer: "tools", model: "deterministic", findings });
const tf = (file: string, line: number, severity: Finding["severity"]): Finding =>
  ({ title: "tool", severity, file, line, rationale: "r", suggestion: "s", source: "tool" });

describe("consolidate — tool outputs vs model agreement", () => {
  it("excludes the tool output from total and count when models also flag the spot", () => {
    const clusters = consolidate([
      out("gpt", [f("a.ts", 10, "high")]),
      out("deepseek", [f("a.ts", 12, "high")]),
      toolOut([tf("a.ts", 10, "high")]),
    ]);
    expect(clusters[0].agreement).toEqual({ count: 2, total: 2 }); // 2 models, not 3
    expect(clusters[0].contested).toBe(false);                      // unanimous among models
  });

  it("does not flip a unanimous model finding to contested just because a tool output exists elsewhere", () => {
    const clusters = consolidate([
      out("gpt", [f("a.ts", 10, "high")]),
      out("deepseek", [f("a.ts", 12, "high")]),
      toolOut([tf("other.ts", 1, "high")]),
    ]);
    const c = clusters.find((x) => x.key.startsWith("a.ts"))!;
    expect(c.agreement).toEqual({ count: 2, total: 2 });
    expect(c.contested).toBe(false);
  });

  it("a tool-only cluster reports 0 model agreement (the tool is not a model)", () => {
    const clusters = consolidate([out("gpt", [f("a.ts", 10, "high")]), toolOut([tf("b.ts", 5, "high")])]);
    const c = clusters.find((x) => x.key.startsWith("b.ts"))!;
    expect(c.agreement).toEqual({ count: 0, total: 1 });
  });
});
