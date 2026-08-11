// Custom model provider pointing at the harness's mock LLM server.
//
// Flue's built-in OpenAI provider does not honor OPENAI_BASE_URL, so the
// conformance contract's "redirect model calls to the mock" requirement is
// met by registering an OpenAI-compatible provider with an explicit baseUrl.
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { noteModelRequest } from './budget.js';
import type { Config } from './config.js';

export function createKoanProvider(model: Config['model']) {
  const api = openAICompletionsApi();
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
    // The budget check lives on the request boundary so an over-budget
    // request is never issued at all (SPEC.md §3).
    api: {
      stream: (model, context, options) => {
        noteModelRequest();
        return api.stream(model, context, options);
      },
      streamSimple: (model, context, options) => {
        noteModelRequest();
        return api.streamSimple(model, context, options);
      },
    },
  });
}
