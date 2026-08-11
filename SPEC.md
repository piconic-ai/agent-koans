# agent-koans Conformance Contract

Version: 0.1.0-draft

agent-koans is a framework-agnostic conformance suite for AI agent
implementations. It verifies the *implementation* half of agent behavior —
argument validation, failure recovery, delegation, context handling,
termination — deterministically, with the model fully mocked. It does not
measure model capability; that is the job of evals.

This document is written for one reader: someone making an agent pass the
suite. It says what your agent must do. Two other files say things
precisely, and win wherever this one is vaguer than they are:

| File | Defines |
| ---- | ------- |
| [openapi.yaml](./openapi.yaml) | The wire format of your agent's HTTP interface |
| [src/koan-spec.ts](./src/koan-spec.ts) | What a koan file may contain |

An implementation conforms when it passes every koan in a released suite
version. Conformance claims MUST cite that version (e.g. "conforms to
agent-koans 1.x").

The key words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as
described in RFC 2119.

## 1. How the suite runs your agent

Your agent is a black box behind an HTTP interface. The runner starts it
once per koan and watches it from both sides:

```
runner ───(1) POST /runs──────────▶ agent under test (black box)
                                        │
   mock LLM server ◀──(2) chat/completions──┤
   mock tool server ◀──(3) invoke/{tool}────┘
```

The mocks answer from a script the koan wrote, and record what your agent
sent them. Most of what the suite checks is that record: how many model
requests you made, what arguments reached a tool, what your conversation
carried at each step.

Checks on message content look for **the values the mock itself scripted**,
never for particular wording. When a koan wants to see that a tool failure
reached the model, it looks for the status code or the error body's own
text in the conversation you sent — so the phrasing of your errors is
yours, in any language, in any format.

## 2. Environment

The runner launches your agent with these environment variables:

| Variable          | Meaning                                                     |
| ----------------- | ----------------------------------------------------------- |
| `PORT`            | Port your agent MUST listen on                              |
| `OPENAI_BASE_URL` | Base URL of the mock LLM server (includes the `/v1` prefix) |
| `OPENAI_API_KEY`  | Dummy credential, for clients that require one to start     |
| `KOAN_TOOLS_URL`  | Base URL of the mock tool server                            |
| `KOAN_WORKSPACE`  | Path to the run's workspace directory                       |

All model calls MUST go to `OPENAI_BASE_URL`, and every invocation of a
tool the run declared MUST go to `KOAN_TOOLS_URL`. A capability of your
agent's own — delegating to a subagent, or reading a file — is executed
internally and MUST NOT reach the tool server (R7).

`OPENAI_API_KEY` is set because OpenAI-compatible clients commonly refuse
to construct without a key. The mock never authenticates a request, so
whether you forward the value, send something else, or omit the header
entirely has no bearing on any koan.

`KOAN_WORKSPACE` always exists, even for a run whose koan puts no files in
it. It is a plain local directory, never reachable through the tool
server; a koan uses it to hand your agent context it must find on disk
rather than over the wire.

## 3. Your HTTP interface

[openapi.yaml](./openapi.yaml) defines the endpoints, their schemas, and
their status codes. This section adds what a schema cannot say — what the
run's state must *do*.

| Endpoint | Purpose |
| -------- | ------- |
| `GET /health` | Readiness. `200` once you can accept runs |
| `POST /runs` | Submit a prompt, plus the run's tools, subagents, and limits |
| `GET /runs/{run_id}` | Poll the run's state |
| `POST /runs/{run_id}/abort` | Cancel a run |
| `POST /runs/{run_id}/prompts` | Continue a run's conversation |

A run's `status` is `running`, `completed`, `failed`, or `aborted`. When
it is `completed`, `output` MUST carry the final answer.

**Terminal state.** Every run MUST reach `completed`, `failed`, or
`aborted` in finite time — whatever the tools do, whatever the model
returns, whatever breaks inside you. A run still `running` past the
runner's timeout fails the koan.

**Abort.** A run in progress MUST then settle `aborted`. A run that has
already settled MUST keep the state it settled on: a late abort never
rewrites a committed result, and repeated aborts are idempotent.

**Follow-up prompts.** Delivering a prompt to a settled run MUST re-open
it: `status` returns to `running`, the run reaches a terminal state again,
and `output` carries the new turn's answer. The conversation MUST carry
every earlier turn into this turn's model requests. Delivering a prompt to
a run still `running` is out of scope — no koan scripts it, and this
version of the contract does not define what you must do with it.

## 4. What your agent must do

You reach the model through the OpenAI Chat Completions API
(`POST {OPENAI_BASE_URL}/chat/completions`). The mock supports streaming
(`stream: true`, SSE) and non-streaming responses, so use whichever your
client prefers. You execute a declared tool by calling the mock tool
server:

```
POST {KOAN_TOOLS_URL}/invoke/{name}
Content-Type: application/json

{ "city": "Tokyo" }
```

The body is the parsed tool arguments. A response status of 400 or above
is a tool failure.

- **R1 — Tool definitions.** When a run was submitted with tools, every
  model request of the conversation the run's prompt opened MUST include
  function definitions for all of them. What a delegate is given is your
  business — narrowing a subagent's tools is a design choice, not a
  defect — so a koan asks only that a delegate can make the calls
  scripted for it.
- **R2 — Tool results.** After executing a tool call, you MUST append a
  `role: "tool"` message whose `tool_call_id` matches the model's call and
  which carries the response body, then send the updated conversation back
  to the model.
- **R3 — Error reporting.** A failed tool call MUST be reported to the
  model as the `role: "tool"` message closing that call. When the failure
  came from the tool server, the report MUST carry what you received — the
  status code, or the error body's content. When you refused the call
  yourself (R6/R7), you SHOULD say why, but only the closing is checked:
  the wording of your own reports is yours.
- **R4 — No implicit retries.** You MUST NOT retry a failed tool call on
  your own. Retrying is the model's decision: report the error and let it
  decide. One model tool call maps to at most one tool server invocation.
- **R5 — Bounded loops.** A run MAY declare `limits.max_model_requests`:
  the most model requests you may issue for it, counted as HTTP requests
  arriving at the model endpoint. You MUST NOT exceed a declared budget,
  and when it runs out before a final answer you MUST settle the run
  `aborted`. Whether you still execute the tool calls the last permitted
  response asked for is up to you — their results could never be reported
  back, so finishing them and skipping them are both accepted. Without a
  declared limit you MUST still bound the model requests per run; that
  bound cannot be verified by a finite script and is not tested.
- **R6 — Argument validation.** Before invoking a tool, you MUST validate
  the arguments against its `input_schema` — at minimum the `required`
  properties, and the primitive types of declared properties. Arguments
  that fail, and arguments that do not parse as a JSON object at all, MUST
  NOT reach the tool server; report per R3.
- **R7 — Unknown tools.** A model tool call naming a tool the run did not
  declare MUST NOT reach the tool server; report per R3.
- **R8 — Model API failure.** When a model request fails with a client
  error that OpenAI-compatible clients surface without retrying (a 4xx
  other than 408 or 429), you MUST NOT re-issue it, and MUST settle the
  run `failed`. How you report it beyond the status is your business.
  Retry behavior for 408, 429, and 5xx is client-dependent and
  deliberately unspecified — no koan scripts those.
- **R9 — Argument fidelity.** The arguments you send to the tool server
  MUST be the ones the model produced: no defaulting, and no dropping of
  fields the tool's schema did not declare. You are a tool call's
  transport, not its editor. Where changing an argument is an accepted
  practice rather than a defect — coercing a scalar to its declared type,
  say — a koan scripts that route explicitly alongside the strict one
  (§5); nothing a koan did not script may be edited on the way through.
- **R10 — Parallel tool calls.** When one model response carries several
  tool calls, you MUST execute every one of them exactly once, and close
  every one before your next model request. Order and concurrency are
  yours: running a batch one call at a time conforms exactly as well as
  running it concurrently.
- **R11 — Delegation isolation.** A run MAY declare `subagents`. When the
  model delegates to one, that delegate holds its own conversation with
  the model, and two boundaries MUST hold. The briefing is the only thing
  it inherits: none of the delegator's prompt, history, or tool results
  may reach it. Its final reply is the only thing that returns, closing
  the delegation the way a tool result closes a tool call (R2); nothing
  else the delegate saw may appear in the delegator's conversation.

## 5. Koans

A koan is a YAML file: the world your agent is given, the exchange the
mocks will script, and the outcome expected of the run.
[src/koan-spec.ts](./src/koan-spec.ts) defines what such a file may
contain, and [koans/](./koans/) holds the suite.

```yaml
name: retry-on-transient-failure
description: >
  A transient 5xx must reach the model as a tool error, and the follow-up
  call must succeed without double-firing the tool.

given:
  tools:
    get_weather:
      input_schema:
        type: object
        properties: { city: { type: string } }
        required: [city]

prompt: "Get the current weather in Tokyo and report it."

when:
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

then:
  status: completed
  output: { contains: "31" }
```

Two things follow from that shape, and they are why most koans assert so
little explicitly:

- **The trace is the assertion.** A run must produce exactly the exchanges
  written — no more and no fewer. Its length is the call-count check, and
  the absence of a tool step after an instruction is the check that you
  did not invoke that tool.
- **Some koans accept more than one process.** Where a contract is about
  the outcome and more than one route legitimately reaches it, a koan
  scripts each route, and your agent conforms by walking any one of them.

## 6. Versioning

The suite is versioned as a whole (semver):

- **major** — incompatible contract changes, or a change to what an
  existing koan means
- **minor** — new koans; existing koans unchanged
- **patch** — fixes that change no pass/fail outcome

Published koans are immutable: to change a koan's contract line, add one
that supersedes it and deprecate the old one, removed at the next major.
Pin a suite version, upgrade deliberately, and record known failures in a
skiplist with reasons rather than mixing koan versions.
