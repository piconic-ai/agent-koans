// Rewrites SPEC.md's koan table in place: `pnpm koan-index`, after
// adding, renaming, or rewording a koan. A pull request that touches
// koans/ has this run for it (.github/workflows/koan-index.yml), so the
// command is a convenience rather than a step to remember; the guarantee
// that the table is current is test/koan-index.test.ts, which regenerates
// the same block and compares.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withKoanIndex } from './koan-index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const specPath = path.join(repoRoot, 'SPEC.md');

const before = fs.readFileSync(specPath, 'utf8');
const after = withKoanIndex(before, path.join(repoRoot, 'koans'));

if (before === after) {
  console.log('SPEC.md: koan index already current');
} else {
  fs.writeFileSync(specPath, after);
  console.log('SPEC.md: koan index rewritten');
}
