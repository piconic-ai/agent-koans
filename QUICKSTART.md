# Quickstart

How to connect your agent to the harness and run the suite. The
normative contract is [SPEC.md](./SPEC.md); this page is the short
path to a first green run.

## The HTTP surface

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

## Environment variables

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

## Run the suite

```sh
pnpm install
AGENT_CMD="<command that starts your agent>" AGENT_CWD="<its directory>" pnpm test
```

Plain `pnpm test` runs the suite against everything in `examples/` —
reference implementations of the contract, with and without an agent
framework. Start from one of them.
