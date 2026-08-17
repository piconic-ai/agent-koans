// What an agent does with runs: accepts them, drives their turns, and
// answers for them. What belongs here is the state a caller polls, the
// queue of turns, and the transitions between them; what does not is what
// a run is made of (run.ts) or how a turn is carried out (conversation.ts).
// Durability rides here too: every session is a row of its own recorded
// history (SPEC.md §3 crash recovery), saved to KOAN_STATE_DIR on every
// change and reloaded at construction — a delegate's conversation stays
// out of it, since a scripted crash never lands mid-delegation.
import fs from 'node:fs';
import path from 'node:path';
import { foldOnRequest, type RunEvent } from './compaction.js';
import { runConversation, type Conversation } from './conversation.js';
import { createModelClient, type ChatMessage, type ToolCall } from './model.js';
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
  /** What the run was submitted with — kept to rebuild `run` on recovery, since a crash loses the in-memory Run itself. */
  setup: RunSetup;
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
  /**
   * The run's declared wall-clock budget (SPEC.md §3), read once at
   * submission and reapplied to every turn this run executes — a
   * follow-up prompt (`sendPrompt`) carries no limits of its own to
   * re-declare it with.
   */
  maxDurationMs?: number;
  /**
   * Armed for the turn currently running, cleared once it settles. Not
   * re-armed for a prompt still sitting in `queued`: turns already run
   * strictly one at a time per run, so a queued prompt's own budget is
   * spent from when it starts running, not from when it waited its turn —
   * a simplification no koan here exercises against a queue.
   */
  timeLimit?: ReturnType<typeof setTimeout>;
}

/** One session's recorded state, as written to `<state.dir>/runs.json` — everything a successor process needs to rebuild it after a crash. */
interface RunRow {
  state: RunState;
  setup: RunSetup;
  messages: ChatMessage[];
  size: { used: number };
  /**
   * Not elapsed wall-clock time: a resumed run re-arms `max_duration_ms`
   * from zero, since only the request count survives a crash here. No
   * koan declares a time budget on a run that also scripts one.
   */
  budgetUsed: number;
  queued: string[];
}

/** Make `definition` runnable: submit runs to it, and ask after them. */
export function createAgent(
  definition: AgentDefinition,
  config: {
    model: { baseUrl: string; apiKey: string; model: string };
    tools: { baseUrl: string };
    state: { dir: string };
  },
) {
  const parts = {
    model: createModelClient(config.model),
    toolsBaseUrl: config.tools.baseUrl,
    own: definition.tools ?? [],
  };
  const sessions = new Map<string, RunSession>();

  fs.mkdirSync(config.state.dir, { recursive: true });
  const stateFile = path.join(config.state.dir, 'runs.json');

  // The whole map, rewritten every time: one koan's session count is
  // small, and temp-then-rename means a crash mid-write never truncates
  // the record it was meant to protect.
  function save(): void {
    const rows: RunRow[] = [...sessions.values()].map((session) => ({
      state: session.state,
      setup: session.setup,
      messages: session.conversation.messages,
      size: session.conversation.size,
      budgetUsed: session.run.budget.used,
      queued: session.queued,
    }));
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rows));
    fs.renameSync(tmp, stateFile);
  }

  function loadRows(): RunRow[] {
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8')) as RunRow[];
    } catch {
      // A first boot has no file yet; nothing to recover either way.
      return [];
    }
  }

  // What an invocation the crash caught in flight becomes: nothing was
  // recorded, so its outcome is unknown, and an unknown outcome reaches
  // the model the way any other tool failure does (SPEC.md §3) — never a
  // re-invocation this agent makes on its own.
  function interruptedClosure(call: ToolCall): ChatMessage {
    return {
      role: 'tool',
      tool_call_id: call.id,
      content:
        `Error: tool "${call.function.name}" was interrupted: the agent restarted while the invocation was ` +
        `in flight, and its outcome is unknown`,
    };
  }

  // Picks a session back up after a crash (SPEC.md §3): closes any
  // invocation the death caught in flight as interrupted, then resumes
  // the loop from the recorded history — the recorded result, once
  // closed for real or synthesized, is what the next model request
  // carries forward.
  function resume(session: RunSession): void {
    const { messages } = session.conversation;
    const last = messages.at(-1);
    if (last?.role === 'assistant' && !(last.tool_calls && last.tool_calls.length > 0)) {
      // The answer was already recorded; only the settlement was lost.
      session.state.status = 'completed';
      session.state.output = last.content ?? '';
      save();
      startNextTurn(session);
      return;
    }
    let turnIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        turnIndex = i;
        break;
      }
    }
    if (turnIndex !== -1) {
      const closedIds = new Set(
        messages
          .slice(turnIndex + 1)
          .filter((m) => m.role === 'tool')
          .map((m) => m.tool_call_id),
      );
      let changed = false;
      for (const call of messages[turnIndex].tool_calls ?? []) {
        if (!closedIds.has(call.id)) {
          messages.push(interruptedClosure(call));
          changed = true;
        }
      }
      if (changed) save();
    }
    runTurn(session);
  }

  function startRun(prompt: string, setup: RunSetup, runId?: string): RunState {
    // A named run that already exists is the caller's identical resend
    // (SPEC.md §3): answer with the run it already started, and do not
    // open a second conversation.
    const existing = runId === undefined ? undefined : sessions.get(runId);
    if (existing !== undefined) return existing.state;
    const state: RunState = { run_id: runId ?? `r_${crypto.randomUUID()}`, status: 'running', events: [] };
    const session: RunSession = {
      state,
      run: createRun(parts, setup, (event) => {
        state.events.push(event);
        save();
      }),
      setup,
      // The run's own `context` provisions the run's own conversation
      // (SPEC.md §3) — a delegate's conversation carries its own instead
      // (run.ts's `delegate`), never this one. `onRecord` is what makes
      // this conversation durable; a delegate's declares none.
      conversation: {
        messages: opening(prompt, definition.system),
        size: { used: 0 },
        context: setup.context,
        onRecord: save,
      },
      queued: [],
      maxDurationMs: setup.limits?.max_duration_ms,
    };
    sessions.set(state.run_id, session);
    // On record before the turn even starts: a crash between acceptance
    // and its first request must still find this run to recover.
    save();
    runTurn(session);
    return state;
  }

  // Recovered at construction, before this agent answers anything: every
  // persisted row is reseated in `sessions` (so a poll or an idempotent
  // resend of a terminal run keeps working) — all of them, in a first
  // pass, before any resume() runs. `resume()` can itself call `save()`
  // (closing an interrupted call, settling from a recorded answer), and
  // `save()` serializes the whole map; resuming inline with the reseat
  // would rewrite runs.json while later rows in this same loop were not
  // yet in `sessions`, dropping them from that write. A second pass then
  // resumes what was still `running`, and drains a queued prompt a
  // terminal row never got to start.
  const reseated = loadRows().map((row) => {
    const session: RunSession = {
      state: row.state,
      run: createRun(
        parts,
        row.setup,
        (event) => {
          row.state.events.push(event);
          save();
        },
        row.budgetUsed,
      ),
      setup: row.setup,
      conversation: { messages: row.messages, size: row.size, context: row.setup.context, onRecord: save },
      queued: row.queued,
      maxDurationMs: row.setup.limits?.max_duration_ms,
    };
    sessions.set(session.state.run_id, session);
    return session;
  });
  for (const session of reseated) {
    if (session.state.status === 'running') resume(session);
    else if (session.queued.length > 0) startNextTurn(session);
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
    save();
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
      // This is also where a timed-out turn's own budget drives the same
      // cancellation (SPEC.md §3's time budget): disarming here, ahead of
      // the `.finally()` below that would otherwise do it once the turn
      // actually unwinds, means a caller's abort never races its own
      // declared timer for the same run.
      disarmTimeLimit(session);
      save();
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
    save();
    runTurn(session);
  }

  // Starts (or restarts, for a follow-up) the fetch chain for one turn,
  // under a fresh AbortController each time.
  function runTurn(session: RunSession): void {
    const controller = new AbortController();
    session.turn = controller;
    armTimeLimit(session);
    void executeTurn(session, controller.signal).finally(() => {
      disarmTimeLimit(session);
      session.turn = undefined;
      save();
      startNextTurn(session);
    });
  }

  // Arms this turn's own declared budget (SPEC.md §3 time budget): when it
  // fires, it drives the same cancellation POST /runs/{id}/abort does —
  // settle aborted, clear the queue, abandon whatever is still unsettled.
  // A no-op when the run declares none.
  function armTimeLimit(session: RunSession): void {
    if (session.maxDurationMs === undefined) return;
    session.timeLimit = setTimeout(() => abortRun(session.state.run_id), session.maxDurationMs);
  }

  function disarmTimeLimit(session: RunSession): void {
    if (session.timeLimit === undefined) return;
    clearTimeout(session.timeLimit);
    session.timeLimit = undefined;
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
