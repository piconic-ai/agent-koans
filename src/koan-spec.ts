// What a koan file is. These types are the format's normative definition —
// SPEC.md links here rather than restating them, and states instead what
// the agent under test must do. Reading a file into
// these types belongs to parse.ts; compiling them into the runner's own
// trace form belongs to koan.ts. Nothing here executes: every export is a
// type.
//
// The shapes are chosen so that a violation is unrepresentable wherever a
// type can say it. `abort` sits beside a trace's steps rather than among
// them, so "abort must be last" needs no rule; a mid-run `prompt` sits on
// the tool step it interrupts rather than beside it, so "the caller sends
// it during a held invocation" needs none; a body is a union of three
// forms rather than three optional fields, so "exactly one of when /
// one_of / turns" needs none either; and the lower bounds that used to be
// checked by hand (a trace has at least one step, `turns` at least two
// entries) are tuple types. A raw YAML file is untyped, though, so
// parse.ts still has to check these same bounds against the input before
// it can build a value these types will accept — the type removes the
// question of what a *valid* file looks like, not the duty to reject an
// invalid one. What remains for parse.ts beyond that duty is the rules no
// type can carry at all: uniqueness, cross-references, budgets, and where
// a `compaction` step may sit — a question only the declared threshold and
// the sizes the surrounding steps report can answer.

/** A tool as declared in `given.tools`; `input_schema` is JSON Schema. */
export interface ToolDef {
  description?: string;
  input_schema: Record<string, unknown>;
}

/** A koan file, as written on disk. */
export interface KoanFile {
  name: string;
  description?: string;
  /** Agent setup only — never the prompt, which belongs to the body. */
  given: Given;
  body: Body;
}

/** Agent setup only — never the prompt. */
export interface Given {
  /** Tool name → definition. Empty when the koan declares none. */
  tools: Record<string, ToolDef>;
  /** Relative path → content, materialized into `KOAN_WORKSPACE` (§2). */
  files?: Record<string, string>;
  limits?: { max_model_requests: number };
  /** The window the conversation grows into, and when to fold it down. */
  context?: ContextSetup;
}

/**
 * The model's context window for the run, and what the agent does as the
 * conversation fills it. Not part of `limits`: that block bounds what the
 * caller lets the agent spend, and a window is not a budget but the size
 * of the world the run is given.
 */
export interface ContextSetup {
  /** The window in tokens; a step's `used_tokens` is measured against it. */
  window: number;
  compaction: Compaction;
}

/**
 * When the agent compacts, as a share of the window. `off` is a word a
 * koan writes rather than a field it leaves out, so that a koan testing
 * "never compact" states the policy instead of leaning on the default —
 * which a koan with no `given.context` at all leans on, and means the
 * same. A share rather than a token count: a third number to keep in
 * agreement with the window and the usage would be one too many.
 */
export type Compaction = { kind: 'off' } | { kind: 'threshold'; percent: number };

/**
 * The three ways to script a run, as a union: a koan is exactly one of
 * them, so no rule has to forbid mixing `when`, `one_of`, and `turns`, and
 * none has to pair `prompt` with the two forms that take one.
 */
export type Body =
  | { kind: 'single'; prompt: string; trace: Trace; then?: Judgment }
  | { kind: 'variants'; prompt: string; variants: Record<string, Trace>; then?: Judgment }
  | { kind: 'turns'; turns: [Turn, Turn, ...Turn[]] };

/** One turn of a `turns` koan — a small koan of its own. */
export interface Turn {
  prompt: string;
  trace: Trace;
  /** Defaulted to `{ status: 'completed' }` while parsing, never absent here. */
  then: Judgment;
}

/**
 * One conversation's expected wire log. `abort` is not a step: it may only
 * end a trace, so it is a property of the trace, and its kind is derived
 * from what it follows rather than written.
 */
export interface Trace {
  steps: [Step, ...Step[]];
  abort?: AbortKind;
}

/** Derived: `live` cancels a run in progress, `late` one already settled. */
export type AbortKind = 'live' | 'late';

/**
 * One entry of a trace, tagged by shape. `tool` is a request/response pair
 * in its own right, not folded into the `model` step whose instruction it
 * closes: writing it this way mirrors the YAML 1:1, and it is what makes
 * "a raw non-empty trace never compiles to an empty timeline" a fact about
 * the shape rather than a rule parse.ts has to check (the old form, which
 * absorbed a tool result into its instruction, produced a turn boundary
 * that could legally add zero new steps — see parse.ts's header).
 */
export type Step =
  /**
   * `used_tokens` is what this response reports the conversation to have
   * grown to. It holds until another step writes one — a koan states a
   * size, not every step that keeps it — starts at zero, and falls only
   * across a compaction.
   */
  | { kind: 'model'; response: ModelResponse; used_tokens?: number }
  /** `prompt` is one the caller sends while this invocation is held open. */
  | { kind: 'tool'; tool: string; args?: ParsedArgs; response: ToolResponse; prompt?: string }
  | { kind: 'subagent'; name: string; trace: Trace }
  /**
   * The extra model request an agent makes to fold a conversation that has
   * reached `given.context.compaction` down to a summary. Everything a
   * fold does is written on it: `summary` is what the mock replies, and
   * the conversation's next request must carry that reply; `used_tokens`
   * is what the conversation shrank to; `compaction` is how the run
   * reported the fold's ending to its caller, named after the event it
   * has to appear as. The request itself is the fold beginning, so only
   * its ending is written.
   *
   * A step of its own, not an annotation on the model step after it: an
   * agent that never folds then has no step to consume here, and one that
   * folds where no koan scripted it none to consume there, so the trace
   * stays the assertion.
   */
  | { kind: 'compaction'; summary: string; used_tokens: number; compaction: CompactionReport };

/**
 * How a fold ended, as its run reported it to its caller. One word today:
 * a fold that fails is not scriptable until the contract says what an
 * agent owes a run whose fold did not happen, and `failed` joins this
 * vocabulary with it.
 */
export type CompactionReport = 'completed';

/**
 * What the mock LLM serves for a model request. A tool-call instruction and
 * a parallel group are one variant, not two: a group is a list of more than
 * one instruction, so every consumer handles N uniformly and the "unordered
 * within a group" rule falls out of the count. Writing a one-element list in
 * YAML is a style error parse.ts rejects; it is not a shape of its own.
 */
export type ModelResponse =
  | { kind: 'reply'; text: string }
  | { kind: 'instructions'; instructions: [Instruction, ...Instruction[]] }
  | { kind: 'api-failure'; status: number; body?: unknown };

/** One instruction inside a model response — standalone, or one member of a parallel group. */
export type Instruction =
  | { kind: 'call'; tool: string; args: Args }
  | { kind: 'delegate'; subagent: string; prompt: string };

/**
 * A tool call's arguments. `mapping` is the JSON-encoding sugar; `wire` is
 * the verbatim `function.arguments` string a koan writes to script a
 * malformed call. A wire string that happens to parse as a JSON object
 * carries the result, and that is exactly what decides whether a tool
 * request may follow — so the rule reads off the value instead of
 * re-parsing it.
 */
export type Args =
  | { kind: 'mapping'; value: ParsedArgs }
  | { kind: 'wire'; text: string; parsed?: ParsedArgs };

/** Arguments once parsed to a JSON object, whichever form declared them. */
export type ParsedArgs = Record<string, unknown>;

/** The tool server's scripted HTTP response. */
export interface ToolResponse {
  status: number;
  body?: unknown;
}

/** `then`: the run's outcome after the trace settles. */
export interface Judgment {
  status?: string;
  output?: Matcher;
}

/** The closed matcher vocabulary; a bare scalar means `equals`. */
export type Matcher =
  | string
  | number
  | boolean
  | { equals?: unknown; contains?: string; matches?: string };
