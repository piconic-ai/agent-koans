// Koan file format: loading and validation. See SPEC.md §6.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

export interface ToolDef {
  description?: string;
  input_schema: Record<string, unknown>;
}

export type ExpectingState = 'initial' | 'tool_result' | 'tool_error';

export interface ToolResponse {
  status: number;
  body?: unknown;
}

export interface ModelEntry {
  expecting?: ExpectingState;
  reply?: string;
  call_tool?: { name: string; args: Record<string, unknown> };
  /**
   * The tool server's scripted response to the invocation this call_tool
   * provokes. Absent on a call_tool entry = the tool server must NOT be
   * invoked for this call (e.g. the arguments fail validation).
   */
  tool_responds?: ToolResponse;
}

export type Matcher =
  | string
  | number
  | boolean
  | { equals?: unknown; contains?: string; matches?: string };

export interface Koan {
  name: string;
  description?: string;
  given: {
    task: string;
    /** Tool name → definition. Defaults to {} when omitted. */
    tools: Record<string, ToolDef>;
  };
  when: {
    /** The run's single timeline, one entry per model request. */
    model: ModelEntry[];
  };
  then: {
    run?: { status?: string; output?: Matcher };
  };
}

export interface DiscoveredKoan {
  /** e.g. "tool-reliability/003-retry-on-transient-failure" */
  id: string;
  file: string;
  koan: Koan;
}

function fail(file: string, message: string): never {
  throw new Error(`Invalid koan ${file}: ${message}`);
}

export function loadKoan(file: string): Koan {
  const raw = parse(fs.readFileSync(file, 'utf8')) as Koan;
  if (!raw || typeof raw !== 'object') fail(file, 'not a YAML mapping');
  if (typeof raw.name !== 'string') fail(file, 'missing "name"');
  if (typeof raw.given?.task !== 'string') fail(file, 'missing "given.task"');
  raw.given.tools ??= {};
  if (typeof raw.given.tools !== 'object' || Array.isArray(raw.given.tools)) {
    fail(file, '"given.tools" must be a mapping of tool name to definition');
  }
  if (!Array.isArray(raw.when?.model) || raw.when.model.length === 0) {
    fail(file, '"when.model" must be a non-empty list');
  }
  for (const [i, entry] of raw.when.model.entries()) {
    const actions = [entry.reply !== undefined, entry.call_tool !== undefined].filter(Boolean);
    if (actions.length !== 1) {
      fail(file, `when.model[${i}] must have exactly one of "reply" / "call_tool"`);
    }
    if (entry.tool_responds !== undefined && entry.call_tool === undefined) {
      fail(file, `when.model[${i}] has "tool_responds" without "call_tool"`);
    }
    if (entry.expecting && !['initial', 'tool_result', 'tool_error'].includes(entry.expecting)) {
      fail(file, `when.model[${i}].expecting has unknown state "${entry.expecting}"`);
    }
  }
  return raw;
}

export function discoverKoans(dir: string): DiscoveredKoan[] {
  const found: DiscoveredKoan[] = [];
  for (const chapter of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!chapter.isDirectory()) continue;
    const chapterDir = path.join(dir, chapter.name);
    for (const file of fs.readdirSync(chapterDir).sort()) {
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
      const full = path.join(chapterDir, file);
      found.push({
        id: `${chapter.name}/${file.replace(/\.ya?ml$/, '')}`,
        file: full,
        koan: loadKoan(full),
      });
    }
  }
  return found.sort((a, b) => a.id.localeCompare(b.id));
}
