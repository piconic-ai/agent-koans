// The run lifecycle: what a caller submitted, what it may ask about it
// afterwards, and the turns that answer. What belongs here is the run
// record, the queue of turns, and the wiring of one run's parts; what does
// not is any step of a turn itself — that is the loop (conversation.ts).
import { createBudget } from './budget.js';
import { fold, type RunEvent } from './compaction.js';
import { runConversation, type Conversation, type RunScope } from './conversation.js';
import { createModelClient } from './model.js';
import { createReadFileTool } from './read-file.js';
import { createSubagentTool, type Delegate, type SubagentDef } from './subagents.js';
import { createDeclaredTool, type Tool, type ToolDef } from './tools.js';
import type { RunContext } from './window.js';

interface Run {
  run_id: string;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  output?: string;
  error?: string;
  /** What the run did that its caller has to be able to show (SPEC.md §3). */
  events: RunEvent[];
}

export interface RunLimits {
  max_model_requests?: number;
}

// Everything a run needs across turns: the conversation the caller keeps
// talking to, and the scope it was started with. Kept for the run's whole
// process lifetime, unlike `controllers` — a follow-up prompt
// (POST /runs/{id}/prompts) must find the same conversation and the same
// shared budget right where the last turn left them, not a fresh one.
interface RunSession {
  conversation: Conversation;
  scope: RunScope;
  /**
   * Prompts that arrived mid-turn. Not appended to the conversation until
   * their turn starts: the running turn would otherwise send unanswered
   * `tool_calls` followed by a user message, which no provider accepts.
   */
  queued: string[];
  /** Whether a turn is in flight; one runs at a time per run. */
  busy: boolean;
}

export function createAgent(config: {
  model: { baseUrl: string; apiKey: string; model: string };
  tools: { baseUrl: string };
  workspace: { dir: string };
}) {
  const model = createModelClient(config.model);
  const runs = new Map<string, Run>();
  const sessions = new Map<string, RunSession>();
  // One AbortController per in-flight turn, so abortRun can cancel exactly
  // that turn's outstanding fetch without touching any other run sharing
  // this process.
  const controllers = new Map<string, AbortController>();

  function startRun(
    prompt: string,
    tools: ToolDef[],
    subagents: SubagentDef[],
    limits?: RunLimits,
    context?: RunContext,
  ): Run {
    const run: Run = { run_id: `r_${crypto.randomUUID()}`, status: 'running', events: [] };
    runs.set(run.run_id, run);
    const scope: RunScope = {
      tools: new Map(),
      budget: createBudget(limits?.max_model_requests),
      context,
      report: (event) => run.events.push(event),
      model,
    };
    // Delegation is this same loop again: a fresh conversation, because a
    // subagent conversation cannot be continued yet, and a size of its own
    // — but the run's one scope, so the budget it spends is the run's.
    const delegate: Delegate = (briefing, signal) =>
      runConversation({ messages: [{ role: 'user', content: briefing }], size: { used: 0 } }, scope, signal);

    for (const def of tools) register(scope.tools, createDeclaredTool(def, config.tools.baseUrl));
    // Registered after the run's own, so a run that declares one of these
    // names cannot reroute a capability of the agent's to the tool server.
    register(scope.tools, createReadFileTool(config.workspace.dir));
    if (subagents.length > 0) register(scope.tools, createSubagentTool(subagents, delegate));

    const session: RunSession = {
      conversation: { messages: [{ role: 'user', content: prompt }], size: { used: 0 } },
      scope,
      queued: [],
      busy: false,
    };
    sessions.set(run.run_id, session);
    runTurn(run, session);
    return run;
  }

  function getRun(runId: string): Run | undefined {
    return runs.get(runId);
  }

  /**
   * Send a follow-up prompt to an existing run's conversation (SPEC.md
   * §3), continuing it with the same tools, subagents, and — since the
   * budget is a run-wide one, not a per-turn one — the same remaining
   * budget. Returns `false` when `runId` is unknown, so the caller can
   * answer 404. Re-opens a run already in a terminal state: `running`
   * again until this turn itself settles.
   *
   * A prompt that arrives mid-turn is accepted the same way and runs as
   * its own turn once that one settles.
   */
  function sendPrompt(runId: string, prompt: string): boolean {
    const run = runs.get(runId);
    const session = sessions.get(runId);
    if (!run || !session) return false;
    session.queued.push(prompt);
    if (!session.busy) startNextTurn(run, session);
    return true;
  }

  /**
   * The caller asks for a fold, and gets it before the answer (SPEC.md
   * §3). Returns `false` when `runId` is unknown, so the caller can answer
   * 404. A refused fold is not an error at the asking: it is reported, and
   * what it means for the run is decided where the room is read.
   */
  async function compactRun(runId: string, instructions?: string): Promise<boolean> {
    const session = sessions.get(runId);
    if (!session) return false;
    // Not the turn's signal: the ask is the caller's, and it is answered
    // whether or not a turn is in flight to carry it.
    const folded = await fold(session.conversation, session.scope, new AbortController().signal, instructions);
    if (!folded) {
      // Folding needs a model request and there is none left to spend. The
      // ask is still answered the way any refused fold is — reported —
      // since a caller cannot act on silence.
      session.scope.report({ type: 'compaction', phase: 'started' });
      session.scope.report({
        type: 'compaction',
        phase: 'failed',
        error: `model-request budget exhausted (${session.scope.budget.max})`,
      });
    }
    return true;
  }

  /**
   * Request cancellation of a run (SPEC.md §3 abort guarantee). Returns
   * `false` when `runId` is unknown, so the caller can answer 404;
   * otherwise always `true`, including for a run already in a terminal
   * state — the abort is then a no-op, since a committed result must
   * never be rewritten.
   */
  function abortRun(runId: string): boolean {
    const run = runs.get(runId);
    if (!run) return false;
    if (run.status === 'running') {
      // Set before firing the signal: the in-flight fetch's rejection
      // races this assignment otherwise, and the catch in executeTurn must
      // see "aborted" already committed rather than overwrite it as failed.
      run.status = 'aborted';
      run.error = 'aborted by caller';
      controllers.get(runId)?.abort();
    }
    return true;
  }

  // The run returns to `running` here rather than where the prompt was
  // accepted: before the turn ahead settles, that would claim work which
  // has not started.
  function startNextTurn(run: Run, session: RunSession): void {
    const prompt = session.queued.shift();
    if (prompt === undefined) return;
    session.conversation.messages.push({ role: 'user', content: prompt });
    run.status = 'running';
    run.output = undefined;
    run.error = undefined;
    runTurn(run, session);
  }

  // Starts (or restarts, for a follow-up) the fetch chain for one turn of
  // `run`'s session, tracked under a fresh AbortController each time.
  function runTurn(run: Run, session: RunSession): void {
    const controller = new AbortController();
    controllers.set(run.run_id, controller);
    session.busy = true;
    void executeTurn(run, session, controller.signal).finally(() => {
      controllers.delete(run.run_id);
      session.busy = false;
      startNextTurn(run, session);
    });
  }

  async function executeTurn(run: Run, session: RunSession, signal: AbortSignal): Promise<void> {
    try {
      const text = await runConversation(session.conversation, session.scope, signal);
      if (text === undefined) {
        // The budget ran out before an answer did. This agent giving up is
        // not a failure of the run: it settles the way a cancellation does.
        run.status = 'aborted';
        run.error = `model-request budget exhausted (${session.scope.budget.max})`;
        return;
      }
      run.status = 'completed';
      run.output = text;
    } catch (err) {
      // Terminal-state guarantee: errors end the run, they never strand
      // it. A cancellation already committed "aborted" in abortRun before
      // firing the signal that made this fetch reject — that commitment
      // must win, not the AbortError this catch would otherwise report.
      if (run.status === 'aborted') return;
      run.status = 'failed';
      run.error = err instanceof Error ? err.message : String(err);
    }
  }

  return { startRun, getRun, sendPrompt, compactRun, abortRun };
}

function register(table: Map<string, Tool>, tool: Tool): void {
  table.set(tool.def.name, tool);
}
