// Folding a conversation down to a summary. What belongs here is the
// summarizing request, the rewrite of the history it replaces, and the
// events a fold owes the caller; what does not is when to fold — the loop
// folds on the run's threshold (conversation.ts), the caller asks for one
// (agent.ts).
import type { Conversation } from './conversation.js';
import type { ChatMessage, ModelClient } from './model.js';
import type { Run } from './run.js';

/** Something the run did that its caller has to be able to show (SPEC.md §3). */
export interface RunEvent {
  type: 'compaction';
  phase: 'started' | 'completed' | 'failed';
  error?: string;
}

/** Append to the run's caller-visible record. A delegate's folds report here too. */
export type ReportEvent = (event: RunEvent) => void;

/**
 * Fold `conversation` because it grew into the run's threshold. Resolves
 * to `false` when the budget had nothing left to spend, and reports
 * nothing then: no fold was attempted, so there is none to tell of.
 */
export async function foldOnThreshold(
  conversation: Conversation,
  run: Run,
  signal: AbortSignal,
): Promise<boolean> {
  if (run.budget.take() === undefined) return false;
  await fold(conversation, run, signal);
  return true;
}

/**
 * Fold `conversation` because the caller asked for one (SPEC.md §3).
 * Reported either way, refusal included: a caller holding the answer has
 * to be able to tell what came of pressing the button, and cannot act on
 * silence.
 */
export async function foldOnRequest(
  conversation: Conversation,
  run: Run,
  signal: AbortSignal,
  instructions?: string,
): Promise<void> {
  if (run.budget.take() === undefined) {
    run.report({ type: 'compaction', phase: 'started' });
    run.report({
      type: 'compaction',
      phase: 'failed',
      error: `model-request budget exhausted (${run.budget.max})`,
    });
    return;
  }
  await fold(conversation, run, signal, instructions);
}

// A fold that fails is not raised: it leaves the conversation as it was,
// and what follows is decided by the room left in the window, never by the
// fold's outcome.
async function fold(
  conversation: Conversation,
  run: Run,
  signal: AbortSignal,
  instructions?: string,
): Promise<void> {
  try {
    await compact(conversation.messages, run.model, run.report, signal, instructions);
    // Not the summarizing request's own usage: carrying that number over
    // would trip the threshold again and fold forever.
    conversation.size.used = 0;
  } catch {
    // Left as it was, which the room check before the next model request
    // reads for what it is.
  }
}

/**
 * One model request outside the conversation's own exchange, whose reply
 * replaces the middle of it. `messages` is rewritten in place, so the
 * caller's history — the session's, or a delegate's — is the compacted one
 * from here on.
 *
 * The opening prompt and any unanswered trailing prompt survive verbatim:
 * the first is the task the fold exists to keep working on, and the second
 * is not history but the question this turn still owes.
 */
async function compact(
  messages: ChatMessage[],
  model: ModelClient,
  report: ReportEvent,
  signal: AbortSignal,
  instructions?: string,
): Promise<void> {
  const opening = messages[0];
  let answered = messages.length;
  while (answered > 1 && messages[answered - 1].role === 'user') answered -= 1;
  const unanswered = messages.slice(answered);

  report({ type: 'compaction', phase: 'started' });
  let message: ChatMessage;
  try {
    ({ message } = await model(
      [
        ...messages,
        {
          role: 'user',
          content:
            'Summarize the conversation so far, keeping every detail the task still needs.' +
            // Verbatim, not paraphrased: the words are the caller's, and
            // the summary is what they were about (SPEC.md §3).
            (instructions !== undefined ? ` ${instructions}` : ''),
        },
      ],
      [],
      signal,
    ));
  } catch (err) {
    report({ type: 'compaction', phase: 'failed', error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
  report({ type: 'compaction', phase: 'completed' });
  const summary = message.content ?? '';
  messages.length = 0;
  messages.push(opening, { role: 'user', content: `Summary of the conversation so far: ${summary}` }, ...unanswered);
}
