// Folding the agent's own conversation when the caller asks (SPEC.md §3).
// What belongs here is that one join — the caller's ask, and the Flue call
// that answers it. The HTTP surface belongs to server.ts, and what the
// agent declares about itself to agents/assistant.ts.
//
// Flue's own manual fold, `harness.compact()`, is not what this uses: the
// harness a render receives is an invocation harness, and its conversation
// is a child of the agent's, so folding it leaves the conversation the
// caller is watching untouched. The agent's own conversation is the
// runtime's `default` session of the `default` harness, which is what
// `initializeRootHarness` below opens — the same call the runtime makes to
// process a delivery.
import { createFlueContext, resolveModel } from '@flue/runtime/internal';
import { Assistant } from './agents/assistant.js';

/**
 * The conversation stores of one run's agent instance, kept from a render
 * so a fold asked for between turns can reach the same conversation.
 *
 * Not read from the runtime: `start()` hands back only `stop()`, and a
 * context left to build its own stores opens an empty conversation of its
 * own instead of the agent's.
 */
interface InstanceStores {
  conversationWriter: unknown;
  attachmentStore: unknown;
}

const stores = new Map<string, InstanceStores>();

/** Keep one run's conversation stores, taken from the harness a render receives. */
export function noteInstanceStores(runId: string, harness: unknown): void {
  const held = harness as { conversationWriter?: unknown; attachmentStore?: unknown };
  if (held.conversationWriter !== undefined) {
    stores.set(runId, { conversationWriter: held.conversationWriter, attachmentStore: held.attachmentStore });
  }
}

/**
 * Fold one run's conversation down, now. Rejects when the summarization
 * request fails — the caller's endpoint answers regardless, since what a
 * failed fold owes is a report, not an error at the asking (SPEC.md §3).
 *
 * Done while the run sits between turns rather than at the next turn's
 * start: a turn builds its context before any hook of it runs, so a fold
 * landing inside the turn would not reach the request that turn is about
 * to make.
 */
export async function compactConversation(runId: string, instanceId: string): Promise<void> {
  const held = stores.get(runId);
  if (held === undefined) throw new Error(`no conversation stores kept for run ${runId}`);
  const context = createFlueContext({
    id: instanceId,
    agentName: 'Assistant',
    env: process.env,
    agentConfig: { resolveModel } as never,
    ...held,
  } as never);
  const harness = (await context.initializeRootHarness(Assistant)) as unknown as {
    session(name?: string): Promise<{ compact(): Promise<void> }>;
  };
  await (await harness.session('default')).compact();
}
