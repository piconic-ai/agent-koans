// Loading and validating the optional agent-koans.yaml config file. This
// module only checks the file's own shape (skip needs mapping + reasons,
// add needs a directory list, delegation a vocabulary mapping, no other
// top-level keys); whether a skip id or an added directory actually
// resolves against discovered koans is the CLI's job, since that needs
// the discovery step this module does not run.
// Deliberately excludes anything like `agent.command`: the default path
// (`--agent` on the command line, no config file) must keep working with
// no file at all, so the schema stays limited to what only makes sense
// once a config file exists — skipping and adding koans.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

/**
 * How the mock LLM emits a delegation instruction on the wire. The mock
 * plays the model, so it must speak the framework's own delegation
 * vocabulary — there is no adapter between mock and framework.
 */
export interface DelegationVocabulary {
  /** The tool_call name the framework's runtime understands. */
  tool: string;
  /** The argument key naming the delegate. */
  agent_arg: string;
  /** The argument key carrying the briefing. */
  prompt_arg: string;
}

/** The neutral default vocabulary, implemented by examples/vanilla. */
export const DEFAULT_DELEGATION: DelegationVocabulary = {
  tool: 'subagent',
  agent_arg: 'name',
  prompt_arg: 'prompt',
};

/** One loaded and validated `agent-koans.yaml`. */
export interface RunnerConfig {
  /** Koan id -> mandatory reason it is skipped. */
  skip: Record<string, string>;
  /** Additional koan directories, resolved to absolute paths. */
  add: string[];
  /** The implementation's delegation wire vocabulary; absent means the neutral default. */
  delegation?: DelegationVocabulary;
}

function fail(file: string, message: string): never {
  throw new Error(`Invalid config ${file}: ${message}`);
}

/**
 * Load and validate a config file. Throws on any format violation,
 * including an unknown top-level key, a `skip` entry without a non-empty
 * reason, or an `add` entry that is not a string.
 */
export function loadConfig(file: string): RunnerConfig {
  const raw = parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> | null | undefined;
  if (raw === null || raw === undefined) return { skip: {}, add: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) fail(file, 'not a YAML mapping');

  const allowedKeys = new Set(['skip', 'add', 'delegation']);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) fail(file, `unknown key "${key}" (allowed: skip, add, delegation)`);
  }

  const skip: Record<string, string> = {};
  if (raw.skip !== undefined) {
    if (Array.isArray(raw.skip)) {
      fail(
        file,
        '"skip" must be a mapping of koan id to reason, not a list — a reason is required for every skip',
      );
    }
    if (typeof raw.skip !== 'object' || raw.skip === null) {
      fail(file, '"skip" must be a mapping of koan id to reason');
    }
    for (const [id, reason] of Object.entries(raw.skip as Record<string, unknown>)) {
      if (typeof reason !== 'string' || reason.trim().length === 0) {
        fail(file, `skip["${id}"] needs a non-empty reason string`);
      }
      skip[id] = reason;
    }
  }

  const add: string[] = [];
  if (raw.add !== undefined) {
    if (!Array.isArray(raw.add)) fail(file, '"add" must be a list of directories');
    const configDir = path.dirname(file);
    for (const [i, entry] of (raw.add as unknown[]).entries()) {
      if (typeof entry !== 'string' || entry.length === 0) {
        fail(file, `add[${i}] must be a non-empty directory path`);
      }
      add.push(path.resolve(configDir, entry));
    }
  }

  let delegation: DelegationVocabulary | undefined;
  if (raw.delegation !== undefined) {
    const rawDelegation = raw.delegation as Record<string, unknown>;
    if (typeof rawDelegation !== 'object' || rawDelegation === null || Array.isArray(rawDelegation)) {
      fail(file, '"delegation" must be a mapping (keys: tool, agent_arg, prompt_arg)');
    }
    // A partial mapping keeps the neutral defaults for the keys it omits,
    // so a framework differing only in the tool name declares one line.
    const filled: DelegationVocabulary = { ...DEFAULT_DELEGATION };
    for (const [key, value] of Object.entries(rawDelegation)) {
      if (key !== 'tool' && key !== 'agent_arg' && key !== 'prompt_arg') {
        fail(file, `delegation has unknown key "${key}" (allowed: tool, agent_arg, prompt_arg)`);
      }
      if (typeof value !== 'string' || value.length === 0) {
        fail(file, `delegation.${key} must be a non-empty string`);
      }
      filled[key] = value;
    }
    delegation = filled;
  }

  return { skip, add, delegation };
}
