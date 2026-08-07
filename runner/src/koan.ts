// Loading and compiling koan YAML into the runner's internal trace form.
// File-format validation belongs here and nowhere else; runtime
// verification belongs to the mocks and the harness.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

/** A tool definition as written in `given.tools` (JSON Schema input). */
export interface ToolDef {
  description?: string;
  input_schema: Record<string, unknown>;
}

/** A scripted tool-server response. */
export interface ToolResponse {
  status: number;
  body?: unknown;
}

interface TraceEntry {
  request?: string | { tool?: string; args?: Record<string, unknown> };
  response?:
    | string
    | {
        tool?: string;
        args?: Record<string, unknown>;
        status?: number;
        body?: unknown;
      };
}

/** One compiled model turn of a trace. */
export interface ModelTurn {
  reply?: string;
  call_tool?: { name: string; args: Record<string, unknown> };
  invoke_args?: Record<string, unknown>;
  tool_responds?: ToolResponse;
}

/** A `then`-block matcher; a bare scalar means `equals`. */
export type Matcher =
  | string
  | number
  | boolean
  | { equals?: unknown; contains?: string; matches?: string };

/** A compiled koan: shared `given`/`then` plus one or more trace variants. */
export interface Koan {
  name: string;
  description?: string;
  given: {
    task: string;
    tools: Record<string, ToolDef>;
  };
  traces: Record<string, ModelTurn[]>;
  then: {
    run?: { status?: string; output?: Matcher };
  };
}

/** A koan found on disk, addressed by its `<chapter>/<file>` id. */
export interface DiscoveredKoan {
  id: string;
  file: string;
  koan: Koan;
}

function fail(file: string, message: string): never {
  throw new Error(`Invalid koan ${file}: ${message}`);
}

function compileTrace(file: string, trace: TraceEntry[], label = 'when'): ModelTurn[] {
  const turns: ModelTurn[] = [];
  for (const [i, e] of trace.entries()) {
    const at = `${label}[${i}]`;
    const req = e?.request;
    const res = e?.response;
    if (req === undefined || req === null) fail(file, `${at} needs "request"`);
    if (res === undefined || res === null) fail(file, `${at} needs "response"`);

    if (req === 'model') {
      const prev = turns.at(-1);
      if (prev && !prev.call_tool) {
        fail(file, `${at}: a model request cannot follow a text reply (multi-turn traces are not supported yet)`);
      }
      if (typeof res === 'string') {
        turns.push({ reply: res });
      } else if (typeof res.tool === 'string') {
        if (res.status !== undefined) {
          fail(file, `${at}.response mixes a tool-call instruction with "status"`);
        }
        turns.push({
          call_tool: { name: res.tool, args: res.args ?? {} },
        });
      } else {
        fail(file, `${at}.response for a model request must be a reply string or { tool, args }`);
      }
    } else if (typeof req === 'object' && typeof req.tool === 'string') {
      if (typeof res === 'string' || typeof res.status !== 'number') {
        fail(file, `${at}.response needs a numeric "status" for a tool request`);
      }
      const turn = turns.at(-1);
      if (!turn?.call_tool) {
        fail(file, `${at}: a tool request must follow a model response containing a tool-call instruction`);
      }
      if (turn.tool_responds !== undefined) {
        fail(file, `${at}: the preceding tool-call instruction already has a tool request`);
      }
      if (turn.call_tool.name !== req.tool) {
        fail(file, `${at}.request.tool is "${req.tool}" but the model requested "${turn.call_tool.name}"`);
      }
      // No mismatch check against the instruction's args: explicit args
      // are a declared transform (SPEC.md §6.3), not a koan bug.
      turn.invoke_args = req.args ?? turn.call_tool.args;
      turn.tool_responds = { status: res.status, body: res.body };
    } else {
      fail(file, `${at}.request must be "model" or { tool: <name> }`);
    }
  }
  if (turns.length === 0) fail(file, '"when" compiled to an empty timeline');
  return turns;
}

/** Load and compile one koan file; throws on any format violation. */
export function loadKoan(file: string): Koan {
  const raw = parse(fs.readFileSync(file, 'utf8')) as {
    name?: unknown;
    description?: string;
    given?: { task?: unknown; tools?: unknown };
    when?: unknown;
    one_of?: unknown;
    then?: Koan['then'];
  };
  if (!raw || typeof raw !== 'object') fail(file, 'not a YAML mapping');
  if (typeof raw.name !== 'string') fail(file, 'missing "name"');
  if (typeof raw.given?.task !== 'string') fail(file, 'missing "given.task"');
  const tools = (raw.given.tools ?? {}) as Record<string, ToolDef>;
  if (typeof tools !== 'object' || Array.isArray(tools)) {
    fail(file, '"given.tools" must be a mapping of tool name to definition');
  }

  if ((raw.when === undefined) === (raw.one_of === undefined)) {
    fail(file, 'a koan needs exactly one of "when" / "one_of"');
  }

  let traces: Record<string, ModelTurn[]>;
  if (raw.when !== undefined) {
    if (!Array.isArray(raw.when) || raw.when.length === 0) {
      fail(file, '"when" must be a non-empty list of trace steps');
    }
    traces = { '': compileTrace(file, raw.when as TraceEntry[]) };
  } else {
    const oneOf = raw.one_of as Record<string, unknown>;
    if (typeof oneOf !== 'object' || oneOf === null || Array.isArray(oneOf)) {
      fail(file, '"one_of" must be a mapping of variant name to trace');
    }
    const entries = Object.entries(oneOf);
    if (entries.length < 2) {
      fail(file, '"one_of" needs at least two variants — use "when" for a single trace');
    }
    traces = {};
    for (const [variant, trace] of entries) {
      if (!Array.isArray(trace) || trace.length === 0) {
        fail(file, `"one_of.${variant}" must be a non-empty list of trace steps`);
      }
      traces[variant] = compileTrace(file, trace as TraceEntry[], `one_of.${variant}`);
    }
  }

  return {
    name: raw.name,
    description: raw.description,
    given: { task: raw.given.task, tools },
    traces,
    then: raw.then ?? {},
  };
}

/** Load every koan under a chapter directory tree, sorted by id. */
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
