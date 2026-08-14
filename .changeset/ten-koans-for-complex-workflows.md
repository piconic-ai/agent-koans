---
"agent-koans": minor
---

Ten koans for complex workflows, 053–062: two prompts delivered mid-run are answered in admission order (053); an abort clears the queued prompt (054) and stops a delegation mid-task (055); a delegate's model failure is the delegation's outcome, not the run's (056); a tool call and a delegation close as one parallel batch (057); delegation nests, with isolation at every depth (058); a second threshold crossing folds again (059); a delegate's usage never triggers the run's fold (060); the summarizing request spends from the model-request budget (061); and a severed tool connection reaches the model as a failure (062). Koan files can now script what these need: several mid-run prompts, `abort` after a delivered prompt or mid-delegation, a model API failure inside a subagent block, `response: disconnect` on a tool step, and a fold as a trace's last exchange.
