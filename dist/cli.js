#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runReview } from "./runner.js";
import { runScan, ALL_SCANNERS } from "./scan.js";
import { consolidate } from "./consolidate.js";
import { decide } from "./decide.js";
import { assemblePrompt } from "./prompts.js";
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const print = (o) => process.stdout.write(JSON.stringify(o, null, 2) + "\n");
// prompts/ ships beside this binary — resolve relative to THIS file, not the cwd, so the CLI serves
// its bundled prompts from wherever the plugin is installed. (src/cli.ts in dev and dist/cli.js in a
// build are both one level under the package root, so `..` lands on it either way.)
const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");
async function main() {
    const [cmd, ...args] = process.argv.slice(2);
    switch (cmd) {
        case "run": {
            // run <reviewer> <backend> <model> <repoDir> <promptFile>
            // backend = ollama | claude | codex. Runs ONE reviewer in <repoDir> (the checked-out PR
            // branch) — the model explores the repo itself. The orchestrator calls this once per
            // (reviewer × model) and collects the printed outputs. Untrusted: a model call.
            const [reviewer, backend, model, repoDir, promptFile] = args;
            const prompt = readFileSync(promptFile, "utf8");
            const { output, warning } = await runReview(reviewer, backend, model, repoDir, prompt);
            print({ reviewer, backend, model, output, warning: warning ?? null });
            break;
        }
        case "scan": {
            // scan <repoDir> <baseRef>   — the deterministic tier (no LLM). Runs `git diff <baseRef>...HEAD`
            // and the scanners; emits a ReviewerOutput {reviewer:"tools", model:"deterministic"} that the
            // orchestrator merges into the same outputs pool as the model reviewers. Trusted, exact, cheap.
            const [repoDir, baseRef] = args;
            const { output, warning } = await runScan(repoDir, baseRef, { scanners: ALL_SCANNERS });
            print({ output, warning: warning ?? null });
            break;
        }
        case "prompt": {
            // prompt <name>   — print the named reviewer/audit prompt + its output contract to stdout, so a
            // skill can build a prompt file with no path to the plugin: `review-gate prompt holistic > f`.
            // The per-invocation scope line ("review THIS PR …") is appended by the caller, not here.
            const [name] = args;
            if (!name) {
                process.stderr.write("usage: review-gate prompt <name>\n");
                process.exit(2);
            }
            process.stdout.write(assemblePrompt(name, (b) => readFileSync(join(PROMPTS_DIR, `${b}.md`), "utf8")));
            break;
        }
        case "consolidate": {
            // consolidate <outputs.json>   — outputs.json = array of ReviewerOutput
            print(consolidate(readJson(args[0])));
            break;
        }
        case "decide": {
            // decide <clusters.json> <adjudications.json> <meta.json>   — the deterministic verdict + the
            // single PR comment. meta.json = {reviewers:[{reviewer,model}], approval:"<orchestrator sign-off>"}.
            // All three are required so every posted comment carries the reviewer roster + a code-checked
            // sign-off (decide throws on an empty sign-off).
            if (!args[0] || !args[1] || !args[2]) {
                process.stderr.write("usage: review-gate decide <clusters.json> <adjudications.json> <meta.json>\n");
                process.exit(2);
            }
            print(decide(readJson(args[0]), readJson(args[1]), readJson(args[2])));
            break;
        }
        default:
            process.stderr.write("usage: review-gate <prompt|run|scan|consolidate|decide> ...\n");
            process.exit(2);
    }
}
main().catch((e) => { process.stderr.write(String(e instanceof Error ? e.stack : e) + "\n"); process.exit(1); });
