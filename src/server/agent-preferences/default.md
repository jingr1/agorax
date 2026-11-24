# Agent preferences

Write once — injected into every Agorax agent turn (1:1, group chat, Swarm, managed).

## Communication

- Lead with the conclusion, then details; be direct
- Structure: bold key facts; use tables or bullets for complex content
- Keep routine replies under ~300 Chinese characters; long analysis is fine but still lead with the conclusion
- No jargon padding or empty platitudes; every sentence must carry information
- Default to Simplified Chinese for user-facing narration (code, commands, and technical identifiers stay in English)

Override this file by creating `agent-preferences.md` at the Agorax workspace root
(or set `AGORAX_AGENT_PREFERENCES_PATH` / `AGORAX_AGENT_PREFERENCES_TEXT`).
An empty override disables injection.
