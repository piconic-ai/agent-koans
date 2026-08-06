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

The agent under test is a black box behind an HTTP interface. The harness
observes it from both sides:

```
harness ──(1) POST /runs──────────▶ agent under test (black box)
                                        │
   mock LLM server ◀──(2) chat/completions──┤
   mock tool server ◀──(3) invoke/{tool}────┘
```

1. The harness submits a task and the tool definitions.
2. The agent talks to a **mock LLM server** (OpenAI Chat Completions
   compatible) instead of a real model. The mock replies from a per-koan
   script.
3. The agent executes tools against a **mock tool server** whose responses
   are likewise scripted.

Most assertions run against the *received requests* of (2) and (3): retry
counts, argument fidelity, and context handling are verified without
touching the implementation's internals.

## 2. Environment

The harness launches the agent process with these environment variables:

| Variable          | Meaning                                                        |
| ----------------- | -------------------------------------------------------------- |
| `PORT`            | Port the agent MUST listen on                                  |
| `OPENAI_BASE_URL` | Base URL of the mock LLM server (includes the `/v1` prefix)    |
| `OPENAI_API_KEY`  | Dummy credential; MUST be sent but is not validated            |
| `KOAN_TOOLS_URL`  | Base URL of the mock tool server                               |

The agent MUST direct all model calls to `OPENAI_BASE_URL` and all tool
executions to `KOAN_TOOLS_URL`.

## 3. Agent HTTP interface

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
errors. A run that stays `running` past the harness timeout fails the koan.

Unknown `run_id` SHOULD return `404`.

## 4. Model interaction

The agent talks to the model via the OpenAI Chat Completions API
(`POST {OPENAI_BASE_URL}/chat/completions`, non-streaming). The mock LLM
responds from the koan's script; each incoming request is matched against
the next script entry.

Requirements:

- **R1 — Tool definitions.** When the run was submitted with tools, every
  model request MUST include function definitions for all of them.
- **R2 — Tool results.** After executing a tool call, the agent MUST append
  a `role: "tool"` message whose `tool_call_id` matches the model's tool
  call, and send the updated conversation back to the model.
- **R3 — Error reporting.** When a tool call fails — the tool server
  returned status ≥ 400, or the arguments failed validation — the failure
  MUST be reported back to the model as a `role: "tool"` message whose
  content includes the word `error` (case-insensitive), along with
  available detail (status code, error body, or validation message).
- **R4 — No implicit retries.** The agent MUST NOT retry a failed tool
  call on its own. Retry decisions belong to the model: report the error
  (R3) and let the model decide. One model tool call maps to at most one
  tool server invocation.
- **R5 — Bounded loops.** The agent MUST bound the number of model steps
  per run and terminate the run (terminal-state guarantee) when the bound
  is exceeded.

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
Keys are actor names (`model`, `tools`); verbs live in the entries.

```yaml
name: retry-on-transient-failure
description: >
  A transient 5xx must reach the model as a tool error, and the follow-up
  call must succeed without double-firing the tool.

given:                    # the world as the agent sees it
  task: "Get the current weather in Tokyo and report it."
  tools:
    - name: get_weather
      input_schema:
        type: object
        properties: { city: { type: string } }
        required: [city]

when:                     # scripted behavior of the mocked world
  model:                  # consumed in order, one entry per model request
    - call_tool: { name: get_weather, args: { city: "Tokyo" } }
    - expecting: tool_error         # asserts what the Nth request must look like
      call_tool: { name: get_weather, args: { city: "Tokyo" } }
    - expecting: tool_result
      reply: "The weather in Tokyo is 31°C."
  tools:
    get_weather:          # consumed in order, one entry per invocation
      - respond: { status: 503, body: { error: "service_unavailable" } }
      - respond: { status: 200, body: { temp: 31 } }

then:                     # assertions
  run:
    status: completed
    output: { contains: "31" }
  tools:
    get_weather:
      last_args: { equals: { city: "Tokyo" } }
```

`given.tools` defaults to an empty list and MAY be omitted.

### 6.1 `when.model` entries

The mock LLM answers the Nth request with the Nth entry. Each entry has one
action — `reply: <text>` or `call_tool: { name, args }` — and an optional
`expecting` assertion on the incoming request:

| `expecting`   | The request must show                                       |
| ------------- | ----------------------------------------------------------- |
| `initial`     | No tool interaction yet (last message is the user task)     |
| `tool_result` | Last message is a successful `role: "tool"` result          |
| `tool_error`  | Last message is a `role: "tool"` error report (per R3)      |

A request beyond the end of the script, or one that contradicts its
`expecting`, fails the koan.

**Script consumption.** A run must consume the entire script — every
`when.model` entry and every scripted tool response, no more and no fewer.
The script length *is* the call-count assertion, so counts are never
asserted explicitly in `then`.

### 6.2 `then` matchers

Keys are nouns (actor properties); matchers are structured values. The
vocabulary is a **closed set** — no general-purpose query language:

| Matcher                 | Meaning                                  |
| ----------------------- | ---------------------------------------- |
| scalar value            | Shorthand for `equals`                   |
| `{ equals: <value> }`   | Deep equality                            |
| `{ contains: <str> }`   | Substring match                          |
| `{ matches: <regex> }`  | Regular expression match                 |

Semantic assertions: `tools.<name>.last_args`, `expecting`, and the
implicit script-consumption rule (§6.1). New verification needs are added
here as named assertions, not as generic matchers.

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
