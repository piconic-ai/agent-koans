---
"agent-koans": minor
---

An optional agent-koans.yaml configures the suite: `add` runs your own koan directories alongside the bundled ones (their ids get the directory's name as a prefix and are tallied separately), and `skip` maps a koan id to a mandatory reason, printed with every skip. The CLI picks the file up from the current directory or via `--config`, and `--help` renders a real help screen.
