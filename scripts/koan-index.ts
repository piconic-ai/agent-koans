// SPEC.md's koan table: every koan's id and the contract line its own
// description states, rendered for the block SPEC.md carries between its
// koan-index markers. A repository tool, not part of the runner and not
// published — it lives here so nothing that maintains the docs ships to
// anyone installing the package.
//
// Run it with `pnpm koan-index` after adding, renaming, or rewording a
// koan. A pull request touching koans/ has it run automatically
// (.github/workflows/koan-index.yml), so the command is a convenience
// rather than a step to remember; what guarantees the table is current is
// test/koan-index.test.ts, which imports the rendering below and compares.
// Running as a script writes; importing does not.
//
// The koans are the contract, so this never paraphrases one: a koan's own
// `description` is what appears, whitespace collapsed and nothing else
// changed. Rewording belongs in the koan file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';

export const INDEX_START = '<!-- koan-index:start -->';
export const INDEX_END = '<!-- koan-index:end -->';

/** One row of the table, in file order. */
function renderRow(dir: string, file: string): string {
  const raw = parse(fs.readFileSync(path.join(dir, file), 'utf8')) as {
    description?: unknown;
  };
  const id = file.replace(/\.ya?ml$/, '');
  if (typeof raw?.description !== 'string' || raw.description.trim() === '') {
    throw new Error(`koan ${file} has no description to index`);
  }
  // A cell cannot carry a line break, and a description written as a YAML
  // folded block arrives with them.
  const line = raw.description.split(/\s+/).filter(Boolean).join(' ');
  return `| [${id}](./koans/${file}) | ${line} |`;
}

/** The whole block, markers included, as SPEC.md should carry it. */
export function renderKoanIndex(koansDir: string): string {
  const rows = fs
    .readdirSync(koansDir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort()
    .map((f) => renderRow(koansDir, f));
  return [INDEX_START, '', '| Koan | Contract |', '| ---- | -------- |', ...rows, '', INDEX_END].join('\n');
}

/** Replace the marked block in `spec` with a freshly rendered one. */
export function withKoanIndex(spec: string, koansDir: string): string {
  const start = spec.indexOf(INDEX_START);
  const end = spec.indexOf(INDEX_END);
  if (start === -1 || end === -1) {
    throw new Error(`SPEC.md is missing its ${INDEX_START} / ${INDEX_END} markers`);
  }
  return spec.slice(0, start) + renderKoanIndex(koansDir) + spec.slice(end + INDEX_END.length);
}

function main(): void {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const specPath = path.join(repoRoot, 'SPEC.md');
  const before = fs.readFileSync(specPath, 'utf8');
  const after = withKoanIndex(before, path.join(repoRoot, 'koans'));

  if (before === after) {
    console.log('SPEC.md: koan table already current');
  } else {
    fs.writeFileSync(specPath, after);
    console.log('SPEC.md: koan table rewritten');
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
