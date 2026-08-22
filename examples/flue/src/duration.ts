// Per-prompt wall-clock budget (SPEC.md §3). The declared value is
// armed once, at the run's start, and read again by every follow-up
// prompt through runTurn — sendPrompt carries no limits of its own, so
// the value has to survive between turns the way budget.ts's and
// window.ts's do. Unlike those, nothing here accumulates across turns:
// the budget restarts fresh for every prompt, so this module holds
// only the declared value, never a running total.
//
// One mutable slot, exactly as budget.ts and window.ts hold theirs: the
// conformance runner starts a fresh agent process per koan and submits
// one run at a time.

let declared: number | undefined;

/** Arm (or disarm, with undefined) the declared duration for the run about to start. */
export function armDuration(maxDurationMs: number | undefined): void {
  declared = maxDurationMs;
}

/** The wall-clock budget declared for this run, for the prompt about to start. */
export function declaredDuration(): number | undefined {
  return declared;
}
