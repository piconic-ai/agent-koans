# agent-koans

**agent-koans** — a *koan* (公案, pronounced "KOH-ahn") is a short Zen
question that tests true understanding — is a framework-agnostic
conformance suite for AI agent implementations.

When an agent fails, the cause is either the model or the code around
it. Evals measure both at once; agent-koans isolates the code. Each
**koan** is a deterministic black-box test: the harness starts your
agent, plays the model's part with a scripted mock, and checks your
code's behavior over HTTP. There are no real LLM calls, so a failing
koan always means a bug in the implementation — never bad luck with
the model. Any framework, any runtime: satisfy the contract and you
pass.

The contract lives in [SPEC.md](./SPEC.md).

## Usage

Your agent is an HTTP server with three endpoints. This is the whole
surface — [openapi.yaml](./openapi.yaml) has the exact wire format:

```ts
app.get('/health', (c) => c.json({ status: 'ok' }));

app.post('/runs', async (c) => {
  const { task, tools } = await c.req.json();
  const run = agent.startRun(task.prompt, tools ?? []);
  return c.json({ run_id: run.run_id }, 202); // run executes async
});

app.get('/runs/:id', (c) => {
  const run = agent.getRun(c.req.param('id'));
  if (!run) return c.json({ error: 'run not found' }, 404);
  return c.json(run); // { status, output, ... }
});
```

The harness tells your agent where the mock servers are through
environment variables. Read them at startup:

```ts
const config = {
  port: Number(process.env.PORT),
  model: {
    baseUrl: process.env.OPENAI_BASE_URL, // mock LLM (OpenAI-compatible)
    apiKey: process.env.OPENAI_API_KEY,
  },
  tools: {
    baseUrl: process.env.KOAN_TOOLS_URL, // mock tool server
  },
};
```

Each koan is a YAML file: a task, a scripted conversation, and the
expected outcome. `koans/tool-reliability/001-happy-path.yaml` for
example:

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

Run the suite against your agent:

```sh
pnpm install
AGENT_CMD="<command that starts your agent>" AGENT_CWD="<its directory>" pnpm test
```

Plain `pnpm test` runs the suite against everything in `examples/` —
reference implementations of the contract, with and without an agent
framework. Start from one of them.

## Repository

| Path        | Contents                                                    |
| ----------- | ----------------------------------------------------------- |
| `SPEC.md`   | The conformance contract — the real deliverable             |
| `openapi.yaml` | Wire format of the agent HTTP interface (OpenAPI 3.1)    |
| `koans/`    | The tests, as declarative YAML                              |
| `runner/`   | Mock LLM server (OpenAI-compatible), mock tool server, harness |
| `examples/` | Implementations that pass                                   |
