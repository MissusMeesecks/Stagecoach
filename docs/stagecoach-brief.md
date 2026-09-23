# Stagecoach — extension brief

status: Built. This is the original brief (2026-09-19) that v1.0 was built from, lightly trimmed. Where it disagrees with README.md or ROADMAP.md, they win.


## What this is

A Spindle extension for Lumiverse that treats a character card's greetings (`first_mes` plus `alternate_greetings`) as an ordered sequence of story stages, and soft-steers a roleplay through them. Mechanically it is an Author's Note with a moving pointer: a single scene-change note, injected once when you advance, describing only the new stage. 

The value of the extension is what it withholds. A static scenario field shows the model the entire arc on every turn, so the arc is either ignored (it sits far from the generation point) or speedrun (everything in context reads as relevant now). This extension shows the model only the current stage, and reveals the next one in controlled steps.

Motivating observation: many current cards write their alternate greetings as sequential "later chapters" rather than parallel alternatives, so this is useful on other people's cards, not only purpose-built ones.

## Provenance of what follows

**Decided by MissusMeesecks**

- Soft steer only. The model writes its own way into each stage. Greeting prose is never inserted into the chat.
- Extension-driven only. Nothing is ever written to a character card: no `characters.update`, no `extensions` blob. Cards must stay portable to other frontends.
- The user picks which greetings count as stages, and in what order.

## Instructions to the coding agent

1. Read the docs listed under "Read first" before writing code. The API facts below were verified on 2026-09-19, but the platform moves quickly.
2. Never write to character cards.
3. Keep the interceptor pure: read state, splice, return. No LLM calls, no storage writes, no state mutation inside it.
4. The mistake you are most likely to make is injecting the full stage list "for context". Do not. Later stages must not appear in the prompt in any form until their tier says so. This is the whole point of the extension.
5. Ask before adding any permission beyond those listed for the current phase.

## Verified platform facts (docs.lumiverse.chat, 2026-09-19)

| Need | API | Permission |
| --- | --- | --- |
| Read greetings | `spindle.characters.get(id)` returns `first_mes` and `alternate_greetings: string[]` | `characters` |
| Chat to character | `spindle.chats.get(chatId)` returns `character_id`; `spindle.chats.getActive()` | `chats` |
| Inject into the prompt | `spindle.registerInterceptor(handler, priority)`. Runs after prompt assembly, before the provider call. Receives the full message array and returns a modified one. | `interceptor` |
| Show the injection in Prompt Breakdown | Return `{ messages, breakdown: [{ messageIndex, name }] }`. Works with `interceptor` alone; only returned `parameters` need `generation_parameters`. | `interceptor` |
| LLM side calls (distill, judge) | `spindle.generate.raw({ messages, parameters, connection_id, reasoning, signal })`. `quiet` uses the active connection. `reasoning: { source: 'off' }` disables thinking for a cheap call. Structured output goes through provider parameters. | `generation` |
| Pick a connection for side calls | `spindle.connections.list()` / `.get(id)` | `generation` |
| React after a reply lands | `GENERATION_ENDED` carries `{ generationId, chatId, messageId, content, error }` | `generation` |
| Other events | `MESSAGE_SENT`, `MESSAGE_EDITED`, `MESSAGE_DELETED`, `MESSAGE_SWIPED` (with an `action` discriminator), `CHAT_SWITCHED`, `CHARACTER_EDITED`, `CHARACTER_DELETED` | none listed |
| Read messages outside the interceptor | `spindle.chat.getMessages(chatId)` | `chat_mutation` |
| Per-user storage | `spindle.userStorage.getJson(path, { fallback })` / `.setJson(path, value)`. `spindle.storage` is per-extension and shared across users on operator installs. | none listed |
| UI | Frontend module receives `ctx` with `ctx.dom.*`, `ctx.ui.*`, `ctx.components.*` (first-party themed inputs). Placements: drawer tabs, floating widgets, dock panels, input bar actions. | n/a |

Further verified details:

- The interceptor context holds `chatId`, `connectionId`, `personaId`, `generationType` (`normal`, `continue`, `regenerate`, `swipe`, `impersonate`, `quiet`) and `activatedWorldInfo`. It does not hold a character id, so resolve it through `chats.get()` and cache it.
- Messages that come from stored chat turns are flagged `__isChatHistory` and carry `sourceMessageId` and `sourceIndexInChat` "where available".
- Interceptor budget: 10 s by default, overridable per extension with `interceptorTimeoutMs` in `spindle.json`, clamped to 1 s – 300 s. On timeout the host passes the unmodified messages through. Interceptor time is silence before the first streamed token.
- Dry runs and prompt previews run the same pipeline, interceptors included. This is why the interceptor must have no side effects.
- Extension calls to `generate.raw`, `quiet` and `batch` do not re-enter the interceptor chain, so no recursion guard is needed.
- Context handlers (`context_handler` permission) run before assembly and cannot place text at a depth. Not needed here.
- No chat-deleted event is documented. Clean up per-chat state lazily.
- Project layout: `spindle.json`, `src/backend.ts`, `src/frontend.ts`, compiled to `dist/`. Types come from `lumiverse-spindle-types`. Other community extensions commit `dist/` so Lumiverse can run the checked-in build, and install by pasting the GitHub URL into the Extensions panel.

## Core design

### Stage card

Each selected greeting is distilled once into a stage card of four short fields. Target about 50 tokens in total, hard cap about 90.

- `presupposes`: what must already be true before this scene can open. State, not events. Later-chapter greetings usually encode this ("three weeks since you arrived").
- `scene`: setting and situation. No dialogue, no user actions.
- `mood`: tone, plus an explicit ceiling on intimacy or heat for this stage. This field also acts as a governor against traits in the card description pulling the story forward early.
- `doneWhen`: an observable narrative condition for the scene feeling finished.

Example, for a "fireside evening" greeting:

```yaml
presupposes: Some weeks have passed. {{user}} has ridden with {{char}} several times and the formality between them has worn off.
scene: Evening at the ranch house, fire lit, a bottle {{char}} has been saving. Just the two of them.
mood: Warm, charged, unhurried. Flirtation is mutual; nothing physical has happened yet.
doneWhen: One of them has openly acknowledged the tension.
```

Stage cards keep `{{char}}` and `{{user}}` literally. The interceptor runs after macro resolution, so the extension must substitute names itself at injection time. Storing the macros keeps cards independent of persona.

### Injection tiers

The tier is a pure function of the chat's route state and the current message index.

1. **Scene Change Note** (first turns after advancing): "The story now moves to: {scene}. Mood: {mood}. Open this scene; a time skip is fine."

The time-skip licence is deliberate. Roleplay models rarely skip time unprompted, and stage preconditions are often elapsed time.

### Data model

All of this lives in `spindle.userStorage`. Nothing lives in the card.

```ts
// cards/<hash>.json, content-addressed by the greeting text
interface StageCard {
  hash: string          // sha-256 of the normalized raw greeting (trim, LF line endings, NFC)
  label: string         // short human name, e.g. "Riding lesson"
  presupposes: string
  scene: string
  mood: string
  doneWhen: string
  source: 'llm' | 'manual' | 'edited'
  updatedAt: number
}

// chats/<chatId>.json
interface ChatRoute {
  chatId: string
  characterId: string
  enabled: boolean
  route: string[]       // ordered StageCard hashes chosen for this playthrough
  stageIndex: number
  enteredAt: number[]   // message index at which each reached stage was entered
  strength: 1 | 2 | 3 | 4 | 5
  timing?: Partial<{ dwell: number; bridge: number; ceiling: number; depth: number }>
  injectMode: 'system-at-depth' | 'append-to-last-user'
}
```

Consequences of content addressing: re-importing a card does not orphan edits, two cards sharing a greeting share a stage card, and an author rewriting a greeting simply yields a new hash that shows as "not distilled". In-progress chats keep working because their route points at hashes, not at card positions.

### Interceptor algorithm

1. If `generationType` is `impersonate` or `quiet`, return the messages unchanged.
2. Load the `ChatRoute` for `context.chatId` from an in-memory cache that is invalidated on UI writes. If missing or disabled, return unchanged.
3. Current index = the highest `sourceIndexInChat` among `__isChatHistory` messages. Turns in stage = `floor((currentIndex - enteredAt[stageIndex]) / 2)`. Using index deltas rather than counting messages keeps this correct when a small context window truncates history, and makes swipes and regenerations harmless.
4. Choose the tier, render the template, substitute names, enforce the token cap.
5. Find the last `__isChatHistory` message and place the directive relative to it, never relative to the end of the array. A preset may end with an assistant prefill, and that must stay last.
6. Return `{ messages, breakdown }` with a name such as "Stagecoach · stage 2/4 · bridge".

Injection modes: `system-at-depth` inserts a system message N history messages from the end. `append-to-last-user` appends the directive to the content of the last user message, which is safe for strict-alternation chat templates. Remember that `content` can be an array of parts; append a text part in that case.

State changes happen only in event handlers and UI actions. On `MESSAGE_DELETED`, if the message count has dropped to or below the last `enteredAt` entry, pop entries and rewind `stageIndex` to match.

### Distillation (the Distill button)

One `generate.raw` call per greeting, on a user-chosen connection, with reasoning off and JSON output. The prompt must ask for the four fields at no more than about 25 words each, tell the model to keep `{{char}}` and `{{user}}` verbatim, to write `presupposes` as state rather than actions, and to exclude dialogue and user actions from `scene`. The result fills the editor. The user edits and saves. Nothing is final until a human has looked at it.


## Unverified, check while building

- Whether `characters.get()` returns greeting text with macros unresolved. Assumed yes; the hashing depends on it.
- Whether `sourceIndexInChat` is always present on history messages. If it can be absent, keep a fallback message count from `MESSAGE_SENT` and `MESSAGE_DELETED` events and log when the fallback is used.
- Whether a macro-resolution helper exists for extension text (see the Macros page). Otherwise substitute `{{char}}` and `{{user}}` by hand; the persona name may require the `personas` permission.
- Which manifest keys cover the frontend entry point and settings (see the Manifest page).
- Whether the Tokens API offers real token counting. Otherwise estimate as characters divided by four.
- How to detect a group chat.

## Read first

- Quick Start, Manifest, Permissions: https://docs.lumiverse.chat/getting-started/quick-start/
- Interceptors: https://docs.lumiverse.chat/backend-api/interceptors/
- Characters: https://docs.lumiverse.chat/backend-api/characters/
- Chats: https://docs.lumiverse.chat/backend-api/chats/
- Events: https://docs.lumiverse.chat/backend-api/events/
- Storage: https://docs.lumiverse.chat/backend-api/storage/
- Generation: https://docs.lumiverse.chat/backend-api/generation/
- Frontend API (UI Placement, Shared Components, Backend Communication): https://docs.lumiverse.chat/frontend-api/
- Prompt Interceptor example: https://docs.lumiverse.chat/examples/prompt-interceptor/

