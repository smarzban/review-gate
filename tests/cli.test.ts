import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Exercises the `prompt` verb end-to-end through the COMMITTED dist/ artifact — the build the
// installed plugin actually runs. Covers cli.ts dispatch + prompt-file resolution, which the
// prompts.ts unit tests (injected read) don't reach; doubles as a smoke test of the shipped binary.
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const run = (args: string[]) => execFileSync("node", [CLI, ...args], { encoding: "utf8" });

describe("cli `prompt` verb (committed dist/ artifact)", () => {
  it("emits a reviewer prompt followed by its output contract", () => {
    const out = run(["prompt", "holistic"]);
    expect(out).toContain("# Holistic code review");
    expect(out).toContain("# Output contract"); // the output-contract was appended
  });

  it("serves an audit pass + the audit output contract", () => {
    expect(run(["prompt", "audit-tests"])).toContain("# Audit: test suite quality");
  });

  it("exits non-zero on an unsafe prompt name (no path traversal through the verb)", () => {
    expect(() => run(["prompt", "../../etc/passwd"])).toThrow();
  });
});
