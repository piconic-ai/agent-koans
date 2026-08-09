---
"agent-koans": minor
---

The bundled `koans/` directory is flat: koan files no longer sit inside a `lifecycle/` or `tool-reliability/` subdirectory, and a koan's id is now just its filename (e.g. `001-happy-path`, not `tool-reliability/001-happy-path`). Custom koan directories added via `add` are flat the same way — a subdirectory inside an added directory is no longer walked. Update any `skip` entries in `agent-koans.yaml` to drop the old directory prefix.
