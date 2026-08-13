// The run's model-request budget. What belongs here is how many requests
// a run may spend and how one is claimed; what does not is what running
// out means — the loop and the run lifecycle each answer that on their own.
//
// One budget per run, shared by the main conversation and every subagent
// conversation: a delegate's requests arrive at the model endpoint too, so
// they draw from the same budget rather than each conversation getting one.

// A ceiling of its own, so a run that declares no limit still terminates.
const MAX_STEPS = 16;

/** What a run declared about how much it may spend (SPEC.md §3). */
export interface RunLimits {
  max_model_requests?: number;
}

/** A claim on one model request. */
export interface Grant {
  /** Whether this claim took the last request the budget permits. */
  last: boolean;
}

/** A run's model-request budget, shared by every conversation of that run. */
export interface Budget {
  readonly max: number;
  /** Claim one model request; `undefined` when the budget is spent. */
  take(): Grant | undefined;
}

/** Open a budget for a run, never wider than this agent's own ceiling. */
export function createBudget(limits?: RunLimits): Budget {
  const max = Math.min(MAX_STEPS, limits?.max_model_requests ?? MAX_STEPS);
  let used = 0;
  return {
    max,
    take() {
      if (used >= max) return undefined;
      used += 1;
      return { last: used === max };
    },
  };
}
