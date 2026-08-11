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
internally and MUST NOT reach the tool server.

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

## 4. Talking to the model

You reach the model at `POST {OPENAI_BASE_URL}/chat/completions`,
streaming (`stream: true`, SSE) or not, as your client prefers. When a run
declares tools, every request of the conversation its prompt opened MUST
carry function definitions for all of them; what a delegate is given is
your business. A tool call is answered with a `role: "tool"` message whose
`tool_call_id` matches it.

You execute a declared tool at `POST {KOAN_TOOLS_URL}/invoke/{name}`, the
parsed arguments as the body. A status of 400 or above is a failure.

What you do with any of this — when to invoke a tool, when to refuse one,
when to retry, when to give up — is the koans' business, below.

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
- **What no koan scripts is open.** No koan answers a model request with
  408, 429, or a 5xx, because clients retry those on their own schedule
  and the trace would stop being deterministic. How yours behaves there
  is its own business.

### The suite

Every koan, in order, as each describes itself. This list is generated
from `koans/` by `pnpm koan-index`, and a test fails when it is stale, so
it cannot drift from the contract it indexes.

<!-- koan-index:start -->

| Koan | Contract |
| ---- | -------- |
| [000-plain-completion](./koans/000-plain-completion.yaml) | The agent forwards the task to the model and reports the final text. |
| [001-happy-path](./koans/001-happy-path.yaml) | One tool call that succeeds on the first try. The agent must invoke the tool with the model's arguments, feed the result back to the model, and report the final answer. |
| [002-arg-validation](./koans/002-arg-validation.yaml) | The model first calls the tool with arguments that violate the input schema (required "city" is missing). The agent must reject the call without invoking the tool — there is no tool request in the trace — report a validation error back to the model, and then execute the corrected call. |
| [003-retry-on-transient-failure](./koans/003-retry-on-transient-failure.yaml) | A transient 5xx must reach the model as a tool error, and the follow-up call must succeed. The agent must not retry on its own: one model tool call maps to at most one tool invocation. |
| [004-unknown-tool](./koans/004-unknown-tool.yaml) | The model first calls a tool that was never declared (a typo'd name). The agent must reject the call without invoking the tool server — there is no tool request in the trace — report the failure back to the model, and then execute the correctly-named call. |
| [005-wrong-arg-type](./koans/005-wrong-arg-type.yaml) | The model first calls the tool with an argument of the wrong primitive type ("city" must be a string, not an array). The agent must reject the call without invoking the tool — there is no tool request in the trace — report a validation error back to the model, and then execute the corrected call. |
| [006-permanent-client-error](./koans/006-permanent-client-error.yaml) | A permanent 4xx (the city does not exist) must reach the model as a tool error. Unlike a transient failure, there is no follow-up call to retry — the model gives up gracefully and reports it could not find the data. Exactly one tool invocation is made. |
| [007-multi-tool-sequence](./koans/007-multi-tool-sequence.yaml) | A task that requires two different tools in sequence. The agent must invoke each tool with the model's arguments, feed each result back to the model in turn, and only then report the combined final answer. |
| [008-repeated-calls](./koans/008-repeated-calls.yaml) | A task that requires the same tool twice with different arguments. The agent must invoke it once per city, feed each result back to the model in turn, and only then report the comparison. |
| [009-scalar-mismatch](./koans/009-scalar-mismatch.yaml) | The model sends "3" where the schema says number — a coercible scalar mismatch. Whatever the process, the user's expectation must be met: the tool ends up correctly invoked and the run completes. Two processes are acceptable: coerce the argument and invoke immediately, or reject it, report back, and let the model correct itself. |
| [010-empty-schema-tool](./koans/010-empty-schema-tool.yaml) | A tool whose input_schema declares an object with no properties. The agent must accept and correctly invoke it with empty arguments, not reject the call as if the schema demanded something. |
| [011-direct-answer](./koans/011-direct-answer.yaml) | Tools are offered but the model's first response is a bare text answer, with no tool call. The agent must not force tool use — no tool_choice coercion, no looping until a tool is called — and must report the answer as soon as the model gives one. |
| [012-give-up-on-persistent-5xx](./koans/012-give-up-on-persistent-5xx.yaml) | A 5xx tool failure must reach the model as a tool error, same as a 4xx. The model may give up instead of asking for a retry; unlike 003, there is no follow-up call. The agent must not retry on its own — exactly one tool invocation is made, and the run still completes. |
| [013-model-api-failure](./koans/013-model-api-failure.yaml) | The model endpoint rejects the request with 401. The agent must not re-issue it and must end the run as failed. |
| [014-malformed-arguments](./koans/014-malformed-arguments.yaml) | The model emits a tool call whose arguments are not valid JSON. The call must never reach the tool server; reported back, the model corrects itself. |
| [015-parallel-tool-calls](./koans/015-parallel-tool-calls.yaml) | The model requests two independent tools in one response (one assistant message, two tool_calls). The agent must invoke both — in any order, sequentially or concurrently — close each with its own tool message, and only then report the combined answer. |
| [016-model-request-budget](./koans/016-model-request-budget.yaml) | The run declares a model-request budget and the model never converges within it. The agent must not exceed the budget and must end the run as aborted. The tool call instructed by the last permitted response may be skipped or finished — both processes stay within the budget. |
| [017-partial-batch-failure](./koans/017-partial-batch-failure.yaml) | One call of a parallel batch succeeds and the other fails. Both must be closed with their own result, the failure reaching the model, and the model's retry must target only the failed call. |
| [018-abort](./koans/018-abort.yaml) | The caller aborts a run in progress. The agent must stop asking the world for anything and settle the run as aborted. |
| [019-late-abort](./koans/019-late-abort.yaml) | An abort that arrives after the run has settled must not rewrite the committed result. |
| [020-subagent-briefing](./koans/020-subagent-briefing.yaml) | The parent delegates one lookup to a subagent. The briefing is the child's whole world: the child must see only its briefing, and the parent must see only the child's final answer — none of the child's intermediate work. |
| [021-subagent-file-handoff](./koans/021-subagent-file-handoff.yaml) | Context crosses to a subagent through a file instead of the briefing. The child reads the named workspace file with the agent's own tool — the mock tool server is never involved — and the file's content must reach the child's next model request. |
| [022-follow-up](./koans/022-follow-up.yaml) | A follow-up prompt to the same conversation. The agent must carry the earlier exchange into the next turn. |
| [023-undeclared-argument](./koans/023-undeclared-argument.yaml) | The schema declares only "city", but the model's call also carries "units", a field the schema never mentioned. Dropping an argument the schema did not declare is forbidden: the tool request must carry both, unchanged, and the run completes normally. |
| [024-parallel-delegation](./koans/024-parallel-delegation.yaml) | One model response delegates to two subagents at once — a parallel group of delegations. Both children must run; the parent's next request must carry both finals, and neither child's own intermediate values — its tool results, distinguishable per child here — may reach the parent or the other child. |
| [025-subagent-budget](./koans/025-subagent-budget.yaml) | A delegate's model requests draw from the same budget as the main conversation, not a fresh one of its own. The budget is exhausted by the main request plus the child's two, right as the child answers — so the parent never gets to make its own next request to report that answer, and the whole run must end aborted. |
| [026-workspace-read](./koans/026-workspace-read.yaml) | The main conversation reads a workspace file directly, with no subagent involved. "read_file" names a tool the run did not declare, so it must not reach the tool server; naming a given.files entry as args.path marks it instead as the agent's own internal read, whose content must flow into the conversation's next model request and the final answer. |

<!-- koan-index:end -->

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
