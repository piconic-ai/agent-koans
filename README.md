# agent-koans

**agent-koans** — a *koan* (公案, pronounced "KOH-ahn") is a short Zen
question that tests true understanding — is a framework-agnostic
conformance suite for AI agent implementations.

When an agent fails, the cause is either the model or the code around
it. Evals measure both at once; agent-koans isolates the code. Each
**koan** is a deterministic black-box test: the harness starts your
agent, plays the model's part with a scripted mock, and checks your
code's behavior over HTTP. There are no real LLM calls, so a failing
koan always means a bug in the agent implementation. Any framework,
any runtime: satisfy the contract and you pass.

The contract lives in [SPEC.md](./SPEC.md).

## Koans and the runner

A koan is a YAML file: a task, a scripted conversation, and the
expected outcome. The simplest one,
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

The runner turns each file into a test. Point it at the command that
starts your agent; it plays the model's turns from the script, serves
the tool responses, and checks the outcome:

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

## Quickstart

Your agent is an HTTP server with three endpoints; the harness starts
it and drives it. [QUICKSTART.md](./QUICKSTART.md) shows the endpoints
and the environment variables, then it comes down to:

```sh
AGENT_CMD="<command that starts your agent>" AGENT_CWD="<its directory>" pnpm test
```

Plain `pnpm test` runs the suite against everything in `examples/` —
reference implementations of the contract, with and without an agent
framework. Start from one of them.

## Repository

| Path        | Contents                                                    |
| ----------- | ----------------------------------------------------------- |
| `SPEC.md`   | The conformance contract — the real deliverable             |
| `QUICKSTART.md` | How to connect your agent and run the suite             |
| `openapi.yaml` | Wire format of the agent HTTP interface (OpenAPI 3.1)    |
| `koans/`    | The tests, as declarative YAML                              |
| `runner/`   | Mock LLM server (OpenAI-compatible), mock tool server, harness |
| `examples/` | Implementations that pass                                   |
