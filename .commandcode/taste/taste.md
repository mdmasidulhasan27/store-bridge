# Taste

## Communication

- Prefers very concise answers — explicitly asks to "answer in one line" and expects responses condensed to a single line when requested. Confidence: 0.7
- Specifies requirements as explicit numbered rule lists that enumerate the expected behavior for each edge case (e.g. create vs update vs stock paths) and expects them implemented literally, letting code follow the stated rules rather than the assistant substituting its own judgment. Confidence: 0.5

## Workflow

- Wants a markdown handoff/context doc at the repo root (e.g. `PROJECT_CONTEXT.md`) capturing architecture, environment variable names, code map, setup commands, current status, caveats, and next steps — so work can be resumed from a different machine. Confidence: 0.7
- Pasting raw terminal/error output (including full HTML error bodies, stack traces, and dev-server logs) with no or minimal accompanying question, and expecting the assistant to identify the root cause and the concrete fix — often without any ask. Confidence: 0.5
- Prefers minimal, necessary-only code: questions whether a proposed change (e.g. a defense-in-depth source guard) is actually required before accepting it, declines optional code when existing behavior already works, and proactively asks to audit and strip unused/dead code (unused re-exports, unused fields, and `export` on internal-only symbols). Confidence: 0.6
