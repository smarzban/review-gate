#!/usr/bin/env -S npx tsx
import { readFileSync } from "node:fs";
import { runReview } from "./runner.js";
import { runScan } from "./scan.js";
import { consolidate } from "./consolidate.js";
import { decide } from "./decide.js";

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const print = (o: unknown) => process.stdout.write(JSON.stringify(o, null, 2) + "\n");

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
      const { output, warning } = await runReview(reviewer, backend as any, model, repoDir, prompt);
      print({ reviewer, backend, model, output, warning: warning ?? null });
      break;
    }
    case "scan": {
      // scan <repoDir> <baseRef>   — the deterministic tier (no LLM). Runs `git diff <baseRef>...HEAD`
      // and the scanners; emits a ReviewerOutput {reviewer:"tools", model:"deterministic"} that the
      // orchestrator merges into the same outputs pool as the model reviewers. Trusted, exact, cheap.
      const [repoDir, baseRef] = args;
      const { output, warning } = await runScan(repoDir, baseRef);
      print({ output, warning: warning ?? null });
      break;
    }
    case "consolidate": {
      // consolidate <outputs.json>   — outputs.json = array of ReviewerOutput
      print(consolidate(readJson(args[0])));
      break;
    }
    case "decide": {
      // decide <clusters.json> [adjudications.json]   — the deterministic verdict + PR comment
      print(decide(readJson(args[0]), args[1] ? readJson(args[1]) : []));
      break;
    }
    default:
      process.stderr.write("usage: review-gate <run|scan|consolidate|decide> ...\n");
      process.exit(2);
  }
}
main().catch((e) => { process.stderr.write(String(e instanceof Error ? e.stack : e) + "\n"); process.exit(1); });
