// Koan file format: loading, validation, and compilation. See SPEC.md §6.
//
// The YAML `when` block is the run's expected wire log: a sequence of
// request/response exchanges. Only the agent issues requests (they are
// asserted); the mocked world only responds (scripted). The loader compiles
// the trace into the internal per-model-turn script the mocks consume.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

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
 * called party's scripted response. The response shape follows the
 * callee: tool_call/reply for a model request, status/body for a tool
 * request.
 */
interface TraceEntry {
  request?: { model?: ConversationState; tool?: string };
  response?: {
    tool_call?: { name: string; args: Record<string, unknown> };
    reply?: string;
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

function compileTrace(file: string, trace: TraceEntry[]): ModelTurn[] {
  const turns: ModelTurn[] = [];
  for (const [i, e] of trace.entries()) {
    const at = `when[${i}]`;
    const req = e?.request;
    const res = e?.response;
    if (!req || typeof req !== 'object') fail(file, `${at} needs "request"`);
    if (!res || typeof res !== 'object') fail(file, `${at} needs "response"`);
    const targets = [req.model !== undefined, req.tool !== undefined].filter(Boolean);
    if (targets.length !== 1) {
      fail(file, `${at}.request must name exactly one of "model" / "tool"`);
    }

    if (req.model !== undefined) {
      if (!['initial', 'tool_result', 'tool_error'].includes(req.model)) {
        fail(file, `${at}.request.model has unknown state "${req.model}"`);
      }
      const actions = [res.tool_call !== undefined, res.reply !== undefined].filter(Boolean);
      if (actions.length !== 1) {
        fail(file, `${at}.response must have exactly one of "tool_call" / "reply" for a model request`);
      }
      turns.push({
        expecting: req.model,
        ...(res.tool_call ? { call_tool: res.tool_call } : { reply: res.reply }),
      });
    } else {
      if (typeof res.status !== 'number') {
        fail(file, `${at}.response needs a numeric "status" for a tool request`);
      }
      const turn = turns.at(-1);
      if (!turn?.call_tool) {
        fail(file, `${at}: a tool request must follow a model response containing a tool_call`);
      }
      if (turn.tool_responds !== undefined) {
        fail(file, `${at}: the preceding tool_call already has a tool request`);
      }
      if (turn.call_tool.name !== req.tool) {
        fail(file, `${at}.request.tool is "${req.tool}" but the model requested "${turn.call_tool.name}"`);
      }
      turn.tool_responds = { status: res.status, body: res.body };
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
