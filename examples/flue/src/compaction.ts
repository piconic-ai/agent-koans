// Folding the agent's own conversation when the caller asks (SPEC.md §3).
// The HTTP surface belongs to server.ts, what the agent declares about
// itself to agents/assistant.ts.
//
// Nothing is ever dropped from the map below: a settled run can be
// prompted again, so no moment marks a run's stores as spent, and the
// conformance runner starts a fresh agent process per koan.
import { createFlueContext, resolveModel } from '@flue/runtime/internal';
import { Assistant } from './agents/assistant.js';

interface InstanceStores {
  conversationWriter: unknown;
  attachmentStore: unknown;
}

const stores = new Map<string, InstanceStores>();

/** Keep one run's conversation stores, taken from the harness a render receives. */
export function noteInstanceStores(runId: string, harness: unknown): void {
  // Not read from the runtime: `start()` hands back only `stop()`, and a
  // context left to build its own stores opens an empty conversation.
  const held = harness as { conversationWriter?: unknown; attachmentStore?: unknown };
  if (held.conversationWriter !== undefined) {
    stores.set(runId, { conversationWriter: held.conversationWriter, attachmentStore: held.attachmentStore });
  }
}

/**
 * Fold one run's conversation down, now. Rejects when the summarization
 * request fails.
 */
export async function compactConversation(runId: string, instanceId: string, instructions?: string): Promise<void> {
  const held = stores.get(runId);
  if (held === undefined) throw new Error(`no conversation stores kept for run ${runId}`);
  // Not `harness.compact()`: the harness a render receives is an
  // invocation harness, and folding its child conversation leaves the one
  // the caller is watching untouched. This opens the agent's own the way
  // the runtime does.
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
  const session = await harness.session('default');
  // The summarizing prompt is Flue's own and takes no words from a
  // caller, so the words ride the request instead — armed here, where the
  // fold this run asked for is about to be the only one in flight, and
  // spent by the provider that sends it (provider.ts).
  armFoldInstructions(instructions);
  try {
    await session.compact();
  } finally {
    armFoldInstructions(undefined);
  }
}

let armed: string | undefined;

function armFoldInstructions(instructions: string | undefined): void {
  armed = instructions;
}

/** What the caller asked this run's fold to keep, for the request that folds. */
export function foldInstructions(): string | undefined {
  return armed;
}
