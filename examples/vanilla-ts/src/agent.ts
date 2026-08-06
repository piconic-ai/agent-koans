// The agent itself: run lifecycle and the model-facing loop.
// No agent framework — this file is the part that agent-koans verifies.
//
// Runtime-neutral by design: only Web-standard APIs (fetch,
// crypto.randomUUID), no imports. Runs on Node, Deno, Bun, and Workers.
//
// Scope: tracks the current suite (chapter: lifecycle). The implementation
// grows chapter by chapter, together with the koans it passes.

/** What the agent needs to talk to a model; the caller provides it. */
export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  /** Model name sent to the API, e.g. "gpt-4o-mini". */
  model: string;
}

export interface Run {
  run_id: string;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  output?: string;
  error?: string;
}

export function createAgent(config: ModelConfig) {
  const runs = new Map<string, Run>();

  /** Start a run and return immediately; execution continues in background. */
  function startRun(prompt: string): Run {
    const run: Run = { run_id: `r_${crypto.randomUUID()}`, status: 'running' };
    runs.set(run.run_id, run);
    void executeRun(run, prompt);
    return run;
  }

  function getRun(runId: string): Run | undefined {
    return runs.get(runId);
  }

  async function executeRun(run: Run, prompt: string): Promise<void> {
    try {
      const message = await callModel(prompt);
      run.status = 'completed';
      run.output = message ?? '';
    } catch (err) {
      // Terminal-state guarantee: errors end the run, they never strand it.
      run.status = 'failed';
      run.error = err instanceof Error ? err.message : String(err);
    }
  }

  async function callModel(prompt: string): Promise<string | null> {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      throw new Error(`model call failed with status ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as {
      choices: Array<{ message: { content: string | null } }>;
    };
    return data.choices[0].message.content;
  }

  return { startRun, getRun };
}

export type Agent = ReturnType<typeof createAgent>;
