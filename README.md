# agent-koans

**agent-koans** — a *koan* (公案, pronounced "KOH-ahn") is a short Zen
question that tests true understanding — is a framework-agnostic
conformance suite for AI agent implementations.

When an agent fails, the cause is either the model or the code around
it. Evals measure both at once; agent-koans isolates the code: it
plays the model's part with a scripted mock, so a failing koan always
means a bug in the agent implementation. Any framework, any runtime:
satisfy the contract ([SPEC.md](./SPEC.md)) and you pass.

## What is a koan

A deterministic black-box test, written as YAML: a task, a scripted
conversation, and the expected outcome. The simplest one,
[001-happy-path.yaml](./koans/tool-reliability/001-happy-path.yaml):

```yaml
given:
  task: "Get the current weather in Tokyo and report it."
  tools:
    get_weather:
      description: "Look up current weather for a city"
      input_schema:
        type: object
        properties:
          city: { type: string }
        required: [city]

when:
  - request: model
    response: { tool: get_weather, args: { city: "Tokyo" } }
  - request: { tool: get_weather }
    response: { status: 200, body: { temp: 31 } }
  - request: model
    response: "The weather in Tokyo is 31°C."

then:
  run:
    status: completed
    output: { contains: "31" }
```

Other koans probe the rest of the tool-calling contract: transient
tool failures, a tool name the model typo'd, bad arguments, multi-tool
sequences. Browse [koans/](./koans/) — each file is self-describing.

## How to use

Point the runner at the command that starts your agent. It runs every
koan: starts the agent, plays the scripted turns, and checks the
outcome:

```console
$ npx agent-koans --agent "node dist/server.js"
ok    lifecycle/000-plain-completion
ok    tool-reliability/001-happy-path
FAIL  tool-reliability/003-retry-on-transient-failure
      unexpected invocation of tool "get_weather": the timeline
      permits no tool call here
...
9/10 passed
```

Your agent is an HTTP server; [openapi.yaml](./openapi.yaml) defines
its three endpoints and [SPEC.md](./SPEC.md) the rules. No server yet?
Paste this prompt into your coding agent:

```text
Build an HTTP server that passes the agent-koans conformance suite.
Wire format: https://raw.githubusercontent.com/piconic-ai/agent-koans/main/openapi.yaml
Rules: https://raw.githubusercontent.com/piconic-ai/agent-koans/main/SPEC.md
The server reads PORT, OPENAI_BASE_URL, OPENAI_API_KEY and
KOAN_TOOLS_URL from the environment, serves GET /health, POST /runs
and GET /runs/{id}, and calls the model with an OpenAI-compatible
client pointed at OPENAI_BASE_URL.
```

`examples/` holds reference implementations of the contract, with and
without an agent framework. Start from one of them, or run `pnpm test`
in this repository to see the suite pass against all of them.

## Repository

| Path        | Contents                                                    |
| ----------- | ----------------------------------------------------------- |
| `SPEC.md`   | The conformance contract — the real deliverable             |
| `openapi.yaml` | Wire format of the agent HTTP interface (OpenAPI 3.1)    |
| `koans/`    | The tests, as declarative YAML                              |
| `runner/`   | Mock LLM server (OpenAI-compatible), mock tool server, harness |
| `examples/` | Implementations that pass                                   |
