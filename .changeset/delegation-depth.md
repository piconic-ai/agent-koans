---
'agent-koans': minor
---

Add `given.limits.run.delegation_depth` and koan 091: the run permits one level of delegation and the delegate tries to delegate again. The cap shares the `run` scope but is not a budget — nothing is spent against it request by request, it is crossed rather than exhausted, and crossing it ends nothing: the one delegation that would cross it is refused the way a delegation to an undeclared name is (koan 073), no conversation opens for it, the refusal reaches the conversation that delegated, and the run carries on. The bundled Flue example cannot honor a run-declared cap and is skipped with a reason.
