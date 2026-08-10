// What the suite asserts: every discovered koan passes against every
// implementation in examples/ — or against the single agent given via
// AGENT_CMD / AGENT_CWD. Each target's own `agent-koans.yaml` (the same
// config file and loader the CLI uses) may skip a koan with a reason —
// the one deliberate exception, for a bundled example that cannot satisfy
// a koan for a cause outside this repo (an upstream framework
// limitation), never a place to paper over a real regression. `add` is
// out of scope here: this suite's koan set is fixed, so a config that
// tries to add koans is a config error, not something this file honors.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { discoverKoans, runKoan, type AgentConfig } from '../src/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
const allIds = new Set(koans.map((k) => k.id));

/**
 * A target's own `agent-koans.yaml` (skips and delegation vocabulary), if
 * it has one — absent by default, since a target need not carry a config
 * file at all. Stale skip ids are rejected the same way the CLI rejects
 * them (SPEC.md §6: a skip must stay honest about what it names). `add`
 * has no meaning for a fixed koan set, so a non-empty one is a config
 * error here, not a silently ignored key.
 */
function loadTargetConfig(dir: string): ReturnType<typeof loadConfig> {
  const configPath = path.join(dir, 'agent-koans.yaml');
  if (!fs.existsSync(configPath)) return { skip: {}, add: [] };

  const config = loadConfig(configPath);
  if (config.add.length > 0) {
    throw new Error(
      `${configPath}: "add" is not supported here — this suite runs a fixed koan set; use the CLI's --config for custom koans.`,
    );
  }
  for (const id of Object.keys(config.skip)) {
    if (!allIds.has(id)) throw new Error(`${configPath}: skip entry "${id}" matches no discovered koan`);
  }
  return config;
}

for (const target of discoverTargets()) {
  const { skip, delegation } = loadTargetConfig(target.agent.cwd ?? process.cwd());
  const agent = { ...target.agent, delegation };
  describe(target.name, () => {
    for (const { id, koan } of koans) {
      const reason = skip[id];
      const test = reason ? it.skip : it;
      test(reason ? `${id} — SKIPPED: ${reason}` : id, { timeout: 60_000 }, async () => {
        await runKoan(koan, agent);
      });
    }
  });
}
