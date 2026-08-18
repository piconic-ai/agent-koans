// Composition root + HTTP adapter: boots the Flue runtime in-process and
// exposes the agent behind the conformance contract's endpoints (SPEC.md §3).
// Hono is used for HTTP routing only.
import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { AgentRunError, type AgentInstanceHandle, init, observe } from '@flue/runtime';
import { sqlite, start } from '@flue/runtime/node';
import { Assistant, type AssistantData, type RunContext } from './agents/assistant.js';
import { armBudget, budgetTripped } from './budget.js';
import { armWindow, noteFoldFailed, noteUsed } from './window.js';
import { armDuration, declaredDuration } from './duration.js';
import { compactConversation } from './compaction.js';
import { loadConfig } from './config.js';
import { createKoanProvider } from './provider.js';
import type { RunSubagentDef } from './subagents.js';
import type { RunToolDef } from './tools.js';

interface RunLimits {
  max_model_requests?: number;
  max_duration_ms?: number;
}

const config = loadConfig();

// The runner always provides KOAN_STATE_DIR, so this only matters for
// the dev fallback — but runs.json below must not lean on the store
// happening to create the directory as a side effect.
fs.mkdirSync(config.state.dir, { recursive: true });

// Durable across a crash (SPEC.md §3): Flue's own store lives in the
// run's state directory, so a restarted process finds every admitted
// submission — the coordinator resumes them before start() resolves.
await start({
  agents: [Assistant],
  providers: [createKoanProvider(config.model)],
  db: sqlite(path.join(config.state.dir, 'flue.db')),
});

interface Run {
  run_id: string;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  output?: string;
  error?: string;
  /** What the run did that its caller has to be able to show (SPEC.md §3). */
  events: Array<{ type: 'compaction'; phase: 'started' | 'completed' | 'failed'; error?: string }>;
}

const runs = new Map<string, Run>();
// Flue names the agent instance, the conformance contract names the run;
// this is the join between them, so a runtime event can be attributed to
// the run whose caller has to see it.
const runsByInstance = new Map<string, Run>();

/**
 * What this adapter itself must remember across a crash: Flue restores
 * conversations and submissions on its own, but the run vocabulary —
 * run_id, the caller-visible status/output/events, and what a recovery
 * would re-dispatch — is the adapter's, so it is written to the state
 * directory on every mutation and reloaded at boot.
 */
interface RunRow {
  run: Run;
  prompt: string;
  initialData: AssistantData;
  limits?: RunLimits;
}

const rows = new Map<string, RunRow>();
const stateFile = path.join(config.state.dir, 'runs.json');

// Temp-then-rename, so a crash mid-write never truncates the record it
// was meant to protect.
function saveRuns(): void {
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify([...rows.values()]));
  fs.renameSync(tmp, stateFile);
}

function loadRunRows(): RunRow[] {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8')) as RunRow[];
  } catch {
    // A first boot has no file yet; nothing to recover either way.
    return [];
  }
}

// Flue reports a fold as `compaction_start` followed by exactly one
// terminal `compaction`, which is the shape SPEC.md §3 asks a run to
// expose — so this listener only forwards it, and does not have to know
// when the runtime decided to fold.
observe((observation, ctx) => {
  const run = ctx.id === undefined ? undefined : runsByInstance.get(ctx.id);
  if (!run) return;
  if (observation.type === 'turn' && observation.purpose === 'agent' && observation.response?.usage) {
    noteUsed(observation.response.usage.input);
  }
  if (observation.type === 'compaction_start') {
    run.events.push({ type: 'compaction', phase: 'started' });
    saveRuns();
  } else if (observation.type === 'compaction') {
    const failed = observation.isError === true;
    if (failed) noteFoldFailed();
    run.events.push({
      type: 'compaction',
      phase: failed ? 'failed' : 'completed',
      ...(failed ? { error: reasonOf(observation.error) } : {}),
    });
    saveRuns();
  }
});

// Not `String(error)`: Flue serializes a failed fold's cause as an object
// ({ name, message, ... }), which stringifies to "[object Object]" — the
// one thing a caller cannot decide from.
function reasonOf(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error ?? 'compaction failed');
}
// The per-run agent handle, kept for the run's whole process lifetime —
// not just while a turn is in flight. The abort endpoint needs it to call
// the handle's own abort(); a follow-up prompt (SPEC.md §3) needs it to
// dispatch into the SAME durable conversation instead of a fresh one.
const handles = new Map<string, AgentInstanceHandle>();

// Runs (or re-runs, for a follow-up) one turn: dispatches `prompt` to
// `agent` and settles `run` from the reply. `initialData` is passed only
// on the turn that creates the instance — Flue itself ignores it on any
// later dispatch to an existing one, so this is just for clarity here.
function runTurn(
  run: Run,
  agent: AgentInstanceHandle,
  prompt: string,
  initialData?: AssistantData,
  idempotencyKey?: string,
): void {
  void (async () => {
    // The declared budget covers this one submission (SPEC.md §3) and
    // restarts fresh for every prompt, so the timer is armed here, on
    // every call, rather than once for the run. Not Flue's own
    // durability timeout (`timeoutMs` / DURABILITY_DEFAULT_TIMEOUT_MS):
    // that fires on the coordinator's reconciliation cadence, far too
    // coarse for a seconds-scale declared budget, and it settles the
    // submission `failed` (reason `exceeded_timeout`) where this wire
    // contract asks for `aborted`.
    const budgetMs = declaredDuration();
    const timer = budgetMs === undefined ? undefined : setTimeout(() => void agent.abort(), budgetMs);
    try {
      // The key makes the dispatch safe to repeat: a recovery after a
      // crash re-sends it and converges on the submission the dead
      // process already opened, instead of opening a second turn.
      const receipt = await agent.dispatch({
        message: prompt,
        ...(initialData !== undefined ? { initialData } : {}),
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      });
      const reply = await agent.read(receipt);
      run.status = 'completed';
      run.output = reply.text;
    } catch (err) {
      // Terminal-state guarantee: errors end the run, they never strand it.
      // A budget stop is this agent giving up, not an error: aborted.
      // A durable abort (handle.abort() from the caller's own request, or
      // from the declared-duration timer above) rejects read() with
      // AgentRunError outcome 'aborted', which this same branch maps.
      run.status = budgetTripped()
        ? 'aborted'
        : err instanceof AgentRunError
          ? err.outcome
          : 'failed';
      run.error = err instanceof Error ? err.message : String(err);
    } finally {
      saveRuns();
      // Cleared on every settlement, not just the timer's own firing: a
      // turn that settles for any other reason must never leave a timer
      // that could later abort a following, unrelated turn.
      if (timer !== undefined) clearTimeout(timer);
    }
  })();
}

function startRun(
  prompt: string,
  tools: RunToolDef[],
  subagents: RunSubagentDef[],
  limits?: RunLimits,
  context?: RunContext,
  runId?: string,
): Run {
  // A named run that already exists is the caller's identical resend
  // (SPEC.md §3): answer with the run it already started — no second
  // instance, no re-armed limits.
  const existing = runId === undefined ? undefined : runs.get(runId);
  if (existing !== undefined) return existing;
  const run: Run = { run_id: runId ?? `r_${crypto.randomUUID()}`, status: 'running', events: [] };
  runs.set(run.run_id, run);
  armBudget(limits?.max_model_requests);
  armWindow(context?.window);
  armDuration(limits?.max_duration_ms);
  // The instance is addressed by the run's own name — minted or
  // caller-named alike — so a restarted process can find it again
  // (SPEC.md §3 crash recovery). `uid: null` keeps this send create-only:
  // a name that somehow reached a live instance this process does not
  // know fails loudly (AgentInstanceExistsError) rather than silently
  // joining another run's conversation.
  const agent = init(Assistant, { id: run.run_id, uid: null });
  handles.set(run.run_id, agent);
  runsByInstance.set(agent.id, run);
  const initialData: AssistantData = {
    runId: run.run_id,
    tools,
    toolsBaseUrl: config.tools.baseUrl,
    subagents,
    workspaceDir: config.workspace.dir,
    context,
  };
  rows.set(run.run_id, { run, prompt, initialData, ...(limits !== undefined ? { limits } : {}) });
  // On record before the dispatch: a crash between the two must still
  // leave a row to recover from.
  saveRuns();
  runTurn(run, agent, prompt, initialData, run.run_id);
  return run;
}

// Re-attach what a previous process left behind. Flue is already driving
// every admitted submission (reconciliation ran inside start()); this
// loop only rebuilds the adapter's own join and re-issues the keyed
// dispatch, which converges on the submission the dead process opened —
// read() then maps its settlement onto the run the caller is polling.
// The stored prompt is the opening one: the koans that script a crash
// are single-turn, and a follow-up-aware recovery is not built until a
// koan needs it.
for (const row of loadRunRows()) {
  const run = row.run;
  rows.set(run.run_id, row);
  runs.set(run.run_id, run);
  const agent = init(Assistant, { id: run.run_id });
  handles.set(run.run_id, agent);
  runsByInstance.set(agent.id, run);
  if (run.status === 'running') {
    armBudget(row.limits?.max_model_requests);
    armWindow(row.initialData.context?.window);
    armDuration(row.limits?.max_duration_ms);
    runTurn(run, agent, row.prompt, row.initialData, run.run_id);
  }
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
  saveRuns();
  runTurn(run, agent, prompt);
  return true;
}

// A fold already running is what a second ask joins rather than starting
// a second one (SPEC.md §3): set for as long as one is in flight, so an
// ask that lands inside that window just awaits it.
const folding = new Map<string, Promise<void>>();

/**
 * Fold this run's conversation down, because its caller asked (SPEC.md
 * §3). Returns `false` when `runId` is unknown, so the caller can answer
 * 404.
 */
async function compactRun(runId: string, instructions?: string): Promise<boolean> {
  const agent = handles.get(runId);
  if (!agent) return false;
  let inFlight = folding.get(runId);
  if (inFlight === undefined) {
    inFlight = compactConversation(runId, agent.id, instructions)
      .catch(() => {
        // Not rethrown: a failed fold owes a report, not an error at the
        // asking, and the observer above already recorded it.
      })
      .finally(() => {
        folding.delete(runId);
      });
    folding.set(runId, inFlight);
  }
  await inFlight;
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
      run_id?: string;
      tools?: RunToolDef[];
      subagents?: RunSubagentDef[];
      limits?: RunLimits;
      context?: RunContext;
    }>()
    .catch(() => null);
  const prompt = body?.prompt;
  if (typeof prompt !== 'string') {
    return c.json({ error: 'prompt is required' }, 400);
  }
  // The run executes asynchronously; the caller polls GET /runs/{id}.
  const run = startRun(
    prompt,
    body?.tools ?? [],
    body?.subagents ?? [],
    body?.limits,
    body?.context,
    typeof body?.run_id === 'string' && body.run_id.length > 0 ? body.run_id : undefined,
  );
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

app.post('/runs/:id/compact', async (c) => {
  const body = await c.req.json<{ instructions?: string }>().catch(() => null);
  const known = await compactRun(c.req.param('id'), body?.instructions);
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
