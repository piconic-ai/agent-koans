// Loading and compiling koan YAML into the runner's internal trace form.
// File-format parsing belongs to koan-spec.ts (the shape) and parse.ts
// (reading it); this file only reads the YAML, hands it to
// parseKoanFile, and COMPILES the result (assumed valid — parse.ts
// already rejected anything else) into the runner's own shapes: Koan,
// ModelTurn, Conversation, Trace. Runtime verification belongs to the
// mocks and the runner, not here.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { deepEqual } from './pending.js';
import type {
  Args,
  ContextSetup,
  Instruction,
  Judgment as ParsedJudgment,
  KoanFile,
  ModelResponse,
  ParsedArgs,
  Step,
  Trace as ParsedTrace,
  Turn as ParsedTurn,
} from './koan-spec.js';
import { isProblem, parseKoanFile } from './parse.js';

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
 * response is written as a list (a parallel group).
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
  /** Declared transform from a following tool-request step's `args`; overrides `args` for fidelity checking. */
  invokeArgs?: Record<string, unknown>;
  tool_responds?: ToolResponse;
  /** A prompt the caller sends while this invocation is held open. */
  promptDuring?: string;
  /**
   * Content of the `given.files` entry named by `args.path`, set when this
   * instruction has no following tool request: an internal read the agent
   * executes with a tool of its own, never the tool server. The next model
   * request of the same conversation must carry this content.
   */
  readsFile?: string;
}

/**
 * One delegation instruction inside a model response — the model hands a
 * briefing to a named subagent.
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
  /**
   * What this response reports the conversation to have grown to, resolved
   * from the trace: a step that writes no `used_tokens` reports whatever
   * the one before it did.
   *
   * A compaction's own response reports the size the fold leaves behind,
   * not the larger one it was handed. Reporting the pre-fold size would be
   * closer to what a real summarizing request costs, but it would also
   * decide, for every implementation, how the auxiliary exchange's usage
   * must be booked: one that reads the size off the last response it saw
   * would find itself over the threshold again and compact forever. That
   * is exactly the internal this suite must not pin down.
   */
  usedTokens: number;
  /** Set on the auxiliary request that folds the conversation down; `reply` is the summary served to it. */
  compaction?: true;
  /** This turn's tool-call instruction(s); more than one means a parallel group. */
  call_tools?: CallToolInstruction[];
  /** This turn's delegation instruction(s), each scripted by a following subagent block. */
  delegations?: DelegationInstruction[];
  fails?: ToolResponse;
  /**
   * Set when this is the trace's last turn and it is followed by the
   * `abort` step: `'live'` when this turn is a tool-call
   * instruction (the run is still in progress when the caller aborts),
   * `'late'` when it is a text reply (the run had already settled).
   */
  abort?: 'live' | 'late';
}

/**
 * Where a prompt the caller sent mid-conversation first reaches the
 * model: turn 2+ of a `turns:` koan, or the request that carries a prompt
 * sent while a tool invocation was held open.
 */
export interface TurnBoundary {
  /** Index into the conversation's `turns` where this turn's exchanges begin. */
  start: number;
  /** The user's prompt that opens this turn. */
  prompt: string;
  /** Set when this request carries a mid-run prompt *and* closes the held tool call. */
  joined?: boolean;
}

/** One scripted conversation of a trace: the main one, or a subagent's. */
export interface Conversation {
  /** `''` for the main conversation, the subagent's name otherwise. */
  name: string;
  /** The delegating conversation's name; undefined for the main conversation. */
  parent?: string;
  turns: ModelTurn[];
  /** The opening user message: the top-level `prompt` (or a `turns:` koan's first turn) for the main conversation, the delegation's briefing otherwise. */
  briefing: string;
  /** Boundaries for turn 2 onward of a `turns:` koan, or the single boundary a mid-run prompt produces; absent otherwise — turn 1 is `briefing`, at index 0. Only ever set on the main conversation. */
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

/**
 * The run's context window and compaction policy, as the run submission
 * carries them. `off` compiles to an absent threshold rather than to a
 * word of its own: an agent that finds no threshold has nothing to compact
 * at, which is the same instruction, and it keeps every run submitted
 * before this existed meaning what it meant.
 */
export interface RunContext {
  window: number;
  compaction?: { at_percent: number };
}

/** A koan's judgment on a run's outcome (top-level, or one turn's). */
export interface Judgment {
  status?: string;
  output?: Matcher;
}

/** One turn of a `turns:` koan: its prompt, and its own judgment. */
export interface TurnSpec {
  prompt: string;
  /** This turn's judgment; defaults to `{ status: 'completed' }` when the turn omits its own `then`. */
  then: Judgment;
}

/** A compiled koan: shared `given`/`then` plus one or more trace variants. */
export interface Koan {
  name: string;
  description?: string;
  /** Agent setup only — never the prompt. */
  given: {
    tools: Record<string, ToolDef>;
    /** Relative path → content, materialized into `KOAN_WORKSPACE` before the run (SPEC.md §2). */
    files?: Record<string, string>;
    limits?: RunLimits;
    context?: RunContext;
  };
  /** The run's initial prompt (top-level `prompt:`); undefined for a `turns:` koan. */
  prompt?: string;
  /** The ordered turns of a `turns:` koan; undefined for a `when`/`one_of` koan. */
  turns?: TurnSpec[];
  traces: Record<string, Trace>;
  /** Empty (unused) for a `turns:` koan — each turn carries its own judgment instead. */
  then: Judgment;
}

/** A koan found on disk, addressed by its filename (without extension) as id. */
export interface DiscoveredKoan {
  id: string;
  file: string;
  koan: Koan;
}

// TypeScript rejects an unhandled discriminated-union case at compile
// time, before this ever runs; parse.ts having already validated the file
// means it never runs anyway. It exists so a variant added to
// koan-spec.ts and forgotten here is a build failure, not a silent gap.
function assertNever(x: never): never {
  throw new Error(`unreachable koan shape: ${JSON.stringify(x)}`);
}

type CallInstruction = Extract<Instruction, { kind: 'call' }>;
type DelegateInstruction = Extract<Instruction, { kind: 'delegate' }>;

function isCall(i: Instruction): i is CallInstruction {
  return i.kind === 'call';
}

function isDelegate(i: Instruction): i is DelegateInstruction {
  return i.kind === 'delegate';
}

function argsValueOf(args: Args): ParsedArgs | undefined {
  return args.kind === 'mapping' ? args.value : args.parsed;
}

// A call instruction's wire string is its `mapping` value re-encoded, or
// the `wire` form's own verbatim text — koan-spec.ts keeps only one of the
// two, per Args's own header.
function compileCallTool(instr: CallInstruction): CallToolInstruction {
  const argsWire = instr.args.kind === 'wire' ? instr.args.text : JSON.stringify(instr.args.value);
  return { name: instr.tool, argsWire, args: argsValueOf(instr.args) };
}

function compileDelegationInstruction(instr: DelegateInstruction): DelegationInstruction {
  // `final` is filled in once the matching subagent block compiles, right
  // after this turn is pushed — the block is mandatory (parse.ts), so a
  // placeholder can never survive to runtime.
  return { subagent: instr.subagent, prompt: instr.prompt, final: '' };
}

function compileModelTurn(response: ModelResponse, usedTokens: number): ModelTurn {
  switch (response.kind) {
    case 'reply':
      return { reply: response.text, usedTokens };
    case 'instructions': {
      const call_tools = response.instructions.filter(isCall).map(compileCallTool);
      const delegations = response.instructions.filter(isDelegate).map(compileDelegationInstruction);
      return {
        usedTokens,
        ...(call_tools.length > 0 ? { call_tools } : {}),
        ...(delegations.length > 0 ? { delegations } : {}),
      };
    }
    case 'api-failure':
      return { fails: { status: response.status, body: response.body }, usedTokens };
    default:
      return assertNever(response);
  }
}

// One `call` instruction still open for a following `tool` step to close,
// paired with the compiled turn field it closes. parse.ts's
// everyToolRequestMatchesAnOpenCall already proved every `tool` step in a
// valid file matches exactly one of these; this walk repeats the same
// match, now free to assume it always succeeds.
interface OpenCall {
  source: CallInstruction;
  compiled: CallToolInstruction;
}

function matchOpenCall(openCalls: OpenCall[], tool: string, args: ParsedArgs | undefined): OpenCall {
  const named = openCalls.filter((c) => c.source.tool === tool);
  const match =
    named.length <= 1
      ? named[0]
      : named.find((c) => args !== undefined && deepEqual(argsValueOf(c.source.args), args));
  // Stated as an invariant rather than asserted away: parse.ts proved the
  // match exists, and if a future change to its rules stops proving it, the
  // failure should name this step instead of surfacing as a dereference of
  // undefined somewhere downstream.
  if (match === undefined) {
    throw new Error(`internal: no open call matches the tool request for "${tool}"`);
  }
  return match;
}

/**
 * Compiles one conversation's steps into `conv.turns`, appending (so a
 * `turns:` koan's later turns extend the same conversation), and
 * recursively compiles any subagent block into a fresh
 * Conversation appended to `conversations` — the main one first, then
 * subagents in first-appearance order.
 */
function compileSteps(steps: Step[], conv: Conversation, conversations: Conversation[]): void {
  const delegationBySubagent = new Map<string, DelegationInstruction>();
  let openCalls: OpenCall[] = [];
  // Read off the conversation, not a local: a `turns:` koan compiles each
  // turn's steps with a fresh call to this function, into the same
  // conversation, and the size a turn ends at is where the next one starts.
  const carried = () => conv.turns.at(-1)?.usedTokens ?? 0;

  for (const [i, step] of steps.entries()) {
    switch (step.kind) {
      case 'model': {
        const turn = compileModelTurn(step.response, step.used_tokens ?? carried());
        conv.turns.push(turn);
        for (const d of turn.delegations ?? []) delegationBySubagent.set(d.subagent, d);
        openCalls =
          step.response.kind === 'instructions'
            ? step.response.instructions
                .filter(isCall)
                .map((source, i) => ({ source, compiled: turn.call_tools![i] }))
            : [];
        break;
      }
      case 'subagent': {
        const briefing = delegationBySubagent.get(step.name)!.prompt;
        const child: Conversation = { name: step.name, parent: conv.name, turns: [], briefing };
        conversations.push(child);
        compileSteps(step.trace.steps, child, conversations);
        // A subagent block always closes a delegation from this same
        // conversation's own turns (parse.ts's pairing) — the child's
        // final reply is what returns to the parent.
        delegationBySubagent.get(step.name)!.final = child.turns.at(-1)!.reply!;
        openCalls = [];
        break;
      }
      case 'compaction': {
        // The size the fold leaves behind, which parse.ts required the
        // model step after it to write. Not a turn boundary and not an
        // answer to anything: the open calls stay open, since folding the
        // conversation down is not what closes them.
        const next = steps.slice(i + 1).find((s) => s.kind === 'model') as Extract<Step, { kind: 'model' }>;
        conv.turns.push({ reply: step.summary, usedTokens: next.used_tokens!, compaction: true });
        break;
      }
      case 'tool': {
        const match = matchOpenCall(openCalls, step.tool, step.args);
        match.compiled.invokeArgs = step.args ?? match.compiled.args;
        match.compiled.tool_responds = { status: step.response.status, body: step.response.body };
        if (step.prompt !== undefined) match.compiled.promptDuring = step.prompt;
        openCalls = openCalls.filter((c) => c !== match);
        break;
      }
      default:
        assertNever(step);
    }
  }
}

// Derived rather than written: a model request after a text reply is the
// prompt re-opening the run, so that seam is the queued turn; without one,
// the prompt joined the request that closes the held invocation.
function promptBoundary(conv: Conversation): TurnBoundary | undefined {
  let held = -1;
  let prompt: string | undefined;
  for (const [i, turn] of conv.turns.entries()) {
    for (const member of turn.call_tools ?? []) {
      if (member.promptDuring !== undefined) {
        held = i;
        prompt = member.promptDuring;
      }
    }
  }
  if (prompt === undefined) return undefined;
  for (let s = held + 1; s < conv.turns.length; s++) {
    // A compaction's summary is a reply the mock served, not the run's own
    // answer, so it never marks the seam a queued prompt re-opens.
    const before = conv.turns[s - 1];
    if (before.reply !== undefined && !before.compaction) return { start: s, prompt };
  }
  // parse.ts requires a model request after a mid-run prompt, so this exists.
  return { start: held + 1, prompt, joined: true };
}

/** The prompt the caller sends into a held invocation, when this trace scripts one. */
export function promptDuringOf(trace: Trace): string | undefined {
  for (const turn of trace.conversations[0].turns) {
    for (const member of turn.call_tools ?? []) {
      if (member.promptDuring !== undefined) return member.promptDuring;
    }
  }
  return undefined;
}

function compileTrace(trace: ParsedTrace, briefing: string): Trace {
  const conversations: Conversation[] = [];
  const main: Conversation = { name: '', turns: [], briefing };
  conversations.push(main);
  compileSteps(trace.steps, main, conversations);
  if (trace.abort !== undefined) main.turns.at(-1)!.abort = trace.abort;
  const boundary = promptBoundary(main);
  if (boundary) main.followUps = [boundary];
  return { conversations };
}

function compileJudgment(then: ParsedJudgment | undefined): Judgment {
  if (then === undefined) return {};
  return { status: then.status, output: then.output };
}

/**
 * Compiles a `turns:` koan into one Trace: a single main
 * conversation whose turn boundaries are recorded in `followUps`, plus
 * any subagent conversations delegated to from inside a turn. Turn 1's
 * prompt becomes the conversation's `briefing` (what `POST /runs`
 * submits); turn 2 onward each append a `followUps` boundary and their
 * own steps to the same conversation.
 */
function compileTurnsTrace(turns: [ParsedTurn, ParsedTurn, ...ParsedTurn[]]): { trace: Trace; turnSpecs: TurnSpec[] } {
  const conversations: Conversation[] = [];
  const followUps: TurnBoundary[] = [];
  const main: Conversation = { name: '', turns: [], briefing: turns[0].prompt, followUps };
  conversations.push(main);

  const turnSpecs: TurnSpec[] = [];
  for (const [i, t] of turns.entries()) {
    if (i > 0) followUps.push({ start: main.turns.length, prompt: t.prompt });
    compileSteps(t.trace.steps, main, conversations);
    turnSpecs.push({ prompt: t.prompt, then: compileJudgment(t.then) });
  }

  return { trace: { conversations }, turnSpecs };
}

// An instruction that names a `given.files` entry and has no tool request
// is an internal read, never a tool-server call: the runner must see the file's
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

function compileContext(context: ContextSetup | undefined): RunContext | undefined {
  if (context === undefined) return undefined;
  return {
    window: context.window,
    ...(context.compaction.kind === 'threshold' ? { compaction: { at_percent: context.compaction.percent } } : {}),
  };
}

function compileKoan(parsed: KoanFile): Koan {
  const given = {
    tools: parsed.given.tools as Record<string, ToolDef>,
    files: parsed.given.files,
    limits: parsed.given.limits,
    context: compileContext(parsed.given.context),
  };

  let prompt: string | undefined;
  let turns: TurnSpec[] | undefined;
  let traces: Record<string, Trace>;

  switch (parsed.body.kind) {
    case 'single':
      prompt = parsed.body.prompt;
      traces = { '': compileTrace(parsed.body.trace, prompt) };
      break;
    case 'variants':
      prompt = parsed.body.prompt;
      traces = {};
      for (const [variant, trace] of Object.entries(parsed.body.variants)) {
        traces[variant] = compileTrace(trace, prompt);
      }
      break;
    case 'turns': {
      const compiled = compileTurnsTrace(parsed.body.turns);
      traces = { '': compiled.trace };
      turns = compiled.turnSpecs;
      break;
    }
    default:
      return assertNever(parsed.body);
  }

  for (const trace of Object.values(traces)) {
    markInternalReads(trace, given.files ?? {});
  }

  const then = parsed.body.kind === 'turns' ? {} : compileJudgment(parsed.body.then);

  return { name: parsed.name, description: parsed.description, given, prompt, turns, traces, then };
}

/** Load and compile one koan file; throws on any format violation. */
export function loadKoan(file: string): Koan {
  const raw: unknown = parse(fs.readFileSync(file, 'utf8'));
  const parsed = parseKoanFile(raw);
  if (isProblem(parsed)) throw new Error(`Invalid koan ${file}: ${parsed.message}`);
  return compileKoan(parsed);
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
