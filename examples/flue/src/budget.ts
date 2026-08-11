// Per-run model-request budget (SPEC.md §3), shared between the HTTP
// adapter and the provider wrapper. Flue exposes no step-limit
// configuration, so the budget is enforced at the provider boundary: the
// request that would exceed it is never issued. A single mutable slot is
// enough — the conformance runner starts a fresh agent process per koan
// and submits one run at a time.

/** Thrown by the provider wrapper instead of issuing an over-budget request. */
export class BudgetExhaustedError extends Error {
  constructor(budget: number) {
    super(`model-request budget exhausted (${budget})`);
    this.name = 'BudgetExhaustedError';
  }
}

let budget: number | undefined;
let used = 0;
let tripped = false;

/** Arm (or disarm, with undefined) the budget for the run about to start. */
export function armBudget(maxModelRequests: number | undefined): void {
  budget = maxModelRequests;
  used = 0;
  tripped = false;
}

/** Account for one model request; throws instead of letting it exceed the budget. */
export function noteModelRequest(): void {
  if (budget === undefined) return;
  if (used >= budget) {
    tripped = true;
    throw new BudgetExhaustedError(budget);
  }
  used += 1;
}

/** Whether the current run was stopped by its budget (reported as aborted). */
export function budgetTripped(): boolean {
  return tripped;
}
