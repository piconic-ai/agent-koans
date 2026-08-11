// Rewrites SPEC.md's koan index in place. Run it after adding, renaming,
// or rewording a koan: `pnpm koan-index`. A test regenerates the same
// block and fails when SPEC.md is stale, so the index cannot silently
// disagree with the suite.
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
