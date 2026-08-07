// Internal: the queue coupling mock-llm.ts (producer) to mock-tools.ts
// (consumer). Only queue-shaped code belongs here.
import type { ToolResponse } from './koan.js';

/** One permitted tool invocation and its scripted response. */
export interface PendingInvocation {
  name: string;
  args: Record<string, unknown>;
  respond: ToolResponse;
}

/** Structural equality over JSON values. */
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
