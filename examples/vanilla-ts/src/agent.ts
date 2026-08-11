// The agent itself: run lifecycle and the model-facing loop.
// No agent framework — this file is the part that agent-koans verifies.
//
// Runtime-neutral by design: Web-standard APIs (fetch, crypto.randomUUID)
// everywhere except two imports — node:fs/promises and node:path for the
// read_file internal tool, since KOAN_WORKSPACE (SPEC.md §2) is a
// filesystem contract and the Web platform has no filesystem API. Kept to
// the one small function that needs it. Runs on Node, Deno, and Bun.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface ToolsConfig {
  baseUrl: string;
}

interface WorkspaceConfig {
  dir: string;
}

export interface ToolDef {
  name: string;
  description?: string;
  input_schema: {
    type?: string;
    properties?: Record<string, { type?: string }>;
    required?: string[];
  };
}

interface Run {
  run_id: string;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  output?: string;
  error?: string;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

interface ToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

export interface RunLimits {
  max_model_requests?: number;
}

/** A delegate declared by the run (SPEC.md §3). */
export interface SubagentDef {
  name: string;
  description?: string;
}

// The internal delegation tool's own name/arg vocabulary — this example
// implements agent-koans' neutral default (config.ts DEFAULT_DELEGATION),
// so it is hardcoded here rather than read from anywhere.
const SUBAGENT_TOOL = 'subagent';
const READ_FILE_TOOL = 'read_file';

const READ_FILE_TOOL_DEF: ToolDef = {
  name: READ_FILE_TOOL,
  description: 'Read a file from the run workspace by its relative path.',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
};

function subagentToolDef(subagents: SubagentDef[]): ToolDef {
  return {
    name: SUBAGENT_TOOL,
    description:
      'Delegate a focused task to a named subagent. Available: ' +
      subagents.map((s) => (s.description ? `${s.name} (${s.description})` : s.name)).join(', '),
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' }, prompt: { type: 'string' } },
      required: ['name', 'prompt'],
    },
  };
}

// A run-wide model-request budget (SPEC.md §3), shared by the main
// conversation and every subagent conversation: a delegate's requests
// arrive at the model endpoint too, so they draw from the same budget
// rather than each conversation getting its own.
interface Budget {
  max: number;
  used: number;
}

const MAX_STEPS = 16;

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function validateArgs(args: Record<string, unknown>, schema: ToolDef['input_schema']): string[] {
  const errors: string[] = [];
  for (const key of schema.required ?? []) {
    if (!(key in args)) errors.push(`missing required property "${key}"`);
  }
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (key in args && prop.type && jsonType(args[key]) !== prop.type) {
      errors.push(`property "${key}" must be of type ${prop.type}, got ${jsonType(args[key])}`);
    }
  }
  return errors;
}

function parseArgs(argsWire: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(argsWire || '{}');
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

// Everything a run's conversation needs across turns (SPEC.md §3): the
// growing message array and the tools/subagents/budget it was started
// with. Kept for the run's whole process lifetime, unlike `controllers`
// — a follow-up prompt (POST /runs/{id}/prompts) must find the same
// conversation and the same shared budget right where the last turn left
// them, not a fresh one.
interface RunSession {
  messages: ChatMessage[];
  tools: ToolDef[];
  subagents: SubagentDef[];
  budget: Budget;
}

export function createAgent(config: { model: ModelConfig; tools: ToolsConfig; workspace: WorkspaceConfig }) {
  const runs = new Map<string, Run>();
  const sessions = new Map<string, RunSession>();
  // One AbortController per in-flight turn, so abortRun can cancel exactly
  // that turn's outstanding fetch without touching any other run sharing
  // this process.
  const controllers = new Map<string, AbortController>();

  function startRun(prompt: string, tools: ToolDef[], subagents: SubagentDef[], limits?: RunLimits): Run {
    const run: Run = { run_id: `r_${crypto.randomUUID()}`, status: 'running' };
    runs.set(run.run_id, run);
    const session: RunSession = {
      messages: [{ role: 'user', content: prompt }],
      tools,
      subagents,
      budget: { max: Math.min(MAX_STEPS, limits?.max_model_requests ?? MAX_STEPS), used: 0 },
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
   */
  function sendPrompt(runId: string, prompt: string): boolean {
    const run = runs.get(runId);
    const session = sessions.get(runId);
    if (!run || !session) return false;
    session.messages.push({ role: 'user', content: prompt });
    run.status = 'running';
    run.output = undefined;
    run.error = undefined;
    runTurn(run, session);
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
      // races this assignment otherwise, and the catch below must see
      // "aborted" already committed rather than overwrite it as failed.
      run.status = 'aborted';
      run.error = 'aborted by caller';
      controllers.get(runId)?.abort();
    }
    return true;
  }

  // Starts (or restarts, for a follow-up) the fetch chain for one turn of
  // `run`'s session, tracked under a fresh AbortController each time.
  function runTurn(run: Run, session: RunSession): void {
    const controller = new AbortController();
    controllers.set(run.run_id, controller);
    void executeTurn(run, session, controller.signal).finally(() => {
      controllers.delete(run.run_id);
    });
  }

  async function executeTurn(run: Run, session: RunSession, signal: AbortSignal): Promise<void> {
    try {
      const text = await runConversation(session.messages, session.tools, session.subagents, session.budget, signal);
      if (text === undefined) {
        // Thrifty on the last permitted request: a result obtained now
        // could never be reported back, so the run ends here instead.
        run.status = 'aborted';
        run.error = `model-request budget exhausted (${session.budget.max})`;
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

  /**
   * Run one conversation's request/response loop against the shared budget
   * — the main one, or (recursively, via the subagent tool) a delegate's.
   * Resolves to the final text reply, or `undefined` when the run-wide
   * budget ran out before one arrived.
   */
  async function runConversation(
    messages: ChatMessage[],
    tools: ToolDef[],
    subagents: SubagentDef[],
    budget: Budget,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    for (;;) {
      if (budget.used >= budget.max) return undefined;
      budget.used += 1;
      const isLastPermitted = budget.used === budget.max;

      const message = await callModel(messages, tools, subagents, signal);

      if (message.tool_calls && message.tool_calls.length > 0) {
        if (isLastPermitted) return undefined;
        messages.push(message);
        for (const call of message.tool_calls) {
          const content = await executeToolCall(call, tools, subagents, budget, signal);
          messages.push({ role: 'tool', tool_call_id: call.id, content });
        }
        continue;
      }

      // Recorded even though this turn is about to return: a `turns:`
      // koan's session keeps `messages` across turns (SPEC.md §3), so
      // the reply that ends this turn must stay in the conversation's
      // history for the next one to carry forward.
      messages.push(message);
      return message.content ?? '';
    }
  }

  async function executeToolCall(
    call: ToolCall,
    tools: ToolDef[],
    subagents: SubagentDef[],
    budget: Budget,
    signal: AbortSignal,
  ): Promise<string> {
    // Internal tools are executed by the agent itself and never reach the
    // mock tool server (SPEC.md §2): a delegation hands the briefing to
    // a subagent conversation, a file read resolves against KOAN_WORKSPACE.
    if (call.function.name === SUBAGENT_TOOL) {
      return runDelegation(call, tools, subagents, budget, signal);
    }
    if (call.function.name === READ_FILE_TOOL) {
      return runReadFile(call);
    }

    const def = tools.find((t) => t.name === call.function.name);
    if (!def) {
      return `Error: unknown tool "${call.function.name}"`;
    }

    const args = parseArgs(call.function.arguments);
    if (args === undefined) {
      return `Error: tool arguments are not valid JSON`;
    }

    const validationErrors = validateArgs(args, def.input_schema ?? {});
    if (validationErrors.length > 0) {
      return `Error: invalid arguments for "${def.name}": ${validationErrors.join('; ')}`;
    }

    const res = await fetch(`${config.tools.baseUrl}/invoke/${encodeURIComponent(def.name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
      signal,
    });
    const body = await res.text();
    if (!res.ok) {
      return `Error: tool "${def.name}" failed with status ${res.status}: ${body}`;
    }
    return body;
  }

  async function runDelegation(
    call: ToolCall,
    tools: ToolDef[],
    subagents: SubagentDef[],
    budget: Budget,
    signal: AbortSignal,
  ): Promise<string> {
    const args = parseArgs(call.function.arguments);
    const name = typeof args?.name === 'string' ? args.name : undefined;
    const prompt = typeof args?.prompt === 'string' ? args.prompt : undefined;
    if (!name || !subagents.some((s) => s.name === name)) {
      return `Error: unknown subagent "${String(name)}"`;
    }
    if (prompt === undefined) {
      return `Error: subagent "${name}" call is missing "prompt"`;
    }

    // A fresh conversation every time: a subagent conversation cannot be
    // continued yet.
    const childMessages: ChatMessage[] = [{ role: 'user', content: prompt }];
    const text = await runConversation(childMessages, tools, subagents, budget, signal);
    return text ?? `Error: subagent "${name}" did not finish before the model-request budget ran out`;
  }

  async function runReadFile(call: ToolCall): Promise<string> {
    const args = parseArgs(call.function.arguments);
    const rel = typeof args?.path === 'string' ? args.path : undefined;
    if (!rel) return `Error: read_file call is missing "path"`;

    const root = path.resolve(config.workspace.dir);
    const resolved = path.resolve(root, rel);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return `Error: path "${rel}" escapes the workspace`;
    }
    try {
      return await readFile(resolved, 'utf8');
    } catch (err) {
      return `Error: could not read "${rel}": ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  async function callModel(
    messages: ChatMessage[],
    tools: ToolDef[],
    subagents: SubagentDef[],
    signal: AbortSignal,
  ): Promise<ChatMessage> {
    const wireTools = [...tools, READ_FILE_TOOL_DEF, ...(subagents.length > 0 ? [subagentToolDef(subagents)] : [])];
    const res = await fetch(`${config.model.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.model.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model.model,
        messages,
        tools: wireTools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.input_schema },
        })),
      }),
      signal,
    });
    if (!res.ok) {
      throw new Error(`model call failed with status ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { choices: Array<{ message: ChatMessage }> };
    return data.choices[0].message;
  }

  return { startRun, getRun, sendPrompt, abortRun };
}
