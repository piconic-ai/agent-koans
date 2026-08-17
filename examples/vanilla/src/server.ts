// Composition root + HTTP adapter: wires config into the agent and
// exposes it behind the conformance contract's endpoints (SPEC.md §3).
// Hono is used for HTTP routing only.
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createAgent, type RunSetup } from './agent/index.js';
import { assistant } from './assistant.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const agent = createAgent(assistant(config), config);

const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok' }));

app.post('/runs', async (c) => {
  const body = await c.req.json<{ prompt?: string; run_id?: string } & Partial<RunSetup>>().catch(() => null);
  const prompt = body?.prompt;
  if (typeof prompt !== 'string') {
    return c.json({ error: 'prompt is required' }, 400);
  }
  // The run executes asynchronously; the caller polls GET /runs/{id}.
  const run = agent.startRun(
    prompt,
    {
      tools: body?.tools ?? [],
      subagents: body?.subagents ?? [],
      limits: body?.limits,
      context: body?.context,
    },
    typeof body?.run_id === 'string' && body.run_id.length > 0 ? body.run_id : undefined,
  );
  return c.json({ run_id: run.run_id }, 202);
});

app.get('/runs/:id', (c) => {
  const run = agent.getRun(c.req.param('id'));
  if (!run) return c.json({ error: 'run not found' }, 404);
  return c.json(run);
});

app.post('/runs/:id/prompts', async (c) => {
  const body = await c.req.json<{ prompt?: string }>().catch(() => null);
  const prompt = body?.prompt;
  if (typeof prompt !== 'string') {
    return c.json({ error: 'prompt is required' }, 400);
  }
  const known = agent.sendPrompt(c.req.param('id'), prompt);
  if (!known) return c.json({ error: 'run not found' }, 404);
  return c.json({}, 202);
});

app.post('/runs/:id/compact', async (c) => {
  const body = await c.req.json<{ instructions?: string }>().catch(() => null);
  const known = await agent.compactRun(c.req.param('id'), body?.instructions);
  if (!known) return c.json({ error: 'run not found' }, 404);
  return c.json({}, 200);
});

app.post('/runs/:id/abort', (c) => {
  const known = agent.abortRun(c.req.param('id'));
  if (!known) return c.json({ error: 'run not found' }, 404);
  return c.json({}, 202);
});

serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`vanilla agent listening on :${config.port}`);
});
