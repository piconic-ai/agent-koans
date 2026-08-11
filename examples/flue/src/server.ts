// Composition root + HTTP adapter: boots the Flue runtime in-process and
// exposes the agent behind the conformance contract's endpoints (SPEC.md §3).
// Hono is used for HTTP routing only.
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { AgentRunError, type AgentInstanceHandle, init } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import { Assistant, type AssistantData } from './agents/assistant.js';
import { armBudget, budgetTripped } from './budget.js';
import { loadConfig } from './config.js';
import { createKoanProvider } from './provider.js';
import type { RunSubagentDef } from './subagents.js';
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
// The per-run agent handle, kept for the run's whole process lifetime —
// not just while a turn is in flight. The abort endpoint needs it to call
// the handle's own abort(); a follow-up prompt (SPEC.md §3) needs it to
// dispatch into the SAME durable conversation instead of a fresh one.
const handles = new Map<string, AgentInstanceHandle>();

// Runs (or re-runs, for a follow-up) one turn: dispatches `prompt` to
// `agent` and settles `run` from the reply. `initialData` is passed only
// on the turn that creates the instance — Flue itself ignores it on any
// later dispatch to an existing one, so this is just for clarity here.
function runTurn(run: Run, agent: AgentInstanceHandle, prompt: string, initialData?: AssistantData): void {
  void (async () => {
    try {
      const receipt = await agent.dispatch(initialData ? { message: prompt, initialData } : prompt);
      const reply = await agent.read(receipt);
      run.status = 'completed';
      run.output = reply.text;
    } catch (err) {
      // Terminal-state guarantee: errors end the run, they never strand it.
      // A budget stop is this agent giving up, not an error: aborted.
      // A durable abort (handle.abort(), below) rejects read() with
      // AgentRunError outcome 'aborted', which this same branch maps.
      run.status = budgetTripped()
        ? 'aborted'
        : err instanceof AgentRunError
          ? err.outcome
          : 'failed';
      run.error = err instanceof Error ? err.message : String(err);
    }
  })();
}

function startRun(prompt: string, tools: RunToolDef[], subagents: RunSubagentDef[], limits?: RunLimits): Run {
  const run: Run = { run_id: `r_${crypto.randomUUID()}`, status: 'running' };
  runs.set(run.run_id, run);
  armBudget(limits?.max_model_requests);
  // No id passed to init(): each run gets an isolated conversation, never
  // reusing another run's state.
  const agent = init(Assistant);
  handles.set(run.run_id, agent);
  const initialData: AssistantData = {
    tools,
    toolsBaseUrl: config.tools.baseUrl,
    subagents,
    workspaceDir: config.workspace.dir,
  };
  runTurn(run, agent, prompt, initialData);
  return run;
}

/**
 * Send a follow-up prompt to an existing run's conversation (SPEC.md
 * §3): the same handle, so Flue continues the same durable instance
 * rather than starting a fresh one. Returns `false` when `runId` is
 * unknown, so the caller can answer 404. Re-opens a run already in a
 * terminal state: `running` again until this turn itself settles. The
 * budget armed at `startRun` is run-wide (SPEC.md §3), not re-armed
 * here, so it keeps counting down across turns.
 */
function sendPrompt(runId: string, prompt: string): boolean {
  const run = runs.get(runId);
  const agent = handles.get(runId);
  if (!run || !agent) return false;
  run.status = 'running';
  run.output = undefined;
  run.error = undefined;
  runTurn(run, agent, prompt);
  return true;
}

/**
 * Request cancellation of a run (SPEC.md §3 abort guarantee). Returns
 * `false` when `runId` is unknown, so the caller can answer 404. Calling
 * abort() on an instance with no live turn in flight has nothing to
 * reject — the settled `run.status` a prior turn already committed is
 * unaffected, so a late abort stays a no-op the way it must.
 */
async function abortRun(runId: string): Promise<boolean> {
  const run = runs.get(runId);
  if (!run) return false;
  await handles.get(runId)?.abort();
  return true;
}

const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok' }));

app.post('/runs', async (c) => {
  const body = await c.req
    .json<{
      prompt?: string;
      tools?: RunToolDef[];
      subagents?: RunSubagentDef[];
      limits?: RunLimits;
    }>()
    .catch(() => null);
  const prompt = body?.prompt;
  if (typeof prompt !== 'string') {
    return c.json({ error: 'prompt is required' }, 400);
  }
  // The run executes asynchronously; the caller polls GET /runs/{id}.
  const run = startRun(prompt, body?.tools ?? [], body?.subagents ?? [], body?.limits);
  return c.json({ run_id: run.run_id }, 202);
});

app.get('/runs/:id', (c) => {
  const run = runs.get(c.req.param('id'));
  if (!run) return c.json({ error: 'run not found' }, 404);
  return c.json(run);
});

app.post('/runs/:id/prompts', async (c) => {
  const body = await c.req.json<{ prompt?: string }>().catch(() => null);
  const prompt = body?.prompt;
  if (typeof prompt !== 'string') {
    return c.json({ error: 'prompt is required' }, 400);
  }
  const known = sendPrompt(c.req.param('id'), prompt);
  if (!known) return c.json({ error: 'run not found' }, 404);
  return c.json({}, 202);
});

app.post('/runs/:id/abort', async (c) => {
  const known = await abortRun(c.req.param('id'));
  if (!known) return c.json({ error: 'run not found' }, 404);
  return c.json({}, 202);
});

serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`flue agent listening on :${config.port}`);
});
