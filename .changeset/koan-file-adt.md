---
"agent-koans": patch
---

The koan file format's shape now lives in `src/koan-spec.ts` as plain types, one per YAML form, so a violation like mixing `when` with `turns` is unrepresentable rather than merely rejected. `src/parse.ts` reads a file into those types and checks the rules no type can carry (delegation and tool-request matching, budgets, distinct openings); `src/koan.ts` only compiles the result into the runner's internal form. `src/format.ts` is removed. No behavior change: every load-time error message is unchanged, and every bundled koan still loads and runs the same way. SPEC.md §6 now points to `src/koan-spec.ts` for the file's exhaustive shape, the way §3 already points to `openapi.yaml` for the wire format, and keeps its own prose to the overview and the verification semantics only a running trace can judge.
