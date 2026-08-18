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
  CompactionReport,
  ContextSetup,
  Instruction,
  Judgment as ParsedJudgment,
  KoanFile,
  ModelResponse,
  ParsedArgs,
  Step,
  SubagentSetup,
  Trace as ParsedTrace,
  Turn as ParsedTurn,
  TurnTrace as ParsedTurnTrace,
} from './koan-spec.js';
import { isProblem, parseKoanFile } from './parse.js';

/** A tool definition as written in `given.tools` (JSON Schema input). */
export interface ToolDef {
  description?: string;
  input_schema: Record<string, unknown>;
  /** How long the caller wants an invocation waited for, in milliseconds (SPEC.md §3); forwarded verbatim to the run submission. */
  timeout_ms?: number;
}

/** A scripted HTTP response of a mocked party (tool server or model API). */
export interface HttpResponse {
  status: number;
  body?: unknown;
}

/**
 * What the tool mock does with a permitted invocation: answer it, sever
 * the connection without answering, or accept it and never answer at all.
 * `crash` is the runner's doing, not the mock's: the agent's process is
 * killed while this invocation is in flight, and nothing is answered.
 */
export type ToolResponse = HttpResponse | { disconnect: true } | { never: true } | { crash: true };

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
  /** Set when the caller re-sends the turn's own submission while this invocation is held open (`- retry: prompt`). */
  retryDuring?: true;
  /** This caller action's position among the trace's held actions, in step order — which hold the runner pairs it with. */
  holdIndex?: number;
  /** Set by a response-less tool request: the agent executes this call itself. Resolved to `readsFile` once the trace has compiled. */
  internal?: true;
  /**
   * Content of the `given.files` entry named by `args.path`, for an
   * instruction the agent executes itself. The conversation's next model
   * request must carry it.
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
  /** The delegate's final reply, lifted from the subagent block that scripts it. Empty when the child never answered — it failed, or the run's abort cut it off. */
  final: string;
  /** The model API failure that ended the child instead of a reply; the parent's next request must carry it as the delegation's outcome. */
  fails?: HttpResponse;
}

/** One compiled model turn of a trace. */
export interface ModelTurn {
  reply?: string;
  /**
   * What this response reports the conversation to have grown to, resolved
   * from the trace: a step that writes no `used_tokens` reports whatever
   * the one before it did.
   *
   * A compaction reports the size its fold leaves behind, not the larger
   * one it was handed. The pre-fold size is closer to what such a request
   * really costs, but it would decide for every implementation how the
   * auxiliary exchange's usage must be booked — one that reads the size
   * off the last response it saw would be over the threshold again and
   * fold forever.
   */
  usedTokens: number;
  /** Set on the auxiliary request that folds the conversation down: how the run reported its ending. `reply` is the summary served to it. */
  compaction?: CompactionReport;
  /**
   * Set on every member of a completed fold: the whole group's summaries
   * (one request, or several — koan-spec.ts's header), so a check run
   * against any one member can require every one of them to resurface.
   * `foldMember` is this member's position within the group; `0` marks
   * the group's leader, which is what a fold's reported events are
   * counted once per (runner.ts), however many requests it cost.
   */
  foldSummaries?: string[];
  foldMember?: number;
  /** What the caller's ask said about how to fold; every request the fold costs must carry it. */
  asked?: string;
  /** Set on a fold's first-served request when the ask that brought the fold about is re-sent while it is in flight (`retry: compact`): the mock withholds this response until the runner releases it. */
  compactRetried?: boolean;
  /** This held fold's position among the trace's held actions — which hold the runner pairs it with, numbered the same way as `CallToolInstruction.holdIndex`. */
  holdIndex?: number;
  /** This turn's tool-call instruction(s); more than one means a parallel group. */
  call_tools?: CallToolInstruction[];
  /** This turn's delegation instruction(s), each scripted by a following subagent block. */
  delegations?: DelegationInstruction[];
  fails?: HttpResponse;
  /**
   * Set when this is the trace's last turn and it is followed by the
   * `abort` step: `'live'` when this turn is a tool-call
   * instruction (the run is still in progress when the caller aborts),
   * `'late'` when it is a text reply (the run had already settled).
   */
  abort?: 'live' | 'late';
  /** Set alongside a live `abort`: the caller's abort delivered a second time once the run has settled from the first (`- retry: abort`). */
  abortRetried?: boolean;
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
  /**
   * Set by a trace's bare `crash` step: once every turn before this index
   * has been served, the runner kills and restarts the agent, and the
   * mock parks any request for this index until the restart completes
   * (mock-llm.ts) — otherwise the doomed process could race its own death
   * to the next exchange. Only ever set on the main conversation.
   */
  crashBefore?: number;
}

/** One compiled trace variant: the main conversation plus any subagent conversations. */
export interface Trace {
  /** The main conversation first; subagent conversations follow in first-appearance order. */
  conversations: Conversation[];
}

/**
 * One caller action a held invocation carries — a mid-run prompt, a
 * re-send of the turn's own submission, a fold ask re-sent while its own
 * fold is in flight — or the one action that is not the caller's at all:
 * the runner killing the agent while the invocation is in flight
 * (`response: crash`).
 */
export type HeldAction = { kind: 'prompt'; prompt: string } | { kind: 'retry' } | { kind: 'crash' } | { kind: 'compact' };

/** A `then`-block matcher; a bare scalar means `equals`. */
export type Matcher =
  | string
  | number
  | boolean
  | { equals?: unknown; contains?: string; matches?: string };

/** Optional per-run budgets, forwarded verbatim to the run submission. */
export interface RunLimits {
  max_model_requests?: number;
  /** Wall-clock budget in milliseconds, per submission, from acceptance to that submission's terminal state (SPEC.md §3). */
  max_duration_ms?: number;
}

/**
 * The run's context window and compaction policy, as the run submission
 * carries them. `off` compiles to an absent threshold rather than a word
 * of its own, so that a run submitted before this existed carries the same
 * instruction it always did.
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

/** One entry of a `turns:` koan: what the caller does, and how the run is judged after it. */
export type TurnSpec =
  | { kind: 'prompt'; prompt: string; then: Judgment }
  | { kind: 'compact'; instructions?: string; retried?: boolean };

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
    /** The window the run's own conversation grows into, and when to fold it down. */
    context?: RunContext;
    /** Subagent name → what the run declares for it beyond its existence. A name absent here has no window and no threshold, and must not compact. */
    subagents?: Record<string, { context: RunContext }>;
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
        const delegation = delegationBySubagent.get(step.name)!;
        const child: Conversation = { name: step.name, parent: conv.name, turns: [], briefing: delegation.prompt };
        conversations.push(child);
        compileSteps(step.trace.steps, child, conversations);
        // A subagent block always closes a delegation from this same
        // conversation's own turns (parse.ts's pairing) — the child's
        // final reply is what returns to the parent. A child that never
        // answered leaves the final empty: its API failure is then the
        // delegation's outcome, and a child the run's abort cut off owes
        // the parent nothing at all.
        const last = child.turns.at(-1)!;
        delegation.final = last.reply ?? '';
        if (last.fails !== undefined && !last.compaction) delegation.fails = last.fails;
        openCalls = [];
        break;
      }
      case 'compaction': {
        // `openCalls` survives: folding a conversation down is not what
        // closes a call, so one still open across it stays open.
        if (step.report === 'failed') {
          conv.turns.push({ fails: step.fails, usedTokens: carried(), compaction: 'failed' });
        } else {
          // One fold, one member turn per scripted summary (koan-spec.ts's
          // header): each is its own wire request/response, all reporting
          // the same post-fold `used_tokens` — that is what the fold
          // shrank the conversation to, however many requests it took.
          step.summaries.forEach((summary, foldMember) => {
            conv.turns.push({
              reply: summary,
              usedTokens: step.used_tokens,
              compaction: 'completed',
              foldSummaries: step.summaries,
              foldMember,
            });
          });
        }
        break;
      }
      case 'tool': {
        const match = matchOpenCall(openCalls, step.tool, step.args);
        match.compiled.invokeArgs = step.args ?? match.compiled.args;
        match.compiled.tool_responds =
          'disconnect' in step.response
            ? { disconnect: true }
            : 'never' in step.response
              ? { never: true }
              : 'crash' in step.response
                ? { crash: true }
                : { status: step.response.status, body: step.response.body };
        if (step.prompt !== undefined) match.compiled.promptDuring = step.prompt;
        if (step.retry !== undefined) match.compiled.retryDuring = true;
        openCalls = openCalls.filter((c) => c !== match);
        break;
      }
      case 'internal': {
        const match = matchOpenCall(openCalls, step.tool, step.args);
        match.compiled.internal = true;
        openCalls = openCalls.filter((c) => c !== match);
        break;
      }
      case 'crash': {
        // `openCalls` survives, like a fold's: the death is the process's,
        // not the conversation's, and a call still open is still owed.
        conv.crashBefore = conv.turns.length;
        break;
      }
      default:
        assertNever(step);
    }
  }
}

// The trace's held actions in step order, each numbered into `holdIndex`
// on the member that holds it — the pairing the runner's holds go by. A
// member carries at most one action (parse.ts).
function heldActions(conv: Conversation): Array<{ turn: number; action: HeldAction }> {
  const held: Array<{ turn: number; action: HeldAction }> = [];
  for (const [i, turn] of conv.turns.entries()) {
    // A compaction turn carries no call_tools, so this is mutually
    // exclusive with the member loop below — never both on one turn.
    if (turn.compactRetried) {
      turn.holdIndex = held.length;
      held.push({ turn: i, action: { kind: 'compact' } });
    }
    for (const member of turn.call_tools ?? []) {
      const action: HeldAction | undefined =
        member.promptDuring !== undefined
          ? { kind: 'prompt', prompt: member.promptDuring }
          : member.retryDuring
            ? { kind: 'retry' }
            : member.tool_responds !== undefined && 'crash' in member.tool_responds
              ? { kind: 'crash' }
              : undefined;
      if (action !== undefined) {
        member.holdIndex = held.length;
        held.push({ turn: i, action });
      }
    }
  }
  return held;
}

// Derived rather than written: a model request after a text reply is a
// delivered prompt re-opening the run, so each such seam is one queued
// turn; a prompt with no seam of its own joined the request that closes
// its held invocation. Seams are claimed from the last prompt backwards:
// a seam can only re-open the run for the latest prompt still unanswered
// when it appears, so walking forwards would hand an earlier, joined
// prompt a seam that belongs to a later one.
function promptBoundaries(conv: Conversation): TurnBoundary[] {
  // A retry re-sends the submission the run already accepted, so unlike a
  // prompt it opens no turn of its own — only held prompts mark seams.
  const held = heldActions(conv).flatMap((h) => (h.action.kind === 'prompt' ? [{ turn: h.turn, prompt: h.action.prompt }] : []));
  if (held.length === 0) return [];
  const seams: number[] = [];
  for (let s = 1; s < conv.turns.length; s++) {
    // A compaction's summary is a reply the mock served, not the run's own
    // answer, so it never marks the seam a queued prompt re-opens.
    const before = conv.turns[s - 1];
    if (before.reply !== undefined && !before.compaction) seams.push(s);
  }
  const boundaries: TurnBoundary[] = new Array<TurnBoundary>(held.length);
  let seam = seams.length - 1;
  for (let k = held.length - 1; k >= 0; k--) {
    if (seam >= 0 && seams[seam] > held[k].turn) {
      boundaries[k] = { start: seams[seam], prompt: held[k].prompt };
      seam -= 1;
    } else {
      // parse.ts requires a model request after a mid-run prompt, so this
      // names it — except where an abort cut the prompt off, and the
      // boundary points past a trace no request of which reads it.
      boundaries[k] = { start: held[k].turn + 1, prompt: held[k].prompt, joined: true };
    }
  }
  return boundaries;
}

/** The held actions of a trace, in step order — one hold each (runner.ts). */
export function actionsDuringOf(trace: Trace): HeldAction[] {
  const actions: HeldAction[] = [];
  for (const turn of trace.conversations[0].turns) {
    if (turn.compactRetried) actions.push({ kind: 'compact' });
    for (const member of turn.call_tools ?? []) {
      if (member.promptDuring !== undefined) actions.push({ kind: 'prompt', prompt: member.promptDuring });
      else if (member.retryDuring) actions.push({ kind: 'retry' });
      else if (member.tool_responds !== undefined && 'crash' in member.tool_responds) actions.push({ kind: 'crash' });
    }
  }
  return actions;
}

function compileTrace(trace: ParsedTrace, briefing: string): Trace {
  const conversations: Conversation[] = [];
  const main: Conversation = { name: '', turns: [], briefing };
  conversations.push(main);
  compileSteps(trace.steps, main, conversations);
  if (trace.abort !== undefined) main.turns.at(-1)!.abort = trace.abort;
  if (trace.abortRetried) main.turns.at(-1)!.abortRetried = true;
  const boundaries = promptBoundaries(main);
  if (boundaries.length > 0) main.followUps = boundaries;
  return { conversations };
}

function compileJudgment(then: ParsedJudgment | undefined): Judgment {
  if (then === undefined) return {};
  return { status: then.status, output: then.output };
}

/**
 * Compiles a `turns:` koan into one Trace per conforming shape: a single
 * main conversation whose turn boundaries are recorded in `followUps`,
 * plus any subagent conversations delegated to from inside a turn. Turn
 * 1's prompt becomes the conversation's `briefing` (what `POST /runs`
 * submits); turn 2 onward each append a `followUps` boundary and their
 * own steps to the same conversation.
 *
 * Ordinarily one Trace, keyed `''`. A koan whose one `one_of` turn
 * (parse.ts's own one-per-koan rule) names N variants compiles to N,
 * keyed by variant name — the same "try each until one passes" shape
 * `variants` bodies already produce (runner.ts's `runKoan`), needed here
 * because how many requests a fold costs is an implementation's own
 * choice (SPEC.md §3), so one turn may legitimately have more than one
 * conforming shape. `turnSpecs` — the prompts and judgments the runner
 * drives turn by turn — never vary by variant: only a chosen variant's
 * wire steps do.
 */
function compileTurnsTrace(turns: [ParsedTurn, ParsedTurn, ...ParsedTurn[]]): {
  traces: Record<string, Trace>;
  turnSpecs: TurnSpec[];
} {
  const turnSpecs: TurnSpec[] = turns.map((t) =>
    t.kind === 'compact'
      ? {
          kind: 'compact',
          ...(t.instructions !== undefined ? { instructions: t.instructions } : {}),
          ...(t.retried ? { retried: true as const } : {}),
        }
      : { kind: 'prompt', prompt: t.prompt, then: compileJudgment(t.then) },
  );

  const oneOfIndex = turns.findIndex((t) => t.trace?.kind === 'one_of');
  if (oneOfIndex === -1) return { traces: { '': compileTurnsVariant(turns) }, turnSpecs };

  const variantsTurnTrace = turns[oneOfIndex].trace as Extract<ParsedTurnTrace, { kind: 'one_of' }>;
  const traces: Record<string, Trace> = {};
  for (const variant of Object.keys(variantsTurnTrace.variants)) {
    traces[variant] = compileTurnsVariant(turns, oneOfIndex, variant);
  }
  return { traces, turnSpecs };
}

// One conforming shape of a `turns:` koan's whole conversation: every
// turn's own steps in order — the one `one_of` turn's named choice where
// `turnIndex` names it, every other turn's single `when` trace otherwise.
function compileTurnsVariant(turns: [ParsedTurn, ParsedTurn, ...ParsedTurn[]], turnIndex = -1, variant?: string): Trace {
  const conversations: Conversation[] = [];
  const followUps: TurnBoundary[] = [];
  // parse.ts requires the first entry to be a prompt: a run starts from one.
  const opening = turns[0] as Extract<ParsedTurn, { kind: 'prompt' }>;
  const main: Conversation = { name: '', turns: [], briefing: opening.prompt, followUps };
  conversations.push(main);

  for (const [i, t] of turns.entries()) {
    if (t.kind === 'prompt' && i > 0) followUps.push({ start: main.turns.length, prompt: t.prompt });
    const steps = turnStepsOf(t, i === turnIndex ? variant : undefined);
    const before = main.turns.length;
    if (steps) compileSteps(steps, main, conversations);
    if (t.kind === 'compact' && t.instructions !== undefined) {
      // Every request the fold costs carries the ask, not just one member
      // of a many-request group (SPEC.md §3: the words must reach the
      // request that summarizes, and here that is every one of them).
      for (let k = before; k < main.turns.length; k++) main.turns[k].asked = t.instructions;
    }
    if (t.kind === 'compact' && t.retried) {
      // The fold's first-served request (its leader, or a failed fold's
      // only one): a fold cannot settle while it is unanswered, so
      // holding it is what proves the repeated ask lands mid-fold —
      // however many requests the fold costs.
      main.turns[before].compactRetried = true;
    }
  }

  // Numbers the fold holds into holdIndex. The only held actions a
  // `turns:` koan can carry — parse.ts forbids a mid-run prompt, a
  // creation retry, and a crash inside one — so no tool-held action can
  // interleave with these.
  heldActions(main);

  return { conversations };
}

// A turn's own steps: `when`'s single trace, or the named member of
// `one_of`'s variants this compile is walking — `pickVariant` is only
// ever set for the one turn a koan may write `one_of` on.
function turnStepsOf(t: ParsedTurn, pickVariant: string | undefined): Step[] | undefined {
  if (t.trace === undefined) return undefined;
  if (t.trace.kind === 'one') return t.trace.trace.steps;
  return t.trace.variants[pickVariant as string].steps;
}

// After compiling rather than in compileSteps, which never sees
// `given.files`. parse.ts proved `args.path` names an entry, so the
// lookup cannot miss.
function resolveInternalReads(trace: Trace, files: Record<string, string>): void {
  for (const conv of trace.conversations) {
    for (const turn of conv.turns) {
      for (const member of turn.call_tools ?? []) {
        if (member.internal === true) member.readsFile = files[member.args?.path as string];
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

function compileSubagents(subagents: Record<string, SubagentSetup> | undefined): Record<string, { context: RunContext }> | undefined {
  if (subagents === undefined) return undefined;
  const compiled: Record<string, { context: RunContext }> = {};
  for (const [name, entry] of Object.entries(subagents)) {
    // Non-undefined: koan-spec.ts's SubagentSetup requires `context`, so
    // compileContext's only undefined-producing input (`undefined` itself)
    // never reaches it here.
    compiled[name] = { context: compileContext(entry.context) as RunContext };
  }
  return compiled;
}

function compileKoan(parsed: KoanFile): Koan {
  const given = {
    tools: parsed.given.tools as Record<string, ToolDef>,
    files: parsed.given.files,
    limits: parsed.given.limits,
    context: compileContext(parsed.given.context),
    subagents: compileSubagents(parsed.given.subagents),
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
      traces = compiled.traces;
      turns = compiled.turnSpecs;
      break;
    }
    default:
      return assertNever(parsed.body);
  }

  for (const trace of Object.values(traces)) {
    resolveInternalReads(trace, given.files ?? {});
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
