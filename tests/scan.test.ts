import { describe, it, expect } from "vitest";
import { parseDiff, gitHygiene, runScan, diffArgs, namesArgs, type Changeset } from "../src/scan.js";

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

  it("skips the '\\ No newline at end of file' marker without advancing line numbers", () => {
    const diff = ["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "@@ -1,2 +1,2 @@", "-old", "\\ No newline at end of file", "+new", "+after"].join("\n");
    const c = parseDiff(diff);
    expect(c.addedLines.find((a) => a.text === "after")!.line).toBe(2); // not drifted to 3
  });

  it("treats '+++ ...' inside a hunk body as an added line, not a file header (no phantom file, no drift)", () => {
    const diff = [
      "diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts",
      "@@ -1,1 +1,2 @@", " ok", "+++ plus",
      "@@ -5,1 +6,1 @@", "+tail",
    ].join("\n");
    const c = parseDiff(diff);
    expect(c.files).toEqual(["x.ts"]); // no phantom "plus" file
    expect(c.addedLines.find((a) => a.text === "++ plus")).toMatchObject({ file: "x.ts", line: 2 });
    expect(c.addedLines.find((a) => a.text === "tail")!.line).toBe(6); // line numbers not drifted
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

  it("flags a focused test in a TEST file as advisory (low, non-gating heuristic)", () => {
    const f = gitHygiene(cs([{ file: "a.test.ts", line: 10, text: "  it.only('x', () => {" }]));
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("low");
    expect(f[0].area).toBe("test-coverage");
  });

  it("flags a left-in debugger statement in a JS/TS file", () => {
    const f = gitHygiene(cs([{ file: "a.ts", line: 3, text: "  debugger;" }]));
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("medium");
  });

  it("does NOT flag a line-leading `debugger` identifier in a non-JS file", () => {
    expect(gitHygiene(cs([{ file: "app.py", line: 1, text: "debugger = get_logger()" }]))).toEqual([]);
  });

  it("flags a committed .env file by path (no added line needed)", () => {
    const f = gitHygiene(cs([], [".env"]));
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("high");
    expect(f[0].file).toBe(".env");
  });

  it("does not flag .env.example or example variants like .env.example.local", () => {
    expect(gitHygiene(cs([], [".env.example"]))).toEqual([]);
    expect(gitHygiene(cs([], [".env.example.local"]))).toEqual([]);
  });

  it("returns [] for a clean changeset", () => {
    expect(gitHygiene(cs([{ file: "a.ts", line: 1, text: "const x = 1;" }]))).toEqual([]);
  });
});

describe("runScan", () => {
  const diffWith = (...added: string[]) =>
    ["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "@@ -1,1 +1,2 @@", " ok", ...added.map((l) => "+" + l)].join("\n");

  it("parses the diff, runs scanners, and returns one ReviewerOutput tagged source=tool", async () => {
    const { output, warning } = await runScan("/repo", "origin/main", { diff: async () => diffWith("<<<<<<< HEAD"), names: async () => "x.ts\n" });
    expect(warning).toBeUndefined();
    expect(output).toMatchObject({ reviewer: "tools", model: "deterministic" });
    expect(output!.findings).toHaveLength(1);
    expect(output!.findings[0].source).toBe("tool");
  });

  it("passes repoDir + baseRef through to the diff call", async () => {
    let seen = { dir: "", base: "" };
    await runScan("/work/pr", "main", { diff: async (dir, base) => { seen = { dir, base }; return ""; }, names: async () => "" });
    expect(seen).toEqual({ dir: "/work/pr", base: "main" });
  });

  it("flags a committed .env that appears only via --name-only (e.g. a pure rename, no +++ header)", async () => {
    const { output } = await runScan("/r", "main", { diff: async () => "", names: async () => ".env\n" });
    expect(output!.findings.some((f) => f.file === ".env" && f.severity === "high")).toBe(true);
  });

  it("warns (never throws) when the diff call fails", async () => {
    const { output, warning } = await runScan("/repo", "main", { diff: async () => { throw new Error("git boom"); }, names: async () => "" });
    expect(output).toBeNull();
    expect(warning).toMatch(/git boom/);
  });
});

describe("git invocation flags", () => {
  it("forces deterministic, parseable plumbing output regardless of user/CI git config", () => {
    const d = diffArgs("main").join(" ");
    expect(d).toMatch(/--no-color/);
    expect(d).toMatch(/--no-ext-diff/);
    expect(d).toMatch(/color\.ui=false/);
    expect(d).toMatch(/core\.quotePath=false/);
    expect(d).toMatch(/diff\.noprefix=false/);
    expect(d).toContain("main...HEAD");
    expect(namesArgs("main").join(" ")).toMatch(/--name-only/);
  });
});

describe("gitHygiene focused-test rule — scoped to test files, statement-anchored", () => {
  it("does NOT flag model.fit() or a bare fit( in application code", () => {
    expect(gitHygiene(cs([{ file: "src/model.ts", line: 1, text: "  const m = model.fit(X, y);" }]))).toEqual([]);
    expect(gitHygiene(cs([{ file: "src/chart.ts", line: 1, text: "  fit(container);" }]))).toEqual([]);
  });

  it("does NOT flag .only mentioned in a string or comment (anchored to statement start)", () => {
    expect(gitHygiene(cs([{ file: "a.test.ts", line: 1, text: '  const s = "it.only(x)";' }]))).toEqual([]);
    expect(gitHygiene(cs([{ file: "a.test.ts", line: 2, text: "  // remove it.only() before committing" }]))).toEqual([]);
  });

  it("flags a real focused test (and chained forms) in a TEST file", () => {
    expect(gitHygiene(cs([{ file: "a.test.ts", line: 3, text: "  it.only('x', () => {" }]))).toHaveLength(1);
    expect(gitHygiene(cs([{ file: "a.spec.ts", line: 4, text: "  test.concurrent.only('y', () => {" }]))).toHaveLength(1);
  });

  it("does NOT apply the focused-test rule outside test files", () => {
    expect(gitHygiene(cs([{ file: "src/app.ts", line: 3, text: "  it.only('x', () => {" }]))).toEqual([]);
  });
});

describe("gitHygiene other guards", () => {
  it("only flags a bare ======= when the same file also has a conflict start marker", () => {
    expect(gitHygiene(cs([{ file: "README.md", line: 1, text: "=======" }]))).toEqual([]); // markdown setext underline
    const real = gitHygiene(cs([{ file: "a.ts", line: 1, text: "<<<<<<< HEAD" }, { file: "a.ts", line: 5, text: "=======" }]));
    expect(real.length).toBeGreaterThanOrEqual(1);
  });

  it("collapses many committed node_modules files into a single finding", () => {
    const f = gitHygiene(cs([], ["node_modules/a/index.js", "node_modules/b/x.js", "node_modules/c/y.js"]));
    expect(f.filter((x) => x.title.includes("node_modules"))).toHaveLength(1);
  });
});
