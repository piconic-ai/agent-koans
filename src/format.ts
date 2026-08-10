// The koan file format's definition: the input types a koan YAML file may
// use (below) and the load-time rules a file must satisfy
// (parseKoanFile and its helpers). SPEC.md §6 is the narrative overview
// and the verification semantics only a running trace can judge
// (conversation coherence, argument fidelity, and the rest); this file is
// the exhaustive, normative shape and the constraints a loader can check
// before any agent runs. Compiling a validated file into the runner's
// internal trace form belongs to koan.ts, not here — nothing in this
// module builds a Koan, a Trace, or a ModelTurn.
//
// This is a parser, not a validator returning a verdict: parseKoanFile
// returns the typed file (its shape-discriminated parts tagged with
// `kind`) or the first problem as a message — never both, never a throw.
// koan.ts then compiles that typed value with exhaustive switches over
// `kind`, so a variant it forgets to handle is a compile error, not a
// silently-wrong koan.
//
// Every rule — whether it reads one field or several, whether it sits at
// the file's top level or three subagent blocks deep — is built on the
// same three-field context, `Ctx<T>`: the node under inspection, its
// path (for messages), and the whole file (for cross-field rules). A
// flat top-level rule is a `Check<T>`, `(ctx: Ctx<T>) => string |
// undefined`. The recursive trace walker (`parseTrace`, and the response
// parsers it calls) shares the same context and the same descent —
// `into(ctx, '[i].when', block.when)` grows `at` automatically instead
// of threading it as a separate parameter — but returns the typed node
// instead of just a message, since parsing is where the shape tagging
// happens; only the return type differs. The context stays exactly these
// three fields: nothing is precomputed into it. A rule that needs an
// aggregate (every briefing in the trace, the running model-request
// count, which subagent names are already used) derives it by walking
// the already-tagged tree in `ctx.koan` where it is used, rather than
// carrying a running tally through the recursion.
import { deepEqual } from './pending.js';

/** A koan file's top-level shape, as parsed from YAML (SPEC.md §6). */
export interface KoanFile {
  name: string;
  description?: string;
  given: GivenBlock;
  /** REQUIRED for a `when`/`one_of` koan, absent for a `turns:` koan (SPEC.md §6.5). */
  prompt?: string;
  when?: TraceStep[];
  one_of?: Record<string, TraceStep[]>;
  turns?: TurnEntry[];
  then?: ThenBlock;
}

/** Agent setup only — never the prompt (SPEC.md §6). */
export interface GivenBlock {
  tools: Record<string, { description?: string; input_schema: Record<string, unknown> }>;
  /** Relative path → content, materialized into `KOAN_WORKSPACE` before the run (SPEC.md §2). */
  files?: Record<string, string>;
  limits?: { max_model_requests: number };
}

/** One `when` trace step (SPEC.md §6.1/§6.4), tagged by shape. */
export type TraceStep =
  | { kind: 'model'; response: ModelResponse }
  | { kind: 'subagent-block'; subagent: string; prompt: string; when: TraceStep[] }
  | { kind: 'abort' };

/** The model's response to a `request: model` step (SPEC.md §6.1), tagged by shape. */
export type ModelResponse =
  | { kind: 'reply'; text: string }
  | ToolCallResponse
  | { kind: 'delegation'; subagent: string; prompt: string }
  | { kind: 'group'; members: GroupMember[] }
  | { kind: 'api-failure'; status: number; body?: unknown };

/**
 * A tool-call instruction, standalone or as one member of a parallel
 * group. `result` and `invokeArgs` are filled in once the following
 * `request: { tool }` step (if any) is parsed — the tool-result is
 * absorbed into the instruction it closes rather than kept as its own
 * trace step, since at most one can ever follow it (R4).
 */
export interface ToolCallResponse {
  kind: 'tool-call';
  tool: string;
  /** Parsed arguments; absent when `argsWire` does not parse as a JSON object. */
  args?: Record<string, unknown>;
  /** The verbatim wire string served as `function.arguments`. */
  argsWire: string;
  /** The following tool-request step's declared args (SPEC.md §6.3, a transform), when different from `args`. */
  invokeArgs?: Record<string, unknown>;
  /** This call's tool-result; absent when the call was refused (no following tool-request step, R6/R7). */
  result?: { status: number; body?: unknown };
}

/** One member of a parallel tool_calls group (SPEC.md §6.1). */
export type GroupMember = ToolCallResponse | { kind: 'delegation'; subagent: string; prompt: string };

/** One entry of a `turns:` koan (SPEC.md §6.5). */
export interface TurnEntry {
  prompt: string;
  when: TraceStep[];
  then?: ThenBlock;
}

/** A judgment on a run's (or one turn's) outcome (SPEC.md §6.2). */
export interface ThenBlock {
  status?: string;
  output?: unknown;
}

/** The node under inspection, its message path, and the whole file, for cross-field rules. */
interface Ctx<T = unknown> {
  node: T;
  at: string;
  koan: KoanFile;
}

type Check<T> = (ctx: Ctx<T>) => string | undefined;

/** Descends into a child node, growing `at`; `key` is pre-formatted (`'.when'`, `'[3]'`, `'.response'`). */
function into<U>(ctx: Ctx, key: string, node: U): Ctx<U> {
  return { ...ctx, node, at: `${ctx.at}${key}` };
}

/** Runs checks in order, stopping at the first message. */
function all<T>(...checks: Array<Check<T>>): Check<T> {
  return (ctx) => {
    for (const check of checks) {
      const message = check(ctx);
      if (message !== undefined) return message;
    }
    return undefined;
  };
}

function isMapping(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Parses a value read from YAML into a koan file, or returns the first
 * problem found as a message. Never throws.
 */
export function parseKoanFile(raw: unknown): KoanFile | string {
  if (!isMapping(raw)) return 'not a YAML mapping';

  // A tentative reading of the file: `given` collapses `null`/absent to
  // `{}` the same way `??` always has, checkGiven below still validates
  // and normalizes it. `when`/`one_of`/`turns` are unchecked casts of
  // whatever raw held — checkBody parses and replaces them with the real
  // tagged trees. Nothing reads them before it does.
  const koan: KoanFile = {
    name: raw.name as string,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    given: (raw.given ?? {}) as GivenBlock,
    prompt: raw.prompt as string | undefined,
    when: raw.when as TraceStep[] | undefined,
    one_of: raw.one_of as Record<string, TraceStep[]> | undefined,
    turns: raw.turns as TurnEntry[] | undefined,
    then: raw.then as ThenBlock | undefined,
  };

  const ctx: Ctx<KoanFile> = { node: koan, at: '', koan };
  const message = checkKoanFile(ctx);
  return message ?? koan;
}

const checkKoanFile: Check<KoanFile> = all(checkName, checkGiven, checkBodyChoice, checkPrompt, checkBody, checkThen);

function checkName(ctx: Ctx<KoanFile>): string | undefined {
  if (typeof ctx.koan.name !== 'string') return 'missing "name"';
  return undefined;
}

// `given` is agent setup only (tools/files/limits) — never the prompt
// (SPEC.md §6). Optional throughout: a koan with no tools, files, or
// limits needs no `given` block, or an empty one, at all. Normalizes
// `ctx.koan.given` in place once valid, so downstream code never sees
// the raw (possibly absent) sub-fields.
function checkGiven(ctx: Ctx<KoanFile>): string | undefined {
  const given = ctx.koan.given as unknown;
  if (typeof given !== 'object' || Array.isArray(given)) return '"given" must be a mapping';
  const g = given as Record<string, unknown>;
  if (g.task !== undefined) return '"given.task" was replaced by a top-level "prompt" field';

  const tools = (g.tools ?? {}) as unknown;
  if (typeof tools !== 'object' || Array.isArray(tools)) {
    return '"given.tools" must be a mapping of tool name to definition';
  }

  let files: Record<string, string> | undefined;
  if (g.files !== undefined) {
    const rawFiles = g.files;
    if (typeof rawFiles !== 'object' || rawFiles === null || Array.isArray(rawFiles)) {
      return '"given.files" must be a mapping of relative path to file content';
    }
    for (const [p, content] of Object.entries(rawFiles as Record<string, unknown>)) {
      if (typeof content !== 'string') return `given.files["${p}"] must be a string (the file's content)`;
      if (p.length === 0 || p.startsWith('/') || p.split('/').includes('..')) {
        return `given.files["${p}"] must be a relative path inside the workspace (no leading "/", no "..")`;
      }
    }
    files = rawFiles as Record<string, string>;
  }

  let limits: { max_model_requests: number } | undefined;
  if (g.limits !== undefined) {
    const rawLimits = g.limits;
    if (typeof rawLimits !== 'object' || rawLimits === null || Array.isArray(rawLimits)) {
      return '"given.limits" must be a mapping';
    }
    for (const key of Object.keys(rawLimits as Record<string, unknown>)) {
      if (key !== 'max_model_requests') return `"given.limits" has unknown key "${key}"`;
    }
    const max = (rawLimits as Record<string, unknown>).max_model_requests;
    if (!Number.isInteger(max) || (max as number) < 1) {
      return '"given.limits.max_model_requests" must be a positive integer';
    }
    limits = { max_model_requests: max as number };
  }

  ctx.koan.given = {
    tools: tools as Record<string, { description?: string; input_schema: Record<string, unknown> }>,
    files,
    limits,
  };
  return undefined;
}

// A `turns:` koan replaces the top-level `prompt` and `when`/`one_of`
// (SPEC.md §6.5): its first turn's prompt is the initial one, and each
// turn carries its own `then`, so a top-level one would be a second,
// conflicting judgment. Exactly one of `when` / `one_of` / `turns`
// otherwise.
function checkBodyChoice(ctx: Ctx<KoanFile>): string | undefined {
  const koan = ctx.koan;
  if (koan.turns !== undefined) {
    if (koan.prompt !== undefined) {
      return '"prompt" cannot be combined with "turns" — the first turn\'s prompt is the initial one';
    }
    if (koan.when !== undefined || koan.one_of !== undefined) {
      return '"turns" cannot be combined with "when" or "one_of"';
    }
    if (koan.then !== undefined) {
      return '"then" cannot be combined with "turns" — write it on the last turn instead';
    }
    return undefined;
  }
  if ((koan.when === undefined) === (koan.one_of === undefined)) {
    return 'a koan needs exactly one of "when" / "one_of" / "turns"';
  }
  return undefined;
}

// Only a `when`/`one_of` koan carries a top-level prompt; a `turns:`
// koan's per-turn prompts are checked in checkBody's turns path instead.
function checkPrompt(ctx: Ctx<KoanFile>): string | undefined {
  if (ctx.koan.turns !== undefined) return undefined;
  if (typeof ctx.koan.prompt !== 'string') return 'missing "prompt"';
  // Routing attributes a request to a conversation by which opening its
  // first user message contains (SPEC.md §6.4); an empty (or all-
  // whitespace) opening is contained in every string, so it would match
  // every request and collapse routing onto the first conversation.
  if (ctx.koan.prompt.trim().length === 0) return '"prompt" must be non-empty';
  return undefined;
}

function checkThenBlock(ctx: Ctx<unknown>): string | undefined {
  if (ctx.node === undefined) return undefined;
  if (typeof ctx.node !== 'object' || ctx.node === null || Array.isArray(ctx.node)) return `${ctx.at} must be a mapping`;
  const j = ctx.node as Record<string, unknown>;
  for (const key of Object.keys(j)) {
    if (key !== 'status' && key !== 'output') {
      return `${ctx.at} has unknown key "${key}" — a judgment carries only "status" and "output"`;
    }
  }
  if (j.status !== undefined && typeof j.status !== 'string') return `${ctx.at}.status must be a string`;
  return undefined;
}

function checkThen(ctx: Ctx<KoanFile>): string | undefined {
  return checkThenBlock(into(ctx, 'then', ctx.koan.then));
}

function checkBody(ctx: Ctx<KoanFile>): string | undefined {
  const koan = ctx.koan;
  if (koan.turns !== undefined) return checkAndParseTurns(ctx);

  const maxRequests = koan.given.limits?.max_model_requests;
  const prompt = koan.prompt as string;

  if (koan.when !== undefined) {
    const rawWhen = koan.when as unknown;
    if (!Array.isArray(rawWhen) || rawWhen.length === 0) return '"when" must be a non-empty list of trace steps';
    const steps = parseTrace(into(ctx, 'when', rawWhen), '', false);
    if (typeof steps === 'string') return steps;
    koan.when = steps;
    return (
      checkSubagentNamesUnique(steps, 'when') ??
      checkOpeningsDistinct(steps, 'when', 'prompt', prompt) ??
      checkBudget(steps, 'when', maxRequests)
    );
  }

  const rawOneOf = koan.one_of as unknown;
  if (typeof rawOneOf !== 'object' || rawOneOf === null || Array.isArray(rawOneOf)) {
    return '"one_of" must be a mapping of variant name to trace';
  }
  const entries = Object.entries(rawOneOf as Record<string, unknown>);
  if (entries.length < 2) return '"one_of" needs at least two variants — use "when" for a single trace';

  // Two passes, like a single variant's own structure-then-cross-checks
  // order: every variant must parse structurally before any variant's
  // openings or budget are judged, so a structural error in a later
  // variant is reported even when an earlier one only has a budget issue.
  const parsed: Record<string, TraceStep[]> = {};
  for (const [variant, trace] of entries) {
    if (!Array.isArray(trace) || trace.length === 0) return `"one_of.${variant}" must be a non-empty list of trace steps`;
    const steps = parseTrace(into(ctx, `one_of.${variant}`, trace), '', false);
    if (typeof steps === 'string') return steps;
    parsed[variant] = steps;
  }
  koan.one_of = parsed;
  for (const [variant, steps] of Object.entries(parsed)) {
    const at = `one_of.${variant}`;
    const err = checkSubagentNamesUnique(steps, at) ?? checkOpeningsDistinct(steps, at, 'prompt', prompt) ?? checkBudget(steps, at, maxRequests);
    if (err) return err;
  }
  return undefined;
}

function checkAndParseTurns(ctx: Ctx<KoanFile>): string | undefined {
  const koan = ctx.koan;
  const rawTurns = koan.turns as unknown;
  if (!Array.isArray(rawTurns) || rawTurns.length === 0) return '"turns" must be a non-empty list of turn entries';
  if (rawTurns.length < 2) return '"turns" needs at least two entries — a 1-turn koan is just "when"';

  const parsedTurns: TurnEntry[] = [];
  for (let i = 0; i < rawTurns.length; i++) {
    const rt = (rawTurns[i] ?? {}) as Record<string, unknown>;
    // Trim-empty counts as empty: turn 1's prompt routes the run (SPEC.md
    // §6.4) the same way a plain koan's does, and a later turn's is what
    // a turn-boundary request must be shown to carry (§6.5) — an
    // all-whitespace one would make that check vacuous.
    if (typeof rt.prompt !== 'string' || rt.prompt.trim().length === 0) {
      return `turns[${i}] needs a non-empty "prompt"`;
    }
    for (const key of Object.keys(rt)) {
      if (key !== 'prompt' && key !== 'when' && key !== 'then') {
        return `turns[${i}] has unknown key "${key}" — a turn entry carries only "prompt", "when", and "then"`;
      }
    }
    const thenErr = checkThenBlock(into(ctx, `turns[${i}].then`, rt.then));
    if (thenErr) return thenErr;
    parsedTurns.push({ prompt: rt.prompt, when: [], then: rt.then as ThenBlock | undefined });
  }

  // One continuous conversation: every turn's `when` extends the same
  // main conversation (SPEC.md §6.5), so `steps` accumulates across
  // calls instead of resetting per turn — the same way a subagent name
  // used in turn 1 stays unavailable in turn 4.
  let steps: TraceStep[] = [];
  for (let i = 0; i < rawTurns.length; i++) {
    const rawWhen = (rawTurns[i] as Record<string, unknown>).when;
    if (!Array.isArray(rawWhen) || rawWhen.length === 0) return `turns[${i}].when must be a non-empty list of trace steps`;
    const result = parseTrace(into(ctx, `turns[${i}].when`, rawWhen), '', true, steps);
    if (typeof result === 'string') return result;
    parsedTurns[i].when = result.slice(steps.length);
    steps = result;
    if (i < rawTurns.length - 1) {
      const last = steps.at(-1);
      if (!last || last.kind !== 'model' || last.response.kind !== 'reply') {
        return `turns[${i}].when must end with a plain text reply — an intermediate turn can only be judged "completed" by ending in one (SPEC.md §6.5)`;
      }
    }
  }
  koan.turns = parsedTurns;

  const maxRequests = koan.given.limits?.max_model_requests;
  return (
    checkSubagentNamesUnique(steps, 'turns') ??
    checkOpeningsDistinct(steps, 'turns', 'turns[0].prompt', parsedTurns[0].prompt) ??
    checkBudget(steps, 'turns', maxRequests)
  );
}

type DelegationLike = { kind: 'delegation'; subagent: string; prompt: string };

function unresolvedMessage(at: string, unresolved: DelegationLike[]): string {
  return `${at}: delegation to "${unresolved[0].subagent}" has no following "subagent" block — every delegation's conversation must be scripted`;
}

function pendingToolCalls(response: ModelResponse): ToolCallResponse[] | undefined {
  if (response.kind === 'tool-call') return [response];
  if (response.kind === 'group') return response.members.filter((m): m is ToolCallResponse => m.kind === 'tool-call');
  return undefined;
}

function pendingDelegations(response: ModelResponse): DelegationLike[] {
  if (response.kind === 'delegation') return [response];
  if (response.kind === 'group') return response.members.filter((m): m is DelegationLike => m.kind === 'delegation');
  return [];
}

/**
 * Parses+checks one `when` (or `one_of` variant, or `turns[i].when`)
 * trace, recursing into subagent blocks with the same context shape
 * (`parseTrace(into(ctx, ...))`) so message paths stay exact —
 * `one_of.coerce[3].response`, `turns[1].when[0][2]`. Returns the tagged
 * steps on success. `priorSteps` is this same conversation's earlier
 * turns, for a `turns:` koan (SPEC.md §6.5) — empty for a fresh
 * conversation (the main one of a `when`/`one_of` koan, or any subagent
 * block, which always starts a brand new conversation, §6.4).
 */
function parseTrace(
  ctx: Ctx<unknown>,
  convName: string,
  turnBoundary: boolean,
  priorSteps: TraceStep[] = [],
): TraceStep[] | string {
  const raw = ctx.node;
  if (!Array.isArray(raw)) return `${ctx.at} must be a non-empty list of trace steps`;

  const steps: TraceStep[] = [...priorSteps];
  const callStart = steps.length;
  let unresolved: DelegationLike[] = [];

  for (let i = 0; i < raw.length; i++) {
    const at_i = `${ctx.at}[${i}]`;
    const prev = steps.at(-1);
    if (prev?.kind === 'model' && prev.response.kind === 'api-failure') {
      return `${at_i}: nothing can follow a model API failure — the agent must stop (R8)`;
    }
    if (prev?.kind === 'abort') return `${at_i}: nothing can follow "abort" — it must be the trace's last step`;

    const item: unknown = raw[i];

    if (item === 'abort') {
      if (unresolved.length > 0) return unresolvedMessage(at_i, unresolved);
      if (turnBoundary) {
        return `${at_i}: "abort" cannot appear inside a "turns" koan — turn-level cancellation is not supported yet`;
      }
      if (convName !== '') {
        return `${at_i}: "abort" cannot appear inside a subagent block — only the caller's own run can be aborted`;
      }
      if (!prev) return `${at_i}: "abort" needs at least one exchange before it in the trace`;
      steps.push({ kind: 'abort' });
      continue;
    }

    if (typeof item === 'object' && item !== null && 'subagent' in item && !('request' in item)) {
      const block = item as Record<string, unknown>;
      for (const key of Object.keys(block)) {
        if (key !== 'subagent' && key !== 'when') {
          return `${at_i} has unknown key "${key}" — a subagent block carries only "subagent" and "when"`;
        }
      }
      if (typeof block.subagent !== 'string' || block.subagent.length === 0) {
        return `${at_i}.subagent must be a non-empty delegate name`;
      }
      const di = unresolved.findIndex((d) => d.subagent === block.subagent);
      if (di === -1) {
        return `${at_i}: subagent block "${block.subagent}" has no matching pending delegation — the preceding model response must include { subagent: "${block.subagent}", prompt: ... }`;
      }
      const [delegation] = unresolved.splice(di, 1);
      const childSteps = parseTrace(into(ctx, `[${i}].when`, block.when), delegation.subagent, false);
      if (typeof childSteps === 'string') return childSteps;
      const childLast = childSteps.at(-1);
      if (!childLast || childLast.kind !== 'model' || childLast.response.kind !== 'reply') {
        return `${at_i}: a subagent block must end with the child's final text reply — it is what returns to the parent`;
      }
      steps.push({ kind: 'subagent-block', subagent: delegation.subagent, prompt: delegation.prompt, when: childSteps });
      continue;
    }

    const entry = item as { request?: unknown; response?: unknown } | null;
    const req = entry?.request;
    const res = entry?.response;
    if (req === undefined || req === null) return `${at_i} needs "request"`;
    if (res === undefined || res === null) return `${at_i} needs "response"`;

    if (req === 'model') {
      if (unresolved.length > 0) return unresolvedMessage(at_i, unresolved);
      // A reply ends this conversation's trace — nothing legitimately
      // follows it within the same `when`, except right here, at the one
      // seam a `turns:` koan opens: this call's first entry, continuing
      // the same conversation a fresh user message just reopened
      // (SPEC.md §6.5).
      const opensTurn = turnBoundary && steps.length === callStart;
      if (prev && !opensTurn && prev.kind === 'model' && prev.response.kind === 'reply') {
        return `${at_i}: a model request cannot follow a text reply here — only a later turn's first request may (SPEC.md §6.5)`;
      }

      const response = parseModelResponse(into(ctx, `[${i}]`, res), convName);
      if (typeof response === 'string') return response;
      steps.push({ kind: 'model', response });
      unresolved = pendingDelegations(response);
    } else if (typeof req === 'object' && req !== null && typeof (req as Record<string, unknown>).tool === 'string') {
      const reqTool = (req as Record<string, unknown>).tool as string;
      const reqArgs = (req as Record<string, unknown>).args as Record<string, unknown> | undefined;
      if (typeof res === 'string' || Array.isArray(res) || typeof (res as Record<string, unknown>).status !== 'number') {
        return `${at_i}.response needs a numeric "status" for a tool request`;
      }
      const r = res as { status: number; body?: unknown };
      const prevStep = steps.at(-1);
      const pending = prevStep?.kind === 'model' ? pendingToolCalls(prevStep.response) : undefined;
      if (!pending) return `${at_i}: a tool request must follow a model response containing a tool-call instruction`;

      const open = pending.filter((m) => m.tool === reqTool && m.result === undefined);
      let member: ToolCallResponse;
      if (open.length === 1) {
        member = open[0];
      } else if (open.length === 0) {
        const named = pending.some((m) => m.tool === reqTool);
        return named
          ? `${at_i}: the preceding tool-call instruction for "${reqTool}" already has a tool request`
          : `${at_i}.request.tool is "${reqTool}" but the preceding model response requests ${pending.map((m) => `"${m.tool}"`).join(', ')}`;
      } else {
        // The tool name repeats within the group: args disambiguate which
        // instruction this step closes, since matching is unordered
        // (SPEC.md §6.1). Duplicate name+args instructions were already
        // rejected when the group was parsed, so at most one candidate
        // can match.
        if (reqArgs === undefined) {
          return `${at_i}: "${reqTool}" appears more than once in the preceding group — write "args" to say which call this closes`;
        }
        const exact = open.filter((m) => m.args !== undefined && deepEqual(m.args, reqArgs));
        if (exact.length !== 1) {
          return `${at_i}: "args" does not match exactly one of the pending "${reqTool}" calls in the group`;
        }
        member = exact[0];
      }

      if (member.args === undefined) {
        return `${at_i}: "${reqTool}"'s arguments do not parse as a JSON object — argument fidelity is undefined, so the agent must refuse the call instead (R6); no tool request can follow it`;
      }
      // No mismatch check against the instruction's args: explicit args
      // are a declared transform (SPEC.md §6.3), not a koan bug.
      member.invokeArgs = reqArgs ?? member.args;
      member.result = { status: r.status, body: r.body };
      // No new step is pushed: the tool-result is absorbed into the
      // instruction it closes (at most one invocation per call, R4).
    } else {
      return `${at_i}.request must be "model" or { tool: <name> }`;
    }
  }

  if (unresolved.length > 0) return unresolvedMessage(`${ctx.at}[${raw.length}]`, unresolved);
  if (steps.length === callStart) return `"${ctx.at}" compiled to an empty timeline`;
  return steps;
}

/** Parses+checks one model response — the shape that discriminates every rule below. `ctx.at` is the step's own path (e.g. `when[2]`); `.response`/member indices are appended as each branch needs. */
function parseModelResponse(ctx: Ctx<unknown>, convName: string): ModelResponse | string {
  const res = ctx.node;
  if (typeof res === 'string') return { kind: 'reply', text: res };

  if (Array.isArray(res)) {
    // A parallel group: one assistant message, multiple tool_calls. A
    // 1-element list is really the single form; writing it as a list
    // would silently work but invite an inconsistent style.
    if (res.length < 2) {
      return `${ctx.at}.response is a list of ${res.length} — a parallel group needs at least two instructions; write the single "{ tool, args }" form instead`;
    }
    const members: GroupMember[] = [];
    for (let j = 0; j < res.length; j++) {
      const r = res[j];
      const memberCtx = into(ctx, `[${j}]`, r);
      if (typeof r === 'object' && r !== null && 'subagent' in r) {
        const d = parseDelegation(memberCtx);
        if (typeof d === 'string') return d;
        members.push(d);
      } else {
        const t = parseToolCall(memberCtx);
        if (typeof t === 'string') return t;
        members.push(t);
      }
    }
    const calls = members.filter((m): m is ToolCallResponse => m.kind === 'tool-call');
    for (let a = 0; a < calls.length; a++) {
      for (let b = a + 1; b < calls.length; b++) {
        if (sameInstruction(calls[a], calls[b])) {
          return `${ctx.at}: list members [${a}] and [${b}] both call "${calls[a].tool}" with the same arguments — matching a following tool request against them would be ambiguous`;
        }
      }
    }
    const delegations = members.filter((m): m is DelegationLike => m.kind === 'delegation');
    for (let a = 0; a < delegations.length; a++) {
      for (let b = a + 1; b < delegations.length; b++) {
        if (delegations[a].subagent === delegations[b].subagent) {
          return `${ctx.at}: two delegations to "${delegations[a].subagent}" in one turn — a subagent name may be delegated to at most once per trace`;
        }
      }
    }
    return { kind: 'group', members };
  }

  if (isMapping(res) && typeof res.subagent === 'string') {
    if (res.status !== undefined || res.tool !== undefined) {
      return `${ctx.at}.response mixes a delegation instruction with other response forms`;
    }
    return parseDelegation(ctx);
  }
  if (isMapping(res) && typeof res.tool === 'string') {
    if (res.status !== undefined) {
      return `${ctx.at}.response mixes a tool-call instruction with "status"`;
    }
    return parseToolCall(ctx);
  }
  if (isMapping(res) && typeof res.status === 'number') {
    if (convName !== '') {
      return `${ctx.at}: a model API failure cannot appear inside a subagent block — it ends the whole run (R8)`;
    }
    // Only statuses the SDKs surface without retrying keep the trace
    // deterministic: 408/429/5xx are auto-retried by common clients.
    if (res.status < 400 || res.status >= 500 || res.status === 408 || res.status === 429) {
      return `${ctx.at}.response.status must be a non-retryable 4xx (not 408/429) for a model API failure`;
    }
    return { kind: 'api-failure', status: res.status, body: res.body };
  }
  return `${ctx.at}.response for a model request must be a reply string, { tool, args }, { subagent, prompt }, a list of instructions, or { status }`;
}

/**
 * Parses+checks one `{ tool, args }` instruction — the single response
 * form, or one member of a parallel group. `args` is a mapping
 * (JSON-encoding sugar) or the verbatim wire string, which may or may
 * not parse as a JSON object (malformed-arguments koans deliberately
 * write one that does not).
 */
function parseToolCall(ctx: Ctx<unknown>): ToolCallResponse | string {
  const raw = ctx.node;
  if (!isMapping(raw) || typeof raw.tool !== 'string') return `${ctx.at} needs "tool"`;
  // Checked here rather than only where the single form is parsed, so a
  // stray key inside a parallel group's list is a load error too.
  for (const key of Object.keys(raw)) {
    if (key !== 'tool' && key !== 'args') {
      return `${ctx.at} has unknown key "${key}" — a tool-call instruction carries only "tool" and "args"`;
    }
  }
  const parsed = parseArgs(ctx.at, raw.args);
  if (typeof parsed === 'string') return parsed;
  return { kind: 'tool-call', tool: raw.tool, args: parsed.args, argsWire: parsed.argsWire };
}

function parseArgs(at: string, raw: unknown): string | { argsWire: string; args?: Record<string, unknown> } {
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
    return { argsWire: JSON.stringify(raw), args: raw as Record<string, unknown> };
  }
  return `${at}.args must be a mapping (JSON-encoding sugar) or a string (the verbatim wire arguments)`;
}

function parseDelegation(ctx: Ctx<unknown>): DelegationLike | string {
  const raw = ctx.node;
  if (!isMapping(raw) || typeof raw.subagent !== 'string' || raw.subagent.length === 0) {
    return `${ctx.at} needs a non-empty "subagent" (the delegate's name)`;
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'subagent' && key !== 'prompt') {
      return `${ctx.at} has unknown key "${key}" — a delegation instruction carries only "subagent" and "prompt"`;
    }
  }
  // Trim-empty counts as empty: routing matches by `.includes`, and an
  // all-whitespace briefing risks the same routing collapse an empty one
  // guarantees (SPEC.md §6.4).
  if (typeof raw.prompt !== 'string' || raw.prompt.trim().length === 0) {
    return `${ctx.at} needs a non-empty "prompt" (the briefing)`;
  }
  return { kind: 'delegation', subagent: raw.subagent, prompt: raw.prompt };
}

// Two instructions are the same call only when their parsed args are
// deep-equal; two malformed instructions (no parsed args) are compared by
// their raw wire string instead, since deep equality has nothing to work
// with. A malformed instruction is never mistaken for a parseable one.
function sameInstruction(a: ToolCallResponse, b: ToolCallResponse): boolean {
  if (a.tool !== b.tool) return false;
  if (a.args !== undefined && b.args !== undefined) return deepEqual(a.args, b.args);
  return a.args === undefined && b.args === undefined && a.argsWire === b.argsWire;
}

// Below: cross-cutting rules over an already-parsed, already-tagged
// trace, derived by walking it fresh rather than threaded through the
// recursive parse above — see the file header for why.

// A subagent name may be delegated to at most once per trace: there is
// no such thing yet as a second delegation resuming an existing
// conversation (SPEC.md §6.4). Depth-first, in trace order, matching the
// order parseTrace itself encounters subagent blocks.
function checkSubagentNamesUnique(steps: TraceStep[], at: string, seen: Set<string> = new Set()): string | undefined {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.kind !== 'subagent-block') continue;
    const at_i = `${at}[${i}]`;
    if (seen.has(step.subagent)) {
      return `${at_i}: subagent "${step.subagent}" already has a conversation in this trace — a subagent conversation cannot be continued yet`;
    }
    seen.add(step.subagent);
    const err = checkSubagentNamesUnique(step.when, `${at_i}.when`, seen);
    if (err) return err;
  }
  return undefined;
}

function collectBriefings(steps: TraceStep[], out: Array<{ label: string; text: string }>): void {
  for (const step of steps) {
    if (step.kind !== 'subagent-block') continue;
    out.push({ label: `the briefing of subagent "${step.subagent}"`, text: step.prompt });
    collectBriefings(step.when, out);
  }
}

// Openings must be mutually non-containing, not merely distinct: the mock
// attributes each incoming request to a conversation by which opening its
// first user message contains (SPEC.md §6.4), and `contains` — chosen to
// tolerate a framework lightly wrapping the briefing — can only route
// unambiguously when no opening is a substring of another.
function checkOpeningsDistinct(steps: TraceStep[], at: string, openingLabel: string, mainText: string): string | undefined {
  const openings: Array<{ label: string; text: string }> = [{ label: openingLabel, text: mainText }];
  collectBriefings(steps, openings);
  for (let a = 0; a < openings.length; a++) {
    for (let b = a + 1; b < openings.length; b++) {
      if (openings[a].text.includes(openings[b].text) || openings[b].text.includes(openings[a].text)) {
        return `${at}: ${openings[a].label} and ${openings[b].label} are not distinct — no briefing may equal or contain another briefing or the prompt, since requests are attributed to conversations by their opening`;
      }
    }
  }
  return undefined;
}

function countModelRequests(steps: TraceStep[]): number {
  let n = 0;
  for (const step of steps) {
    if (step.kind === 'model') n++;
    else if (step.kind === 'subagent-block') n += countModelRequests(step.when);
  }
  return n;
}

// Subagent conversations count too: R5 counts HTTP requests at the model
// endpoint, and a delegate's requests arrive there as well.
function checkBudget(steps: TraceStep[], at: string, maxRequests: number | undefined): string | undefined {
  if (maxRequests === undefined) return undefined;
  const total = countModelRequests(steps);
  if (total > maxRequests) {
    return `${at} scripts ${total} model requests, more than given.limits.max_model_requests (${maxRequests}) permits`;
  }
  return undefined;
}
