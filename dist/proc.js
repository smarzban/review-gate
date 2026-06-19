import { spawn } from "node:child_process";
// Low-level process + env utilities shared by the model runner and the deterministic scanners. It is a
// NEUTRAL module both import, so neither depends on the other (runner used to reach into scan.ts for
// `envNum`). The single bounded-spawn core lives here so the orphan-hang hardening (force-settle,
// process-group kill, stdio teardown) is written ONCE and every spawn — model agent, git, scanner —
// gets it; previously only the model runner did, and a git/scanner subprocess could still hang.
/** Coerce an env override to a positive finite number, else the default; clamp to setTimeout's 32-bit
 *  max so a bad override can't silently disable a safety cap (NaN) or fire a timer immediately. */
export const envNum = (v, def) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 2_147_483_647) : def;
};
const KILL_GRACE_MS = 5_000;
/** Spawn a child under a HARD wall-clock deadline + an output byte cap, in its own process group.
 *  Hardened against the orphaned-pipe hang (the PR #4 bug): the deadline FORCE-SETTLES — it does NOT
 *  wait for `'close'` — and we tear down our read handles + `unref` the child, so an orphaned
 *  grandchild holding the stdout pipe can't keep the host alive. `detached` makes the child a group
 *  leader so we can signal the whole group. Settles exactly once.
 *
 *  byteCap "abort"    → on cap: SIGKILL the group + settle now with `byteAbort` (a hard failure).
 *  byteCap "truncate" → on cap: SIGKILL but keep the partial output + the `truncated` flag and settle
 *                       on close/deadline (the caller fails closed on it rather than parse partial). */
export function spawnBounded(bin, args, opts) {
    const graceMs = opts.graceMs ?? KILL_GRACE_MS;
    return new Promise((resolve) => {
        // detached → own process group so process.kill(-pid) reaches descendants; stdin ignored (headless).
        const child = spawn(bin, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true, signal: opts.signal });
        let out = "", err = "", bytes = 0, timedOut = false, truncated = false, byteAbort = false, settled = false;
        const killGroup = (sig) => { try {
            if (child.pid)
                process.kill(-child.pid, sig);
        }
        catch { /* group already gone */ } };
        const finish = (over) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(softTimer);
            clearTimeout(hardTimer);
            // Drop OUR read handles + the child ref so the host can exit even if an orphaned grandchild still
            // holds the pipe's write end (force-settling the promise alone leaves the read FD open → libuv
            // keeps the process alive at exit → a parent `wait` still hangs; this is the PR #4/#5 fix).
            child.stdout?.destroy();
            child.stderr?.destroy();
            try {
                child.unref();
            }
            catch { /* already gone */ }
            resolve({ stdout: out, stderr: err, code: -1, missing: false, timedOut, truncated, byteAbort, ...over });
        };
        const softTimer = setTimeout(() => { timedOut = true; killGroup("SIGTERM"); }, opts.timeoutMs);
        // Hard deadline: SIGKILL the group AND settle now — never wait on 'close' (an orphan may hold the pipe).
        const hardTimer = setTimeout(() => { killGroup("SIGKILL"); finish({}); }, opts.timeoutMs + graceMs);
        child.stdout.on("data", (d) => {
            bytes += d.length;
            if (bytes > opts.maxBytes) {
                if (opts.byteCap === "abort") {
                    byteAbort = true;
                    killGroup("SIGKILL");
                    return finish({});
                }
                truncated = true;
                killGroup("SIGKILL");
                return; // truncate: stop the child, keep what we have, settle on close
            }
            out += d.toString();
        });
        child.stderr.on("data", (d) => { if (err.length < opts.maxBytes)
            err += d.toString(); }); // cap stderr too — no OOM lever
        child.on("error", (e) => finish({ missing: e.code === "ENOENT", stderr: e.message }));
        // A clean exit (0) wins even if the soft timer just fired; only count timedOut when the kill made
        // it exit non-zero, so a natural exit at the deadline isn't a false timeout.
        child.on("close", (code) => finish({ code: code ?? -1, timedOut: timedOut && code !== 0 }));
    });
}
