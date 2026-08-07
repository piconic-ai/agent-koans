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

## Pull request descriptions

Write for non-native English readers: short sentences, no idioms.
Structure: Problem → Solution → (optional) rejected alternatives → verification.

## Conventions

- English everywhere in the repo. SPEC.md and openapi.yaml are normative.
- Published koans are immutable; koans and SPEC change together.
- Every new koan must be shown falsifiable: a broken implementation (mutant) must fail it.
