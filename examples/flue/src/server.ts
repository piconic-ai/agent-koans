// Composition root + HTTP adapter: boots the Flue runtime in-process and
// exposes the agent behind the conformance contract's endpoints (SPEC.md §3).
// Hono is used for HTTP routing only.
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { AgentRunError, init } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import { Assistant, type AssistantData } from './agents/assistant.js';
import { armBudget, budgetTripped } from './budget.js';
import { loadConfig } from './config.js';
import { createKoanProvider } from './provider.js';
import type { RunToolDef } from './tools.js';

interface RunLimits {
  max_model_requests?: number;
}

const config = loadConfig();

// No persistence configured: each process only needs to survive one run.
await start({
  agents: [Assistant],
  providers: [createKoanProvider(config.model)],
});

interface Run {
  run_id: string;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  output?: string;
  error?: string;
}

const runs = new Map<string, Run>();

function startRun(prompt: string, tools: RunToolDef[], limits?: RunLimits): Run {
  const run: Run = { run_id: `r_${crypto.randomUUID()}`, status: 'running' };
  runs.set(run.run_id, run);
  armBudget(limits?.max_model_requests);
  void (async () => {
    try {
      // No id passed to init(): each run gets an isolated conversation,
      // never reusing another run's state.
      const agent = init(Assistant);
      const initialData: AssistantData = { tools, toolsBaseUrl: config.tools.baseUrl };
      const receipt = await agent.dispatch({ message: prompt, initialData });
      const reply = await agent.read(receipt);
      run.status = 'completed';
      run.output = reply.text;
    } catch (err) {
      // Terminal-state guarantee: errors end the run, they never strand it.
      // A budget stop is this agent giving up, not an error: aborted.
      run.status = budgetTripped()
        ? 'aborted'
        : err instanceof AgentRunError
          ? err.outcome
          : 'failed';
      run.error = err instanceof Error ? err.message : String(err);
    }
  })();
  return run;
}

const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok' }));

app.post('/runs', async (c) => {
  const body = await c.req
    .json<{ task?: { prompt?: string }; tools?: RunToolDef[]; limits?: RunLimits }>()
    .catch(() => null);
  const prompt = body?.task?.prompt;
  if (typeof prompt !== 'string') {
    return c.json({ error: 'task.prompt is required' }, 400);
  }
  // The run executes asynchronously; the caller polls GET /runs/{id}.
  const run = startRun(prompt, body?.tools ?? [], body?.limits);
  return c.json({ run_id: run.run_id }, 202);
});

app.get('/runs/:id', (c) => {
  const run = runs.get(c.req.param('id'));
  if (!run) return c.json({ error: 'run not found' }, 404);
  return c.json(run);
});

serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`flue agent listening on :${config.port}`);
});
