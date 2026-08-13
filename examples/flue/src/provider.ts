// Custom model provider pointing at the harness's mock LLM server.
//
// Flue's built-in OpenAI provider does not honor OPENAI_BASE_URL, so the
// conformance contract's "redirect model calls to the mock" requirement is
// met by registering an OpenAI-compatible provider with an explicit baseUrl.
import { createProvider, type Context } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { noteModelRequest } from './budget.js';
import { foldInstructions } from './compaction.js';
import { checkRoom } from './window.js';
import type { Config } from './config.js';

/**
 * The window the registered model claims. Exported because Flue expresses
 * a compaction threshold as headroom left in this number, so an agent
 * honoring a run's own declared threshold has to convert against it
 * (agents/assistant.ts).
 */
export const CONTEXT_WINDOW = 128_000;

// A fold the caller asked with words of its own: they belong to the
// request Flue is about to send, and Flue's summarizing prompt has no
// room for them (compaction.ts).
function asked(context: Context): Context {
  const instructions = foldInstructions();
  if (instructions === undefined) return context;
  return {
    ...context,
    messages: [
      ...context.messages,
      { role: 'user', content: [{ type: 'text', text: instructions }], timestamp: Date.now() },
    ],
  };
}

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
        contextWindow: CONTEXT_WINDOW,
        maxTokens: 8192,
      },
    ],
    // The budget and window checks live on the request boundary so a
    // request neither allows is never issued at all (SPEC.md §3).
    api: {
      stream: (model, context, options) => {
        checkRoom();
        noteModelRequest();
        return api.stream(model, asked(context), options);
      },
      streamSimple: (model, context, options) => {
        checkRoom();
        noteModelRequest();
        return api.streamSimple(model, asked(context), options);
      },
    },
  });
}
