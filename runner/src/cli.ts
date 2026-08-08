#!/usr/bin/env node
// CLI entry: run the koan suite against one agent command, no test
// file needed. Argument parsing and reporting live here; discovery and
// execution stay in koan.ts and harness.ts. Not part of the package
// surface (index.ts) — nothing here is importable.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runKoan } from './harness.js';
import { discoverKoans } from './koan.js';

const HELP = `Usage: agent-koans --agent "<command>" [options]

Runs every koan against the agent that <command> starts.

Options:
  --agent <command>  shell command that starts your agent (required)
  --cwd <dir>        working directory for the agent command
  --koans <dir>      koans directory (default: ./koans, else the copy
                     shipped next to the runner)
  --filter <text>    run only koans whose id contains <text>
  -h, --help         show this help`;

function usageError(message: string): never {
  console.error(`${message}\n\n${HELP}`);
  process.exit(2);
}

let values: { agent?: string; cwd?: string; koans?: string; filter?: string; help?: boolean };
try {
  ({ values } = parseArgs({
    options: {
      agent: { type: 'string' },
      cwd: { type: 'string' },
      koans: { type: 'string' },
      filter: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (e) {
  usageError((e as Error).message);
}

if (values.help) {
  console.log(HELP);
  process.exit(0);
}
if (!values.agent) usageError('--agent is required');

// Two built-in fallbacks rather than one: koans/ sits beside runner/ in
// the source tree but at the package root in a published package, so a
// single relative path cannot serve both layouts.
const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = values.koans
  ? [values.koans]
  : ['koans', path.join(here, '..', '..', 'koans'), path.join(here, '..', 'koans')];
const isDirectory = (dir: string): boolean => {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
};
const koansDir = candidates.find(isDirectory);
if (koansDir === undefined) {
  usageError(`koans directory not found (tried: ${candidates.join(', ')})`);
}

const filter = values.filter;
let koans = discoverKoans(koansDir);
if (filter !== undefined) {
  koans = koans.filter(({ id }) => id.includes(filter));
}
if (koans.length === 0) {
  usageError(filter === undefined ? `no koans in ${koansDir}` : `no koan id contains "${filter}"`);
}

let failed = 0;
for (const { id, koan } of koans) {
  try {
    await runKoan(koan, { command: values.agent, cwd: values.cwd });
    console.log(`ok    ${id}`);
  } catch (e) {
    failed += 1;
    console.error(`FAIL  ${id}`);
    console.error(`      ${(e as Error).message.split('\n').join('\n      ')}`);
  }
}
console.log(`\n${koans.length - failed}/${koans.length} passed`);
process.exit(failed === 0 ? 0 : 1);
