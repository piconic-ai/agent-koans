#!/usr/bin/env node
// CLI entry: run the koan suite against one agent command, no test
// file needed. Argument parsing and reporting live here; discovery and
// compilation stay in koan.ts, config validation in config.ts, execution
// in runner.ts, the --help screen in help.ts. Not part of the package
// surface (index.ts) — nothing here is importable.
//
// Responsibility split: flags here (--agent, --cwd, --koans, --filter,
// --config, --help) control how THIS invocation runs. What the suite
// consists of — which koans are skipped, which directories are added —
// lives only in agent-koans.yaml (config.ts): a skip must carry a reason
// (SPEC.md §7), and a flag can't enforce that the way a checked-in file
// can, so there is no CLI equivalent for skip or add.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runKoan } from './runner.js';
import { discoverKoans, type DiscoveredKoan } from './koan.js';
import { loadConfig } from './config.js';
import { renderHelp } from './help.js';

// Each print site colorizes for its own stream: --help writes to stdout,
// a usage error reprints the same screen to stderr, and piping one but
// not the other (or NO_COLOR) must not paint escape codes into a file.
const isColorEnabled = (stream: { isTTY?: boolean }): boolean =>
  stream.isTTY === true && process.env.NO_COLOR === undefined;

function usageError(message: string): never {
  console.error(`${message}\n\n${renderHelp(isColorEnabled(process.stderr))}`);
  process.exit(2);
}

let values: { agent?: string; cwd?: string; koans?: string; filter?: string; config?: string; help?: boolean };
try {
  ({ values } = parseArgs({
    options: {
      agent: { type: 'string' },
      cwd: { type: 'string' },
      koans: { type: 'string' },
      filter: { type: 'string' },
      config: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (e) {
  usageError((e as Error).message);
}

if (values.help) {
  console.log(renderHelp(isColorEnabled(process.stdout)));
  process.exit(0);
}
if (!values.agent) usageError('--agent is required');

const isDirectory = (dir: string): boolean => {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = values.koans
  ? [values.koans]
  : ['koans', path.join(here, '..', 'koans')];
const koansDir = candidates.find(isDirectory);
if (koansDir === undefined) {
  usageError(`koans directory not found (tried: ${candidates.join(', ')})`);
}

// Config is optional and off the default path: `--config` names it
// explicitly (and must exist), otherwise we look for a conventional file
// next to where the CLI was invoked. Neither is required to run the
// bundled suite.
let configPath = values.config;
if (configPath !== undefined) {
  if (!fs.existsSync(configPath)) usageError(`config file not found: ${configPath}`);
} else if (fs.existsSync('agent-koans.yaml')) {
  configPath = 'agent-koans.yaml';
}

let config: { skip: Record<string, string>; add: string[] } = { skip: {}, add: [] };
if (configPath !== undefined) {
  try {
    config = loadConfig(configPath);
  } catch (e) {
    usageError((e as Error).message);
  }
}

/** One discovery source: the bundled suite (name "") or a config-added directory. */
interface Group {
  name: string;
  koans: DiscoveredKoan[];
}

const groups: Group[] = [];
const allIds = new Set<string>();

const bundled = discoverKoans(koansDir);
for (const { id } of bundled) allIds.add(id);
groups.push({ name: '', koans: bundled });

// Added dirs get an id prefix so they can never collide with the bundled
// suite by construction; two added dirs sharing a basename would produce
// the same prefix, so that is rejected up front rather than left to
// surface as a confusing per-koan id collision later.
const seenBasenames = new Set<string>();
for (const dir of config.add) {
  if (!isDirectory(dir)) usageError(`${configPath}: add directory not found: ${dir}`);
  const basename = path.basename(dir);
  if (seenBasenames.has(basename)) {
    usageError(`${configPath}: two added directories share the basename "${basename}" — their koan ids would collide`);
  }
  seenBasenames.add(basename);

  const discovered = discoverKoans(dir).map((k) => ({ ...k, id: `${basename}/${k.id}` }));
  if (discovered.length === 0) usageError(`${configPath}: no koans in ${dir}`);
  for (const { id } of discovered) {
    if (allIds.has(id)) usageError(`koan id "${id}" collides with an already discovered koan`);
    allIds.add(id);
  }
  groups.push({ name: basename, koans: discovered });
}

// Skips are validated against the full discovered set (bundled + added,
// before --filter) so a stale skip is caught even when --filter would
// otherwise hide it: rot in the skiplist must not go unnoticed.
for (const id of Object.keys(config.skip)) {
  if (!allIds.has(id)) usageError(`${configPath}: skip entry "${id}" matches no discovered koan`);
}

const filter = values.filter;
if (filter !== undefined) {
  for (const group of groups) group.koans = group.koans.filter(({ id }) => id.includes(filter));
}
const totalToRun = groups.reduce((n, g) => n + g.koans.length, 0);
if (totalToRun === 0) {
  usageError(filter === undefined ? `no koans in ${koansDir}` : `no koan id contains "${filter}"`);
}

let totalFailed = 0;
for (const group of groups) {
  if (group.koans.length === 0) continue;
  if (group.name !== '') console.log(`\n${group.name}:`);

  let failed = 0;
  let skipped = 0;
  for (const { id, koan } of group.koans) {
    const reason = config.skip[id];
    if (reason !== undefined) {
      skipped += 1;
      console.log(`skip  ${id}`);
      console.log(`      ${reason}`);
      continue;
    }
    try {
      await runKoan(koan, { command: values.agent, cwd: values.cwd });
      console.log(`ok    ${id}`);
    } catch (e) {
      failed += 1;
      console.error(`FAIL  ${id}`);
      console.error(`      ${(e as Error).message.split('\n').join('\n      ')}`);
    }
  }
  totalFailed += failed;

  const passed = group.koans.length - failed - skipped;
  const skipNote = skipped > 0 ? `, ${skipped} skipped` : '';
  console.log(`\n${passed}/${group.koans.length} passed${skipNote}`);
}
process.exit(totalFailed === 0 ? 0 : 1);
