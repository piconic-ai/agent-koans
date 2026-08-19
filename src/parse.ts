// Reading a koan file: a YAML value → the types of koan-spec.ts, or the
// first problem as a message. Two jobs live here and stay apart.
//
// Failure is a tagged value (`Problem`, `{ kind: 'problem', message }`),
// not a bare string: several parsers below succeed with a string (a
// model's text reply, a tool call's wire-format args), and `typeof x ===
// 'string'` cannot tell that success apart from every other parser's
// failure. Tagging the failure instead means `isProblem` is the one check
// every call site needs, and a future parser whose success value is
// itself a string stays unambiguous by construction rather than by
// convention.
//
// `parse*` functions recognize shapes and tag them — the rules a single
// node's own subtree can decide, including a node's immediate neighbors
// within the SAME list (`abort` must be last, a model request cannot
// follow a text reply, a parallel group needs at least two members, a
// one-element list is a style error, the non-retryable-4xx range). They
// take the spike's `Ctx<T> = { node, at, koan }` and descend with `into`,
// which grows `at` automatically instead of threading a path parameter.
// The ADT makes a violation unrepresentable in the RETURNED value — it
// does not remove the parser's duty to reject it in the RAW one, since a
// YAML file arrives untyped.
//
// A tool-call instruction and the request/response pair that later closes
// it are two different steps here (`call` inside a `model` step's
// instructions, `tool` as its own step) rather than one mutated node, the
// way koan-spec.ts's header explains. That is what makes "which pending
// call does this tool step close" a question no single node's parse can
// answer by itself — matching a `tool` step against the group of calls
// still open from the model step before it needs the whole trace walked
// in order, tracking what closed and what did not. The same is true of
// matching a `subagent` step against the delegation it answers, and of
// "did anything come after the model's API failure" once `tool` steps are
// their own entries and a failure is no longer the trace's forced last
// write. Those, plus rules that were always whole-trace (openings
// distinct across every briefing, a subagent name delegated to once, the
// request budget), live in `constraints`: pure functions over the already
// -parsed `KoanFile`, each named for the rule it checks. The list reads as
// the format's rule set.
import { deepEqual } from './pending.js';
import type {
  AbortKind,
  Args,
  Body,
  Compaction,
  ContextSetup,
  Given,
  Instruction,
  Judgment,
  KoanFile,
  Matcher,
  ModelResponse,
  ParsedArgs,
  Step,
  SubagentSetup,
  ToolDef,
  Trace,
  Turn,
  TurnTrace,
} from './koan-spec.js';

interface Ctx<T = unknown> {
  node: T;
  at: string;
  koan: KoanFile;
}

/** A problem found while reading a file — the message its author will see. */
export type Problem = { kind: 'problem'; message: string };

/** Either a parsed value, or the first problem found. */
export type Parsed<T> = T | Problem;

const problem = (message: string): Problem => ({ kind: 'problem', message });

/** Narrows a `Parsed<T>` to its failure case. */
export const isProblem = (x: unknown): x is Problem =>
  typeof x === 'object' && x !== null && (x as { kind?: unknown }).kind === 'problem';

function into<U>(ctx: Ctx, key: string, node: U): Ctx<U> {
  return { ...ctx, node, at: `${ctx.at}${key}` };
}

function isMapping(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

// ---------------------------------------------------------------------------
// Parsing: a YAML value becomes a tagged shape, or says what it should be.
// ---------------------------------------------------------------------------

/**
 * Reads a value already parsed from YAML into a koan file, or returns the
 * first problem found. Never throws.
 */
export function parseKoanFile(raw: unknown): Parsed<KoanFile> {
  if (!isMapping(raw)) return problem('not a YAML mapping');
  if (typeof raw.name !== 'string') return problem('missing "name"');

  const given = parseGiven(raw.given);
  if (isProblem(given)) return given;

  const koan: KoanFile = {
    name: raw.name,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    given,
    body: undefined as unknown as Body,
  };
  const ctx: Ctx<KoanFile> = { node: koan, at: '', koan };

  const body = parseBody(ctx, raw);
  if (isProblem(body)) return body;
  koan.body = body;

  for (const constraint of constraints) {
    const found = constraint(koan);
    if (found !== undefined) return found;
  }
  return koan;
}

// `given` is agent setup only (tools/files/limits) — never the prompt.
// Optional throughout: a koan with no tools, files, or limits needs no
// `given` block, or an empty one, at all.
function parseGiven(rawGiven: unknown): Parsed<Given> {
  const given = rawGiven ?? {};
  if (typeof given !== 'object' || Array.isArray(given)) return problem('"given" must be a mapping');
  const g = given as Record<string, unknown>;
  if (g.task !== undefined) return problem('"given.task" was replaced by a top-level "prompt" field');

  const tools = g.tools ?? {};
  if (typeof tools !== 'object' || Array.isArray(tools)) {
    return problem('"given.tools" must be a mapping of tool name to definition');
  }
  for (const [name, def] of Object.entries(tools as Record<string, unknown>)) {
    if (typeof def !== 'object' || def === null) continue;
    const t = (def as Record<string, unknown>).timeout_ms;
    if (t !== undefined && (typeof t !== 'number' || !Number.isInteger(t) || t <= 0)) {
      return problem(`given.tools["${name}"].timeout_ms must be a positive integer of milliseconds`);
    }
  }

  let files: Record<string, string> | undefined;
  if (g.files !== undefined) {
    const rawFiles = g.files;
    if (typeof rawFiles !== 'object' || rawFiles === null || Array.isArray(rawFiles)) {
      return problem('"given.files" must be a mapping of relative path to file content');
    }
    for (const [p, content] of Object.entries(rawFiles as Record<string, unknown>)) {
      if (typeof content !== 'string') return problem(`given.files["${p}"] must be a string (the file's content)`);
      if (p.length === 0 || p.startsWith('/') || p.split('/').includes('..')) {
        return problem(`given.files["${p}"] must be a relative path inside the workspace (no leading "/", no "..")`);
      }
    }
    files = rawFiles as Record<string, string>;
  }

  let limits: { max_model_requests?: number; max_duration_ms?: number } | undefined;
  if (g.limits !== undefined) {
    const rawLimits = g.limits;
    if (typeof rawLimits !== 'object' || rawLimits === null || Array.isArray(rawLimits)) {
      return problem('"given.limits" must be a mapping');
    }
    const rl = rawLimits as Record<string, unknown>;
    for (const key of Object.keys(rl)) {
      if (key !== 'max_model_requests' && key !== 'max_duration_ms') {
        return problem(`"given.limits" has unknown key "${key}" (allowed: max_model_requests, max_duration_ms)`);
      }
    }
    // Each key optional on its own, but a block with neither would budget
    // nothing at all — that koan should not have written `limits:` to
    // begin with.
    if (Object.keys(rl).length === 0) return problem('"given.limits" declares no budget');
    let max_model_requests: number | undefined;
    if (rl.max_model_requests !== undefined) {
      if (!Number.isInteger(rl.max_model_requests) || (rl.max_model_requests as number) < 1) {
        return problem('"given.limits.max_model_requests" must be a positive integer');
      }
      max_model_requests = rl.max_model_requests as number;
    }
    let max_duration_ms: number | undefined;
    if (rl.max_duration_ms !== undefined) {
      if (!Number.isInteger(rl.max_duration_ms) || (rl.max_duration_ms as number) < 1) {
        return problem('"given.limits.max_duration_ms" must be a positive integer');
      }
      max_duration_ms = rl.max_duration_ms as number;
    }
    limits = {
      ...(max_model_requests !== undefined ? { max_model_requests } : {}),
      ...(max_duration_ms !== undefined ? { max_duration_ms } : {}),
    };
  }

  const context = parseContext(g.context);
  if (isProblem(context)) return context;

  const subagents = parseSubagents(g.subagents);
  if (isProblem(subagents)) return subagents;

  return { tools: tools as Record<string, ToolDef>, files, limits, context, subagents };
}

// Both keys are required once the block is written: a window with no
// policy leaves the implementation to decide the one thing this block
// exists to decide, and a policy with no window is a share of nothing.
// `label` lets a subagent's own declaration (below) report the same rules
// under its own path instead of every message hard-coding "given.context" —
// the smaller edit next to wrapping every one of parseContext's returns.
function parseContext(raw: unknown, label = 'given.context'): Parsed<ContextSetup | undefined> {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return problem(`"${label}" must be a mapping (keys: window, compaction)`);
  }
  const c = raw as Record<string, unknown>;
  for (const key of Object.keys(c)) {
    if (key !== 'window' && key !== 'compaction') {
      return problem(`"${label}" has unknown key "${key}" (allowed: window, compaction)`);
    }
  }
  if (!Number.isInteger(c.window) || (c.window as number) < 1) {
    return problem(`"${label}.window" must be a positive integer (the window in tokens)`);
  }
  const compaction = parseCompactionPolicy(c.compaction, label);
  if (isProblem(compaction)) return compaction;
  return { window: c.window as number, compaction };
}

function parseCompactionPolicy(raw: unknown, label = 'given.context'): Parsed<Compaction> {
  if (raw === 'off') return { kind: 'off' };
  const match = typeof raw === 'string' ? /^(\d{1,3})%$/.exec(raw) : null;
  const percent = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
    return problem(`"${label}.compaction" must be "off" or a percentage of the window, like "90%"`);
  }
  return { kind: 'threshold', percent };
}

// A mapping keyed by name, not a list like the wire's `given.subagents`
// (openapi.yaml): an entry augments an already-named delegate, so writing
// it by name makes a duplicate or a typo a YAML-level clash instead of a
// silent pairing-by-position against the trace.
function parseSubagents(raw: unknown): Parsed<Record<string, SubagentSetup> | undefined> {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return problem('"given.subagents" must be a mapping of subagent name to declaration');
  }
  const built: Record<string, SubagentSetup> = {};
  for (const [name, rawEntry] of Object.entries(raw as Record<string, unknown>)) {
    if (name.trim().length === 0) {
      return problem('"given.subagents" has an empty name — a declaration must name the subagent it provisions');
    }
    if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) {
      return problem(`given.subagents["${name}"] must be a mapping (keys: context)`);
    }
    const e = rawEntry as Record<string, unknown>;
    for (const key of Object.keys(e)) {
      if (key !== 'context') {
        return problem(`given.subagents["${name}"] has unknown key "${key}" (allowed: context)`);
      }
    }
    const context = parseContext(e.context, `given.subagents["${name}"].context`);
    if (isProblem(context)) return context;
    built[name] = { context };
  }
  return built;
}

// A `turns:` koan replaces the top-level `prompt` and `when`/`one_of`;
// a `when`/`one_of` koan carries a top-level `prompt` and
// exactly one of the two trace forms. Dispatches on which raw keys are
// present, then hands off to the matching parser.
function parseBody(ctx: Ctx<KoanFile>, raw: Record<string, unknown>): Parsed<Body> {
  if (raw.turns !== undefined) {
    if (raw.prompt !== undefined) {
      return problem('"prompt" cannot be combined with "turns" — the first turn\'s prompt is the initial one');
    }
    if (raw.when !== undefined || raw.one_of !== undefined) {
      return problem('"turns" cannot be combined with "when" or "one_of"');
    }
    if (raw.then !== undefined) {
      return problem('"then" cannot be combined with "turns" — write it on the last turn instead');
    }
    return parseTurnsBody(ctx, raw.turns);
  }
  if ((raw.when === undefined) === (raw.one_of === undefined)) {
    return problem('a koan needs exactly one of "when" / "one_of" / "turns"');
  }
  if (typeof raw.prompt !== 'string') return problem('missing "prompt"');
  // Routing attributes a request to a conversation by which opening its
  // first user message contains; an empty (or all-
  // whitespace) opening is contained in every string, so it would match
  // every request and collapse routing onto the first conversation.
  if (raw.prompt.trim().length === 0) return problem('"prompt" must be non-empty');
  const prompt = raw.prompt;

  if (raw.when !== undefined) {
    if (!Array.isArray(raw.when) || raw.when.length === 0) return problem('"when" must be a non-empty list of trace steps');
    const trace = parseTrace(into(ctx, 'when', raw.when), false, false);
    if (isProblem(trace)) return trace;
    const then = parseJudgment(into(ctx, 'then', raw.then));
    if (isProblem(then)) return then;
    return { kind: 'single', prompt, trace, then };
  }

  const rawOneOf = raw.one_of;
  if (typeof rawOneOf !== 'object' || rawOneOf === null || Array.isArray(rawOneOf)) {
    return problem('"one_of" must be a mapping of variant name to trace');
  }
  const entries = Object.entries(rawOneOf as Record<string, unknown>);
  if (entries.length < 2) return problem('"one_of" needs at least two variants — use "when" for a single trace');
  const variants: Record<string, Trace> = {};
  for (const [variant, rawTrace] of entries) {
    if (!Array.isArray(rawTrace) || rawTrace.length === 0) {
      return problem(`"one_of.${variant}" must be a non-empty list of trace steps`);
    }
    const trace = parseTrace(into(ctx, `one_of.${variant}`, rawTrace), false, false);
    if (isProblem(trace)) return trace;
    variants[variant] = trace;
  }
  const then = parseJudgment(into(ctx, 'then', raw.then));
  if (isProblem(then)) return then;
  return { kind: 'variants', prompt, variants, then };
}

// Two passes over the raw list, like the shape of the koan itself: every
// entry's own fields validate before any entry's `when`/`one_of` is
// parsed, so a shape error in entry 0's `then` is reported even when
// entry 1's `when` is merely empty.
function parseTurnsBody(ctx: Ctx<KoanFile>, rawTurns: unknown): Parsed<Body> {
  if (!Array.isArray(rawTurns) || rawTurns.length === 0) return problem('"turns" must be a non-empty list of turn entries');
  if (rawTurns.length < 2) return problem('"turns" needs at least two entries — a 1-turn koan is just "when"');

  const thens: Judgment[] = [];
  // Which turn, if any, has already claimed the koan's one "one_of" —
  // how many requests a fold costs is an implementation's own choice
  // (SPEC.md §3), so a turn may need more than one conforming shape;
  // naming every combination across more than one such turn is not a
  // thing this format takes on.
  let oneOfTurnAt = -1;
  // Whether a "crash" entry has already been seen — at most one death per
  // koan, the same one-per-trace rule a mid-trace "crash" step carries
  // (parseTrace), just checked here instead since this "crash" is an
  // entry of "turns" itself rather than a step of one turn's own trace.
  let crashAt = -1;
  for (let i = 0; i < rawTurns.length; i++) {
    if (rawTurns[i] === 'crash') {
      if (i === 0) {
        return problem('turns[0]: "crash" cannot open the koan — the record it tests is written by the turns before it');
      }
      if (i === rawTurns.length - 1) {
        return problem(`turns[${i}]: nothing follows this "crash" — a koan that ends at the death tests nothing about recovery`);
      }
      if (crashAt !== -1) {
        return problem(
          `turns[${i}]: a second "crash" — one death per koan; what survives it is the same record however often you kill the process`,
        );
      }
      crashAt = i;
      thens.push({});
      continue;
    }
    const rt = (rawTurns[i] ?? {}) as Record<string, unknown>;
    const asking = rt.compact !== undefined;
    for (const key of Object.keys(rt)) {
      const allowed = asking
        ? key === 'compact' || key === 'retry' || key === 'when' || key === 'one_of'
        : key === 'prompt' || key === 'when' || key === 'one_of' || key === 'then';
      if (!allowed) {
        return problem(
          asking
            ? `turns[${i}] has unknown key "${key}" — an entry asking for a fold carries only "compact", "retry", "when", and "one_of"`
            : `turns[${i}] has unknown key "${key}" — a prompt entry carries only "prompt", "when", "one_of", and "then"`,
        );
      }
    }
    if (rt.when !== undefined && rt.one_of !== undefined) {
      return problem(`turns[${i}] carries both "when" and "one_of" — a turn's own trace is one or the other`);
    }
    if (rt.one_of !== undefined) {
      if (oneOfTurnAt !== -1) {
        return problem(
          `turns[${i}].one_of: a koan may write "one_of" on at most one turn — turns[${oneOfTurnAt}] already does`,
        );
      }
      oneOfTurnAt = i;
    }
    if (asking) {
      // A string is what the ask said about how to fold; `true` is an ask
      // that said nothing, which is why the two are one field.
      if (rt.compact !== true && typeof rt.compact !== 'string') {
        return problem(
          `turns[${i}].compact must be true, or what the caller asked the fold to keep — the ask either says how or does not`,
        );
      }
      if (typeof rt.compact === 'string' && rt.compact.trim().length === 0) {
        return problem(`turns[${i}].compact is empty — an ask that says nothing about the fold is written "compact: true"`);
      }
      if (rt.retry !== undefined && rt.retry !== 'compact') {
        return problem(
          `turns[${i}].retry names what the caller re-sends — only "compact" (this same ask, delivered again) is supported on an entry asking for a fold`,
        );
      }
      if (i === 0) {
        return problem(`turns[0].compact: the caller asks a run that has already answered — an ask cannot open a koan`);
      }
      thens.push({});
      continue;
    }
    // Trim-empty counts as empty: entry 1's prompt routes the run the same
    // way a plain koan's does, and a later one's is what a turn-boundary
    // request must be shown to carry.
    if (typeof rt.prompt !== 'string' || rt.prompt.trim().length === 0) {
      return problem(`turns[${i}] needs a non-empty "prompt"`);
    }
    const then =
      rt.then !== undefined ? parseJudgment(into(ctx, `turns[${i}].then`, rt.then)) : ({ status: 'completed' } as Judgment);
    if (isProblem(then)) return then;
    thens.push(then);
  }

  const turns: Turn[] = [];
  for (let i = 0; i < rawTurns.length; i++) {
    if (rawTurns[i] === 'crash') {
      turns.push('crash');
      continue;
    }
    const rt = rawTurns[i] as Record<string, unknown>;
    const last = i === rawTurns.length - 1;
    // Omitted only where nothing could follow: a prompt the agent answers
    // with no model request at all ends the koan by definition.
    if (rt.when === undefined && rt.one_of === undefined && rt.compact === undefined && last) {
      turns.push({ kind: 'prompt', prompt: rt.prompt as string, then: thens[i] });
      continue;
    }
    const turnTrace = parseTurnTraceField(ctx, rt, i);
    if (isProblem(turnTrace)) return turnTrace;
    if (rt.compact !== undefined) {
      const err = checkEachVariant(turnTrace, i, checkCompactStep);
      if (err) return err;
      turns.push({
        kind: 'compact',
        ...(typeof rt.compact === 'string' ? { instructions: rt.compact } : {}),
        ...(rt.retry !== undefined ? { retried: true } : {}),
        trace: turnTrace,
      });
      continue;
    }
    if (!last) {
      // An intermediate turn can only be judged "completed" by ending in
      // a plain reply — the one seam where a later turn's first request
      // is allowed to continue the same conversation. Every conforming
      // shape owes it, not just the one written first.
      const err = checkEachVariant(turnTrace, i, checkEndsInReply);
      if (err) return err;
    }
    turns.push({ kind: 'prompt', prompt: rt.prompt as string, trace: turnTrace, then: thens[i] });
  }

  // "crash" is already rejected as turns[0] above; the check still reads
  // off the built value rather than assuming it, the way this rule always
  // has.
  if (turns[0] === 'crash' || turns[0].kind !== 'prompt') return problem('turns[0] must be a prompt — a run starts from one');
  return { kind: 'turns', turns: turns as [Turn, Turn, ...Turn[]] };
}

// A turn's own trace: `when` (one step list) or `one_of` (named
// variants, at least two) — never both, checked in the pass before this
// one runs.
function parseTurnTraceField(ctx: Ctx<KoanFile>, rt: Record<string, unknown>, i: number): Parsed<TurnTrace> {
  if (rt.one_of !== undefined) {
    const rawOneOf = rt.one_of;
    if (typeof rawOneOf !== 'object' || rawOneOf === null || Array.isArray(rawOneOf)) {
      return problem(`turns[${i}].one_of must be a mapping of variant name to a list of trace steps`);
    }
    const entries = Object.entries(rawOneOf as Record<string, unknown>);
    if (entries.length < 2) return problem(`turns[${i}].one_of needs at least two variants — use "when" for a single trace`);
    const variants: Record<string, Trace> = {};
    for (const [variant, rawSteps] of entries) {
      if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
        return problem(`turns[${i}].one_of.${variant} must be a non-empty list of trace steps`);
      }
      const trace = parseTrace(into(ctx, `turns[${i}].one_of.${variant}`, rawSteps), true, false);
      if (isProblem(trace)) return trace;
      variants[variant] = trace;
    }
    return { kind: 'one_of', variants };
  }
  if (!Array.isArray(rt.when) || rt.when.length === 0) {
    return problem(`turns[${i}].when must be a non-empty list of trace steps`);
  }
  const trace = parseTrace(into(ctx, `turns[${i}].when`, rt.when), true, false);
  if (isProblem(trace)) return trace;
  return { kind: 'one', trace };
}

// Applies `check` to every trace a turn's own `TurnTrace` scripts — the
// one trace `when` writes, or each named variant `one_of` writes — so a
// rule that must hold for whichever conforming shape a koan picks is
// checked against all of them, not just the one written first.
function checkEachVariant(
  turnTrace: TurnTrace,
  i: number,
  check: (trace: Trace, at: string) => Problem | undefined,
): Problem | undefined {
  if (turnTrace.kind === 'one') return check(turnTrace.trace, `turns[${i}].when`);
  for (const [variant, trace] of Object.entries(turnTrace.variants)) {
    const found = check(trace, `turns[${i}].one_of.${variant}`);
    if (found) return found;
  }
  return undefined;
}

function checkCompactStep(trace: Trace, at: string): Problem | undefined {
  if (trace.steps.length !== 1 || trace.steps[0].kind !== 'compaction') {
    return problem(
      `${at} scripts ${trace.steps.length} step(s) — an ask brings about the fold and nothing else, since without a prompt there is no other work`,
    );
  }
  return undefined;
}

function checkEndsInReply(trace: Trace, at: string): Problem | undefined {
  const end = trace.steps[trace.steps.length - 1];
  if (end.kind !== 'model' || end.response.kind !== 'reply') {
    return problem(
      `${at} must end with a plain text reply — an intermediate turn can only be judged "completed" by ending in one`,
    );
  }
  return undefined;
}

function parseJudgment(ctx: Ctx<unknown>): Parsed<Judgment> {
  if (ctx.node === undefined) return {};
  if (typeof ctx.node !== 'object' || ctx.node === null || Array.isArray(ctx.node)) {
    return problem(`${ctx.at} must be a mapping`);
  }
  const j = ctx.node as Record<string, unknown>;
  for (const key of Object.keys(j)) {
    if (key !== 'status' && key !== 'output') {
      return problem(`${ctx.at} has unknown key "${key}" — a judgment carries only "status" and "output"`);
    }
  }
  if (j.status !== undefined && typeof j.status !== 'string') return problem(`${ctx.at}.status must be a string`);
  return { status: j.status as string | undefined, output: j.output as Matcher | undefined };
}

/** Derived, never written: a trace ending in a reply was already settled. */
function abortKindOf(trace: Trace): AbortKind {
  const last = trace.steps[trace.steps.length - 1];
  return last.kind === 'model' && last.response.kind === 'reply' ? 'late' : 'live';
}

/**
 * A trace: its steps, the `abort` that may end it, and the mid-run
 * `prompt` one of its tool steps may carry. The bare `abort` item leaves the step
 * list here and becomes the trace's own field (koan-spec.ts's header),
 * which is why nothing downstream has to check that it came last — this
 * function still has to, against the raw list. `inTurns`/`inSubagent` are
 * context, not shape: they say where this array sits, for the rules that
 * read that context (`abort` and a mid-run `prompt` inside a `turns`
 * koan or a subagent block). `crashSeen` is threaded through this
 * function's own recursion into a subagent block, rather than a fresh
 * local each call: "one death per koan" has to see across that boundary,
 * which a call-local flag could not. `kind` records which shape the one
 * death seen so far was — only a tool step answered "crash" leaves room
 * for a second, and only directly after it (checked locally, against
 * `prev`, since that adjacency does not cross the recursion boundary).
 */
function parseTrace(
  ctx: Ctx<unknown>,
  inTurns: boolean,
  inSubagent: boolean,
  crashSeen: { at?: string; kind?: 'tool' | 'bare' } = {},
): Parsed<Trace> {
  const { node, at } = ctx;
  // Unquoted, unlike the callers above: they already reject a missing or
  // empty `when` before calling this, quoting the YAML key itself
  // ("when", "one_of.x", "turns[i].when"); the one caller that does not
  // pre-check is the subagent-block recursion below, where `at` is
  // already a full path (e.g. "when[0].when"), not a bare key.
  if (!Array.isArray(node) || node.length === 0) {
    return problem(`${at} must be a non-empty list of trace steps`);
  }

  const written = [...node];
  const compactAt = written.findIndex((s) => s === 'compact');
  if (compactAt !== -1) {
    return problem(
      `${at}[${compactAt}]: "compact" is the caller's, not a step of the trace — write it as a turn's own "compact: true"`,
    );
  }

  const bareRetryAt = written.findIndex((s) => s === 'retry');
  if (bareRetryAt !== -1) {
    return problem(`${at}[${bareRetryAt}]: "retry" names what the caller re-sends — write "retry: prompt"`);
  }

  let abort = false;
  let abortRetried = false;
  // Set here, not inside the per-item loop below: the marker this admits
  // is popped off `written` before that loop ever sees it (same move as
  // `retryingAbort`'s), since it is a property of the trace's last turn
  // (koan.ts), not a step of its own. Whether it is legal at all still
  // waits on the trace being built — a late abort already settled, so
  // this cannot be confirmed until `abortKindOf` has something to read.
  let abortCrashed = false;
  const abortAt = written.findIndex((s) => s === 'abort');
  if (abortAt !== -1) {
    const after = written.slice(abortAt + 1);
    // The two things that may follow "abort": the caller's own abort,
    // delivered again, or the process dying before the run settled —
    // anything else ends the trace here, same as today.
    const retryingAbort =
      after.length === 1 &&
      typeof after[0] === 'object' &&
      after[0] !== null &&
      !Array.isArray(after[0]) &&
      'retry' in after[0] &&
      !('request' in after[0]);
    const crashingAbort = after.length === 1 && after[0] === 'crash';
    if (after.length > 1 || (after.length === 1 && !retryingAbort && !crashingAbort)) {
      return problem(
        `${at}[${abortAt + 1}]: nothing can follow "abort" — it must be the trace's last step, "retry: abort", or "crash"`,
      );
    }
    if (inTurns) {
      return problem(`${at}[${abortAt}]: "abort" cannot appear inside a "turns" koan — turn-level cancellation is not supported yet`);
    }
    if (inSubagent) {
      return problem(`${at}[${abortAt}]: "abort" cannot appear inside a subagent block — only the caller's own run can be aborted`);
    }
    if (abortAt === 0) {
      return problem(`${at}[0]: "abort" needs at least one exchange before it in the trace`);
    }
    if (retryingAbort) {
      const at_r = `${at}[${abortAt + 1}]`;
      const block = after[0] as Record<string, unknown>;
      for (const key of Object.keys(block)) {
        if (key !== 'retry') {
          return problem(`${at_r} has unknown key "${key}" — a retry step is only "retry"`);
        }
      }
      if (block.retry !== 'abort') {
        return problem(`${at_r}: "retry: abort" is the only retry that may follow "abort" — write "retry: abort"`);
      }
      written.pop();
      abortRetried = true;
    }
    if (crashingAbort) {
      written.pop();
      abortCrashed = true;
    }
    written.pop();
    abort = true;
  }

  const steps: Step[] = [];
  let promptsSent = 0;
  // Written index for the message, step index for the carrier check below:
  // a `- retry: prompt` item folds onto the step before it instead of
  // becoming one, so the two lists no longer line up past it.
  let lastPromptAt = -1;
  let lastPromptStep = -1;
  let queuedSeams = 0;
  for (let i = 0; i < written.length; i++) {
    const at_i = `${at}[${i}]`;
    const prev = steps.at(-1);
    const item: unknown = written[i];

    if (item === 'crash') {
      if (inTurns) {
        return problem(
          `${at_i}: "crash" cannot appear inside a turn's own trace — a mid-submission death is not supported in a "turns" koan yet; only the seam between turns is, written as an entry of "turns" itself`,
        );
      }
      if (abort) {
        return problem(
          `${at_i}: "crash" cannot share a trace with "abort" — the only pairing this format admits is a bare "crash" ` +
            `directly after a live "abort", the trace's last two steps; anywhere else, one ending per run is all this format scripts`,
        );
      }
      // One death per koan, except the one pair this admits: the death
      // that already reached this trace was a tool step answered
      // "crash" (below), and this bare "crash" directly follows it — the
      // recovery's own first request, caught in flight in turn. Anywhere
      // else a second "crash" still means a second, ungrounded death.
      const directlyAfterToolCrash = prev?.kind === 'tool' && 'crash' in prev.response;
      if (crashSeen.at !== undefined && !directlyAfterToolCrash) {
        return problem(
          crashSeen.kind === 'tool'
            ? `${at_i}: a second "crash" is admitted only directly after the tool step it recovers from — landing anywhere else is just a second, ungrounded death`
            : `${at_i}: a second "crash" — one death per koan, wherever it lands`,
        );
      }
      crashSeen.at = at_i;
      crashSeen.kind = 'bare';
      steps.push({ kind: 'crash' });
      continue;
    }

    if (typeof item === 'object' && item !== null && 'retry' in item && !('request' in item)) {
      const block = item as Record<string, unknown>;
      for (const key of Object.keys(block)) {
        if (key !== 'retry') {
          return problem(`${at_i} has unknown key "${key}" — a retry step is only "retry"`);
        }
      }
      if (block.retry !== 'prompt') {
        if (block.retry === 'abort') {
          return problem(`${at_i}: "retry: abort" must directly follow "abort" — it retries the caller's abort delivery, not a held invocation`);
        }
        return problem(
          `${at_i}.retry names what the caller re-sends — only "prompt" (this turn's own submission) is supported`,
        );
      }
      if (inTurns) {
        return problem(`${at_i}: "retry" cannot appear inside a "turns" koan — retrying a follow-up submission is not supported yet`);
      }
      if (inSubagent) {
        return problem(`${at_i}: "retry" cannot appear inside a subagent block — only the caller's own submission can be retried`);
      }
      if (prev === undefined || prev.kind !== 'tool') {
        return problem(
          `${at_i}: "retry" must directly follow a tool step — its held invocation is what proves the run is still running when the resend lands`,
        );
      }
      if ('never' in prev.response) {
        return problem(`${at_i}: "retry" cannot follow a tool step answered "never" — its invocation is never released`);
      }
      if ('crash' in prev.response) {
        return problem(`${at_i}: "retry" cannot follow a tool step answered "crash" — the process the resend would reach is being killed`);
      }
      if (prev.prompt !== undefined || prev.retry !== undefined) {
        return problem(
          `${at_i}: a held invocation carries one caller action — this tool step already carries "${prev.retry !== undefined ? 'retry' : 'prompt'}"`,
        );
      }
      prev.retry = 'prompt';
      continue;
    }

    if (typeof item === 'object' && item !== null && 'subagent' in item && !('request' in item)) {
      const block = item as Record<string, unknown>;
      for (const key of Object.keys(block)) {
        if (key !== 'subagent' && key !== 'when') {
          return problem(`${at_i} has unknown key "${key}" — a subagent block carries only "subagent" and "when"`);
        }
      }
      if (typeof block.subagent !== 'string' || block.subagent.length === 0) {
        return problem(`${at_i}.subagent must be a non-empty delegate name`);
      }
      // `inTurns` rides into the child: a block nested in a turn's trace
      // is still inside that turn, so what a turn forbids — a
      // mid-submission death above all — stays forbidden at every depth.
      const childTrace = parseTrace(into(ctx, `[${i}].when`, block.when), inTurns, true, crashSeen);
      if (isProblem(childTrace)) return childTrace;
      const childLast = childTrace.steps[childTrace.steps.length - 1];
      const settles =
        childLast.kind === 'model' && (childLast.response.kind === 'reply' || childLast.response.kind === 'api-failure');
      // A child the run's abort cut off ends wherever the abort caught it;
      // only the trace's last step can be that child, since the abort
      // follows it directly.
      const cutOff = abort && i === written.length - 1;
      if (!settles && !cutOff) {
        return problem(
          `${at_i}: a subagent block must end with the child's final text reply or its model API failure — what came of the delegation is what returns to the parent`,
        );
      }
      steps.push({ kind: 'subagent', name: block.subagent, trace: childTrace });
      continue;
    }

    const entry = item as { request?: unknown; response?: unknown; prompt?: unknown } | null;
    const req = entry?.request;
    const res = entry?.response;
    const rawPrompt = entry?.prompt;
    if (req === undefined || req === null) return problem(`${at_i} needs "request"`);

    // A misspelled key would otherwise be dropped in silence, and the two
    // that can be dropped hurt most: a mistyped `prompt` leaves a koan
    // that still passes while scripting no delivery at all.
    for (const key of Object.keys(entry as Record<string, unknown>)) {
      if (key !== 'request' && key !== 'response' && key !== 'prompt') {
        return problem(
          `${at_i} has unknown key "${key}" — a trace step is a "request" and its "response", plus a tool step's "prompt"; anything else belongs inside one of them`,
        );
      }
    }
    const target = parseRequestTarget(at_i, req);
    if (isProblem(target)) return target;

    // Which calls a response-less request may close (koan-spec.ts) is a
    // whole-trace question, left to the tool-request matching in
    // `constraints`.
    if (target.kind === 'tool' && res === undefined) {
      if (rawPrompt !== undefined) {
        return problem(`${at_i}: "prompt" belongs on the tool step whose response is held open — an internal request holds nothing`);
      }
      steps.push({ kind: 'internal', tool: target.tool, ...(target.args !== undefined ? { args: target.args } : {}) });
      continue;
    }
    if (res === undefined || res === null) return problem(`${at_i} needs "response"`);

    if (target.kind === 'model') {
      if (rawPrompt !== undefined) {
        return problem(
          `${at_i}: "prompt" belongs on the tool step whose response is held open, not on a model request`,
        );
      }
      // A reply ends a conversation's trace — nothing legitimately
      // follows it with another model request here. A later turn's own
      // array starts fresh, so this never fires for a
      // turn's own opening request; a tool or subagent-block entry has
      // no such restriction of its own, so this check is model-request-
      // only, same as the shape it mirrors.
      //
      // Not forbidden after a mid-run prompt: the request following the reply
      // can only be the delivery re-opening the run, which is how koan.ts
      // tells a queueing agent from a joining one.
      if (prev?.kind === 'model' && prev.response.kind === 'reply') {
        if (promptsSent === 0) {
          return problem(`${at_i}: a model request cannot follow a text reply here — only a later turn's first request may`);
        }
        if (queuedSeams >= promptsSent) {
          return problem(
            `${at_i}: a prompt sent mid-run opens at most one queued turn each — more model requests follow text replies than prompts were sent`,
          );
        }
        queuedSeams += 1;
      }
      if (target.purpose !== undefined) {
        const fold = parseCompactionStep(at_i, res, (inTurns && i === 0) || inSubagent);
        if (isProblem(fold)) return fold;
        steps.push(fold);
        continue;
      }
      const envelope = parseModelEnvelope(at_i, res);
      if (isProblem(envelope)) return envelope;
      const response = parseModelResponse(into(ctx, `[${i}]`, envelope.body));
      if (isProblem(response)) return response;
      steps.push({
        kind: 'model',
        response,
        ...(envelope.used_tokens !== undefined ? { used_tokens: envelope.used_tokens } : {}),
      });
    } else if (target.kind === 'tool') {
      const reqTool = target.tool;
      // No shape check on the request's own args: it is a declared
      // transform, not re-validated against the
      // instruction it closes.
      const reqArgs = target.args;
      const disconnects = res === 'disconnect';
      const never = res === 'never';
      const crashes = res === 'crash';
      if (
        !disconnects &&
        !never &&
        !crashes &&
        (typeof res === 'string' || Array.isArray(res) || typeof (res as Record<string, unknown>).status !== 'number')
      ) {
        return problem(
          `${at_i}.response needs a numeric "status" for a tool request, "disconnect" for a connection severed without one, ` +
            `"never" for an invocation accepted and never answered, or "crash" for the agent's process killed while it is in flight`,
        );
      }
      // "never" hangs the invocation until something declared gives up on
      // it — the run's own time budget, or the tool's own timeout — and
      // without either, an agent that keeps waiting would just run out
      // against the runner's generic timeout instead, which is a worse
      // failure than refusing to load the koan at all.
      if (
        never &&
        ctx.koan.given.limits?.max_duration_ms === undefined &&
        ctx.koan.given.tools[reqTool]?.timeout_ms === undefined
      ) {
        return problem(
          `${at_i}: "never" needs "given.limits.max_duration_ms" or a "timeout_ms" on the tool — nothing else ends the wait`,
        );
      }
      if (crashes) {
        if (inTurns) {
          return problem(
            `${at_i}: a tool step answered "crash" cannot appear inside a "turns" koan — a mid-invocation death is not supported here yet, and the "- crash" entry of "turns" scripts a different death: between two turns, with nothing in flight`,
          );
        }
        if (inSubagent) {
          return problem(`${at_i}: a tool step answered "crash" cannot appear inside a subagent block — the process that dies is the whole agent's`);
        }
        if (abort) {
          return problem(
            `${at_i}: "crash" cannot share a trace with "abort" — the only pairing this format admits is a bare "crash" ` +
              `directly after a live "abort", not a tool step's own; anywhere else, one ending per run is all this format scripts`,
          );
        }
        if (crashSeen.at !== undefined) {
          return problem(`${at_i}: a second "crash" — one death per koan, wherever it lands`);
        }
        crashSeen.at = at_i;
        crashSeen.kind = 'tool';
      }
      const r = disconnects || never || crashes ? undefined : (res as { status: number; body?: unknown });
      if (rawPrompt !== undefined) {
        // A held-then-released invocation is what carries a mid-run
        // prompt; "never" never releases, so there is nothing for one to
        // ride, and "crash" kills the very process the delivery would
        // reach.
        if (never) {
          return problem(`${at_i}: a tool step answered "never" cannot carry "prompt" — its invocation is never released`);
        }
        if (crashes) {
          return problem(`${at_i}: a tool step answered "crash" cannot carry "prompt" — the process the delivery would reach is being killed`);
        }
        if (inTurns) {
          return problem(
            `${at_i}: a tool step's "prompt" cannot appear inside a "turns" koan — a scripted turn and a prompt sent mid-run are different things`,
          );
        }
        if (inSubagent) {
          return problem(
            `${at_i}: a tool step's "prompt" cannot appear inside a subagent block — only the caller's own run can be prompted`,
          );
        }
        if (typeof rawPrompt !== 'string' || rawPrompt.length === 0) {
          return problem(`${at_i}.prompt must be a non-empty string — what the caller sends while this response is held`);
        }
        promptsSent += 1;
        lastPromptAt = i;
        lastPromptStep = steps.length;
      }
      steps.push({
        kind: 'tool',
        tool: reqTool,
        args: reqArgs,
        response:
          r !== undefined
            ? { status: r.status, body: r.body }
            : never
              ? { never: true }
              : crashes
                ? { crash: true }
                : { disconnect: true },
        ...(typeof rawPrompt === 'string' ? { prompt: rawPrompt } : {}),
      });
    }
  }

  // An abort cuts the delivered prompt off before any request could carry
  // it — that is the point of scripting the two together — so the
  // model-request-after rule holds only for a trace that runs on.
  if (lastPromptAt !== -1 && !abort && !steps.slice(lastPromptStep + 1).some((s) => s.kind === 'model')) {
    return problem(
      `${at}[${lastPromptAt}]: a mid-run "prompt" needs a model request after it — otherwise no request carries it`,
    );
  }

  const trace: Trace = { steps: steps as [Step, ...Step[]] };
  if (abort) trace.abort = abortKindOf(trace);
  if (abortRetried) {
    if (trace.abort !== 'live') {
      return problem(`${at}: "retry: abort" only follows a live abort — a late one already tests nothing more by repeating`);
    }
    trace.abortRetried = true;
  }
  if (abortCrashed) {
    if (trace.abort !== 'live') {
      return problem(`${at}: "crash" only follows a live abort — a late one already settled, and a death after it tests nothing new`);
    }
    // Checked only now, not while popping the marker off `written` above:
    // an earlier crash elsewhere in this same trace is only known once the
    // steps before it have actually been walked (the loop just above),
    // same as the ordinary one-crash-per-koan rule this still owes.
    if (crashSeen.at !== undefined) {
      return problem(`${at}[${abortAt + 1}]: a second "crash" — one death per koan, wherever it lands`);
    }
    trace.abortCrashed = true;
  }
  return trace;
}

/**
 * Who a step's request goes to, and anything qualifying it. Two written
 * forms per target — `model` or `{ type: model, purpose: ... }`, and
 * `{ tool: name, args: ... }` — so a step that needs no detail carries
 * none, the way most do.
 */
type RequestTarget =
  | { kind: 'model'; purpose?: 'compaction' }
  | { kind: 'tool'; tool: string; args?: ParsedArgs };

function parseRequestTarget(at: string, req: unknown): Parsed<RequestTarget> {
  if (req === 'model') return { kind: 'model' };
  if (isMapping(req) && typeof req.tool === 'string') {
    for (const key of Object.keys(req)) {
      if (key !== 'tool' && key !== 'args') {
        return problem(`${at}.request has unknown key "${key}" — a tool request carries only "tool" and "args"`);
      }
    }
    // No shape check on the request's own args: it is a declared
    // transform, not re-validated against the instruction it closes.
    return { kind: 'tool', tool: req.tool, args: req.args as ParsedArgs | undefined };
  }
  if (isMapping(req) && req.type === 'model') {
    for (const key of Object.keys(req)) {
      if (key !== 'type' && key !== 'purpose') {
        return problem(`${at}.request has unknown key "${key}" — a model request carries only "type" and "purpose"`);
      }
    }
    if (req.purpose !== undefined && req.purpose !== 'compaction') {
      return problem(`${at}.request.purpose must be "compaction" — the only purpose a koan gives a model request of its own`);
    }
    return { kind: 'model', ...(req.purpose === 'compaction' ? { purpose: 'compaction' as const } : {}) };
  }
  return problem(`${at}.request must be "model", { type: model, purpose: ... }, or { tool: <name> }`);
}

/**
 * A model response: the body itself, or the body with what the response
 * reported alongside it. An envelope is recognized by carrying nothing but
 * those two keys, which keeps it apart from the API-failure body
 * `{ status, body }` without a written marker.
 */
function parseModelEnvelope(at: string, res: unknown): Parsed<{ body: unknown; used_tokens?: number }> {
  if (!isMapping(res) || res.body === undefined) return { body: res };
  const keys = Object.keys(res);
  if (!keys.every((key) => key === 'body' || key === 'used_tokens')) return { body: res };
  const used = parseUsedTokens(at, res.used_tokens);
  if (isProblem(used)) return used;
  return { body: res.body, ...(used !== undefined ? { used_tokens: used } : {}) };
}

function parseUsedTokens(at: string, raw: unknown): Parsed<number | undefined> {
  if (raw === undefined) return undefined;
  if (!Number.isInteger(raw) || (raw as number) < 0) {
    return problem(`${at}.response.used_tokens must be a non-negative integer — the size this response reports the conversation to have reached`);
  }
  return raw as number;
}

/**
 * The response to a model request whose purpose is a fold. `compaction`
 * says how it ended and decides what the rest must carry: a fold that
 * completed carries the summary it received and the size it left behind,
 * one that failed carries the failure the endpoint answered with, and
 * neither carries the other's fields.
 */
function parseCompactionStep(at: string, res: unknown, mayFoldHere: boolean): Parsed<Step> {
  // Anywhere but a turn's first step, or inside a subagent block, would
  // pin down one of two conforming designs: some agents fold before the
  // next request of a turn already running, some once that turn settles
  // (SPEC.md §3). A delegate's own declared threshold puts a fold inside
  // its block instead — its conversation ends at its final answer, so
  // there is no settled turn for it to defer to (SPEC.md §3).
  if (!mayFoldHere) {
    return problem(
      `${at}: a compaction belongs at the start of a later turn of a "turns:" koan, or inside a subagent block, where a delegate's own declared threshold puts one — a run folds the conversation down by the time the next turn's first model request goes out, and where inside the turn before it is the agent's own business`,
    );
  }
  if (!isMapping(res)) {
    return problem(`${at}.response for a compaction must be a mapping (keys: body, used_tokens, compaction)`);
  }
  if (res.compaction === 'failed') return parseFailedCompaction(at, res);
  if (res.compaction !== 'completed') {
    return problem(
      `${at}.response needs "compaction: completed" or "compaction: failed" — how the run reported this fold's ending to its caller`,
    );
  }
  for (const key of Object.keys(res)) {
    if (key !== 'body' && key !== 'used_tokens' && key !== 'compaction') {
      return problem(`${at}.response has unknown key "${key}" — a completed compaction carries only "body", "used_tokens", and "compaction"`);
    }
  }
  const summaries = parseFoldSummaries(at, res.body);
  if (isProblem(summaries)) return summaries;
  const used = parseUsedTokens(at, res.used_tokens);
  if (isProblem(used)) return used;
  if (used === undefined) {
    return problem(`${at}.response needs "used_tokens" — what the conversation shrank to, which is half of what a fold does`);
  }
  return { kind: 'compaction', summaries, used_tokens: used, report: 'completed' };
}

/**
 * `body`: the summary served to a fold's one request, or — for a fold an
 * implementation serves by more than one summarizing request (SPEC.md
 * §3: how many is the implementation's own choice) — a list of every
 * summary those requests are served, in no particular order (the wire
 * order is not the koan's to say). A one-element list is a style error,
 * the same as a one-element parallel group: write the bare-string form.
 * No summary may equal or contain another — the request that follows the
 * fold has to be shown to carry each one on its own, and a contained
 * summary's own check would never fail on its account.
 */
function parseFoldSummaries(at: string, raw: unknown): Parsed<[string, ...string[]]> {
  if (typeof raw === 'string') {
    if (raw.trim().length === 0) {
      return problem(
        `${at}.response.body for a compaction must be the summary served to it (a non-empty string), or a list of two or more for a fold served by that many requests`,
      );
    }
    return [raw];
  }
  if (Array.isArray(raw)) {
    if (raw.length < 2) {
      return problem(
        `${at}.response.body is a list of ${raw.length} — a fold served by more than one request needs at least two summaries; write the single string form for one`,
      );
    }
    for (const [i, s] of raw.entries()) {
      if (typeof s !== 'string' || s.trim().length === 0) {
        return problem(`${at}.response.body[${i}] must be a non-empty string`);
      }
    }
    const summaries = raw as string[];
    for (let a = 0; a < summaries.length; a++) {
      for (let b = a + 1; b < summaries.length; b++) {
        if (summaries[a].includes(summaries[b]) || summaries[b].includes(summaries[a])) {
          return problem(
            `${at}.response.body[${a}] and [${b}] are not distinct — no summary may equal or contain another, since the request after the fold must be shown to carry each on its own`,
          );
        }
      }
    }
    return summaries as [string, ...string[]];
  }
  return problem(
    `${at}.response.body for a compaction must be the summary served to it (a non-empty string), or a list of two or more for a fold served by that many requests`,
  );
}

// A fold the model endpoint refused. `status` is restricted the same way a
// model API failure's is, and for the same reason: a koan cannot script a
// status the client under test would retry on a schedule of its own.
function parseFailedCompaction(at: string, res: Record<string, unknown>): Parsed<Step> {
  for (const key of Object.keys(res)) {
    if (key !== 'status' && key !== 'body' && key !== 'compaction') {
      return problem(`${at}.response has unknown key "${key}" — a failed compaction carries only "status", "body", and "compaction"`);
    }
  }
  const status = res.status;
  if (typeof status !== 'number' || status < 400 || status >= 500 || status === 408 || status === 429) {
    return problem(`${at}.response.status must be a non-retryable 4xx (not 408/429) — what the model endpoint refused the fold with`);
  }
  return { kind: 'compaction', fails: { status, body: res.body }, report: 'failed' };
}

/**
 * A model response, discriminated by its written form: a bare
 * string replies, a mapping instructs or fails, a list is a parallel
 * group. An API failure may sit in a subagent block too — it is then the
 * child's ending, and what the trace does with it is the whole-trace
 * rule apiFailureEndsTheTrace's business.
 */
function parseModelResponse(ctx: Ctx<unknown>): Parsed<ModelResponse> {
  const { node, at } = ctx;
  if (typeof node === 'string') return { kind: 'reply', text: node };

  if (Array.isArray(node)) {
    // A 1-element list is really the single form; writing it as a list
    // would silently work but invite an inconsistent style.
    if (node.length < 2) {
      return problem(
        `${at}.response is a list of ${node.length} — a parallel group needs at least two instructions; write the single "{ tool, args }" form instead`,
      );
    }
    const instructions: Instruction[] = [];
    for (let j = 0; j < node.length; j++) {
      const parsed = parseInstruction(into(ctx, `[${j}]`, node[j]));
      if (isProblem(parsed)) return parsed;
      instructions.push(parsed);
    }
    const calls = instructions.filter(isCall);
    for (let a = 0; a < calls.length; a++) {
      for (let b = a + 1; b < calls.length; b++) {
        if (sameInstruction(calls[a], calls[b])) {
          return problem(
            `${at}: list members [${a}] and [${b}] both call "${calls[a].tool}" with the same arguments — matching a following tool request against them would be ambiguous`,
          );
        }
      }
    }
    const delegations = instructions.filter(isDelegate);
    for (let a = 0; a < delegations.length; a++) {
      for (let b = a + 1; b < delegations.length; b++) {
        if (delegations[a].subagent === delegations[b].subagent) {
          return problem(
            `${at}: two delegations to "${delegations[a].subagent}" in one turn — a subagent name may be delegated to at most once per trace`,
          );
        }
      }
    }
    return { kind: 'instructions', instructions: instructions as [Instruction, ...Instruction[]] };
  }

  if (isMapping(node) && typeof node.subagent === 'string') {
    if (node.status !== undefined || node.tool !== undefined) {
      return problem(`${at}.response mixes a delegation instruction with other response forms`);
    }
    const d = parseDelegateInstruction(ctx);
    if (isProblem(d)) return d;
    return { kind: 'instructions', instructions: [d] };
  }
  if (isMapping(node) && typeof node.tool === 'string') {
    if (node.status !== undefined) return problem(`${at}.response mixes a tool-call instruction with "status"`);
    const c = parseCallInstruction(ctx);
    if (isProblem(c)) return c;
    return { kind: 'instructions', instructions: [c] };
  }
  if (isMapping(node) && typeof node.status === 'number') {
    const { status } = node;
    // Only statuses the SDKs surface without retrying keep the trace
    // deterministic: 408/429/5xx are auto-retried by common clients.
    if (status < 400 || status >= 500 || status === 408 || status === 429) {
      return problem(`${at}.response.status must be a non-retryable 4xx (not 408/429) for a model API failure`);
    }
    return { kind: 'api-failure', status, body: node.body };
  }
  return problem(
    `${at}.response for a model request must be a reply string, { tool, args }, { subagent, prompt }, a list of instructions, or { status }`,
  );
}

// One member of a parallel group: dispatch is by key presence, not by its
// value's type, unlike the single-response dispatch above — a group
// member with a non-string `subagent` still reports the delegation
// instruction's own message (below) rather than the response-level
// fallback, because a group has no fallback shape of its own to fall to.
function parseInstruction(ctx: Ctx<unknown>): Parsed<Instruction> {
  if (isMapping(ctx.node) && 'subagent' in ctx.node) return parseDelegateInstruction(ctx);
  return parseCallInstruction(ctx);
}

/**
 * A `{ tool, args }` instruction — the single response form, or one
 * member of a parallel group.
 */
function parseCallInstruction(ctx: Ctx<unknown>): Parsed<Instruction> {
  const { node, at } = ctx;
  if (!isMapping(node) || typeof node.tool !== 'string') return problem(`${at} needs "tool"`);
  for (const key of Object.keys(node)) {
    if (key !== 'tool' && key !== 'args') {
      return problem(`${at} has unknown key "${key}" — a tool-call instruction carries only "tool" and "args"`);
    }
  }
  const args = parseArgs(into(ctx, '.args', node.args));
  if (isProblem(args)) return args;
  return { kind: 'call', tool: node.tool, args };
}

/**
 * Arguments: a mapping is the JSON-encoding sugar; a string is the wire
 * text verbatim. The wire form keeps whatever it parses to, so the rule
 * about a following tool request reads the value instead of parsing the
 * string a second time (koan-spec.ts's header).
 */
function parseArgs(ctx: Ctx<unknown>): Parsed<Args> {
  const { node, at } = ctx;
  if (node === undefined) return { kind: 'mapping', value: {} };
  if (typeof node === 'string') {
    try {
      const parsed: unknown = JSON.parse(node);
      if (isMapping(parsed)) return { kind: 'wire', text: node, parsed };
    } catch {
      // Deliberately malformed arguments: the koan scripts a refusal.
    }
    return { kind: 'wire', text: node };
  }
  if (isMapping(node)) return { kind: 'mapping', value: node };
  return problem(`${at} must be a mapping (JSON-encoding sugar) or a string (the verbatim wire arguments)`);
}

function parseDelegateInstruction(ctx: Ctx<unknown>): Parsed<Instruction> {
  const { node, at } = ctx;
  if (!isMapping(node) || typeof node.subagent !== 'string' || node.subagent.length === 0) {
    return problem(`${at} needs a non-empty "subagent" (the delegate's name)`);
  }
  for (const key of Object.keys(node)) {
    if (key !== 'subagent' && key !== 'prompt') {
      return problem(`${at} has unknown key "${key}" — a delegation instruction carries only "subagent" and "prompt"`);
    }
  }
  // Trim-empty counts as empty: routing matches by `.includes`, and an
  // all-whitespace briefing risks the same routing collapse an empty one
  // guarantees.
  if (typeof node.prompt !== 'string' || node.prompt.trim().length === 0) {
    return problem(`${at} needs a non-empty "prompt" (the briefing)`);
  }
  return { kind: 'delegate', subagent: node.subagent, prompt: node.prompt };
}

function isCall(i: Instruction): i is Extract<Instruction, { kind: 'call' }> {
  return i.kind === 'call';
}

function isDelegate(i: Instruction): i is Extract<Instruction, { kind: 'delegate' }> {
  return i.kind === 'delegate';
}

function argsValueOf(args: Args): ParsedArgs | undefined {
  return args.kind === 'mapping' ? args.value : args.parsed;
}

// Two instructions are the same call only when their parsed args are
// deep-equal; two malformed instructions (no parsed value) are compared by
// their raw wire string instead, since deep equality has nothing to work
// with. A malformed instruction is never mistaken for a parseable one.
function sameInstruction(a: Extract<Instruction, { kind: 'call' }>, b: Extract<Instruction, { kind: 'call' }>): boolean {
  if (a.tool !== b.tool) return false;
  const av = argsValueOf(a.args);
  const bv = argsValueOf(b.args);
  if (av !== undefined && bv !== undefined) return deepEqual(av, bv);
  const aw = a.args.kind === 'wire' ? a.args.text : undefined;
  const bw = b.args.kind === 'wire' ? b.args.text : undefined;
  return av === undefined && bv === undefined && aw !== undefined && bw === aw;
}

// ---------------------------------------------------------------------------
// Constraints: pure functions over the parsed file. Each one is a rule that
// no type or single-node parse can carry — a match spanning several steps,
// a uniqueness, a budget. The list is the format's rule set, and a rule
// cannot be added without naming it.
// ---------------------------------------------------------------------------

type Constraint = (koan: KoanFile) => Problem | undefined;

const constraints: Constraint[] = [
  everyDelegationHasABlock,
  everyToolRequestMatchesAnOpenCall,
  apiFailureEndsTheTrace,
  neverEndsTheTrace,
  eachSubagentIsDelegatedToOnce,
  everyDeclaredSubagentIsDelegatedTo,
  openingsAreDistinct,
  theTraceFitsTheModelRequestBudget,
  usedTokensFitTheWindow,
  compactionMatchesTheDeclaredThreshold,
  everyFoldReachesTheConversation,
];

/**
 * One scripted trace to check, plus the label its messages report, its
 * opening, and whether an `abort` follows its last step — `abort` is not
 * itself a step (koan-spec.ts's header), but it is still a write after
 * the last one for the rule that says nothing may follow an API failure.
 */
interface ScriptedTrace {
  steps: Step[];
  at: string;
  opening: { label: string; text: string };
  abort?: AbortKind;
}

// `turns:` scripts one continuous conversation: each turn's
// own trace holds only that turn's own steps (koan.ts appends them in
// order when compiling), so the rules below that read a whole
// conversation — delegation resolution, tool-request matching, budget,
// distinct openings — see it as the concatenation of every turn. `abort`
// cannot appear inside a `turns` koan (rejected while parsing), so only
// `single`/`variants` ever carry one.
function scriptedTraces(koan: KoanFile): ScriptedTrace[] {
  const body = koan.body;
  if (body.kind === 'single') {
    return [{ steps: body.trace.steps, at: 'when', opening: { label: 'prompt', text: body.prompt }, abort: body.trace.abort }];
  }
  if (body.kind === 'variants') {
    return Object.entries(body.variants).map(([name, trace]) => ({
      steps: trace.steps,
      at: `one_of.${name}`,
      opening: { label: 'prompt', text: body.prompt },
      abort: trace.abort,
    }));
  }
  const opening = body.turns[0] as Extract<Turn, { kind: 'prompt' }>;
  return turnsScriptedConversations(body.turns).map(({ label, conv }) => ({
    steps: conv.flatMap((t) => t.steps),
    at: label,
    opening: { label: 'turns[0].prompt', text: opening.prompt },
  }));
}

// One entry per conforming shape of a `turns:` koan's whole conversation:
// the turns as written, when no turn carries `one_of`, or one per named
// variant of the one turn that does (a koan writes `one_of` on at most
// one turn — parseTurnsBody's own rule). Every other turn contributes its
// single `when` trace unchanged. Shared by `scriptedTraces` (which
// flattens each entry into one step list) and `scriptedConversations`
// (which needs the turn-by-turn boundaries kept apart).
function turnsScriptedConversations(turns: Turn[]): Array<{ label: string; conv: ConversationTurns }> {
  const oneOfIndex = turns.findIndex((t) => t !== 'crash' && t.trace?.kind === 'one_of');
  const stepsOf = (t: Exclude<Turn, 'crash'>): Step[] => (t.trace?.kind === 'one' ? t.trace.trace.steps : []);

  // A "crash" entry contributes no turn of its own — the death sits
  // between two turns' steps, not inside either, so every rule that reads
  // a conversation's scripted steps (delegation resolution, tool
  // matching, budgets, window sizes) never sees it at all.
  const build = (variant?: string): ConversationTurns =>
    turns.flatMap((t, i) => {
      if (t === 'crash') return [];
      if (oneOfIndex !== -1 && i === oneOfIndex && variant !== undefined) {
        const variantsTurnTrace = t.trace as Extract<TurnTrace, { kind: 'one_of' }>;
        return [
          {
            steps: variantsTurnTrace.variants[variant].steps,
            at: `turns[${i}].one_of.${variant}`,
            ...(t.kind === 'compact' ? { compact: true as const } : {}),
          },
        ];
      }
      return [
        {
          steps: stepsOf(t),
          at: `turns[${i}].when`,
          ...(t.kind === 'compact' ? { compact: true as const } : {}),
        },
      ];
    });

  if (oneOfIndex === -1) return [{ label: 'turns', conv: build() }];

  const variantsTurnTrace = (turns[oneOfIndex] as Exclude<Turn, 'crash'>).trace as Extract<TurnTrace, { kind: 'one_of' }>;
  return Object.keys(variantsTurnTrace.variants).map((variant) => ({
    label: `turns.one_of.${variant}`,
    conv: build(variant),
  }));
}

// Across entries, not within one: the fold an ask brings about is an
// entry of its own, and the request that carries its summary belongs to
// the prompt that follows. Recurses into subagent blocks (same pattern as
// checkApiFailureEnds) — a child's own fold owes a model request after it
// the same way the run's own does, and a subagent block's inner steps are
// otherwise invisible to `scriptedTraces`, which only walks the top level.
function everyFoldReachesTheConversation(koan: KoanFile): Problem | undefined {
  for (const { steps, at } of scriptedTraces(koan)) {
    const found = checkFoldsReachTheirConversation(steps, at);
    if (found) return found;
  }
  return undefined;
}

function checkFoldsReachTheirConversation(steps: Step[], at: string): Problem | undefined {
  for (const [i, step] of steps.entries()) {
    if (step.kind === 'subagent') {
      const found = checkFoldsReachTheirConversation(step.trace.steps, `${at}[${i}].when`);
      if (found) return found;
      continue;
    }
    // Only a fold that completed: a refused one produced no summary to
    // carry, and a run that gives up on the refusal ends right there.
    if (step.kind !== 'compaction' || step.report !== 'completed') continue;
    // The (sub)trace's last exchange owes no carrier: nothing after it
    // may ask the model again — a fold can spend the budget's last
    // request and end the (sub)trace's scripted exchanges right there. A
    // subagent block can never actually end on one, since it must end in
    // a reply or an api-failure (parseTrace's own rule), but the
    // exemption applies uniformly rather than special-casing that away.
    if (i === steps.length - 1) continue;
    if (steps[i + 1]?.kind !== 'model') {
      return problem(`${at}[${i}]: a compaction needs a model request after it — otherwise no request carries its summary`);
    }
  }
  return undefined;
}

/**
 * Unlike a tool call, a delegation has no round trip a koan may omit: it
 * must be answered — unless it names someone outside a declared roster,
 * which must have no block at all. The roster rule rides the same walk:
 * both decide which delegations get a block.
 */
function everyDelegationHasABlock(koan: KoanFile): Problem | undefined {
  const roster = koan.given.subagents ? new Set(Object.keys(koan.given.subagents)) : undefined;
  for (const { steps, at } of scriptedTraces(koan)) {
    const found = checkDelegationsResolved(steps, at, roster);
    if (found) return found;
  }
  return undefined;
}

// `roster` is threaded through the recursion rather than re-derived per
// block: it is the whole run's, not each conversation's own. A non-roster
// delegation is dropped from `unresolved` rather than flagged — it is
// intentionally blockless, the way an undeclared tool call gets no tool
// request.
function checkDelegationsResolved(steps: Step[], at: string, roster: Set<string> | undefined): Problem | undefined {
  let unresolved: Array<{ subagent: string; prompt: string }> = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const at_i = `${at}[${i}]`;
    if (step.kind === 'model') {
      if (unresolved.length > 0) return problem(unresolvedDelegationMessage(at_i, unresolved));
      const delegations = step.response.kind === 'instructions' ? step.response.instructions.filter(isDelegate) : [];
      unresolved = roster ? delegations.filter((d) => roster.has(d.subagent)) : delegations;
    } else if (step.kind === 'subagent') {
      if (roster && !roster.has(step.name)) {
        return problem(
          `${at_i}: subagent block "${step.name}" is not in given.subagents — when the run declares its delegates, a conversation can only belong to one of them`,
        );
      }
      const di = unresolved.findIndex((d) => d.subagent === step.name);
      if (di === -1) {
        return problem(
          `${at_i}: subagent block "${step.name}" has no matching pending delegation — the preceding model response must include { subagent: "${step.name}", prompt: ... }`,
        );
      }
      unresolved.splice(di, 1);
      const found = checkDelegationsResolved(step.trace.steps, `${at_i}.when`, roster);
      if (found) return found;
    }
  }
  if (unresolved.length > 0) return problem(unresolvedDelegationMessage(`${at}[${steps.length}]`, unresolved));
  return undefined;
}

function unresolvedDelegationMessage(at: string, unresolved: Array<{ subagent: string }>): string {
  return `${at}: delegation to "${unresolved[0].subagent}" has no following "subagent" block — every delegation's conversation must be scripted`;
}

/**
 * Matches every `tool` step against the group of calls still open from the
 * model step before it, resolving a repeated tool name by args when the
 * group needs it to. Argument fidelity is undefined for a wire string that
 * never parsed as an object, so a matched call with no parsed value is
 * rejected here too — establishing that requires the same match.
 */
function everyToolRequestMatchesAnOpenCall(koan: KoanFile): Problem | undefined {
  for (const { steps, at } of scriptedTraces(koan)) {
    const found = checkToolMatching(koan, steps, at);
    if (found) return found;
  }
  return undefined;
}

type CallInstruction = Extract<Instruction, { kind: 'call' }>;

// Not inferred as internal the way it once was: absence must keep meaning
// "never executed", so a call that looks like an internal read has to be
// closed by a written step.
function unclosedInternalRead(
  koan: KoanFile,
  pending: CallInstruction[] | undefined,
  closed: Set<CallInstruction>,
  at: string,
): Problem | undefined {
  for (const call of pending ?? []) {
    if (closed.has(call)) continue;
    if (call.tool in koan.given.tools) continue;
    const p = argsValueOf(call.args)?.path;
    if (typeof p === 'string' && koan.given.files?.[p] !== undefined) {
      return problem(
        `${at}: the call to "${call.tool}" names given.files["${p}"] but no step says what became of it — a request with no response, "- request: { tool: ${call.tool} }", says the agent executed it itself`,
      );
    }
  }
  return undefined;
}

function checkToolMatching(koan: KoanFile, steps: Step[], at: string): Problem | undefined {
  let pending: CallInstruction[] | undefined;
  let closed = new Set<CallInstruction>();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const at_i = `${at}[${i}]`;
    if (step.kind === 'model') {
      const left = unclosedInternalRead(koan, pending, closed, at_i);
      if (left) return left;
      pending = step.response.kind === 'instructions' ? step.response.instructions.filter(isCall) : undefined;
      closed = new Set();
      continue;
    }
    if (step.kind === 'subagent') {
      const left = unclosedInternalRead(koan, pending, closed, at_i);
      if (left) return left;
      pending = undefined;
      closed = new Set();
      const found = checkToolMatching(koan, step.trace.steps, `${at_i}.when`);
      if (found) return found;
      continue;
    }
    // Folding the conversation down neither opens nor closes a call: a
    // call still open across it stays open, and its tool request may
    // still come. A crash neither opens nor closes one either — what a
    // recovered process owes a call left open is the runtime's story, not
    // this matching's.
    if (step.kind === 'compaction' || step.kind === 'crash') continue;

    const what = step.kind === 'tool' ? 'a tool request' : 'an internal request';
    if (pending === undefined) {
      return problem(
        step.kind === 'tool'
          ? `${at_i}: a tool request must follow a model response containing a tool-call instruction`
          : `${at_i}: a request with no response is the agent executing a call itself — it must follow a model response containing a tool-call instruction`,
      );
    }
    const open = pending.filter((c) => c.tool === step.tool && !closed.has(c));
    let member: CallInstruction;
    if (open.length === 1) {
      member = open[0];
    } else if (open.length === 0) {
      const named = pending.some((c) => c.tool === step.tool);
      if (named) {
        return problem(
          step.kind === 'tool'
            ? `${at_i}: the preceding tool-call instruction for "${step.tool}" already has a tool request`
            : `${at_i}: the preceding tool-call instruction for "${step.tool}" is already closed`,
        );
      }
      return problem(
        `${at_i}.request.tool is "${step.tool}" but the preceding model response requests ${pending.map((c) => `"${c.tool}"`).join(', ')}`,
      );
    } else {
      if (step.args === undefined) {
        return problem(`${at_i}: "${step.tool}" appears more than once in the preceding group — write "args" to say which call this closes`);
      }
      const exact = open.filter((c) => {
        const v = argsValueOf(c.args);
        return v !== undefined && deepEqual(v, step.args);
      });
      if (exact.length !== 1) {
        return problem(`${at_i}: "args" does not match exactly one of the pending "${step.tool}" calls in the group`);
      }
      member = exact[0];
    }
    closed.add(member);
    if (argsValueOf(member.args) === undefined) {
      return problem(
        `${at_i}: "${step.tool}"'s arguments do not parse as a JSON object — argument fidelity is undefined, so the agent must refuse the call instead; no ${what.replace(/^an? /, '')} can follow it`,
      );
    }
    if (step.kind === 'internal') {
      if (member.tool in koan.given.tools) {
        return problem(
          `${at_i}: "${member.tool}" is declared in given.tools — a declared tool runs at the tool server, so its request carries the response it answered with`,
        );
      }
      const p = argsValueOf(member.args)?.path;
      if (typeof p !== 'string' || koan.given.files?.[p] === undefined) {
        return problem(
          `${at_i}: an internal request is the agent reading the run's workspace — the call's args.path must name a given.files entry`,
        );
      }
    }
  }
  return unclosedInternalRead(koan, pending, closed, `${at}[${steps.length}]`);
}

/**
 * Nothing may follow a model API failure in its own conversation — the
 * conversation the endpoint refused stops there. For the main
 * conversation that ends the run, a trailing `abort` included; for a
 * subagent's it ends the child, whose parent runs on with the failure as
 * the delegation's outcome. Local adjacency in the old, mutation-based
 * trace form; here a `tool` step following a failed `model` step is a
 * step of its own, and `abort` is not a step at all (koan-spec.ts's
 * header), so seeing whether anything comes after needs a fresh pass over
 * the finished trace — one per conversation, since the rule is scoped to
 * one.
 */
function apiFailureEndsTheTrace(koan: KoanFile): Problem | undefined {
  for (const { steps, at, abort } of scriptedTraces(koan)) {
    const found = checkApiFailureEnds(steps, at, abort);
    if (found) return found;
  }
  return undefined;
}

function checkApiFailureEnds(steps: Step[], at: string, abort: AbortKind | undefined): Problem | undefined {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const isLast = i === steps.length - 1;
    if (step.kind === 'model' && step.response.kind === 'api-failure' && (!isLast || abort !== undefined)) {
      return problem(`${at}[${i + 1}]: nothing can follow a model API failure — the conversation it refused must stop`);
    }
    if (step.kind === 'subagent') {
      const found = checkApiFailureEnds(step.trace.steps, `${at}[${i}].when`, undefined);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * A tool step answered `never` holds its invocation open forever, so
 * nothing may follow it in the trace that scripts it — the same "this
 * ends the conversation" shape apiFailureEndsTheTrace checks for a model
 * API failure, kept separate since a `never` response sits on a `tool`
 * step rather than a `model` one. A sibling still closing the same
 * parallel group is not "following" it, though: the group's own end —
 * its next model request, which can never be scripted since nothing ever
 * releases the held invocation — is what the trace must stop before.
 */
function neverEndsTheTrace(koan: KoanFile): Problem | undefined {
  for (const { steps, at } of scriptedTraces(koan)) {
    const found = checkNeverEnds(koan, steps, at);
    if (found) return found;
  }
  return undefined;
}

function checkNeverEnds(koan: KoanFile, steps: Step[], at: string): Problem | undefined {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.kind === 'subagent') {
      const found = checkNeverEnds(koan, step.trace.steps, `${at}[${i}].when`);
      if (found) return found;
      continue;
    }
    if (step.kind !== 'tool' || !('never' in step.response)) continue;
    // A tool with its own declared timeout ends the wait itself (SPEC.md
    // §3), so the trace legitimately continues: the next model request is
    // the give-up reaching the model.
    if (koan.given.tools[step.tool]?.timeout_ms !== undefined) continue;
    let j = i + 1;
    while (j < steps.length && (steps[j].kind === 'tool' || steps[j].kind === 'internal' || steps[j].kind === 'subagent')) j++;
    if (j < steps.length) {
      return problem(`${at}[${j}]: nothing can follow "never" — the invocation it answers is held open forever`);
    }
  }
  return undefined;
}

// A subagent name may be delegated to at most once per trace: there is no
// such thing yet as a second delegation resuming an existing
// conversation. Depth-first, in trace order.
function eachSubagentIsDelegatedToOnce(koan: KoanFile): Problem | undefined {
  for (const { steps, at } of scriptedTraces(koan)) {
    const found = checkNamesUnique(steps, at, new Set());
    if (found) return found;
  }
  return undefined;
}

function checkNamesUnique(steps: Step[], at: string, seen: Set<string>): Problem | undefined {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.kind !== 'subagent') continue;
    const at_i = `${at}[${i}]`;
    if (seen.has(step.name)) {
      return problem(`${at_i}: subagent "${step.name}" already has a conversation in this trace — a subagent conversation cannot be continued yet`);
    }
    seen.add(step.name);
    const found = checkNamesUnique(step.trace.steps, `${at_i}.when`, seen);
    if (found) return found;
  }
  return undefined;
}

// A declaration with no matching delegation would provision a conversation
// the koan never opens — every `given.subagents` key must name a subagent
// some scripted trace actually delegates to, in any variant.
function everyDeclaredSubagentIsDelegatedTo(koan: KoanFile): Problem | undefined {
  const declared = koan.given.subagents;
  if (declared === undefined) return undefined;
  const delegated = new Set<string>();
  for (const { steps } of scriptedTraces(koan)) {
    collectDelegatedNames(steps, delegated);
  }
  for (const name of Object.keys(declared)) {
    if (!delegated.has(name)) {
      return problem(
        `given.subagents["${name}"]: no trace delegates to a subagent of this name — a declaration must provision a delegation the koan scripts`,
      );
    }
  }
  return undefined;
}

function collectDelegatedNames(steps: Step[], out: Set<string>): void {
  for (const step of steps) {
    if (step.kind === 'model' && step.response.kind === 'instructions') {
      for (const instruction of step.response.instructions) {
        if (instruction.kind === 'delegate') out.add(instruction.subagent);
      }
    } else if (step.kind === 'subagent') {
      collectDelegatedNames(step.trace.steps, out);
    }
  }
}

// Openings must be mutually non-containing, not merely distinct: the mock
// attributes each incoming request to a conversation by which opening its
// first user message contains, and `contains` — chosen to
// tolerate a framework lightly wrapping the briefing — can only route
// unambiguously when no opening is a substring of another.
function openingsAreDistinct(koan: KoanFile): Problem | undefined {
  for (const { steps, at, opening } of scriptedTraces(koan)) {
    const openings = [opening];
    collectBriefings(steps, openings);
    for (let a = 0; a < openings.length; a++) {
      for (let b = a + 1; b < openings.length; b++) {
        if (openings[a].text.includes(openings[b].text) || openings[b].text.includes(openings[a].text)) {
          return problem(
            `${at}: ${openings[a].label} and ${openings[b].label} are not distinct — no briefing may equal or contain another briefing or the prompt, since requests are attributed to conversations by their opening`,
          );
        }
      }
    }
  }
  return undefined;
}

function collectBriefings(steps: Step[], out: Array<{ label: string; text: string }>): void {
  for (const step of steps) {
    if (step.kind === 'model' && step.response.kind === 'instructions') {
      for (const instruction of step.response.instructions) {
        if (instruction.kind === 'delegate') {
          out.push({ label: `the briefing of subagent "${instruction.subagent}"`, text: instruction.prompt });
        }
      }
    } else if (step.kind === 'subagent') {
      collectBriefings(step.trace.steps, out);
    }
  }
}

// Subagent conversations and compactions count too: the budget counts HTTP
// requests at the model endpoint, and a delegate's requests — and the one
// that asks for a summary — arrive there as well.
function theTraceFitsTheModelRequestBudget(koan: KoanFile): Problem | undefined {
  const maxRequests = koan.given.limits?.max_model_requests;
  if (maxRequests === undefined) return undefined;
  for (const { steps, at } of scriptedTraces(koan)) {
    const total = countModelRequests(steps);
    if (total > maxRequests) {
      return problem(`${at} scripts ${total} model requests, more than given.limits.max_model_requests (${maxRequests}) permits`);
    }
  }
  return undefined;
}

/** One conversation's steps, split where a new turn begins. */
type ConversationTurns = Array<{ steps: Step[]; at: string; compact?: true }>;

/**
 * One scripted conversation, plus which subagent it belongs to —
 * `undefined` for the run's own. Carried alongside `turns` rather than
 * folded into each turn's own record: the name is one fact about the whole
 * conversation, not something that could vary turn to turn.
 */
interface ScriptedConversation {
  name: string | undefined;
  turns: ConversationTurns;
}

// Turn by turn, and not `scriptedTraces` above: a size belongs to one
// conversation, so a child's starts empty however full its parent's is,
// and the two rules below both turn on where a turn begins.
function scriptedConversations(koan: KoanFile): ScriptedConversation[] {
  const found: ScriptedConversation[] = [];

  const addSubagents = (steps: Step[], at: string): void => {
    for (const [i, step] of steps.entries()) {
      if (step.kind !== 'subagent') continue;
      const nested = `${at}[${i}].when`;
      found.push({ name: step.name, turns: [{ steps: step.trace.steps, at: nested }] });
      addSubagents(step.trace.steps, nested);
    }
  };

  const body = koan.body;
  if (body.kind === 'turns') {
    for (const { conv } of turnsScriptedConversations(body.turns)) {
      found.push({ name: undefined, turns: conv });
      for (const turn of conv) addSubagents(turn.steps, turn.at);
    }
    return found;
  }

  const traces =
    body.kind === 'single'
      ? [{ steps: body.trace.steps, at: 'when' }]
      : Object.entries(body.variants).map(([name, trace]) => ({ steps: trace.steps, at: `one_of.${name}` }));
  for (const trace of traces) {
    found.push({ name: undefined, turns: [trace] });
    addSubagents(trace.steps, trace.at);
  }
  return found;
}

// A conversation's context: the run's own for the main conversation, the
// run's declaration for that name for a delegate's — never a delegate's
// standing in for another, the way koan 060 already pins the sizes
// themselves to not do.
function resolveContext(koan: KoanFile, name: string | undefined): ContextSetup | undefined {
  return name === undefined ? koan.given.context : koan.given.subagents?.[name]?.context;
}

/**
 * A conversation grows into the declared window and only a compaction
 * folds it back down. Not checked while parsing a step: the window lives
 * in `given`, which a single step cannot see.
 */
function usedTokensFitTheWindow(koan: KoanFile): Problem | undefined {
  for (const { name, turns } of scriptedConversations(koan)) {
    const context = resolveContext(koan, name);
    let used = 0;
    for (const turn of turns) {
      for (const [i, step] of turn.steps.entries()) {
        if (step.kind !== 'model' && step.kind !== 'compaction') continue;
        const written = step.kind === 'compaction' && step.report === 'failed' ? undefined : step.used_tokens;
        if (written === undefined) continue;
        if (context === undefined) {
          // Only the run's own conversation must have one to compare
          // against: a delegate's without a declared context has no
          // window at all, so its reported size is whatever the endpoint
          // says, unbounded — koan 060 scripts exactly this.
          if (name === undefined) {
            return problem(`${turn.at}[${i}]: "used_tokens" needs "given.context.window" — there is no window for it to be a part of`);
          }
        } else if (written > context.window) {
          // Named by the declaration that actually applies: a delegate's
          // overflow against its own declared window would otherwise be
          // reported against the run's, which may not even exist.
          const declared = name === undefined ? 'given.context.window' : `given.subagents["${name}"].context.window`;
          return problem(`${turn.at}[${i}]: used_tokens (${written}) is larger than ${declared} (${context.window})`);
        }
        if (written < used && step.kind !== 'compaction') {
          return problem(
            `${turn.at}[${i}]: used_tokens falls from ${used} to ${written} — a conversation shrinks only where a compaction folds it down`,
          );
        }
        used = written;
      }
    }
  }
  return undefined;
}

/**
 * Where a compaction may sit. Two things put one there — the conversation
 * reaching the declared threshold, or the caller asking after the turn
 * before — and both land it in the same place: a turn that has reached the
 * threshold cannot ask for another model request, since the agent may fold
 * before that request or after the turn settles and the trace could not
 * say which; and a turn that opens owing a fold must open with it, since
 * by its first request the agent has run out of room to defer.
 */
function compactionMatchesTheDeclaredThreshold(koan: KoanFile): Problem | undefined {
  for (const { name, turns } of scriptedConversations(koan)) {
    const context = resolveContext(koan, name);
    const compaction = context?.compaction;
    const threshold =
      context !== undefined && compaction?.kind === 'threshold'
        ? Math.ceil((context.window * compaction.percent) / 100)
        : undefined;

    let used = 0;
    for (const turn of turns) {
      const asked = turn.compact === true;
      let over = threshold !== undefined && used >= threshold;
      if ((over || asked) && turn.steps[0].kind !== 'compaction') {
        return problem(
          asked
            ? `${turn.at}[0]: the caller asked for a fold before this turn — it must open with one`
            : `${turn.at}[0]: the conversation carries ${used} of ${context!.window} tokens into this turn, at or above the threshold of ${threshold} — it must open with a compaction`,
        );
      }
      for (const [i, step] of turn.steps.entries()) {
        if (step.kind === 'compaction') {
          if (!over && !asked) {
            // Named by the conversation the missing threshold belongs to:
            // for a delegate, "the run declares no threshold" would point
            // at the wrong declaration — the run's own may even exist.
            const noThreshold =
              name === undefined
                ? ' and the run declares no threshold'
                : ` and the run declares no threshold for delegate "${name}"`;
            return problem(
              `${turn.at}[${i}]: nothing has asked for a fold here — the conversation is at ${used} tokens${
                threshold === undefined ? noThreshold : `, below the threshold of ${threshold}`
              }, and the caller did not ask before this turn`,
            );
          }
          // A fold that failed leaves the conversation as it was. What
          // decides whether the turn may ask the model again is the room
          // left in the window, not the fold (SPEC.md §3), so the size
          // stays and only the obligation is discharged.
          if (step.report === 'failed') {
            over = false;
            continue;
          }
          if (threshold !== undefined && step.used_tokens >= threshold) {
            return problem(
              `${turn.at}[${i}]: used_tokens (${step.used_tokens}) is still at or above the threshold of ${threshold} — the agent would fold the conversation down again immediately`,
            );
          }
          used = step.used_tokens;
          over = false;
          continue;
        }
        if (step.kind !== 'model') continue;
        if (over) {
          return problem(
            `${turn.at}[${i}]: the conversation reached ${used} of ${context!.window} tokens, at or above the threshold of ${threshold}, earlier in this turn — a turn cannot ask for another model request past its threshold, since when the agent folds it down before the next turn is the agent's own business`,
          );
        }
        if (step.used_tokens !== undefined) used = step.used_tokens;
        over = threshold !== undefined && used >= threshold;
      }
    }
  }
  return undefined;
}

function countModelRequests(steps: Step[]): number {
  let n = 0;
  for (const step of steps) {
    if (step.kind === 'model') n++;
    // A completed fold costs one request per scripted summary — however
    // many an implementation chooses to spend (SPEC.md §3) — a failed one
    // is always the single request the endpoint refused.
    else if (step.kind === 'compaction') n += step.report === 'completed' ? step.summaries.length : 1;
    else if (step.kind === 'subagent') n += countModelRequests(step.trace.steps);
  }
  return n;
}
