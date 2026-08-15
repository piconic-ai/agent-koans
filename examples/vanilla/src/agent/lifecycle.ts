// What an agent does with runs: accepts them, drives their turns, and
// answers for them. What belongs here is the state a caller polls, the
// queue of turns, and the transitions between them; what does not is what
// a run is made of (run.ts) or how a turn is carried out (conversation.ts).
import { foldOnRequest, type RunEvent } from './compaction.js';
import { runConversation, type Conversation } from './conversation.js';
import { createModelClient, type ChatMessage } from './model.js';
import { createRun, type Run, type RunSetup } from './run.js';
import type { Tool } from './tools.js';

/**
 * What makes one agent a particular agent: what it is told it is, and what
 * it can do beyond whatever a run declares. Everything else about running
 * it is the same for any agent, which is why nothing else here asks.
 */
export interface AgentDefinition {
  /** Standing instructions, sent ahead of a run's first prompt. */
  system?: string;
  /** Tools of the agent's own, executed by the agent and never sent out. */
  tools?: Tool[];
}

/** A run as its caller sees it: what GET /runs/{id} answers with (SPEC.md §3). */
interface RunState {
  run_id: string;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  output?: string;
  error?: string;
  /** What the run did that its caller has to be able to show. */
  events: RunEvent[];
}

// Everything held about one run, for its whole process lifetime: a
// follow-up prompt (POST /runs/{id}/prompts) must find the same
// conversation and the same remaining budget right where the last turn
// left them, not a fresh one.
interface RunSession {
  state: RunState;
  run: Run;
  conversation: Conversation;
  /**
   * Prompts that arrived mid-turn. Not appended to the conversation until
   * their turn starts: the running turn would otherwise send unanswered
   * `tool_calls` followed by a user message, which no provider accepts.
   */
  queued: string[];
  /**
   * The turn in flight, if any; one runs at a time per run. Its controller
   * is what an abort fires, so it cancels exactly that turn's outstanding
   * fetch and no other run's sharing this process.
   */
  turn?: AbortController;
}

/** Make `definition` runnable: submit runs to it, and ask after them. */
export function createAgent(
  definition: AgentDefinition,
  config: { model: { baseUrl: string; apiKey: string; model: string }; tools: { baseUrl: string } },
) {
  const parts = {
    model: createModelClient(config.model),
    toolsBaseUrl: config.tools.baseUrl,
    own: definition.tools ?? [],
  };
  const sessions = new Map<string, RunSession>();

  function startRun(prompt: string, setup: RunSetup): RunState {
    const state: RunState = { run_id: `r_${crypto.randomUUID()}`, status: 'running', events: [] };
    const session: RunSession = {
      state,
      run: createRun(parts, setup, (event) => state.events.push(event)),
      // The run's own `context` provisions the run's own conversation
      // (SPEC.md §3) — a delegate's conversation carries its own instead
      // (run.ts's `delegate`), never this one.
      conversation: { messages: opening(prompt, definition.system), size: { used: 0 }, context: setup.context },
      queued: [],
    };
    sessions.set(state.run_id, session);
    runTurn(session);
    return state;
  }

  function getRun(runId: string): RunState | undefined {
    return sessions.get(runId)?.state;
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
    const session = sessions.get(runId);
    if (!session) return false;
    session.queued.push(prompt);
    if (session.turn === undefined) startNextTurn(session);
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
    await foldOnRequest(session.conversation, session.run, new AbortController().signal, instructions);
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
    const session = sessions.get(runId);
    if (!session) return false;
    if (session.state.status === 'running') {
      // Set before firing the signal: the in-flight fetch's rejection
      // races this assignment otherwise, and the catch in executeTurn must
      // see "aborted" already committed rather than overwrite it as failed.
      session.state.status = 'aborted';
      session.state.error = 'aborted by caller';
      // The queue too, not just the turn in flight: an abort covers every
      // submission still unsettled (SPEC.md §3), and a prompt accepted
      // but unanswered is exactly that. A prompt arriving after this
      // still re-opens the run — the queue empties, it does not close.
      session.queued.length = 0;
      session.turn?.abort();
    }
    return true;
  }

  // The run returns to `running` here rather than where the prompt was
  // accepted: before the turn ahead settles, that would claim work which
  // has not started.
  function startNextTurn(session: RunSession): void {
    const prompt = session.queued.shift();
    if (prompt === undefined) return;
    session.conversation.messages.push({ role: 'user', content: prompt });
    session.state.status = 'running';
    session.state.output = undefined;
    session.state.error = undefined;
    runTurn(session);
  }

  // Starts (or restarts, for a follow-up) the fetch chain for one turn,
  // under a fresh AbortController each time.
  function runTurn(session: RunSession): void {
    const controller = new AbortController();
    session.turn = controller;
    void executeTurn(session, controller.signal).finally(() => {
      session.turn = undefined;
      startNextTurn(session);
    });
  }

  async function executeTurn(session: RunSession, signal: AbortSignal): Promise<void> {
    const { state } = session;
    try {
      const text = await runConversation(session.conversation, session.run, signal);
      if (text === undefined) {
        // The budget ran out before an answer did. This agent giving up is
        // not a failure of the run: it settles the way a cancellation does.
        state.status = 'aborted';
        state.error = `model-request budget exhausted (${session.run.budget.max})`;
        return;
      }
      state.status = 'completed';
      state.output = text;
    } catch (err) {
      // Terminal-state guarantee: errors end the run, they never strand
      // it. A cancellation already committed "aborted" in abortRun before
      // firing the signal that made this fetch reject — that commitment
      // must win, not the AbortError this catch would otherwise report.
      if (state.status === 'aborted') return;
      state.status = 'failed';
      state.error = err instanceof Error ? err.message : String(err);
    }
  }

  return { startRun, getRun, sendPrompt, compactRun, abortRun };
}

// Standing instructions lead, so every request of the conversation carries
// them: they are what the run is to be answered as, not a turn of it.
function opening(prompt: string, system: string | undefined): ChatMessage[] {
  const user: ChatMessage = { role: 'user', content: prompt };
  return system === undefined ? [user] : [{ role: 'system', content: system }, user];
}
