# Stagecoach — notes for coding agents

Lumiverse Spindle extension. Read `docs/stagecoach-brief.md` first; it is the design record.

Hard rules from the brief:
- Never write to character cards (no `characters.update`, no `extensions` blob).
- The interceptor in `src/backend.ts` is pure: read caches, splice, return. No LLM calls, storage writes, or state mutation there.
- Only the current stage's card may reach the prompt. Later stages never appear, in any form, until their tier says so.
- Ask before adding permissions beyond `characters`, `chats`, `interceptor`, `generation`.

Toolchain: `bun install`, `bun run verify` (tsc + bun test + build). Commit `dist/` after building; the host runs the checked-in bundle.
Platform types: `lumiverse-spindle-types` in node_modules (docs.lumiverse.chat may be unreachable from sandboxes).
Findings from live tests: names resolve via the macro engine; trailing/mid-history system messages were ignored by the roleplay model, appending to the user turn steers at once (so append is the default).
Per-stage transition styles (route.transitions, keyed by stage hash) shape only the arrival wording; default is 'elapse' (narrated time skip), and the legacy 'auto' value maps to it. Only scene and mood reach the model; presupposes is a read-only context line, doneWhen is parked.
Append mode wraps the directive as `(OOC: …)` (parentheses on purpose: `[OOC: …]` is the host's regen-feedback marker). Every directive ends with a keep-tense-and-voice note.
Decided: one note per stage, on the first reply after Advance; stage 1 never gets a note. The optional in-stage reminder (route.timing.reminderEvery) is off by default and has no UI; both a repeated note and a note on every reply looped the scene.
On the Lumiverse build this was developed against (Sept 2026), the frontend had no ctx.messages.get; the opening greeting is read from the mounted first-message bubble in the DOM instead. Raw generate calls need an explicit connection id and model.
Distill must send the connection's model explicitly (top-level and in parameters) or OpenRouter answers "No models provided".
Phase status: v1 built, tested and extended. Auto-advance, strength and the judge were dropped by decision.
