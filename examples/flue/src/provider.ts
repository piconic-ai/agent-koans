// Custom model provider pointing at the harness's mock LLM server.
//
// Flue's built-in OpenAI provider does not honor OPENAI_BASE_URL, so the
// conformance contract's "redirect model calls to the mock" requirement is
// met by registering an OpenAI-compatible provider with an explicit baseUrl.
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import type { Config } from './config.js';

export function createKoanProvider(model: Config['model']) {
  return createProvider({
    id: 'koan',
    name: 'agent-koans mock LLM',
    auth: {
      apiKey: {
        name: 'agent-koans dummy key',
        resolve: async () => ({ auth: { apiKey: model.apiKey } }),
      },
    },
    models: [
      {
        id: 'default',
        name: 'Mock model',
        api: 'openai-completions',
        provider: 'koan',
        baseUrl: model.baseUrl,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ],
    api: openAICompletionsApi(),
  });
}
