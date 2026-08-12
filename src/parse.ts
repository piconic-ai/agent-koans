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
  ToolDef,
  Trace,
  Turn,
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

  let limits: { max_model_requests: number } | undefined;
  if (g.limits !== undefined) {
    const rawLimits = g.limits;
    if (typeof rawLimits !== 'object' || rawLimits === null || Array.isArray(rawLimits)) {
      return problem('"given.limits" must be a mapping');
    }
    for (const key of Object.keys(rawLimits as Record<string, unknown>)) {
      if (key !== 'max_model_requests') return problem(`"given.limits" has unknown key "${key}"`);
    }
    const max = (rawLimits as Record<string, unknown>).max_model_requests;
    if (!Number.isInteger(max) || (max as number) < 1) {
      return problem('"given.limits.max_model_requests" must be a positive integer');
    }
    limits = { max_model_requests: max as number };
  }

  const context = parseContext(g.context);
  if (isProblem(context)) return context;

  return { tools: tools as Record<string, ToolDef>, files, limits, context };
}

// Both keys are required once the block is written: a window with no
// policy leaves the implementation to decide the one thing this block
// exists to decide, and a policy with no window is a share of nothing.
function parseContext(raw: unknown): Parsed<ContextSetup | undefined> {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return problem('"given.context" must be a mapping (keys: window, compaction)');
  }
  const c = raw as Record<string, unknown>;
  for (const key of Object.keys(c)) {
    if (key !== 'window' && key !== 'compaction') {
      return problem(`"given.context" has unknown key "${key}" (allowed: window, compaction)`);
    }
  }
  if (!Number.isInteger(c.window) || (c.window as number) < 1) {
    return problem('"given.context.window" must be a positive integer (the window in tokens)');
  }
  const compaction = parseCompactionPolicy(c.compaction);
  if (isProblem(compaction)) return compaction;
  return { window: c.window as number, compaction };
}

function parseCompactionPolicy(raw: unknown): Parsed<Compaction> {
  if (raw === 'off') return { kind: 'off' };
  const match = typeof raw === 'string' ? /^(\d{1,3})%$/.exec(raw) : null;
  const percent = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
    return problem('"given.context.compaction" must be "off" or a percentage of the window, like "90%"');
  }
  return { kind: 'threshold', percent };
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
// turn's own fields (prompt, unknown keys, its `then`) validate before any
// turn's `when` is parsed, so a shape error in turn 0's `then` is reported
// even when turn 1's `when` is merely empty.
function parseTurnsBody(ctx: Ctx<KoanFile>, rawTurns: unknown): Parsed<Body> {
  if (!Array.isArray(rawTurns) || rawTurns.length === 0) return problem('"turns" must be a non-empty list of turn entries');
  if (rawTurns.length < 2) return problem('"turns" needs at least two entries — a 1-turn koan is just "when"');

  const prompts: string[] = [];
  const thens: Judgment[] = [];
  for (let i = 0; i < rawTurns.length; i++) {
    const rt = (rawTurns[i] ?? {}) as Record<string, unknown>;
    // Trim-empty counts as empty: turn 1's prompt routes the run the same
    // way a plain koan's does, and a later turn's is what a turn-boundary
    // request must be shown to carry.
    if (typeof rt.prompt !== 'string' || rt.prompt.trim().length === 0) {
      return problem(`turns[${i}] needs a non-empty "prompt"`);
    }
    for (const key of Object.keys(rt)) {
      if (key !== 'prompt' && key !== 'when' && key !== 'then') {
        return problem(`turns[${i}] has unknown key "${key}" — a turn entry carries only "prompt", "when", and "then"`);
      }
    }
    const then =
      rt.then !== undefined ? parseJudgment(into(ctx, `turns[${i}].then`, rt.then)) : ({ status: 'completed' } as Judgment);
    if (isProblem(then)) return then;
    prompts.push(rt.prompt);
    thens.push(then);
  }

  const traces: Trace[] = [];
  for (let i = 0; i < rawTurns.length; i++) {
    const rawWhen = (rawTurns[i] as Record<string, unknown>).when;
    if (!Array.isArray(rawWhen) || rawWhen.length === 0) {
      return problem(`turns[${i}].when must be a non-empty list of trace steps`);
    }
    const trace = parseTrace(into(ctx, `turns[${i}].when`, rawWhen), true, false);
    if (isProblem(trace)) return trace;
    if (i < rawTurns.length - 1) {
      const last = trace.steps[trace.steps.length - 1];
      // An intermediate turn can only be judged "completed" by ending in
      // a plain reply — the one seam where a later turn's first request
      // is allowed to continue the same conversation.
      if (last.kind !== 'model' || last.response.kind !== 'reply') {
        return problem(
          `turns[${i}].when must end with a plain text reply — an intermediate turn can only be judged "completed" by ending in one`,
        );
      }
    }
    traces.push(trace);
  }

  const turns = prompts.map((prompt, i) => ({ prompt, trace: traces[i], then: thens[i] }));
  return { kind: 'turns', turns: turns as [Turn, Turn, ...Turn[]] };
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
 * koan or a subagent block).
 */
function parseTrace(ctx: Ctx<unknown>, inTurns: boolean, inSubagent: boolean): Parsed<Trace> {
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
  let abort = false;
  const abortAt = written.findIndex((s) => s === 'abort');
  if (abortAt !== -1) {
    if (abortAt !== written.length - 1) {
      return problem(`${at}[${abortAt + 1}]: nothing can follow "abort" — it must be the trace's last step`);
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
    written.pop();
    abort = true;
  }

  const steps: Step[] = [];
  let sentPrompt = false;
  let sentPromptAt = -1;
  let queuedSeam = false;
  for (let i = 0; i < written.length; i++) {
    const at_i = `${at}[${i}]`;
    const prev = steps.at(-1);
    const item: unknown = written[i];

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
      const childTrace = parseTrace(into(ctx, `[${i}].when`, block.when), false, true);
      if (isProblem(childTrace)) return childTrace;
      const childLast = childTrace.steps[childTrace.steps.length - 1];
      if (childLast.kind !== 'model' || childLast.response.kind !== 'reply') {
        return problem(`${at_i}: a subagent block must end with the child's final text reply — it is what returns to the parent`);
      }
      steps.push({ kind: 'subagent', name: block.subagent, trace: childTrace });
      continue;
    }

    const entry = item as { request?: unknown; response?: unknown; prompt?: unknown } | null;
    const req = entry?.request;
    const res = entry?.response;
    const rawPrompt = entry?.prompt;
    if (req === undefined || req === null) return problem(`${at_i} needs "request"`);
    if (res === undefined || res === null) return problem(`${at_i} needs "response"`);

    // A misspelled key would otherwise be dropped in silence, and the two
    // that can be dropped hurt most: a mistyped `prompt` leaves a koan
    // that still passes while scripting no delivery at all.
    for (const key of Object.keys(entry as Record<string, unknown>)) {
      if (
        key !== 'request' &&
        key !== 'response' &&
        key !== 'prompt' &&
        key !== 'used_tokens' &&
        key !== 'purpose' &&
        key !== 'report'
      ) {
        return problem(
          `${at_i} has unknown key "${key}" — a trace step carries only "request", "response", "used_tokens", a tool step's "prompt", and a compaction's "purpose" and "report"`,
        );
      }
    }
    const rawPurpose = (entry as Record<string, unknown>).purpose;
    const rawReport = (entry as Record<string, unknown>).report;
    const rawUsed = (entry as Record<string, unknown>).used_tokens;
    if (rawUsed !== undefined && (!Number.isInteger(rawUsed) || (rawUsed as number) < 0)) {
      return problem(`${at_i}.used_tokens must be a non-negative integer — the size this response reports the conversation to have reached`);
    }

    if (req === 'model') {
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
        if (!sentPrompt) {
          return problem(`${at_i}: a model request cannot follow a text reply here — only a later turn's first request may`);
        }
        if (queuedSeam) {
          return problem(
            `${at_i}: a prompt sent mid-run opens at most one queued turn — this is the second model request to follow a text reply`,
          );
        }
        queuedSeam = true;
      }
      if (rawPurpose !== undefined) {
        const fold = parseCompactionStep(at_i, rawPurpose, res, rawUsed, rawReport, inTurns, i);
        if (isProblem(fold)) return fold;
        steps.push(fold);
        continue;
      }
      if (rawReport !== undefined) {
        return problem(`${at_i}: "report" belongs on a compaction — it says how the run reported that fold's ending`);
      }
      const response = parseModelResponse(into(ctx, `[${i}]`, res), inSubagent);
      if (isProblem(response)) return response;
      steps.push({ kind: 'model', response, ...(rawUsed !== undefined ? { used_tokens: rawUsed as number } : {}) });
    } else if (typeof req === 'object' && req !== null && typeof (req as Record<string, unknown>).tool === 'string') {
      const reqTool = (req as Record<string, unknown>).tool as string;
      // No shape check on the request's own args: it is a declared
      // transform, not re-validated against the
      // instruction it closes.
      const reqArgs = (req as Record<string, unknown>).args as ParsedArgs | undefined;
      if (typeof res === 'string' || Array.isArray(res) || typeof (res as Record<string, unknown>).status !== 'number') {
        return problem(`${at_i}.response needs a numeric "status" for a tool request`);
      }
      const r = res as { status: number; body?: unknown };
      if (rawUsed !== undefined) {
        return problem(
          `${at_i}: "used_tokens" belongs on a model step — it is what a model response reports, not something a tool request carries`,
        );
      }
      if (rawPurpose !== undefined || rawReport !== undefined) {
        return problem(`${at_i}: "purpose" and "report" belong on a model request — a fold is one`);
      }
      if (rawPrompt !== undefined) {
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
        if (sentPrompt) {
          return problem(`${at_i}: a trace carries at most one mid-run "prompt" — the caller sends once`);
        }
        if (typeof rawPrompt !== 'string' || rawPrompt.length === 0) {
          return problem(`${at_i}.prompt must be a non-empty string — what the caller sends while this response is held`);
        }
        sentPrompt = true;
        sentPromptAt = i;
      }
      steps.push({
        kind: 'tool',
        tool: reqTool,
        args: reqArgs,
        response: { status: r.status, body: r.body },
        ...(typeof rawPrompt === 'string' ? { prompt: rawPrompt } : {}),
      });
    } else {
      return problem(`${at_i}.request must be "model" or { tool: <name> }`);
    }
  }

  if (abort && sentPrompt) {
    return problem(
      `${at}: a trace carries either "abort" or a mid-run "prompt", not both — cancelling a held invocation is not scripted yet`,
    );
  }
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].kind !== 'compaction') continue;
    if (steps[i + 1]?.kind !== 'model') {
      return problem(`${at}[${i}]: a compaction step needs a model request after it — otherwise no request carries its summary`);
    }
  }
  if (sentPromptAt !== -1 && !steps.slice(sentPromptAt + 1).some((s) => s.kind === 'model')) {
    return problem(
      `${at}[${sentPromptAt}]: a mid-run "prompt" needs a model request after it — otherwise no request carries it`,
    );
  }

  const trace: Trace = { steps: steps as [Step, ...Step[]] };
  if (abort) trace.abort = abortKindOf(trace);
  return trace;
}

/**
 * A model request whose `purpose` names it a fold. Everything it does is
 * written on it, and each field is required: the summary it receives, the
 * size the fold leaves behind, and how the run reported the fold's ending
 * to its caller.
 */
function parseCompactionStep(
  at: string,
  purpose: unknown,
  res: unknown,
  used: unknown,
  report: unknown,
  inTurns: boolean,
  index: number,
): Parsed<Step> {
  if (purpose !== 'compaction') {
    return problem(`${at}.purpose must be "compaction" — the only purpose a koan gives a model request of its own`);
  }
  // Anywhere but a turn's first step would pin down one of two conforming
  // designs: some agents fold before the next request of a turn already
  // running, some once that turn settles (SPEC.md §3).
  if (!inTurns || index !== 0) {
    return problem(
      `${at}: a compaction belongs at the start of a later turn of a "turns:" koan — a run folds the conversation down by the time the next turn's first model request goes out, and where inside the turn before it is the agent's own business`,
    );
  }
  if (typeof res !== 'string' || res.trim().length === 0) {
    return problem(`${at}.response for a compaction must be the summary served to it (a non-empty string)`);
  }
  if (used === undefined) {
    return problem(`${at} needs "used_tokens" — what the conversation shrank to, which is half of what a fold does`);
  }
  if (report !== 'completed') {
    return problem(
      `${at} needs "report: completed" — how the run reported this fold's ending to its caller. A fold that ends any other way is not scriptable yet`,
    );
  }
  return { kind: 'compaction', summary: res, used_tokens: used as number, report: 'completed' };
}

/**
 * A model response, discriminated by its written form: a bare
 * string replies, a mapping instructs or fails, a list is a parallel
 * group. `inSubagent` gates the one rule that depends on where this
 * response sits: a model API failure ends the whole run, so it cannot be
 * scripted inside a subagent's own conversation.
 */
function parseModelResponse(ctx: Ctx<unknown>, inSubagent: boolean): Parsed<ModelResponse> {
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
    if (inSubagent) {
      return problem(`${at}: a model API failure cannot appear inside a subagent block — it ends the whole run`);
    }
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
  eachSubagentIsDelegatedToOnce,
  openingsAreDistinct,
  theTraceFitsTheModelRequestBudget,
  usedTokensFitTheWindow,
  compactionMatchesTheDeclaredThreshold,
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
  const steps = body.turns.flatMap((t) => t.trace.steps);
  return [{ steps, at: 'turns', opening: { label: 'turns[0].prompt', text: body.turns[0].prompt } }];
}

/** Unlike a tool call, a delegation has no round trip a koan may omit: it must be answered. */
function everyDelegationHasABlock(koan: KoanFile): Problem | undefined {
  for (const { steps, at } of scriptedTraces(koan)) {
    const found = checkDelegationsResolved(steps, at);
    if (found) return found;
  }
  return undefined;
}

function checkDelegationsResolved(steps: Step[], at: string): Problem | undefined {
  let unresolved: Array<{ subagent: string; prompt: string }> = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const at_i = `${at}[${i}]`;
    if (step.kind === 'model') {
      if (unresolved.length > 0) return problem(unresolvedDelegationMessage(at_i, unresolved));
      unresolved = step.response.kind === 'instructions' ? step.response.instructions.filter(isDelegate) : [];
    } else if (step.kind === 'subagent') {
      const di = unresolved.findIndex((d) => d.subagent === step.name);
      if (di === -1) {
        return problem(
          `${at_i}: subagent block "${step.name}" has no matching pending delegation — the preceding model response must include { subagent: "${step.name}", prompt: ... }`,
        );
      }
      unresolved.splice(di, 1);
      const found = checkDelegationsResolved(step.trace.steps, `${at_i}.when`);
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
    const found = checkToolMatching(steps, at);
    if (found) return found;
  }
  return undefined;
}

type CallInstruction = Extract<Instruction, { kind: 'call' }>;

function checkToolMatching(steps: Step[], at: string): Problem | undefined {
  let pending: CallInstruction[] | undefined;
  let closed = new Set<CallInstruction>();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const at_i = `${at}[${i}]`;
    if (step.kind === 'model') {
      pending = step.response.kind === 'instructions' ? step.response.instructions.filter(isCall) : undefined;
      closed = new Set();
      continue;
    }
    if (step.kind === 'subagent') {
      pending = undefined;
      closed = new Set();
      const found = checkToolMatching(step.trace.steps, `${at_i}.when`);
      if (found) return found;
      continue;
    }
    // Folding the conversation down neither opens nor closes a call: a
    // call still open across it stays open, and its tool request may
    // still come.
    if (step.kind === 'compaction') continue;

    if (pending === undefined) {
      return problem(`${at_i}: a tool request must follow a model response containing a tool-call instruction`);
    }
    const open = pending.filter((c) => c.tool === step.tool && !closed.has(c));
    let member: CallInstruction;
    if (open.length === 1) {
      member = open[0];
    } else if (open.length === 0) {
      const named = pending.some((c) => c.tool === step.tool);
      if (named) return problem(`${at_i}: the preceding tool-call instruction for "${step.tool}" already has a tool request`);
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
        `${at_i}: "${step.tool}"'s arguments do not parse as a JSON object — argument fidelity is undefined, so the agent must refuse the call instead; no tool request can follow it`,
      );
    }
  }
  return undefined;
}

/**
 * Nothing may follow a model API failure — the agent must stop,
 * including an `abort` that trails the trace. Local adjacency in the old,
 * mutation-based trace form; here a `tool` step following a failed
 * `model` step is a step of its own, and `abort` is not a step at all
 * (koan-spec.ts's header), so seeing whether anything comes after needs a
 * fresh pass over the finished trace.
 */
function apiFailureEndsTheTrace(koan: KoanFile): Problem | undefined {
  for (const { steps, at, abort } of scriptedTraces(koan)) {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const isLast = i === steps.length - 1;
      if (step.kind === 'model' && step.response.kind === 'api-failure' && (!isLast || abort !== undefined)) {
        return problem(`${at}[${i + 1}]: nothing can follow a model API failure — the agent must stop`);
      }
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

/** One conversation of a scripted trace, split where a new turn begins. */
type ScriptedConversation = Array<{ steps: Step[]; at: string }>;

// Turn by turn, and not `scriptedTraces` above: a size belongs to one
// conversation, so a child's starts empty however full its parent's is,
// and the two rules below both turn on where a turn begins.
function scriptedConversations(koan: KoanFile): ScriptedConversation[] {
  const found: ScriptedConversation[] = [];

  const addSubagents = (steps: Step[], at: string): void => {
    for (const [i, step] of steps.entries()) {
      if (step.kind !== 'subagent') continue;
      const nested = `${at}[${i}].when`;
      found.push([{ steps: step.trace.steps, at: nested }]);
      addSubagents(step.trace.steps, nested);
    }
  };

  const body = koan.body;
  if (body.kind === 'turns') {
    found.push(body.turns.map((t, i) => ({ steps: t.trace.steps, at: `turns[${i}].when` })));
    for (const [i, t] of body.turns.entries()) addSubagents(t.trace.steps, `turns[${i}].when`);
    return found;
  }

  const traces =
    body.kind === 'single'
      ? [{ steps: body.trace.steps, at: 'when' }]
      : Object.entries(body.variants).map(([name, trace]) => ({ steps: trace.steps, at: `one_of.${name}` }));
  for (const trace of traces) {
    found.push([trace]);
    addSubagents(trace.steps, trace.at);
  }
  return found;
}

/**
 * A conversation grows into the declared window and only a compaction
 * folds it back down. Not checked while parsing a step: the window lives
 * in `given`, which a single step cannot see.
 */
function usedTokensFitTheWindow(koan: KoanFile): Problem | undefined {
  const context = koan.given.context;
  for (const conv of scriptedConversations(koan)) {
    let used = 0;
    for (const turn of conv) {
      for (const [i, step] of turn.steps.entries()) {
        if (step.kind !== 'model' && step.kind !== 'compaction') continue;
        const written = step.used_tokens;
        if (written === undefined) continue;
        if (context === undefined) {
          return problem(`${turn.at}[${i}]: "used_tokens" needs "given.context.window" — there is no window for it to be a part of`);
        }
        if (written > context.window) {
          return problem(`${turn.at}[${i}]: used_tokens (${written}) is larger than given.context.window (${context.window})`);
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
 * Where a compaction may sit, given the declared threshold: a turn that
 * has reached it cannot ask for another model request, since the agent may
 * fold before that request or after the turn settles and the trace could
 * not say which; and a turn that begins past it must open with the fold,
 * since by its first request the agent has run out of room to defer.
 */
function compactionMatchesTheDeclaredThreshold(koan: KoanFile): Problem | undefined {
  const context = koan.given.context;
  const compaction = context?.compaction;
  const threshold =
    context !== undefined && compaction?.kind === 'threshold'
      ? Math.ceil((context.window * compaction.percent) / 100)
      : undefined;

  for (const conv of scriptedConversations(koan)) {
    let used = 0;
    for (const turn of conv) {
      let over = threshold !== undefined && used >= threshold;
      if (over && turn.steps[0].kind !== 'compaction') {
        return problem(
          `${turn.at}[0]: the conversation carries ${used} of ${context!.window} tokens into this turn, at or above the threshold of ${threshold} — it must open with a compaction step`,
        );
      }
      for (const [i, step] of turn.steps.entries()) {
        if (step.kind === 'compaction') {
          if (threshold === undefined) {
            return problem(
              `${turn.at}[${i}]: a compaction step needs "given.context.compaction" to name a threshold — with "off", or with no "given.context" at all, the agent must not compact`,
            );
          }
          if (!over) {
            return problem(
              `${turn.at}[${i}]: the conversation is at ${used} tokens, below the threshold of ${threshold} — nothing has asked the agent to fold it down here`,
            );
          }
          if (step.used_tokens >= threshold) {
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
    if (step.kind === 'model' || step.kind === 'compaction') n++;
    else if (step.kind === 'subagent') n += countModelRequests(step.trace.steps);
  }
  return n;
}
