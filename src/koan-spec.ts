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
  /**
   * How long the caller wants an invocation of this tool waited for, in
   * milliseconds (SPEC.md §3). Unanswered at the declared timeout, the
   * invocation must be given up then — not sooner, not later — with the
   * failure reaching the model; the run carries on. Also what licenses a
   * trace to continue past a `never` response: the timeout is then what
   * ends the wait.
   */
  timeout_ms?: number;
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
  /**
   * Budgets the caller lets the agent spend on this run; exhausting any
   * one of them must end the run `aborted`. `max_duration_ms` is a
   * wall-clock ceiling measured per submission, from the moment a prompt
   * is accepted.
   */
  limits?: { max_model_requests?: number; max_duration_ms?: number };
  /** The window the run's own conversation grows into, and when to fold it down. */
  context?: ContextSetup;
  /**
   * Subagent name → what the run declares for it beyond its existence.
   * Absent, every delegated name is declared implicitly by its block.
   * Written at all, it is the run's complete roster: a delegation naming
   * anything outside it is scripted as refused and carries no subagent
   * block — the way a call to an undeclared tool carries no tool request.
   */
  subagents?: Record<string, SubagentSetup>;
}

/**
 * What the run declares for one delegate beyond its existence — possibly
 * nothing (`{}`): once `given.subagents` is a roster, the key alone tells
 * a real delegate apart from a hallucinated name. The shape is a mapping
 * rather than `context` itself so a future declaration can grow another
 * field beside it without every existing entry changing shape.
 */
export interface SubagentSetup {
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

/**
 * One entry of a `turns` koan: something the caller did, and what the
 * agent did about it. A prompt is one such thing and asking for a fold is
 * another, so they are two shapes rather than one carrying a flag — an
 * ask has no prompt to send and no outcome to judge, and the fold it
 * brings about is its own exchange, not the next prompt's.
 */
export type Turn = PromptTurn | CompactTurn;

/** The caller sent a prompt. `trace` is absent where no model request followed it. */
export interface PromptTurn {
  kind: 'prompt';
  prompt: string;
  trace?: TurnTrace;
  /** Defaulted to `{ status: 'completed' }` while parsing, never absent here. */
  then: Judgment;
}

/**
 * The caller asked the run to fold its conversation down.
 *
 * `instructions` is what the ask said about how, written as the words
 * themselves (`compact: "Keep every operator code verbatim."`) and absent
 * where the ask said nothing (`compact: true`). Words rather than a
 * prompt, because they are about the summary and not the task, so they
 * open no turn of their own. A koan that writes them holds the
 * summarizing request to carrying them; one that writes `true` says
 * nothing about the wording, which is the agent's.
 */
export interface CompactTurn {
  kind: 'compact';
  instructions?: string;
  /** The fold the ask brings about, and nothing else: without a prompt there is no other work. */
  trace: TurnTrace;
  /**
   * The caller's own ask, delivered a second time while the fold it
   * brought about is still in flight (`retry: compact`, written beside
   * `compact`) — it must not start a second fold: it joins the one
   * already running, and its answer still waits for that fold to settle
   * (SPEC.md §3). A word rather than a flag, so what is re-sent is
   * named, same as a tool step's `retry: prompt`.
   */
  retried?: boolean;
}

/**
 * What a `turns:` entry's own trace is: one step list (`when:`), or a
 * choice among named ones (`one_of:`) — the same "more than one
 * conforming process" escape the top-level body already has, needed here
 * because how many requests a fold costs is an implementation's own
 * choice (SPEC.md §3), so one turn can legitimately have more than one
 * conforming shape. A koan may write `one_of` on at most one turn: naming
 * every combination of every turn's variants is not a thing this format
 * takes on.
 */
export type TurnTrace = { kind: 'one'; trace: Trace } | { kind: 'one_of'; variants: Record<string, Trace> };

/**
 * One conversation's expected wire log. `abort` is not a step: it may only
 * end a trace, so it is a property of the trace, and its kind is derived
 * from what it follows rather than written.
 */
export interface Trace {
  steps: [Step, ...Step[]];
  abort?: AbortKind;
  /**
   * The caller's own abort, delivered a second time once the run has
   * settled from the first (`- retry: abort`, written right after
   * `- abort`) — must be accepted again and must not rewrite the
   * committed result (SPEC.md §3: repeated aborts are idempotent). Live
   * only: a late abort's own repetition tests nothing a late abort does
   * not already.
   */
  abortRetried?: boolean;
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
 *
 * A step is written as a `request` and its `response`, and whatever
 * qualifies either sits inside it — `{ type: model, purpose: compaction }`
 * on the one side, `{ body, used_tokens }` on the other — with a plain
 * scalar on the sides that qualify nothing, which is most of them. These
 * types are flat: the grouping says where a detail is written, which is
 * not something a shape has to enforce.
 */
export type Step =
  /**
   * `used_tokens` is what this response reported the conversation to have
   * grown to. It holds until another step writes one — a koan states a
   * size, not every step that keeps it — starts at zero, and falls only
   * across a compaction.
   */
  | { kind: 'model'; response: ModelResponse; used_tokens?: number }
  /**
   * `prompt` is one the caller sends while this invocation is held open;
   * `retry` says the caller re-sends this turn's own submission instead —
   * the identical creation request, which must land on the same run
   * (SPEC.md §3). Written in YAML as its own `- retry: prompt` item and
   * folded onto the tool step it follows, the same move `abort` makes in
   * the other direction; a word rather than a flag, so what is re-sent is
   * named — `prompt` is the only object yet. One caller action per held
   * invocation: a step carries `prompt` or `retry`, never both.
   */
  | { kind: 'tool'; tool: string; args?: ParsedArgs; response: ToolResponse; prompt?: string; retry?: 'prompt' }
  /**
   * A tool request written without a `response`: the agent executed the
   * call itself — `read_file`, against the run's workspace. No response,
   * because a response is what a mock answered and nothing observable
   * answers this call; what must surface instead is the named file's
   * content in the conversation's next model request. `args`
   * disambiguates a repeated name within a group, as on a `tool` step.
   */
  | { kind: 'internal'; tool: string; args?: ParsedArgs }
  | { kind: 'subagent'; name: string; trace: Trace }
  /**
   * The extra model request(s) an agent makes to fold a conversation that
   * has reached `given.context.compaction` down to a summary — written as
   * a model request with `purpose: compaction`, since that is what it is.
   * Its response carries everything the fold produced: `summaries`
   * (written `body`, a string or a non-empty list of them) is what the
   * mock replies, and the conversation's next request must carry every
   * one of them; `used_tokens` is what the conversation shrank to;
   * `report` (written `compaction`) is how the run reported the fold's
   * ending to its caller. The request itself is the fold beginning, so
   * only its ending is written.
   *
   * One fold, not necessarily one request: how many summarizing requests
   * a fold costs is an implementation's own choice (SPEC.md §3), so
   * `body` written as a list scripts a fold answered by that many
   * requests, served in whichever order they arrive — the koan does not
   * say which request gets which reply, only that every reply is one this
   * fold serves and must resurface. A single `used_tokens` and a single
   * `report` still cover the whole fold: the conversation shrinks once,
   * and is told of once, however many requests that took. A one-element
   * list is a style error, the same as a one-element parallel group
   * (ModelResponse's header) — write the bare-string form instead.
   *
   * A fold that failed has neither of the first two — nothing was
   * summarized and nothing shrank — so it carries the failure the model
   * endpoint answered with instead, and the same `report`. A failed fold
   * is always one request: a partial failure inside a many-request fold
   * is not something this format scripts.
   *
   * A shape of its own rather than a `model` step carrying optional
   * fields: a fold's response is a summary and never a tool call, and what
   * it must carry depends on how it ended, neither of which a shared shape
   * could say.
   */
  | { kind: 'compaction'; summaries: [string, ...string[]]; used_tokens: number; report: 'completed' }
  | { kind: 'compaction'; fails: HttpToolResponse; report: 'failed' }
  /**
   * The agent's process is killed without warning (SIGKILL) once every
   * exchange before this step has been observed, and restarted; the trace
   * after it is what the recovered process still owes. A step of its own,
   * unlike `abort`: an abort may only end a trace, but a crash sits in
   * the middle of one — what follows it is the point.
   */
  | { kind: 'crash' };

/**
 * How a fold ended, as its run reported it to its caller. A fold that
 * failed owes nothing further of the agent — carrying on and ending the
 * run both conform (SPEC.md §3) — so what a koan can assert about one is
 * that its caller was told, which is what this word is.
 */
export type CompactionReport = 'completed' | 'failed';

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
export interface HttpToolResponse {
  status: number;
  body?: unknown;
}

/**
 * What the mock tool server does with a permitted invocation: answer it,
 * sever the connection without answering (`response: disconnect` in
 * YAML), or accept it and never answer at all (`response: never`). A
 * union rather than an optional `status`, so a response that answers
 * always has one to answer with. `never` is withheld forever — the agent
 * sees neither a status line nor a severed connection, only silence; what
 * a koan pairs it with is a declared `max_duration_ms`, since nothing
 * else ends the wait.
 *
 * `crash` is not the tool server's doing at all: while this invocation is
 * in flight, the runner kills the agent's process and restarts it
 * (SPEC.md §3). Like `disconnect` it closes the call with a failure and
 * no scripted content — the interruption's outcome is unknown, and an
 * unknown outcome reaches the model like any other tool failure; whether
 * the work is asked for again is the model's next instruction, never the
 * agent's own retry.
 */
export type ToolResponse = HttpToolResponse | { disconnect: true } | { never: true } | { crash: true };

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
