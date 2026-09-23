# Roadmap

Kept so decisions survive the chat they were made in. Update it when the slate changes.

## Done

- v0 from the brief: route builder, stage cards with Distill, stage pointer with Advance/Back, two injection modes.
- Append-to-last-user is the default injection mode (system messages were ignored by the tested roleplay models).
- Per-stage transition styles ("Way in"): hard cut, skip time and narrate the gap (default), develop in-scene.
- `(OOC: ...)` wrapper in append mode; keep-tense-and-voice note on every directive.
- Route copied onto forked chats; pointer rewinds when messages are deleted back past a stage change.
- Detection of the greeting a chat opened with, with a one-click "make it stage 1".
- Distill prompt keeps `{{user}}`'s actions out of the scene field.
- One note per stage, at arrival; stage 1 silent. Periodic in-stage reminders looped the scene, so they are off (the backend still honours `timing.reminderEvery` if a future UI wants it).

## Parked

- **`{{stage}}` macro.** Lets preset authors place the directive themselves instead of using append or system mode. Cheap (`registerMacro` is free-tier).
- **Manual bridge.** A "Prepare next stage" toggle beside Advance that reveals the next stage's `presupposes` so the model can lay groundwork before the scene changes. An untested hypothesis from the original design.
- **Export and import stage cards.** Parked. Two shapes to explore:
  - A JSON file per character, the plain option.
  - Save the stage cards into the character's lorebook, creating one if the card has none. Writing *entries* into a lorebook that is already attached needs only the `world_books` permission and leaves the card untouched. *Attaching* a new lorebook means `characters.update(world_book_ids)`, which is a card write and collides with the never-write-to-cards rule; the card would carry the book on export, which is the point, so this needs an explicit decision (and permission ask) before building.
- **Suggested order.** One LLM call proposing a sequence for cards with many alternates.
- **In-stage reminder.** Re-send the current stage's scene every N replies for very long stages or small context windows. Backend supports it (`timing.reminderEvery`, currently 0 = off); the UI control was removed because a repeated note looped the scene on literal models.

## Dropped

- **Turn ceilings and auto-advance.** The change point being user-directed turned out to be the pacing control that matters.
- **Strength slider.** Every "how fast" question is answered by pressing Advance; with append mode, injection depth is moot too.
- **LLM judge (v2).** Same reason. Also the only feature that needed the `chat_mutation` permission.
- **Model-callable `advance_stage` tool.** Takes the change point away from the user.
- **Wind-down wording.** The status line's turns-in-stage count carries the same information without touching the prompt.
- **`doneWhen` field.** Only the judge would have used it. Removed from the editor and from Distill; stored cards keep the field as an empty string.
- **Editable `presupposes`.** Kept as a read-only "Context" line from Distill, purely to vibe-check scene and mood. Never sent to the model.
- **"Default: time skip allowed" transition.** Too vague; the narrated skip is the default now. The stored value `auto` still reads as the narrated skip.
