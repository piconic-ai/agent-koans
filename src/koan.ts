// Loading and compiling koan YAML into the runner's internal trace form.
// File-format validation belongs here and nowhere else; runtime
// verification belongs to the mocks and the runner.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { deepEqual } from './pending.js';

/** A tool definition as written in `given.tools` (JSON Schema input). */
export interface ToolDef {
  description?: string;
  input_schema: Record<string, unknown>;
}

/** A scripted HTTP response of a mocked party (tool server or model API). */
export interface ToolResponse {
  status: number;
  body?: unknown;
}

/**
 * One tool-call instruction inside a model response — one entry of a
 * `tool_calls` array. A model turn carries more than one of these when the
 * response is written as a list (a parallel group, SPEC.md §6.1).
 */
export interface CallToolInstruction {
  name: string;
  /** The verbatim wire string served as this call's `function.arguments`. */
  argsWire: string;
  /**
   * Parsed arguments, present whenever `argsWire` parses as a JSON object.
   * Undefined for malformed args (unparseable, or parsed to a non-object
   * like an array or a number) — fidelity is then undefined by design, so
   * a following `request: { tool: ... }` step is a load error instead of
   * a runtime assertion.
   */
  args?: Record<string, unknown>;
  /** Declared transform from a following tool-request step's `args` (§6.3); overrides `args` for fidelity checking. */
  invokeArgs?: Record<string, unknown>;
  tool_responds?: ToolResponse;
}

interface RawInstruction {
  tool?: unknown;
  args?: unknown;
}

interface TraceEntry {
  // A tool request's own `args` (§6.3 declared transform) is always a
  // plain object — it names the invocation the koan expects, never a raw
  // wire string; only a *response* instruction's `args` can be the wire
  // string form (malformed-arguments koans, §6.1).
  request?: string | { tool?: string; args?: Record<string, unknown> };
  response?:
    | string
    | { tool?: unknown; args?: unknown; status?: number; body?: unknown }
    | RawInstruction[];
}

// A trace step is normally a { request, response } exchange; the bare
// string "abort" is the one exception (SPEC.md §6.1).
type RawTraceStep = 'abort' | TraceEntry;

/** One compiled model turn of a trace. */
export interface ModelTurn {
  reply?: string;
  /** This turn's tool-call instruction(s); more than one means a parallel group. */
  call_tools?: CallToolInstruction[];
  fails?: ToolResponse;
  /**
   * Set when this is the trace's last turn and it is followed by the
   * `abort` step (SPEC.md §6.1): `'live'` when this turn is a tool-call
   * instruction (the run is still in progress when the caller aborts),
   * `'late'` when it is a text reply (the run had already settled).
   */
  abort?: 'live' | 'late';
}

/** A `then`-block matcher; a bare scalar means `equals`. */
export type Matcher =
  | string
  | number
  | boolean
  | { equals?: unknown; contains?: string; matches?: string };

/** Optional per-run budgets, forwarded verbatim to the run submission. */
export interface RunLimits {
  max_model_requests?: number;
}

/** A compiled koan: shared `given`/`then` plus one or more trace variants. */
export interface Koan {
  name: string;
  description?: string;
  given: {
    task: string;
    tools: Record<string, ToolDef>;
    limits?: RunLimits;
  };
  traces: Record<string, ModelTurn[]>;
  then: {
    run?: { status?: string; output?: Matcher };
  };
}

/** A koan found on disk, addressed by its filename (without extension) as id. */
export interface DiscoveredKoan {
  id: string;
  file: string;
  koan: Koan;
}

function fail(file: string, message: string): never {
  throw new Error(`Invalid koan ${file}: ${message}`);
}

/**
 * Compile one `{ tool, args }` instruction's `args`. A mapping is the
 * JSON-encoding sugar; a string is the verbatim wire string, which may or
 * may not parse as a JSON object (malformed-arguments koans deliberately
 * write one that does not).
 */
function compileArgs(file: string, at: string, raw: unknown): { argsWire: string; args?: Record<string, unknown> } {
  if (raw === undefined) return { argsWire: '{}', args: {} };
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { argsWire: raw, args: parsed as Record<string, unknown> };
      }
    } catch {
      // falls through: argsWire keeps the unparseable string, args stays undefined
    }
    return { argsWire: raw, args: undefined };
  }
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const args = raw as Record<string, unknown>;
    return { argsWire: JSON.stringify(args), args };
  }
  fail(file, `${at}.args must be a mapping (JSON-encoding sugar) or a string (the verbatim wire arguments)`);
}

function compileInstruction(file: string, at: string, raw: RawInstruction): CallToolInstruction {
  if (typeof raw?.tool !== 'string') fail(file, `${at} needs "tool"`);
  // Checked here rather than only where the single form is compiled, so a
  // stray key inside a parallel group's list is a load error too.
  for (const key of Object.keys(raw)) {
    if (key !== 'tool' && key !== 'args') {
      fail(file, `${at} has unknown key "${key}" — a tool-call instruction carries only "tool" and "args"`);
    }
  }
  const { argsWire, args } = compileArgs(file, at, raw.args);
  return { name: raw.tool, argsWire, args };
}

// Two instructions are the same call only when their parsed args are
// deep-equal; two malformed instructions (no parsed args) are compared by
// their raw wire string instead, since deep equality has nothing to work
// with. A malformed instruction is never mistaken for a parseable one.
function sameInstruction(a: CallToolInstruction, b: CallToolInstruction): boolean {
  if (a.name !== b.name) return false;
  if (a.args !== undefined && b.args !== undefined) return deepEqual(a.args, b.args);
  return a.args === undefined && b.args === undefined && a.argsWire === b.argsWire;
}

function compileTrace(file: string, trace: RawTraceStep[], label = 'when'): ModelTurn[] {
  const turns: ModelTurn[] = [];
  for (const [i, raw] of trace.entries()) {
    const at = `${label}[${i}]`;
    if (turns.at(-1)?.fails) {
      fail(file, `${at}: nothing can follow a model API failure — the agent must stop (R8)`);
    }
    // Checked the same way as the R8 rule above: once the previous turn
    // carries an abort marker, any further entry — including a second
    // "abort" — is past the trace's end (SPEC.md §6.1).
    if (turns.at(-1)?.abort) {
      fail(file, `${at}: nothing can follow "abort" — it must be the trace's last step`);
    }

    if (raw === 'abort') {
      const last = turns.at(-1);
      if (!last) {
        fail(file, `${at}: "abort" needs at least one exchange before it in the trace`);
      }
      last.abort = last.call_tools ? 'live' : 'late';
      continue;
    }

    const e = raw;
    const req = e?.request;
    const res = e?.response;
    if (req === undefined || req === null) fail(file, `${at} needs "request"`);
    if (res === undefined || res === null) fail(file, `${at} needs "response"`);

    if (req === 'model') {
      const prev = turns.at(-1);
      if (prev && !prev.call_tools) {
        fail(file, `${at}: a model request cannot follow a text reply (multi-turn traces are not supported yet)`);
      }
      if (typeof res === 'string') {
        turns.push({ reply: res });
      } else if (Array.isArray(res)) {
        // A parallel group: one assistant message, multiple tool_calls.
        // A 1-element list is really the single form; writing it as a
        // list would silently work but invite an inconsistent style.
        if (res.length < 2) {
          fail(
            file,
            `${at}.response is a list of ${res.length} — a parallel group needs at least two instructions; write the single "{ tool, args }" form instead`,
          );
        }
        const call_tools = res.map((r, j) => compileInstruction(file, `${at}[${j}]`, r));
        for (let a = 0; a < call_tools.length; a++) {
          for (let b = a + 1; b < call_tools.length; b++) {
            if (sameInstruction(call_tools[a], call_tools[b])) {
              fail(
                file,
                `${at}: list members [${a}] and [${b}] both call "${call_tools[a].name}" with the same arguments — matching a following tool request against them would be ambiguous`,
              );
            }
          }
        }
        turns.push({ call_tools });
      } else if (typeof res.tool === 'string') {
        if (res.status !== undefined) {
          fail(file, `${at}.response mixes a tool-call instruction with "status"`);
        }
        turns.push({ call_tools: [compileInstruction(file, at, res)] });
      } else if (typeof res.status === 'number') {
        // Only statuses the SDKs surface without retrying keep the trace
        // deterministic: 408/429/5xx are auto-retried by common clients.
        if (res.status < 400 || res.status >= 500 || res.status === 408 || res.status === 429) {
          fail(file, `${at}.response.status must be a non-retryable 4xx (not 408/429) for a model API failure`);
        }
        turns.push({ fails: { status: res.status, body: res.body } });
      } else {
        fail(
          file,
          `${at}.response for a model request must be a reply string, { tool, args }, a list of { tool, args }, or { status }`,
        );
      }
    } else if (typeof req === 'object' && typeof req.tool === 'string') {
      if (typeof res === 'string' || Array.isArray(res) || typeof res.status !== 'number') {
        fail(file, `${at}.response needs a numeric "status" for a tool request`);
      }
      const turn = turns.at(-1);
      if (!turn?.call_tools) {
        fail(file, `${at}: a tool request must follow a model response containing a tool-call instruction`);
      }

      const open = turn.call_tools.filter((m) => m.name === req.tool && m.tool_responds === undefined);
      let member: CallToolInstruction;
      if (open.length === 1) {
        member = open[0];
      } else if (open.length === 0) {
        const named = turn.call_tools.some((m) => m.name === req.tool);
        fail(
          file,
          named
            ? `${at}: the preceding tool-call instruction for "${req.tool}" already has a tool request`
            : `${at}.request.tool is "${req.tool}" but the preceding model response requests ${turn.call_tools.map((m) => `"${m.name}"`).join(', ')}`,
        );
      } else {
        // The tool name repeats within the group: args disambiguate which
        // instruction this step closes, since matching is unordered
        // (SPEC.md §6.1). Duplicate name+args instructions were already
        // rejected when the group was compiled, so at most one candidate
        // can match.
        if (req.args === undefined) {
          fail(
            file,
            `${at}: "${req.tool}" appears more than once in the preceding group — write "args" to say which call this closes`,
          );
        }
        const exact = open.filter((m) => m.args !== undefined && deepEqual(m.args, req.args));
        if (exact.length !== 1) {
          fail(file, `${at}: "args" does not match exactly one of the pending "${req.tool}" calls in the group`);
        }
        member = exact[0];
      }

      if (member.args === undefined) {
        fail(
          file,
          `${at}: "${req.tool}"'s arguments do not parse as a JSON object — argument fidelity is undefined, so the agent must refuse the call instead (R6); no tool request can follow it`,
        );
      }
      // No mismatch check against the instruction's args: explicit args
      // are a declared transform (SPEC.md §6.3), not a koan bug.
      member.invokeArgs = req.args ?? member.args;
      member.tool_responds = { status: res.status, body: res.body };
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
    given?: { task?: unknown; tools?: unknown; limits?: unknown };
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

  let limits: RunLimits | undefined;
  if (raw.given.limits !== undefined) {
    const rawLimits = raw.given.limits as Record<string, unknown>;
    if (typeof rawLimits !== 'object' || rawLimits === null || Array.isArray(rawLimits)) {
      fail(file, '"given.limits" must be a mapping');
    }
    for (const key of Object.keys(rawLimits)) {
      if (key !== 'max_model_requests') fail(file, `"given.limits" has unknown key "${key}"`);
    }
    const max = rawLimits.max_model_requests;
    if (!Number.isInteger(max) || (max as number) < 1) {
      fail(file, '"given.limits.max_model_requests" must be a positive integer');
    }
    limits = { max_model_requests: max as number };
  }

  if ((raw.when === undefined) === (raw.one_of === undefined)) {
    fail(file, 'a koan needs exactly one of "when" / "one_of"');
  }

  let traces: Record<string, ModelTurn[]>;
  if (raw.when !== undefined) {
    if (!Array.isArray(raw.when) || raw.when.length === 0) {
      fail(file, '"when" must be a non-empty list of trace steps');
    }
    traces = { '': compileTrace(file, raw.when as RawTraceStep[]) };
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
      traces[variant] = compileTrace(file, trace as RawTraceStep[], `one_of.${variant}`);
    }
  }

  if (limits?.max_model_requests !== undefined) {
    for (const [variant, turns] of Object.entries(traces)) {
      if (turns.length > limits.max_model_requests) {
        const at = variant ? `one_of.${variant}` : 'when';
        fail(file, `${at} scripts ${turns.length} model requests, more than given.limits.max_model_requests (${limits.max_model_requests}) permits`);
      }
    }
  }

  return {
    name: raw.name,
    description: raw.description,
    given: { task: raw.given.task, tools, limits },
    traces,
    then: raw.then ?? {},
  };
}

/** Load every koan file directly in a directory, sorted by id. */
export function discoverKoans(dir: string): DiscoveredKoan[] {
  const found: DiscoveredKoan[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isDirectory()) {
      // A silently-ignored subdirectory would mean koans inside it never
      // run again — the worst failure mode for a conformance suite. Fail
      // loud instead of shrinking the suite quietly.
      throw new Error(
        `${path.join(dir, entry.name)} is a subdirectory — koans must sit directly in ${dir}, nesting is not supported`,
      );
    }
    if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) continue;
    const full = path.join(dir, entry.name);
    found.push({
      id: entry.name.replace(/\.ya?ml$/, ''),
      file: full,
      koan: loadKoan(full),
    });
  }
  return found.sort((a, b) => a.id.localeCompare(b.id));
}
