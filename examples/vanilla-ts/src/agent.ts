// The agent itself: run lifecycle and the model-facing loop.
// No agent framework — this file is the part that agent-koans verifies.
//
// Runtime-neutral by design: only Web-standard APIs (fetch,
// crypto.randomUUID), no imports. Runs on Node, Deno, Bun, and Workers.

interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface ToolsConfig {
  baseUrl: string;
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

export function createAgent(config: { model: ModelConfig; tools: ToolsConfig }) {
  const runs = new Map<string, Run>();
  // One AbortController per in-flight run, so abortRun can cancel exactly
  // that run's outstanding fetch without touching any other run sharing
  // this process.
  const controllers = new Map<string, AbortController>();

  function startRun(prompt: string, tools: ToolDef[], limits?: RunLimits): Run {
    const run: Run = { run_id: `r_${crypto.randomUUID()}`, status: 'running' };
    runs.set(run.run_id, run);
    const controller = new AbortController();
    controllers.set(run.run_id, controller);
    void executeRun(run, prompt, tools, limits, controller.signal).finally(() => {
      controllers.delete(run.run_id);
    });
    return run;
  }

  function getRun(runId: string): Run | undefined {
    return runs.get(runId);
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

  async function executeRun(
    run: Run,
    prompt: string,
    tools: ToolDef[],
    limits: RunLimits | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const budget = Math.min(MAX_STEPS, limits?.max_model_requests ?? MAX_STEPS);
      const messages: ChatMessage[] = [{ role: 'user', content: prompt }];

      for (let request = 1; request <= budget; request++) {
        const message = await callModel(messages, tools, signal);

        if (message.tool_calls && message.tool_calls.length > 0) {
          // Thrifty on the last permitted request: a result obtained now
          // could never be reported back, so the invocation is skipped.
          if (request === budget) break;
          messages.push(message);
          for (const call of message.tool_calls) {
            const content = await executeToolCall(call, tools, signal);
            messages.push({ role: 'tool', tool_call_id: call.id, content });
          }
          continue;
        }

        run.status = 'completed';
        run.output = message.content ?? '';
        return;
      }

      run.status = 'aborted';
      run.error = `model-request budget exhausted (${budget})`;
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

  async function executeToolCall(call: ToolCall, tools: ToolDef[], signal: AbortSignal): Promise<string> {
    const def = tools.find((t) => t.name === call.function.name);
    if (!def) {
      return `Error: unknown tool "${call.function.name}"`;
    }

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
    } catch {
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

  async function callModel(messages: ChatMessage[], tools: ToolDef[], signal: AbortSignal): Promise<ChatMessage> {
    const res = await fetch(`${config.model.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.model.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model.model,
        messages,
        ...(tools.length > 0
          ? {
              tools: tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.input_schema },
              })),
            }
          : {}),
      }),
      signal,
    });
    if (!res.ok) {
      throw new Error(`model call failed with status ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { choices: Array<{ message: ChatMessage }> };
    return data.choices[0].message;
  }

  return { startRun, getRun, abortRun };
}
