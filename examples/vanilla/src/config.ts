// Environment reading, in one place. The rest of the code receives
// plain values and never touches process.env.
export interface Config {
  port: number;
  model: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  tools: {
    baseUrl: string;
  };
  workspace: {
    dir: string;
  };
  state: {
    dir: string;
  };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    port: Number(env.PORT ?? 3000),
    model: {
      baseUrl: env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      apiKey: env.OPENAI_API_KEY ?? '',
      model: env.OPENAI_MODEL ?? 'gpt-4o-mini',
    },
    tools: {
      baseUrl: env.KOAN_TOOLS_URL ?? '',
    },
    workspace: {
      dir: env.KOAN_WORKSPACE ?? '',
    },
    state: {
      // Unlike workspace/tools above, this path is mkdirSync'd at
      // startup, so an explicitly empty value must fall back too — hence
      // the length check instead of `??`.
      dir: env.KOAN_STATE_DIR && env.KOAN_STATE_DIR.length > 0 ? env.KOAN_STATE_DIR : '.agent-koans',
    },
  };
}
