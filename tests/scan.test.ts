import { describe, it, expect } from "vitest";
import { parseDiff, gitHygiene, runScan, type Changeset } from "../src/scan.js";

const cs = (addedLines: Changeset["addedLines"], files?: string[]): Changeset =>
  ({ files: files ?? [...new Set(addedLines.map((a) => a.file))], addedLines });

describe("parseDiff", () => {
  it("extracts added lines with new-file line numbers, and the changed files", () => {
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 111..222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -10,3 +10,4 @@ function f() {",
      " const a = 1;",
      "+const b = 2;",
      "-const old = 0;",
      " const c = 3;",
      "@@ -50,2 +51,3 @@",
      "+const d = 4;",
      " tail",
    ].join("\n");
    const cs = parseDiff(diff);
    expect(cs.files).toEqual(["src/app.ts"]);
    expect(cs.addedLines).toEqual([
      { file: "src/app.ts", line: 11, text: "const b = 2;" },
      { file: "src/app.ts", line: 51, text: "const d = 4;" },
    ]);
  });

  it("ignores deleted files (+++ /dev/null) and counts only added lines", () => {
    const diff = [
      "diff --git a/gone.ts b/gone.ts",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-was here",
      "-and here",
    ].join("\n");
    const c = parseDiff(diff);
    expect(c.files).toEqual([]);
    expect(c.addedLines).toEqual([]);
  });
});

describe("gitHygiene", () => {
  it("flags a merge conflict marker as critical, sourced from the tool", () => {
    const f = gitHygiene(cs([{ file: "a.ts", line: 5, text: "<<<<<<< HEAD" }]));
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("critical");
    expect(f[0].source).toBe("tool");
    expect(f[0]).toMatchObject({ file: "a.ts", line: 5 });
  });

  it("flags a focused test as a gating test-coverage issue", () => {
    const f = gitHygiene(cs([{ file: "a.test.ts", line: 10, text: "  it.only('x', () => {" }]));
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("medium");
    expect(f[0].area).toBe("test-coverage");
  });

  it("flags a left-in debugger statement", () => {
    const f = gitHygiene(cs([{ file: "a.ts", line: 3, text: "  debugger;" }]));
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("medium");
  });

  it("flags a committed .env file by path (no added line needed)", () => {
    const f = gitHygiene(cs([], [".env"]));
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("high");
    expect(f[0].file).toBe(".env");
  });

  it("does not flag .env.example", () => {
    expect(gitHygiene(cs([], [".env.example"]))).toEqual([]);
  });

  it("returns [] for a clean changeset", () => {
    expect(gitHygiene(cs([{ file: "a.ts", line: 1, text: "const x = 1;" }]))).toEqual([]);
  });
});

describe("runScan", () => {
  const diffWith = (...added: string[]) =>
    ["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "@@ -1,1 +1,2 @@", " ok", ...added.map((l) => "+" + l)].join("\n");

  it("parses the diff, runs scanners, and returns one ReviewerOutput tagged source=tool", async () => {
    const { output, warning } = await runScan("/repo", "origin/main", { diff: async () => diffWith("<<<<<<< HEAD") });
    expect(warning).toBeUndefined();
    expect(output).toMatchObject({ reviewer: "tools", model: "deterministic" });
    expect(output!.findings).toHaveLength(1);
    expect(output!.findings[0].source).toBe("tool");
  });

  it("passes repoDir + baseRef through to the diff call", async () => {
    let seen = { dir: "", base: "" };
    await runScan("/work/pr", "main", { diff: async (dir, base) => { seen = { dir, base }; return ""; } });
    expect(seen).toEqual({ dir: "/work/pr", base: "main" });
  });

  it("warns (never throws) when the diff call fails", async () => {
    const { output, warning } = await runScan("/repo", "main", { diff: async () => { throw new Error("git boom"); } });
    expect(output).toBeNull();
    expect(warning).toMatch(/git boom/);
  });
});
