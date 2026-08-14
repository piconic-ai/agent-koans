---
"agent-koans": minor
---

A koan now writes the agent executing a call with a tool of its own as the request it is, with no response: `- request: { tool: read_file }`. A step's response is what a mock answered, and nothing observable answers this one — the file is in `given.files`, and what must surface is its content in the conversation's next model request. Three shapes now carry three meanings: a request with a response ran at the tool server, a request alone the agent answered itself, and no step at all is a call never executed. Before, the internal execution was an absence too, told apart from a refusal only by whether `args.path` named a `given.files` entry; a koan that still leaves an internal read to an absence is rejected at load time with the step to write, and a declared tool's request without a response is rejected naming the response it owes. The published koans 021 and 026 are rewritten in the new form; their contracts and every pass/fail outcome are unchanged.
