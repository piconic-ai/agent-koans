# agent-koans Conformance Contract

Version: 0.1.0-draft

agent-koans is a framework-agnostic conformance suite for AI agent
implementations. It verifies the *implementation* half of agent behavior —
argument validation, failure recovery, idempotent execution, context
management, termination — deterministically, with the model fully mocked.
It does not measure model capability; that is the job of evals.

An implementation conforms when it passes every koan in a released suite
version. Conformance claims MUST cite the suite version (e.g. "conforms to
agent-koans 1.x").

The key words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as
described in RFC 2119.

## 1. Architecture

The agent under test is a black box behind an HTTP interface. The runner
observes it from both sides:

```
runner ───(1) POST /runs──────────▶ agent under test (black box)
                                        │
   mock LLM server ◀──(2) chat/completions──┤
   mock tool server ◀──(3) invoke/{tool}────┘
```

1. The runner submits a task and the tool definitions.
2. The agent talks to a **mock LLM server** (OpenAI Chat Completions
   compatible) instead of a real model. The mock replies from a per-koan
   script.
3. The agent executes tools against a **mock tool server** whose responses
   are likewise scripted.

Most assertions run against the *received requests* of (2) and (3): retry
counts, argument fidelity, and context handling are verified without
touching the implementation's internals.

## 2. Environment

The runner launches the agent process with these environment variables:

| Variable          | Meaning                                                        |
| ----------------- | -------------------------------------------------------------- |
| `PORT`            | Port the agent MUST listen on                                  |
| `OPENAI_BASE_URL` | Base URL of the mock LLM server (includes the `/v1` prefix)    |
| `OPENAI_API_KEY`  | Dummy credential; MUST be sent but is not validated            |
| `KOAN_TOOLS_URL`  | Base URL of the mock tool server                               |
| `KOAN_WORKSPACE`  | Filesystem path to the run's workspace directory                |

The agent MUST direct all model calls to `OPENAI_BASE_URL` and all tool
executions to `KOAN_TOOLS_URL`.

`KOAN_WORKSPACE` is always set, to a directory that always exists, even
for a run whose koan declares no files. The runner materializes a koan's
`given.files` (§6) into it before starting the agent — a mapping of
relative path to file content, written to disk ahead of the run. An agent
MAY read files under this directory as one of its own capabilities (§6.1);
it is a plain local directory, never reachable through `KOAN_TOOLS_URL`.

## 3. Agent HTTP interface

The wire format — endpoints, request/response schemas, status codes — is
defined normatively in [openapi.yaml](./openapi.yaml). This section
summarizes it and adds the behavioral requirements.

### 3.1 `GET /health`

Readiness probe. MUST return `200` once the agent can accept runs.

### 3.2 `POST /runs`

Submits a task.

```json
{
  "prompt": "Get the current weather in Tokyo and report it.",
  "tools": [
    {
      "name": "get_weather",
      "description": "Look up current weather",
      "input_schema": {
        "type": "object",
        "properties": { "city": { "type": "string" } },
        "required": ["city"]
      }
    }
  ]
}
```

`prompt` MUST be non-empty: routing an incoming model request to the
right conversation (§6.4) matches by substring, and an empty prompt would
match every request. `tools` MAY be empty. `input_schema` is a JSON
Schema object describing the tool's arguments. The body MAY also carry
`limits`, per-run budgets the agent must honor (see R5), and `subagents`,
the delegates available for this run (§6.4):

```json
{ "subagents": [{ "name": "researcher", "description": "Looks things up." }] }
```

`name` is how the model addresses the delegate; `description` is OPTIONAL.
`subagents` MAY be empty or omitted for a run that declares no delegates.

Response: `201` or `202` with a body containing `run_id` (string).

### 3.3 `GET /runs/{run_id}`

```json
{ "run_id": "r_1", "status": "completed", "output": "The weather in Tokyo is 31°C." }
```

`status` MUST be one of:

| Status      | Meaning                                        |
| ----------- | ---------------------------------------------- |
| `running`   | Non-terminal; the run is in progress           |
| `completed` | Terminal; `output` MUST carry the final answer |
| `failed`    | Terminal; `error` SHOULD explain why           |
| `aborted`   | Terminal; cancelled or gave up                 |

**Terminal-state guarantee.** Every run MUST reach a terminal state in
finite time — regardless of tool failures, model misbehavior, or internal
errors. A run that stays `running` past the runner timeout fails the koan.

**Abort guarantee.** A run still in progress MUST then reach the terminal
state `aborted` in finite time. A run that has already reached a terminal
state MUST keep it: a late abort never rewrites a committed result.
Repeated aborts are idempotent.

Unknown `run_id` SHOULD return `404`.

### 3.4 `POST /runs/{run_id}/abort`

Requests cancellation of a run.

Response: `202` (`200` also acceptable) with any body. Unknown `run_id`
SHOULD return `404`. See the abort guarantee above for what the run's
state must do afterward, and §6.1 for how a koan trace scripts an abort.

### 3.5 `POST /runs/{run_id}/prompts`

Delivers a follow-up prompt to an existing run, continuing its
conversation (§6.5).

```json
{ "prompt": "What about Osaka?" }
```

Response: `202` (`200` also acceptable) with any body. Unknown `run_id`
SHOULD return `404`.

Delivering a prompt to a run already in a terminal state MUST re-open it:
`status` MUST return to `running`, and the run MUST then reach a terminal
state again in finite time (the terminal-state guarantee above, applied
to this new turn), with `output` carrying this turn's final answer. The
conversation MUST carry every earlier turn's exchanges into this turn's
model requests — the same continuity §6.5 requires of the koan trace.

Delivering a prompt to a run still `running` is out of scope: no koan
scripts it, and this version of the contract does not define what an
agent must do with it.

## 4. Model interaction

The agent talks to the model via the OpenAI Chat Completions API
(`POST {OPENAI_BASE_URL}/chat/completions`). The mock LLM supports both
streaming (`stream: true`, SSE) and non-streaming responses, so the agent
MAY use either. The mock responds from the koan's script; each incoming
request is matched against the next script entry.

Requirements:

- **R1 — Tool definitions.** When the run was submitted with tools, every
  model request MUST include function definitions for all of them.
- **R2 — Tool results.** After executing a tool call, the agent MUST append
  a `role: "tool"` message whose `tool_call_id` matches the model's tool
  call, and send the updated conversation back to the model.
- **R3 — Error reporting.** When a tool call fails, the failure MUST be
  reported back to the model as the `role: "tool"` message closing that
  call. When the failure came from the tool server (status ≥ 400), the
  report MUST carry the failure information the agent received — the
  status code or the error body's content; the runner verifies this by
  information flow (it produced the response, so it knows what must reach
  the model), not by matching any vocabulary. When the agent itself
  refused the call (R6/R7), it SHOULD state the reason; the runner
  verifies only that the call was closed without invoking the tool, since
  the phrasing of self-generated reports is implementation-specific.
- **R4 — No implicit retries.** The agent MUST NOT retry a failed tool
  call on its own. Retry decisions belong to the model: report the error
  (R3) and let the model decide. One model tool call maps to at most one
  tool server invocation.
- **R5 — Bounded loops.** A run MAY declare `limits.max_model_requests`:
  the maximum number of model requests the agent may issue for that run,
  counted as HTTP requests observed at the model endpoint. The agent MUST
  NOT exceed a declared budget, and when the budget is exhausted before a
  final answer it MUST end the run as `aborted`. Whether the tool calls
  instructed by the final permitted model response are still executed is
  implementation-defined — their results can never be reported back, so
  executing them is permitted waste and skipping them permitted thrift;
  koans accept both processes (§6.3). Without a declared limit the agent
  MUST still bound the number of model requests per run; that default
  bound's existence cannot be verified by a finite script and is not
  tested.
- **R8 — Model API failure.** When a model request fails with a client
  error that OpenAI-compatible SDKs surface without retrying (a 4xx other
  than 408 or 429), the agent MUST NOT re-issue the request and MUST end
  the run as `failed`. How the failure is reported beyond the status is
  the implementation's business. Retry behavior for 408, 429, and 5xx is
  SDK-dependent and deliberately unspecified — koans do not script those.

## 5. Tool invocation

Tools are executed by calling the mock tool server:

```
POST {KOAN_TOOLS_URL}/invoke/{name}
Content-Type: application/json

{ "city": "Tokyo" }
```

The request body is the parsed tool arguments. A response status ≥ 400 is
a tool failure (see R3/R4). The response body of a successful call MUST be
made available to the model as the tool result content.

- **R6 — Argument validation.** Before invoking a tool, the agent MUST
  validate the arguments against the tool's `input_schema` — at minimum
  `required` properties and primitive types of declared properties. If
  validation fails, the tool server MUST NOT be called; report the failure
  to the model per R3. Tool-call arguments that do not parse as a JSON
  object MUST NOT reach the tool server either; report per R3.
- **R7 — Unknown tools.** A model tool call naming a tool that was not in
  the run's `tools` MUST NOT reach the tool server; report per R3.

## 6. Koan file format

The koan file's exhaustive shape and its load-time constraints are
defined normatively in [src/format.ts](./src/format.ts). This section
gives the overview and the verification semantics a validator cannot
express: conversation coherence, trace consumption, argument fidelity,
the information flows of §6.4, and the meanings a step's position alone
derives (live/late abort, unordered parallel groups).

Koans are declarative YAML files using a given / when / then structure.
The `when` block is the run's **expected wire log**: an ordered sequence
of request/response exchanges observed at the two mock servers. Only the
agent issues requests — they are assertions on its behavior; the mocked
world only responds — responses are the script.

```yaml
name: retry-on-transient-failure
description: >
  A transient 5xx must reach the model as a tool error, and the follow-up
  call must succeed without double-firing the tool.

given:                    # agent setup only — never the prompt
  tools:                  # tool name → definition
    get_weather:
      input_schema:
        type: object
        properties: { city: { type: string } }
        required: [city]

prompt: "Get the current weather in Tokyo and report it."

when:                     # the expected wire log, in order
  - request: model
    response: { tool: get_weather, args: { city: "Tokyo" } }
  - request: { tool: get_weather }
    response: { status: 503, body: { error: "service_unavailable" } }
  - request: model
    response: { tool: get_weather, args: { city: "Tokyo" } }
  - request: { tool: get_weather }
    response: { status: 200, body: { temp: 31 } }
  - request: model
    response: "The weather in Tokyo is 31°C."

then:                     # assertions on the run's outcome
  status: completed
  output: { contains: "31" }
```

`given` carries agent setup only — never the prompt (§6.2 explains why
`then` reads the same way). `given.tools` is converted to the
wire-format list of §3.2. `given.files` materializes into
`KOAN_WORKSPACE` (§2) before starting the agent — this is how a koan
hands the agent context it must find on disk instead of over the wire
(§6.1 internal reads, §6.4 subagent conversations). `given.limits` is
forwarded verbatim in the run submission (§3.2). A trace MUST NOT script
more model requests than a declared `max_model_requests` permits — the
loader rejects such a koan; a subagent conversation's requests count
toward the same budget as the main conversation's (§6.4).

The top-level `prompt` is the run's initial prompt — what `POST /runs`
submits (§3.2). It is REQUIRED for a `when`/`one_of` koan; a `turns:`
koan (§6.5) carries a prompt per turn instead, and has no top-level one.

### 6.1 The `when` trace

Each step pairs the agent's request (asserted) with the called party's
scripted response. Requests take two forms:

- `request: model` — the agent calls the model. What the conversation
  must show is not written: it is **derived from the preceding trace**
  (conversation coherence, below).
- `request: { tool: <name> }` — the agent invokes that tool, directly
  following the model response whose tool-call instruction provokes it
  (one model tool call maps to at most one invocation, R4). `args` MAY be
  written to declare the expected invocation arguments when the trace
  legitimately transforms them (see §6.3); omitted, argument fidelity
  applies — the invocation must carry the instruction's args verbatim.
  When the preceding response is a parallel group (below), a tool request
  is matched against the group's instructions by tool name, and by `args`
  when the name repeats within the group, not by the position it is
  written in.

Responses discriminate by form:

| Form                                  | Meaning                                              |
| ------------------------------------- | ----------------------------------------------------- |
| bare string                           | The model's text reply                                |
| `{ tool: <name>, args }`              | The model's tool-call instruction                     |
| `{ subagent: <name>, prompt }`        | The model's delegation instruction (§6.4)             |
| list of `{ tool, args }` / `{ subagent, prompt }` | A parallel group: one assistant message, multiple tool_calls |
| `{ status, body }`                    | The called party's HTTP response                      |

A `{ status }` response to `request: model` scripts a **model API
failure**. Its `status` MUST be a 4xx other than 408 or 429: those two
and 5xx are auto-retried by common SDKs, which would make the trace
nondeterministic — 401 is the canonical choice. `body` MAY be omitted;
the mock then serves an OpenAI-style error envelope, since its content
is not part of the contract (R8). Such a step MUST be the last one:
after a non-retryable API failure the agent contacts no one.

A tool-call instruction's `args` is normally a mapping — JSON-encoding
sugar for the wire `function.arguments` string, which the mock builds by
`JSON.stringify`-ing it. `args` MAY instead be a string: the verbatim
wire string the mock serves as `function.arguments`, unencoded. This is
how a koan scripts malformed arguments. If the string parses as a JSON
object, argument fidelity applies to the parsed object, exactly as for
the mapping form. If it does not parse as a JSON object — unparseable,
or parsed to a non-object like an array or a number — a following
`request: { tool: ... }` step is a load error: argument fidelity is
undefined for arguments that do not parse as a JSON object, so the agent
MUST refuse the call instead (R6). The refusal path is the existing one:
an instruction with no following tool request.

`response` on a `request: model` step MAY also be a list of instructions
instead of one — `{ tool, args }`, `{ subagent, prompt }`, or a mix of
both — a single assistant message carrying multiple `tool_calls` (a
**parallel group**). A 1-element list is a load error — write the single
form. Two list members naming the same tool with deep-equal args, or two
delegating to the same subagent, are load errors too, since a following
tool request or subagent block could not tell them apart. The
`request: { tool: ... }` steps and the subagent blocks (§6.4) that close
a group are matched against it unordered, as stated above; nothing in the
YAML spells out the unorderedness, it is derived from the group having
more than one member. A group member with no matching tool-request step
follows the ordinary absence rule (below); every delegation, in contrast,
MUST have a matching subagent block — a koan cannot script one the model
"decides" not to pursue, since delegation has no tool-server round trip
to omit. The agent MAY execute a group's invocations sequentially or
concurrently, in any order — the contract is completeness (every member
closed, R2) and exactly-once delivery per member (R4), not concurrency,
so an implementation that serializes a parallel group conforms exactly as
well as one that runs it concurrently.

**Conversation coherence.** For every model request, what the incoming
conversation must show is fully determined by the trace before it:

| Preceding trace                              | The conversation must show                                          |
| -------------------------------------------- | ------------------------------------------------------------------- |
| Nothing (first request)                      | The prompt; no tool interaction yet                                  |
| Instruction + tool request with status < 400 | The call closed with a tool message carrying the response body's content (R2) |
| Instruction + tool request with status ≥ 400 | The call closed with a tool message carrying the status code or the error body's content (R3) |
| Instruction with **no** tool request         | The call closed back to the model without any invocation (R6/R7); content unconstrained |

Content checks are by information flow: the runner looks for the scalar
values it scripted into the tool response, never for any wording.

A request beyond the end of the trace, or one that contradicts its step,
fails the koan. Three further rules fall out of the trace itself, so
`then` never asserts counts or arguments explicitly:

- **Trace consumption.** A run must produce the entire trace — every
  exchange, no more and no fewer. The trace length *is* the call-count
  assertion.
- **Argument fidelity.** A tool request's arguments must deep-equal the
  `args` of the tool-call instruction that provoked it — the agent
  forwards the model's arguments verbatim.
- **Absence of a tool request.** A tool-call instruction with no
  following `request: { tool: ... }` step asserts the tool server MUST
  NOT be invoked for that call (e.g. the arguments are scripted to fail
  validation, R6).
- **Internal reads.** Refine the row above when the instruction's
  `args.path` names an entry of `given.files`: the absence of a tool
  request then is not an unconstrained refusal, it scripts one of the
  agent's own capabilities — reading `KOAN_WORKSPACE` (§2) directly,
  never the tool server (R7) — and the runner additionally asserts that
  entry's content reaches the *same* conversation's next model request.
  Nothing about the instruction's tool name marks it this way; only the
  `args.path` correlation with `given.files` does.

A trace MAY end with the bare list item `abort` (a YAML string, not a
`request`/`response` mapping). It MUST be the trace's last step —
anything after it is a load error — and it MUST follow at least one
exchange: `abort` alone, with nothing before it, is a load error too. Its
meaning is derived from what precedes it, the same shape-derived style as
the rest of this format: preceded by a tool exchange or a tool-call
instruction (the run is still in progress) it is a **live abort** — the
caller cancels mid-run, and `then` asserts `status: aborted`; preceded by
a model text reply (the final answer already delivered) it is a **late
abort** — the caller cancels after the run has settled, and `then`
asserts the committed result is unchanged. For a live abort, the runner
fires `POST /runs/{run_id}/abort` (§3.4) as soon as every step before it
has been observed; from that point the world stops answering — a further
model request racing the abort is parked (held open, never answered, and
never scored as an overrun), so the agent is left with nothing to do but
settle the run `aborted`. For a late abort, the runner waits for the
run's terminal state first, then fires the abort, then re-reads the run
so `then` judges the state after it.

### 6.2 `then`: judging the run's outcome

`then` judges one thing: the run's outcome after the trace settles
(§3.3), as `{ status, output }`, both OPTIONAL. There is no nesting — an
earlier draft wrapped both under a `run:` key, anticipating other actors
`then` might someday judge, but none ever appeared: every other
verification need turned out to belong to the trace itself instead (the
`request` steps, and rules like §6.1's "Absence of a tool request" or
§6.4's "Isolation"), not to `then`. `status` and `output` are matched
with the same closed set of matchers throughout the format:

| Matcher                 | Meaning                                  |
| ----------------------- | ---------------------------------------- |
| scalar value            | Shorthand for `equals`                   |
| `{ equals: <value> }`   | Deep equality                            |
| `{ contains: <str> }`   | Substring match                          |
| `{ matches: <regex> }`  | Regular expression match                 |

A new verification need is added as a named rule on the trace side, not
as a new `then` key or a general-purpose query language.

### 6.3 Alternative processes (`one_of`)

Some contracts are outcome-level: more than one process legitimately
reaches the user's expected result. Such a koan replaces its top-level
`when` with `one_of`. `given` and `then` stay single and shared — the
variants may differ only in process, by construction.

```yaml
one_of:
  coerce:
    - request: model
      response: { tool: get_forecast, args: { days: "3" } }
    - request: { tool: get_forecast, args: { days: 3 } }   # declared transform
      response: { status: 200, body: { forecast: "sunny" } }
    - request: model
      response: "Sunny for the next 3 days."
  reject-and-report:
    - request: model
      response: { tool: get_forecast, args: { days: "3" } }
    - request: model
      response: { tool: get_forecast, args: { days: 3 } }
    - request: { tool: get_forecast }
      response: { status: 200, body: { forecast: "sunny" } }
    - request: model
      response: "Sunny for the next 3 days."
```

The runner runs the koan once per variant, each run fully deterministic
against that variant's script, and the implementation conforms if at
least one run passes. A single run exhibits exactly one of the processes
— hence `one_of`. Composition order is fixed: `one_of` composes whole
traces (OR, outside); the structure inside a trace is reserved for the
interaction shape itself (e.g. the parallel tool-call group of §6.1).

### 6.4 Subagent conversations

A model response MAY be a **delegation instruction**,
`{ subagent: <name>, prompt: <briefing> }`, instead of a tool call or a
text reply (§6.1). `name` MUST be one of the run's declared `subagents`
(§3.2); `prompt` is the briefing that opens that delegate's own
conversation with the model. On the wire this is a `tool_calls` entry
like any other: the agent's own delegation tool, which per R7 MUST NOT
reach the tool server, and instead starts a **subagent conversation** as
scripted below. This suite does not mandate a wire name or argument keys
for that tool — an implementation declares its own vocabulary out of
band, so the mock can speak it — only that the agent recognizes its own
delegation calls and handles them as this section specifies.

A delegation instruction MUST be scripted by a following **subagent
block**, a trace step of the form `- subagent: <name>` / `when: <trace>`
— not a `request`/`response` pair, a third kind of step alongside those
and `abort`. `when` has exactly the shape of a top-level `when` (§6.1):
it may itself contain further tool calls, model API failures are
forbidden inside it (a subagent conversation cannot end the run — only
the caller's own run can, R8), `abort` is forbidden inside it for the
same reason, and it may contain its own delegation instructions and
subagent blocks, nested arbitrarily. It MUST end with the delegate's own
text reply — never a tool call or a further delegation — since that
reply is what returns to the delegator; there is no such thing as a
subagent block whose delegation instruction goes unanswered (unlike a
plain tool call, a delegation cannot be scripted absent, §6.1).

```yaml
when:
  - request: model
    response: { subagent: researcher, prompt: "Look up the current temperature in Tokyo." }
  - subagent: researcher
    when:
      - request: model
        response: { tool: get_weather, args: { city: "Tokyo" } }
      - request: { tool: get_weather }
        response: { status: 200, body: { temp: 31 } }
      - request: model
        response: "31°C."
  - request: model
    response: "Tokyo is 31°C."
```

**One delegation per name.** A subagent name MAY be delegated to at most
once per trace: a second delegation instruction or subagent block naming
a delegate already used earlier in the trace is a load error — a
subagent conversation cannot be continued yet. This is a format
limitation, not a capability one: nothing stops a caller from addressing
the same delegate again in a later koan version once the format grows a
way to script it.

**Ordering.** Sibling subagent blocks — those resolving delegations from
the same parallel group — MAY appear in the trace in any order relative
to each other and to that group's own tool-request steps; the format
does not spell this out any more than parallel tool-call ordering is
(§6.1), it falls out the same way from the group having more than one
member. Everything closing one model turn — every tool request and every
subagent block for that turn — MUST appear before the trace's next
`request: model` step or `abort`.

**Conversation coherence, per conversation.** §6.1's conversation
coherence table and its "Trace consumption" and "Argument fidelity"
rules apply independently to every conversation in the trace: the main
one (opened by the top-level `prompt`) and every subagent's (each opened
by its delegation's briefing).

**Routing.** The mock attributes an incoming model request to a
conversation by content: whichever opening — the top-level `prompt`, or a
delegate's briefing — its first user message contains. This is why no
briefing may equal or contain another briefing or the prompt: `contains`,
chosen to tolerate a framework lightly wrapping the briefing text, could
not otherwise route unambiguously. For the same reason every opening
MUST be non-empty (trimmed of whitespace) — an empty one is contained in
every string, so it would match every request instead of routing at all.
The loader rejects a koan whose openings are not mutually distinct or
not all non-empty this way.

**Isolation.** A subagent conversation's world is its briefing, nothing
more; the parent's is the delegate's final reply, nothing more. The
runner verifies this by information flow, scalar values never wording,
in both directions:

- *Positive.* A delegation's parent-side tool result — the content that
  closes it, the same way a tool call is closed (R2) — MUST be the
  delegate's final reply. For a parallel group of delegations, this
  applies to every sibling.
- *Negative.* A value scripted exclusively for one conversation MUST NOT
  appear in a different conversation's request. Between a conversation
  and its own delegate, only genuinely exclusive material is restricted:
  the delegator's prompt/briefings and its own tool results MUST NOT reach
  the delegate (they were not disclosed in the briefing), and the
  delegate's tool results MUST NOT reach the delegator (only its final
  reply is a sanctioned crossing). Between conversations that are not in
  a direct parent/child relationship — siblings, or otherwise unrelated
  — everything scripted exclusively into one MUST NOT appear in the
  other's requests at all.

### 6.5 Turn koans (follow-up prompts)

A koan MAY replace the top-level `prompt` and `when`/`one_of` with a
top-level **`turns`**: a list of at least two entries, each
`{ prompt, when, then }`. `prompt` is the user's text for that turn;
`when` is a trace with exactly the grammar of §6.1 — subagent blocks
included — scripting that turn's exchanges; `then` is that turn's own
judgment, in the same flat shape as the top-level `then` (§6.2). A turn's
`then` is OPTIONAL, defaulting to `{ status: completed }` — every turn
is judged, whether the koan writes its own `then` or relies on that
default. A `turns:` koan has no top-level `then` of its own: the last
turn's is the run's final judgment, since a turn is a small koan and
every level of this format keeps `when`/`then`'s names and meaning.
Mixing `turns` with a top-level `prompt`, `when`, `one_of`, or `then` is
a load error; a 1-turn koan is just `when` (`POST .../prompts`, §3.5,
needs a second turn to exercise at all).

```yaml
given:
  tools:
    get_weather:            # same shape as any given.tools entry (§6)
      input_schema: { type: object, properties: { city: { type: string } }, required: [city] }

turns:
  - prompt: "What is the weather in Tokyo?"
    when:
      - request: model
        response: { tool: get_weather, args: { city: "Tokyo" } }
      - request: { tool: get_weather }
        response: { status: 200, body: { temp: 31 } }
      - request: model
        response: "Tokyo is 31°C."
    then:
      status: completed
      output: { contains: "31" }
  - prompt: "What about Osaka?"
    when:
      - request: model
        response: { tool: get_weather, args: { city: "Osaka" } }
      - request: { tool: get_weather }
        response: { status: 200, body: { temp: 33 } }
      - request: model
        response: "Osaka is 33°C, warmer than Tokyo."
    then:
      status: completed
      output: { contains: "33" }
```

**Runner process.** Turn 1's prompt is submitted as `prompt` (§3.2), the
same as any koan's top-level one. The runner waits for a terminal state
(§3.3), judges that turn against its own `then`, and — for every turn but
the last — continues only if the run in fact landed `completed`: nothing
meaningful is left to continue otherwise, whatever that turn's `then`
happened to expect. It then sends the next turn's prompt via `POST
.../prompts` (§3.5) and waits for a terminal state again. The run's final
state (after the last turn, late abort included where applicable) is
judged against that last turn's `then`.

**One continuous conversation.** All turns belong to the same
conversation as the main one of a `when`/`one_of` koan — `turns` is an
alternative way to script it, not a different kind of conversation.
§6.1's conversation coherence table, "Trace consumption", and "Argument
fidelity" all apply across the whole thing, turn boundaries included.
Routing (§6.4) is unaffected: every request in the run, whichever turn
it belongs to, still carries turn 1's prompt somewhere in its history, so
it still routes to this conversation by the same content match.

**Turn boundaries.** The first request of turn 2 onward MUST carry that
turn's prompt, plus everything scripted into every earlier turn of the
same conversation (prompts, replies, tool results, internal reads, and
any subagent's final reply) — checked by information flow, the same
positive-flow style as a delegate's final reply crossing into its parent
(§6.4), applied here across turns of one conversation instead of across
conversations. `abort` MUST NOT appear inside a `turns` koan's `when` —
turn-level cancellation is not part of this version of the contract.

## 7. Versioning

The suite is versioned as a whole (semver):

- **major** — incompatible SPEC changes, or changes to the meaning of an
  existing koan
- **minor** — new koans; existing koans unchanged
- **patch** — fixes that do not affect any pass/fail outcome

Published koans are immutable: to change a koan's contract line, add a new
koan that supersedes it and deprecate the old one (removed at the next
major). Consumers SHOULD pin a suite version, upgrade deliberately, and
track known failures in a skiplist with reasons rather than mixing koan
versions.
