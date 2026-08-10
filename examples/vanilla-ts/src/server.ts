// Composition root + HTTP adapter: wires config into the agent and
// exposes it behind the conformance contract's endpoints (SPEC.md §3).
// Hono is used for HTTP routing only.
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createAgent, type RunLimits, type SubagentDef, type ToolDef } from './agent.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const agent = createAgent({ model: config.model, tools: config.tools, workspace: config.workspace });

const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok' }));

app.post('/runs', async (c) => {
  const body = await c.req
    .json<{ task?: { prompt?: string }; tools?: ToolDef[]; subagents?: SubagentDef[]; limits?: RunLimits }>()
    .catch(() => null);
  const prompt = body?.task?.prompt;
  if (typeof prompt !== 'string') {
    return c.json({ error: 'task.prompt is required' }, 400);
  }
  // The run executes asynchronously; the caller polls GET /runs/{id}.
  const run = agent.startRun(prompt, body?.tools ?? [], body?.subagents ?? [], body?.limits);
  return c.json({ run_id: run.run_id }, 202);
});

app.get('/runs/:id', (c) => {
  const run = agent.getRun(c.req.param('id'));
  if (!run) return c.json({ error: 'run not found' }, 404);
  return c.json(run);
});

app.post('/runs/:id/abort', (c) => {
  const known = agent.abortRun(c.req.param('id'));
  if (!known) return c.json({ error: 'run not found' }, 404);
  return c.json({}, 202);
});

serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`vanilla-ts agent listening on :${config.port}`);
});
