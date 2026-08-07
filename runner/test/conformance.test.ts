import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { discoverKoans } from '../src/koan.js';
import { runKoan, type AgentConfig } from '../src/harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface Target {
  name: string;
  agent: AgentConfig;
}

function discoverTargets(): Target[] {
  if (process.env.AGENT_CMD || process.env.AGENT_CWD) {
    return [
      {
        name: 'agent under test',
        agent: {
          command: process.env.AGENT_CMD ?? 'pnpm --silent start',
          cwd: process.env.AGENT_CWD ?? process.cwd(),
        },
      },
    ];
  }
  const examplesDir = path.join(repoRoot, 'examples');
  return fs
    .readdirSync(examplesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(examplesDir, e.name, 'package.json')))
    .map((e) => ({
      name: `examples/${e.name}`,
      agent: { command: 'pnpm --silent start', cwd: path.join(examplesDir, e.name) },
    }));
}

const koans = discoverKoans(path.join(repoRoot, 'koans'));

for (const target of discoverTargets()) {
  describe(target.name, () => {
    for (const { id, koan } of koans) {
      it(id, { timeout: 60_000 }, async () => {
        await runKoan(koan, target.agent);
      });
    }
  });
}
