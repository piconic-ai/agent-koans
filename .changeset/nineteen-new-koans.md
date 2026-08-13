---
"agent-koans": minor
---

Nineteen new koans, covering ordinary cases the suite stated only through their failures.

Arguments: an optional field left out of a call, a number and a boolean, and an object argument whose fields the schema never describes — all three must reach the tool as the model wrote them (034–036).

Tool failures: a 429 and a failure with no body at all, where the status is the only thing the model can be told (037–038).

Parallel batches: the same tool called twice in one group, a batch whose calls all fail, and a group of three (039–041).

Delegation: a delegate that answers without a tool, a tool failing inside a delegate, and a second delegate briefed after the first has answered (042–044).

Budgets and the model endpoint: a model converging on the last request the budget permits, and a model request refused midway through a run (045–046).

The workspace: a read sharing one parallel group with a declared tool, and two files read one after the other (047–048).

Later turns: a third turn carrying both earlier ones, and a follow-up turn that delegates (049–050).

Compaction: a declared threshold the conversation stays below, and a caller asking for a fold there anyway (051–052).
