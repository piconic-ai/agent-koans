// Koan file format: loading, validation, and compilation. See SPEC.md §6.
//
// The YAML `when` block is the run's expected wire log: a sequence of
// request/response exchanges. Only the agent issues requests (they are
// asserted); the mocked world only responds (scripted). The loader compiles
// the trace into the internal per-model-turn script the mocks consume.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { deepEqual } from './pending.js';

export interface ToolDef {
  description?: string;
  input_schema: Record<string, unknown>;
}

export type ConversationState = 'initial' | 'tool_result' | 'tool_error';

export interface ToolResponse {
  status: number;
  body?: unknown;
}

/**
 * One step of the YAML trace: the agent's request (asserted) and the
 * called party's scripted response.
 *
 * A request is `model` (bare scalar) or `{ tool: <name> }`. What a model
 * request's conversation must show is not written — it is derived from
 * the preceding trace (conversation coherence, SPEC.md §6.1). A tool
 * request MAY carry explicit `args` for readability; they must equal the
 * provoking instruction's args (argument fidelity fixes them).
 *
 * The response discriminates by form: a bare string is the model's text
 * reply; { tool, args } is the model's tool-call instruction;
 * { status, body } is the tool server's response.
 */
interface TraceEntry {
  request?: 'model' | { tool?: string; args?: Record<string, unknown> };
  response?:
    | string
    | {
        tool?: string;
        args?: Record<string, unknown>;
        status?: number;
        body?: unknown;
      };
}

/** Internal, compiled form: one entry per model request. */
export interface ModelTurn {
  /** What the incoming conversation must show (the agent's calls_model). */
  expecting: ConversationState;
  reply?: string;
  call_tool?: { name: string; args: Record<string, unknown> };
  /**
   * The tool server's scripted response to the invocation the agent must
   * make (the calls_tool step). Absent = the agent must NOT invoke the
   * tool for this turn's tool_call.
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
    /** Compiled timeline, one entry per model request. */
    model: ModelTurn[];
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

/**
 * Conversation coherence: what a model request's conversation must show
 * is fully determined by the preceding trace (SPEC.md §6.1).
 */
function deriveExpecting(file: string, at: string, prev: ModelTurn | undefined): ConversationState {
  if (!prev) return 'initial';
  if (!prev.call_tool) {
    fail(file, `${at}: a model request cannot follow a text reply (multi-turn traces are not supported yet)`);
  }
  if (!prev.tool_responds) return 'tool_error'; // the agent refused the call (R6/R7)
  return prev.tool_responds.status < 400 ? 'tool_result' : 'tool_error';
}

function compileTrace(file: string, trace: TraceEntry[]): ModelTurn[] {
  const turns: ModelTurn[] = [];
  for (const [i, e] of trace.entries()) {
    const at = `when[${i}]`;
    const req = e?.request;
    const res = e?.response;
    if (req === undefined || req === null) fail(file, `${at} needs "request"`);
    if (res === undefined || res === null) fail(file, `${at} needs "response"`);

    if (req === 'model') {
      const expecting = deriveExpecting(file, at, turns.at(-1));
      if (typeof res === 'string') {
        turns.push({ expecting, reply: res });
      } else if (typeof res.tool === 'string') {
        if (res.status !== undefined) {
          fail(file, `${at}.response mixes a tool-call instruction with "status"`);
        }
        turns.push({
          expecting,
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
      if (req.args !== undefined && !deepEqual(req.args, turn.call_tool.args)) {
        // Explicit args are documentation; fidelity fixes their value.
        fail(
          file,
          `${at}.request.args differ from the provoking instruction's args ` +
            `(${JSON.stringify(req.args)} vs ${JSON.stringify(turn.call_tool.args)})`,
        );
      }
      turn.tool_responds = { status: res.status, body: res.body };
    } else {
      fail(file, `${at}.request must be "model" or { tool: <name> }`);
    }
  }
  if (turns.length === 0) fail(file, '"when" compiled to an empty timeline');
  return turns;
}

export function loadKoan(file: string): Koan {
  const raw = parse(fs.readFileSync(file, 'utf8')) as {
    name?: unknown;
    description?: string;
    given?: { task?: unknown; tools?: unknown };
    when?: unknown;
    then?: Koan['then'];
  };
  if (!raw || typeof raw !== 'object') fail(file, 'not a YAML mapping');
  if (typeof raw.name !== 'string') fail(file, 'missing "name"');
  if (typeof raw.given?.task !== 'string') fail(file, 'missing "given.task"');
  const tools = (raw.given.tools ?? {}) as Record<string, ToolDef>;
  if (typeof tools !== 'object' || Array.isArray(tools)) {
    fail(file, '"given.tools" must be a mapping of tool name to definition');
  }
  if (!Array.isArray(raw.when) || raw.when.length === 0) {
    fail(file, '"when" must be a non-empty list of trace steps');
  }
  return {
    name: raw.name,
    description: raw.description,
    given: { task: raw.given.task, tools },
    when: { model: compileTrace(file, raw.when as TraceEntry[]) },
    then: raw.then ?? {},
  };
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
