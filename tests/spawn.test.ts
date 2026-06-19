import { describe, it, expect } from "vitest";
import { spawnWithDeadline } from "../src/runner.js";

// Reproduces the PR #4 dogfood hang: a model run that never settles because a child (or an orphaned
// grandchild re-parented to init) holds the stdout pipe open, so 'close' never fires. The fix is a
// hard wall-clock deadline that force-SETTLES the promise regardless of the child's state (plus a
// best-effort process-group kill). No network — pure local subprocesses.
const node = process.execPath;
const opts = { cwd: process.cwd(), timeoutMs: 250, graceMs: 250, maxBytes: 1 << 20 };

describe("spawnWithDeadline (hard wall-clock — must never hang)", () => {
  it("force-rejects within the deadline when a child never exits and holds stdout open", async () => {
    // setInterval keeps it alive forever; self-exits at 30s only as a leak backstop (we kill it first)
    await expect(
      spawnWithDeadline(node, ["-e", "setTimeout(()=>process.exit(0),30000); setInterval(()=>{},1e9)"], opts),
    ).rejects.toThrow(/timed out/i);
  }, 8000);

  it("force-rejects even when the PARENT exits but a detached grandchild keeps the pipe open (the orphan case)", async () => {
    // parent spawns a detached grandchild that INHERITS stdout (our pipe), unrefs it, then exits at 50ms.
    // the grandchild holds the pipe ~3s (self-exits) so 'close' can't fire on our child within the deadline.
    const orphan =
      "const cp=require('child_process');" +
      "cp.spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),3000)'],{detached:true,stdio:['ignore','inherit','ignore']}).unref();" +
      "setTimeout(()=>process.exit(0),50);";
    await expect(spawnWithDeadline(node, ["-e", orphan], opts)).rejects.toThrow(/timed out/i);
  }, 8000);

  it("resolves with stdout when the command exits cleanly before the deadline", async () => {
    const out = await spawnWithDeadline(node, ["-e", "process.stdout.write('hello')"], { ...opts, timeoutMs: 5000 });
    expect(out).toBe("hello");
  }, 8000);

  it("rejects with the exit code on a non-zero exit", async () => {
    await expect(
      spawnWithDeadline(node, ["-e", "process.stderr.write('boom'); process.exit(3)"], { ...opts, timeoutMs: 5000 }),
    ).rejects.toThrow(/exited 3/);
  }, 8000);
});
