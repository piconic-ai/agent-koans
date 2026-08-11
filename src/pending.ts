// Internal: the queue coupling mock-llm.ts (producer) to mock-tools.ts
// (consumer). Only queue-shaped code belongs here.
import type { ToolResponse } from './koan.js';

/** One permitted tool invocation and its scripted response. */
export interface PendingInvocation {
  name: string;
  args: Record<string, unknown>;
  respond: ToolResponse;
  /** Set when the caller intercepts the run during this invocation. */
  hold?: InvocationHold;
}

/**
 * A scripted tool response withheld until the caller has delivered into
 * the run. The tool mock engages the hold when the invocation arrives and
 * waits for the release; the runner waits for the engagement, sends its
 * prompt, and releases.
 *
 * Two promises rather than callbacks or a polled flag: HTTP is what stops
 * the agent here — it cannot proceed until this response arrives — so
 * "the run is still running" is settled by the wire, and neither side has
 * to sample the other's progress to know it.
 */
export interface InvocationHold {
  /** Resolves once the invocation has arrived and its response is being withheld. */
  engaged: Promise<void>;
  /** Resolves once the runner has let the response go. */
  released: Promise<void>;
  /** Called by the tool mock when the invocation arrives. */
  engage(): void;
  /** Called by the runner once its delivery has been accepted. */
  release(): void;
}

/** A fresh hold. Engaging or releasing more than once is a no-op. */
export function createHold(): InvocationHold {
  let engage!: () => void;
  let release!: () => void;
  const engaged = new Promise<void>((resolve) => {
    engage = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { engaged, released, engage, release };
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
