// The run's declared context window (SPEC.md §3). Enforced where the
// budget is, at the provider boundary: Flue treats a refused fold as
// best-effort and asks the model again, so the request the window has no
// room for has to be stopped before it is issued.

/** Thrown by the provider wrapper instead of issuing a request the window cannot hold. */
export class WindowFullError extends Error {
  constructor(window: number) {
    super(`no room left in the declared context window (${window})`);
    this.name = 'WindowFullError';
  }
}

let declared: number | undefined;
let used = 0;
let full = false;

/** Arm (or disarm, with undefined) the window for the run about to start. */
export function armWindow(window: number | undefined): void {
  declared = window;
  used = 0;
  full = false;
}

/** The size the model last reported for this run's own conversation. */
export function noteUsed(tokens: number): void {
  used = tokens;
}

/** A refused fold left the conversation as it was; from here the room decides. */
export function noteFoldFailed(): void {
  if (declared !== undefined && used >= declared) full = true;
}

/** Throws when the conversation has no room for another request. */
export function checkRoom(): void {
  if (full) throw new WindowFullError(declared as number);
}
