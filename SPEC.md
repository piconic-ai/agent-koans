# agent-koans Conformance Contract

Version: 0.1.0-draft

agent-koans is a framework-agnostic conformance suite for AI agent
implementations. It verifies the *implementation* half of agent behavior —
argument validation, failure recovery, idempotent execution, context
management, termination — deterministically, with the model fully mocked.
It does not measure model capability; that is the job of evals.

An implementation conforms when it passes every koan in a released suite
version. Conformance claims MUST cite the suite version (e.g. "conforms to
agent-koans 1.x / tool-reliability").

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

The agent MUST direct all model calls to `OPENAI_BASE_URL` and all tool
executions to `KOAN_TOOLS_URL`.

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
  "task": { "prompt": "Get the current weather in Tokyo and report it." },
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

`tools` MAY be empty. `input_schema` is a JSON Schema object describing the
tool's arguments.

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

Unknown `run_id` SHOULD return `404`.

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
- **R5 — Bounded loops.** The agent MUST bound the number of model steps
  per run and terminate the run (terminal-state guarantee) when the bound
  is exceeded.
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
  to the model per R3.
- **R7 — Unknown tools.** A model tool call naming a tool that was not in
  the run's `tools` MUST NOT reach the tool server; report per R3.

## 6. Koan file format

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

given:                    # the world as the agent sees it
  task: "Get the current weather in Tokyo and report it."
  tools:                  # tool name → definition
    get_weather:
      input_schema:
        type: object
        properties: { city: { type: string } }
        required: [city]

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
  run:
    status: completed
    output: { contains: "31" }
```

`given.tools` maps tool name → definition; it defaults to empty and MAY be
omitted. The runner converts it to the wire-format list of §3.2.

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

Responses discriminate by form:

| Form                     | Meaning                                    |
| ------------------------ | ------------------------------------------ |
| bare string              | The model's text reply                     |
| `{ tool: <name>, args }` | The model's tool-call instruction          |
| `{ status, body }`       | The called party's HTTP response           |

A `{ status }` response to `request: model` scripts a **model API
failure**. Its `status` MUST be a 4xx other than 408 or 429: those two
and 5xx are auto-retried by common SDKs, which would make the trace
nondeterministic — 401 is the canonical choice. `body` MAY be omitted;
the mock then serves an OpenAI-style error envelope, since its content
is not part of the contract (R8). Such a step MUST be the last one:
after a non-retryable API failure the agent contacts no one.

**Conversation coherence.** For every model request, what the incoming
conversation must show is fully determined by the trace before it:

| Preceding trace                              | The conversation must show                                          |
| -------------------------------------------- | ------------------------------------------------------------------- |
| Nothing (first request)                      | The task; no tool interaction yet                                   |
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

### 6.2 `then` matchers

Keys are nouns (actor properties); matchers are structured values. The
vocabulary is a **closed set** — no general-purpose query language:

| Matcher                 | Meaning                                  |
| ----------------------- | ---------------------------------------- |
| scalar value            | Shorthand for `equals`                   |
| `{ equals: <value> }`   | Deep equality                            |
| `{ contains: <str> }`   | Substring match                          |
| `{ matches: <regex> }`  | Regular expression match                 |

Semantic assertions: the `request` steps and the implicit trace rules
(§6.1). New verification needs are added here as named assertions, not as
generic matchers.

### 6.3 Alternative processes (`one_of`)

Some contracts are outcome-level: more than one process legitimately
reaches the user's expected result. Such a koan replaces its top-level
`when` with `one_of`, a mapping of variant name → trace, where each trace
has exactly the shape of `when`. `given` and `then` stay single and
shared — the variants may differ only in process, by construction.

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
interaction shape itself (e.g. future concurrent conversation logs).

## 7. Versioning

The suite is versioned as a whole (semver):

- **major** — incompatible SPEC changes, or changes to the meaning of an
  existing koan
- **minor** — new koans or chapters; existing koans unchanged
- **patch** — fixes that do not affect any pass/fail outcome

Published koans are immutable: to change a koan's contract line, add a new
koan that supersedes it and deprecate the old one (removed at the next
major). Consumers SHOULD pin a suite version, upgrade deliberately, and
track known failures in a skiplist with reasons rather than mixing koan
versions.
