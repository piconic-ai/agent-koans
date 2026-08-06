// The timeline coupling between the mock LLM and the mock tool server.
//
// A koan's `when.model` is a single timeline: a call_tool entry with
// tool_responds enqueues the one invocation it permits; the tool server
// consumes the queue in order. An invocation with nothing pending is a
// contract violation (either the model turn permitted no tool call, or
// the arguments were supposed to fail validation).
import type { ToolResponse } from './koan.js';

export interface PendingInvocation {
  name: string;
  args: Record<string, unknown>;
  respond: ToolResponse;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a as object);
  const keysB = Object.keys(b as object);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}
