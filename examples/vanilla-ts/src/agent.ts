// The agent itself: run lifecycle and the model-facing loop.
// No agent framework — this file is the part that agent-koans verifies.
//
// Runtime-neutral by design: only Web-standard APIs (fetch,
// crypto.randomUUID), no imports. Runs on Node, Deno, Bun, and Workers.
//
// Scope: tracks the current suite (chapters: lifecycle, tool-reliability).
// The implementation grows chapter by chapter, together with the koans it
// passes.

/** What the agent needs to talk to a model; the caller provides it. */
export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  /** Model name sent to the API, e.g. "gpt-4o-mini". */
  model: string;
}

/** Where tool invocations go; the caller provides it. */
export interface ToolsConfig {
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

export interface Run {
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

const MAX_STEPS = 16;

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Minimal JSON Schema validation: `required` properties and primitive
 * types of declared properties (SPEC.md R6).
 */
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

  /** Start a run and return immediately; execution continues in background. */
  function startRun(prompt: string, tools: ToolDef[]): Run {
    const run: Run = { run_id: `r_${crypto.randomUUID()}`, status: 'running' };
    runs.set(run.run_id, run);
    void executeRun(run, prompt, tools);
    return run;
  }

  function getRun(runId: string): Run | undefined {
    return runs.get(runId);
  }

  async function executeRun(run: Run, prompt: string, tools: ToolDef[]): Promise<void> {
    try {
      const messages: ChatMessage[] = [{ role: 'user', content: prompt }];

      for (let step = 0; step < MAX_STEPS; step++) {
        const message = await callModel(messages, tools);

        if (message.tool_calls && message.tool_calls.length > 0) {
          messages.push(message);
          for (const call of message.tool_calls) {
            const content = await executeToolCall(call, tools);
            messages.push({ role: 'tool', tool_call_id: call.id, content });
          }
          continue;
        }

        run.status = 'completed';
        run.output = message.content ?? '';
        return;
      }

      // R5: bounded loop — give up rather than run forever.
      run.status = 'aborted';
      run.error = `exceeded ${MAX_STEPS} model steps`;
    } catch (err) {
      // Terminal-state guarantee: errors end the run, they never strand it.
      run.status = 'failed';
      run.error = err instanceof Error ? err.message : String(err);
    }
  }

  /** Execute one model tool call; returns the tool-result message content. */
  async function executeToolCall(call: ToolCall, tools: ToolDef[]): Promise<string> {
    const def = tools.find((t) => t.name === call.function.name);
    if (!def) {
      // R7: never forward unknown tools to the tool server.
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
      // R6: invalid arguments never reach the tool server.
      return `Error: invalid arguments for "${def.name}": ${validationErrors.join('; ')}`;
    }

    const res = await fetch(`${config.tools.baseUrl}/invoke/${encodeURIComponent(def.name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    const body = await res.text();
    if (!res.ok) {
      // R3: report the failure to the model; R4: no retry here.
      return `Error: tool "${def.name}" failed with status ${res.status}: ${body}`;
    }
    return body;
  }

  async function callModel(messages: ChatMessage[], tools: ToolDef[]): Promise<ChatMessage> {
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
    });
    if (!res.ok) {
      throw new Error(`model call failed with status ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { choices: Array<{ message: ChatMessage }> };
    return data.choices[0].message;
  }

  return { startRun, getRun };
}

export type Agent = ReturnType<typeof createAgent>;
