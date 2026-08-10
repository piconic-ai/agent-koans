// Loading and compiling koan YAML into the runner's internal trace form.
// File-format parsing and validation belong to format.ts; this file only
// reads the YAML, hands it to parseKoanFile, and COMPILES the result
// (assumed valid — format.ts already rejected anything else) into the
// runner's own shapes: Koan, ModelTurn, Conversation, Trace. Runtime
// verification belongs to the mocks and the runner, not here.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import {
  parseKoanFile,
  type GroupMember,
  type ModelResponse,
  type ThenBlock,
  type ToolCallResponse,
  type TraceStep,
  type TurnEntry as ParsedTurn,
} from './format.js';

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
  /**
   * Content of the `given.files` entry named by `args.path`, set when this
   * instruction has no following tool request: an internal read the agent
   * executes with a tool of its own (SPEC.md §5 R7). The next model
   * request of the same conversation must carry this content.
   */
  readsFile?: string;
}

/**
 * One delegation instruction inside a model response — the model hands a
 * briefing to a named subagent (SPEC.md §6.4).
 */
export interface DelegationInstruction {
  /** The delegate's name, as declared to the run. */
  subagent: string;
  /** The briefing that opens the delegate's conversation. */
  prompt: string;
  /** The delegate's final reply, lifted from the subagent block that scripts it. */
  final: string;
}

/** One compiled model turn of a trace. */
export interface ModelTurn {
  reply?: string;
  /** This turn's tool-call instruction(s); more than one means a parallel group. */
  call_tools?: CallToolInstruction[];
  /** This turn's delegation instruction(s), each scripted by a following subagent block (SPEC.md §6.4). */
  delegations?: DelegationInstruction[];
  fails?: ToolResponse;
  /**
   * Set when this is the trace's last turn and it is followed by the
   * `abort` step (SPEC.md §6.1): `'live'` when this turn is a tool-call
   * instruction (the run is still in progress when the caller aborts),
   * `'late'` when it is a text reply (the run had already settled).
   */
  abort?: 'live' | 'late';
}

/**
 * Where turn 2+ of a `turns:` koan's main conversation starts, and the
 * prompt that opens it (SPEC.md §6.5).
 */
export interface TurnBoundary {
  /** Index into the conversation's `turns` where this turn's exchanges begin. */
  start: number;
  /** The user's prompt that opens this turn. */
  prompt: string;
}

/** One scripted conversation of a trace: the main one, or a subagent's (SPEC.md §6.4). */
export interface Conversation {
  /** `''` for the main conversation, the subagent's name otherwise. */
  name: string;
  /** The delegating conversation's name; undefined for the main conversation. */
  parent?: string;
  turns: ModelTurn[];
  /** The opening user message: the top-level `prompt` (or a `turns:` koan's first turn) for the main conversation, the delegation's briefing otherwise. */
  briefing: string;
  /** Boundaries for turn 2 onward of a `turns:` koan (SPEC.md §6.5); absent otherwise — turn 1 is `briefing`, at index 0. Only ever set on the main conversation. */
  followUps?: TurnBoundary[];
}

/** One compiled trace variant: the main conversation plus any subagent conversations. */
export interface Trace {
  /** The main conversation first; subagent conversations follow in first-appearance order. */
  conversations: Conversation[];
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

/** A koan's judgment on a run's outcome (top-level, or one turn's, SPEC.md §6.2/§6.5). */
export interface Judgment {
  status?: string;
  output?: Matcher;
}

/** One turn of a `turns:` koan: its prompt, and its own judgment (SPEC.md §6.5). */
export interface TurnSpec {
  prompt: string;
  /** This turn's judgment; defaults to `{ status: 'completed' }` when the turn omits its own `then`. */
  then: Judgment;
}

/** A compiled koan: shared `given`/`then` plus one or more trace variants. */
export interface Koan {
  name: string;
  description?: string;
  /** Agent setup only — never the prompt (SPEC.md §6). */
  given: {
    tools: Record<string, ToolDef>;
    /** Relative path → content, materialized into `KOAN_WORKSPACE` before the run (SPEC.md §2). */
    files?: Record<string, string>;
    limits?: RunLimits;
  };
  /** The run's initial prompt (top-level `prompt:`); undefined for a `turns:` koan (SPEC.md §6.5). */
  prompt?: string;
  /** The ordered turns of a `turns:` koan (SPEC.md §6.5); undefined for a `when`/`one_of` koan. */
  turns?: TurnSpec[];
  traces: Record<string, Trace>;
  /** Empty (unused) for a `turns:` koan — each turn carries its own judgment instead (SPEC.md §6.5). */
  then: Judgment;
}

/** A koan found on disk, addressed by its filename (without extension) as id. */
export interface DiscoveredKoan {
  id: string;
  file: string;
  koan: Koan;
}

// TypeScript rejects an unhandled discriminated-union case at compile
// time, before this ever runs; format.ts having already validated the
// file means it never runs anyway. It exists so a variant added to
// format.ts and forgotten here is a build failure, not a silent gap.
function assertNever(x: never): never {
  throw new Error(`unreachable koan shape: ${JSON.stringify(x)}`);
}

function compileCallTool(r: ToolCallResponse): CallToolInstruction {
  return { name: r.tool, argsWire: r.argsWire, args: r.args, invokeArgs: r.invokeArgs, tool_responds: r.result };
}

function compileDelegationInstruction(r: { subagent: string; prompt: string }): DelegationInstruction {
  // `final` is filled in once the matching subagent block compiles, right
  // after this turn is pushed — the block is mandatory (format.ts), so a
  // placeholder can never survive to runtime.
  return { subagent: r.subagent, prompt: r.prompt, final: '' };
}

function isToolCall(m: GroupMember): m is ToolCallResponse {
  return m.kind === 'tool-call';
}

function isDelegation(m: GroupMember): m is Extract<GroupMember, { kind: 'delegation' }> {
  return m.kind === 'delegation';
}

function compileModelTurn(response: ModelResponse): ModelTurn {
  switch (response.kind) {
    case 'reply':
      return { reply: response.text };
    case 'tool-call':
      return { call_tools: [compileCallTool(response)] };
    case 'delegation':
      return { delegations: [compileDelegationInstruction(response)] };
    case 'group': {
      const call_tools = response.members.filter(isToolCall).map(compileCallTool);
      const delegations = response.members.filter(isDelegation).map(compileDelegationInstruction);
      return {
        ...(call_tools.length > 0 ? { call_tools } : {}),
        ...(delegations.length > 0 ? { delegations } : {}),
      };
    }
    case 'api-failure':
      return { fails: { status: response.status, body: response.body } };
    default:
      return assertNever(response);
  }
}

/**
 * Compiles one conversation's steps into `conv.turns`, appending (so a
 * `turns:` koan's later turns extend the same conversation, SPEC.md
 * §6.5), and recursively compiles any subagent block into a fresh
 * Conversation appended to `conversations` — the main one first, then
 * subagents in first-appearance order.
 */
function compileSteps(steps: TraceStep[], conv: Conversation, conversations: Conversation[]): void {
  const delegationBySubagent = new Map<string, DelegationInstruction>();
  for (const step of steps) {
    switch (step.kind) {
      case 'model': {
        const turn = compileModelTurn(step.response);
        conv.turns.push(turn);
        for (const d of turn.delegations ?? []) delegationBySubagent.set(d.subagent, d);
        break;
      }
      case 'subagent-block': {
        const child: Conversation = { name: step.subagent, parent: conv.name, turns: [], briefing: step.prompt };
        conversations.push(child);
        compileSteps(step.when, child, conversations);
        // A subagent block always closes a delegation from this same
        // conversation's own turns (format.ts's pairing) — the child's
        // final reply is what returns to the parent (SPEC.md §6.4).
        delegationBySubagent.get(step.subagent)!.final = child.turns.at(-1)!.reply!;
        break;
      }
      case 'abort': {
        const last = conv.turns.at(-1)!;
        last.abort = last.call_tools || last.delegations ? 'live' : 'late';
        break;
      }
      default:
        assertNever(step);
    }
  }
}

function compileTrace(steps: TraceStep[], prompt: string): Trace {
  const conversations: Conversation[] = [];
  const main: Conversation = { name: '', turns: [], briefing: prompt };
  conversations.push(main);
  compileSteps(steps, main, conversations);
  return { conversations };
}

function compileJudgment(then: ThenBlock | undefined): Judgment {
  if (then === undefined) return {};
  return { status: then.status, output: then.output as Matcher | undefined };
}

/**
 * Compiles a `turns:` koan (SPEC.md §6.5) into one Trace: a single main
 * conversation whose turn boundaries are recorded in `followUps`, plus
 * any subagent conversations delegated to from inside a turn. Turn 1's
 * prompt becomes the conversation's `briefing` (what `POST /runs`
 * submits); turn 2 onward each append a `followUps` boundary and their
 * own steps to the same conversation.
 */
function compileTurnsTrace(turns: ParsedTurn[]): { trace: Trace; turnSpecs: TurnSpec[] } {
  const conversations: Conversation[] = [];
  const followUps: TurnBoundary[] = [];
  const main: Conversation = { name: '', turns: [], briefing: turns[0].prompt, followUps };
  conversations.push(main);

  const turnSpecs: TurnSpec[] = [];
  for (const [i, t] of turns.entries()) {
    if (i > 0) followUps.push({ start: main.turns.length, prompt: t.prompt });
    compileSteps(t.when, main, conversations);
    // Every turn is judged, whether the koan writes its own `then` or not
    // — an intermediate turn defaults to requiring "completed" (SPEC.md
    // §6.5), and this is the only place that default is applied.
    turnSpecs.push({ prompt: t.prompt, then: t.then !== undefined ? compileJudgment(t.then) : { status: 'completed' } });
  }

  return { trace: { conversations }, turnSpecs };
}

// An instruction that names a `given.files` entry and has no tool request
// is an internal read (SPEC.md §5 R7): the runner must see the file's
// content flow into the conversation's next model request. Marked after
// the trace compiles, since `tool_responds` is only known then.
function markInternalReads(trace: Trace, files: Record<string, string>): void {
  for (const conv of trace.conversations) {
    for (const turn of conv.turns) {
      for (const member of turn.call_tools ?? []) {
        if (member.tool_responds !== undefined) continue;
        const p = member.args?.path;
        if (typeof p === 'string' && files[p] !== undefined) member.readsFile = files[p];
      }
    }
  }
}

/** Load and compile one koan file; throws on any format violation. */
export function loadKoan(file: string): Koan {
  const raw: unknown = parse(fs.readFileSync(file, 'utf8'));
  const parsed = parseKoanFile(raw);
  if (typeof parsed === 'string') throw new Error(`Invalid koan ${file}: ${parsed}`);

  const given = {
    tools: parsed.given.tools as Record<string, ToolDef>,
    files: parsed.given.files,
    limits: parsed.given.limits,
  };

  let prompt: string | undefined;
  let turns: TurnSpec[] | undefined;
  let traces: Record<string, Trace>;

  if (parsed.turns !== undefined) {
    const compiled = compileTurnsTrace(parsed.turns);
    traces = { '': compiled.trace };
    turns = compiled.turnSpecs;
  } else if (parsed.when !== undefined) {
    prompt = parsed.prompt;
    traces = { '': compileTrace(parsed.when, prompt as string) };
  } else {
    prompt = parsed.prompt;
    traces = {};
    for (const [variant, steps] of Object.entries(parsed.one_of!)) {
      traces[variant] = compileTrace(steps, prompt as string);
    }
  }

  for (const trace of Object.values(traces)) {
    markInternalReads(trace, given.files ?? {});
  }

  return {
    name: parsed.name,
    description: parsed.description,
    given,
    prompt,
    turns,
    traces,
    then: compileJudgment(parsed.then),
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
