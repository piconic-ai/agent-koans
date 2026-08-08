# CLAUDE.md

## Documentation layering

Each kind of information lives in exactly one place:

| Layer         | Carries                                                        |
| ------------- | -------------------------------------------------------------- |
| Code          | How                                                            |
| Test code     | What                                                           |
| Commit log    | Why                                                            |
| Code comments | Why not — the reason an obvious alternative was not taken      |

Comments never explain what code is, restate SPEC.md, or record history.

Two comment kinds are required on top of why-not:

- Every TS file opens with a short responsibility header: what this file
  is for, what belongs in it, and what does not.
- Every export in `runner/` carries JSDoc — it is user documentation.
  Keep exports minimal: the public surface is `runner/src/index.ts`;
  every module behind it is internal, and test-only exposure is kept
  separate from the package surface.

## Pull request descriptions

Write for non-native English readers: short sentences, no idioms.
Never hard-wrap lines: GitHub renders each newline in a PR body as a
line break, so one paragraph (or list item) must be one source line.
Structure: Overview → Problem → Solution → Verification. The overview
opens the description: a few sentences saying what this PR does, so a
reader can stop there. Add a "Rejected alternatives" section only when
the PR carries a design decision — never in mechanical changes
(cleanups, dependency bumps, koan additions that follow an
already-decided format).

## Conventions

- English everywhere in the repo. SPEC.md and openapi.yaml are normative.
- Published koans are immutable; koans and SPEC change together.
- Every new koan must be shown falsifiable: a broken implementation (mutant) must fail it.
