# agent-koans

[![npm version](https://img.shields.io/npm/v/agent-koans.svg)](https://www.npmjs.com/package/agent-koans)
[![CI](https://github.com/piconic-ai/agent-koans/actions/workflows/ci.yml/badge.svg)](https://github.com/piconic-ai/agent-koans/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**agent-koans** — a *koan* (公案, pronounced "KOH-ahn") is a short Zen
question that tests true understanding — is a framework-agnostic
conformance suite for AI agent implementations.

Your AI agent misbehaves. Was it the model, the prompt, or your code?
Evals cannot tell — they measure the three together. agent-koans
isolates your code: a failing koan always means a bug in the agent
implementation, never the model or the prompt. Any framework, any
runtime: satisfy the contract and you pass.

## What is a koan

A deterministic black-box test, written as YAML: a task, a scripted
conversation, and the expected outcome. The simplest one,
[001-happy-path.yaml](./koans/001-happy-path.yaml):

```yaml
given:
  tools:
    get_weather:
      description: "Look up current weather for a city"
      input_schema:
        type: object
        properties:
          city: { type: string }
        required: [city]

prompt: "Get the current weather in Tokyo and report it."

when:
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

Other koans probe the rest of the tool-calling contract: transient
tool failures, a tool name the model typo'd, bad arguments, multi-tool
sequences. Browse [koans/](./koans/) — each file is self-describing.

## How to use

Test whether your agent satisfies every koan:

```console
$ npx agent-koans --agent "node dist/server.js"
ok    000-plain-completion
ok    001-happy-path
FAIL  003-retry-on-transient-failure
      unexpected invocation of tool "get_weather": the timeline
      permits no tool call here
...
9/10 passed
```

To run the suite, your agent needs to be an HTTP server:
[openapi.yaml](./openapi.yaml) defines the endpoints and
[SPEC.md](./SPEC.md) the rules. No server yet? Paste this prompt into
your coding agent:

```text
Build an HTTP server that passes the agent-koans conformance suite.
Wire format: https://raw.githubusercontent.com/piconic-ai/agent-koans/main/openapi.yaml
Rules: https://raw.githubusercontent.com/piconic-ai/agent-koans/main/SPEC.md
The server reads PORT, OPENAI_BASE_URL, OPENAI_API_KEY,
KOAN_TOOLS_URL and KOAN_WORKSPACE from the environment, serves
GET /health, POST /runs, GET /runs/{id}, POST /runs/{id}/prompts and
POST /runs/{id}/abort, and calls the model with an OpenAI-compatible
client pointed at OPENAI_BASE_URL.
```

`examples/` holds reference implementations of the contract, with and
without an agent framework. Start from one of them, or run `pnpm test`
in this repository to see the suite pass against all of them.

## Custom koans and skips

The default `npx agent-koans --agent "..."` run needs no config file.
For advanced use, drop an `agent-koans.yaml` next to where you run the
CLI — it is picked up automatically, or pointed at with `--config`:

```yaml
skip:
  # koan id -> reason; a reason is required, so a skip never rots silently
  009-scalar-mismatch: "pi-ai coerces scalars before validation (upstream #12)"
add:
  - ./my-koans
```

Added koans get ids prefixed by their directory's basename (e.g.
`my-koans/001-refund-idempotency`), so they can never collide with the
bundled suite, and the summary reports them separately — a conformance
claim against the published suite always stays distinct from your own
koans.

## Repository

| Path        | Contents                                                    |
| ----------- | ----------------------------------------------------------- |
| `SPEC.md`   | The conformance contract — the real deliverable             |
| `openapi.yaml` | Wire format of the agent HTTP interface (OpenAPI 3.1)    |
| `koans/`    | The tests, as declarative YAML                              |
| `src/`      | The runner: mock LLM server (OpenAI-compatible), mock tool server, CLI |
| `examples/` | Implementations that pass                                   |
