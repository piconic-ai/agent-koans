// The context window a run declared, and the arithmetic of how full it is.
// What belongs here is reading a conversation's size against that window;
// what does not is folding one down (compaction.ts) or deciding what a
// full window ends (conversation.ts).

/** The window the run's conversations grow into, and when to fold one down (SPEC.md §3). */
export interface RunContext {
  window: number;
  /** Absent means never: the conversation is carried as it stands. */
  compaction?: { at_percent: number };
}

/** One conversation's last reported size, shared with the loop that reads it. */
export interface ConversationSize {
  used: number;
}

/** Whether a conversation has grown into the share of the window at which the run folds. */
export function reachedThreshold(size: ConversationSize, context: RunContext | undefined): boolean {
  if (context?.compaction === undefined) return false;
  return size.used >= Math.ceil((context.window * context.compaction.at_percent) / 100);
}

/** Throws when the conversation has no room left for another request. */
export function checkRoom(size: ConversationSize, context: RunContext | undefined): void {
  if (context !== undefined && size.used >= context.window) {
    throw new Error(`no room left in the declared context window (${context.window})`);
  }
}
