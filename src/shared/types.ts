// =============================================================================
// Stagecoach — shared types (used by both backend and frontend bundles)
// =============================================================================

/** A distilled greeting: four short fields the interceptor renders from. */
export interface StageCard {
  /** sha-256 hex of the normalised raw greeting text (trim, LF, NFC). */
  hash: string
  /** Short human name, e.g. "Riding lesson". */
  label: string
  /** What must already be true before this scene can open. State, not events. */
  presupposes: string
  /** Setting and situation. No dialogue, no user actions. */
  scene: string
  /** Tone, plus an explicit ceiling on intimacy/heat for this stage. */
  mood: string
  /** Observable narrative condition for the scene feeling finished. */
  doneWhen: string
  /** Who {{char}} shares this scene with. Empty = {{user}}. A name (group member or anyone) otherwise. */
  with?: string
  source: 'llm' | 'manual' | 'edited'
  updatedAt: number
}

export type InjectMode = 'system-at-depth' | 'append-to-last-user'

/** How the arrival wording asks the model to get INTO a stage. A playthrough choice, so it lives on the route. */
export type TransitionStyle = 'auto' | 'cut' | 'elapse' | 'flow'

export type Strength = 1 | 2 | 3 | 4 | 5

export interface RouteTiming {
  dwell: number
  bridge: number
  ceiling: number
  depth: number
  /** Inject the in-stage note only every N replies (arrival turns always inject). */
  reminderEvery: number
}

/** Per-chat playthrough state. Lives in userStorage at chats/<chatId>.json. */
export interface ChatRoute {
  chatId: string
  characterId: string
  enabled: boolean
  /** Ordered StageCard hashes chosen for this playthrough. */
  route: string[]
  stageIndex: number
  /** Message index at which each reached stage was entered. Length === stageIndex + 1. */
  enteredAt: number[]
  strength: Strength
  timing?: Partial<RouteTiming>
  injectMode: InjectMode
  /** Transition style keyed by the hash of the stage being entered. Absent = 'auto'. */
  transitions?: Record<string, TransitionStyle>
  /** Latest message id when each stage was entered, keyed by stage index. The interceptor counts replies after it. */
  anchors?: Record<string, string>
  /** User pressed "Skip this note": no note for the current stage entry. Cleared by any pointer move or by "Send scene note". */
  skipNote?: boolean
}

/** One greeting on the active character, as shown in the panel. */
export interface GreetingInfo {
  /** 0 = first_mes, 1.. = alternate_greetings[n-1]. */
  index: number
  hash: string
  /** Full raw greeting text (macros unresolved). */
  text: string
  /** Stage card if one has been saved for this hash. */
  card: StageCard | null
  /** Whose card this greeting is on. Set for live greetings; absent for orphaned cards (index -1). */
  characterId?: string
  characterName?: string
}

export interface ConnectionInfo {
  id: string
  name: string
  provider: string
  model: string
  is_default: boolean
}

export interface ExtensionSettings {
  /** Connection used for the Distill button. null = user's default. */
  distillConnectionId: string | null
  /** Standing instructions after scene and mood in every in-stage note (sent only with in-stage reminders on, which have no UI). null = the built-in default. */
  inStageInstructions: string | null
  /** Last sentence of every scene-change (arrival) note, the note that is actually sent. null = TENSE_NOTE. */
  closingLine: string | null
  /** "Higher token limit" switch: every budget in HIGH_TOKEN_LIMITS instead of STANDARD_TOKEN_LIMITS. */
  highTokenLimit: boolean
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  distillConnectionId: null,
  inStageInstructions: null,
  closingLine: null,
  highTokenLimit: false,
}

/** The budgets the "Higher token limit" switch moves together. */
export interface TokenLimits {
  /** Soft token budget for the injected note; the renderer trims scene and mood, then the whole note, to fit. */
  directive: number
  /** Soft target for a whole stage card. */
  cardTarget: number
  /** Cap for a whole stage card; the editor's count turns red past it. */
  cardCap: number
  /** Longest custom closing line (or in-stage instructions) accepted. It shares the directive budget with scene and mood. */
  instructionsChars: number
  /** Per-field word limit Distill asks for. */
  distillWords: number
}

/** Usable on a 4K-context connection. The default. */
export const STANDARD_TOKEN_LIMITS: TokenLimits = { directive: 120, cardTarget: 50, cardCap: 90, instructionsChars: 400, distillWords: 25 }
/** Every budget doubled, for connections with room to spare. */
export const HIGH_TOKEN_LIMITS: TokenLimits = { directive: 240, cardTarget: 100, cardCap: 180, instructionsChars: 800, distillWords: 50 }

export function tokenLimitsFor(settings: Pick<ExtensionSettings, 'highTokenLimit'>): TokenLimits {
  return settings.highTokenLimit ? HIGH_TOKEN_LIMITS : STANDARD_TOKEN_LIMITS
}

/** Everything the drawer tab needs to render, for one chat. */
export interface PanelState {
  chatId: string | null
  characterId: string | null
  characterName: string | null
  greetings: GreetingInfo[]
  route: ChatRoute | null
  connections: ConnectionInfo[]
  settings: ExtensionSettings
  permissions: string[]
  /** Hash of the greeting this chat opened with, when it could be matched. null = checked, no match. */
  openingHash?: string | null
  /** Why detection did or did not match: 'matched', 'no-match', or the frontend probe reason. */
  openingStatus?: string
  /** On 'no-match': a short excerpt of what was read as the first message, so the user can see why. */
  openingSample?: string
  /** Group chat: greetings are pooled from every member and {{char}} on a card means the card's owner. */
  isGroup?: boolean
  /** Group members in host order (the chat's own character first). */
  members?: Array<{ id: string; name: string }>
  /** Set when the backend could not load the chat/character; shown to the user. */
  error?: string
}

// ---- Frontend → backend messages ---------------------------------------------

export type FrontendMessage =
  | { type: 'get_state'; chatId: string | null; openingText?: string | null; openingProbe?: string; openingCandidates?: string[] }
  /** Frontend-observed message count after a deletion; the backend rewinds the pointer if needed. */
  | { type: 'sync_count'; chatId: string; messageCount: number }
  | { type: 'set_enabled'; chatId: string; enabled: boolean; messageCount: number }
  | { type: 'set_route'; chatId: string; route: string[]; messageCount: number }
  | { type: 'set_stage'; chatId: string; stageIndex: number; messageCount: number; latestMessageId?: string | null }
  /** armed=true re-enters the current stage so its scene-change note goes out on the next reply; armed=false skips it. */
  | { type: 'set_note'; chatId: string; armed: boolean; messageCount: number; latestMessageId?: string | null }
  | { type: 'set_inject_mode'; chatId: string; injectMode: InjectMode }
  | { type: 'set_depth'; chatId: string; depth: number }
  | { type: 'set_reminder_every'; chatId: string; every: number }
  | { type: 'set_transition'; chatId: string; hash: string; style: TransitionStyle }
  | { type: 'save_card'; chatId: string | null; card: StageCard }
  | { type: 'delete_card'; chatId: string | null; hash: string }
  /** runId is echoed on the reply, so a reply from a run the panel gave up on (or replaced) can be told apart. */
  | { type: 'distill'; chatId: string; hash: string; connectionId: string | null; runId?: string }
  | { type: 'set_settings'; chatId: string | null; settings: Partial<ExtensionSettings> }
  | { type: 'count_tokens'; requestId: string; text: string }

// ---- Backend → frontend messages ---------------------------------------------

export type BackendMessage =
  | { type: 'state'; state: PanelState }
  | { type: 'distill_result'; hash: string; runId?: string; card: Omit<StageCard, 'hash' | 'updatedAt'> }
  | { type: 'distill_error'; hash: string; runId?: string; message: string }
  | { type: 'token_count'; requestId: string; tokens: number; approximate: boolean }
  | { type: 'error'; message: string }

/** Directive budget when no settings are in play (tests, callers that pass no cap). */
export const DIRECTIVE_TOKEN_CAP = STANDARD_TOKEN_LIMITS.directive
