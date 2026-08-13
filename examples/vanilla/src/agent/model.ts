// The one place this agent talks to the model endpoint. What belongs here
// is the OpenAI-compatible wire vocabulary and the single request that
// carries it; what does not is any decision about what to send — the
// conversation composes that and hands it over.
import type { ToolDef } from './tools.js';

interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** One message of a conversation, in the shape the endpoint takes. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

/** A tool call the model asked for, its arguments still as the model wrote them. */
export interface ToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

/** A reply, and the size the endpoint reported for the request that earned it. */
export interface ModelReply {
  message: ChatMessage;
  used: number;
}

/** Send one request and read one reply. Rejects when the endpoint refuses it. */
export type ModelClient = (
  messages: ChatMessage[],
  tools: ToolDef[],
  signal: AbortSignal,
) => Promise<ModelReply>;

/** Open a client against the run's model endpoint. */
export function createModelClient(model: ModelConfig): ModelClient {
  return async (messages, tools, signal) => {
    const res = await fetch(`${model.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${model.apiKey}`,
      },
      body: JSON.stringify({
        model: model.model,
        messages,
        tools: tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.input_schema },
        })),
      }),
      signal,
    });
    if (!res.ok) {
      throw new Error(`model call failed with status ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as {
      choices: Array<{ message: ChatMessage }>;
      usage?: { prompt_tokens?: number };
    };
    return { message: data.choices[0].message, used: data.usage?.prompt_tokens ?? 0 };
  };
}
