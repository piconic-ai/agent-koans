// What the index promises: SPEC.md's list of koans is the suite itself,
// not a hand-kept copy of it. Regenerating the block and comparing is the
// whole check — a koan added, renamed, or reworded without running
// `pnpm koan-index` fails here rather than leaving the contract's one
// overview quietly out of date. A workflow regenerates the table on a
// pull request that touches koans/, so in practice this fires for someone
// working locally, or when that workflow could not push.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withKoanIndex } from '../scripts/koan-index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('SPEC.md koan index', () => {
  it('lists every koan, exactly as the koans describe themselves', () => {
    const spec = fs.readFileSync(path.join(repoRoot, 'SPEC.md'), 'utf8');
    expect(withKoanIndex(spec, path.join(repoRoot, 'koans'))).toBe(spec);
  });
});
