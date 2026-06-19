// The CLI serves its OWN bundled prompts so a skill never needs a filesystem path to them — it asks
// for a prompt by name (`review-gate prompt holistic`) and the binary resolves the file relative to
// itself (see cli.ts). `name` names a bundled prompt, never a path: it is format-validated here so a
// stray `../` or absolute path can't turn `prompt` into an arbitrary-file reader.

const NAME_RE = /^[a-z][a-z0-9-]*$/;

export type PromptParts = { base: string; contract: string };

export function promptParts(name: string): PromptParts {
  if (!NAME_RE.test(name)) throw new Error(`invalid prompt name: ${JSON.stringify(name)} (use lowercase letters, digits, hyphens)`);
  // Audit passes carry their own output contract; everything else uses the PR-review one.
  const contract = name.startsWith("audit-") ? "audit-output-contract" : "output-contract";
  if (name === contract) throw new Error(`'${name}' is an output contract, not a reviewer prompt`);
  return { base: name, contract };
}

// `read` takes a prompt basename (no extension) and returns its text. Injectable so the resolution
// logic is testable without the filesystem; cli.ts passes the real loader.
export function assemblePrompt(name: string, read: (basename: string) => string): string {
  const { base, contract } = promptParts(name);
  return read(base) + "\n" + read(contract);
}
