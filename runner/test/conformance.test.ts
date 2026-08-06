// Conformance suite entry point.
//
// By default the suite runs against examples/vanilla-ts. Point it at any
// implementation with:
//   AGENT_CMD="<shell command>" AGENT_CWD="<dir>" pnpm test
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { discoverKoans } from '../src/koan.js';
import { runKoan, type AgentConfig } from '../src/harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const agent: AgentConfig = {
  command: process.env.AGENT_CMD ?? 'pnpm --silent start',
  cwd: process.env.AGENT_CWD ?? path.join(repoRoot, 'examples/vanilla-ts'),
};

const koans = discoverKoans(path.join(repoRoot, 'koans'));

describe('agent-koans', () => {
  for (const { id, koan } of koans) {
    it(id, { timeout: 60_000 }, async () => {
      await runKoan(koan, agent);
    });
  }
});
