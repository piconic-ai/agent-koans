---
"agent-koans": patch
---

The koan file format's shape and load-time rules now live in one place, `src/format.ts`, instead of being interleaved with compilation in `src/koan.ts`. No behavior changes: every load-time error message is unchanged, and every bundled koan still loads and runs the same way. SPEC.md §6 now points to `src/format.ts` for the file's exhaustive shape, the way §3 already points to `openapi.yaml` for the wire format, and keeps its own prose to the overview and the verification semantics a validator cannot express.
