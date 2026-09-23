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
  /** Standing instructions after scene and mood in every in-stage note. null = the built-in default. */
  inStageInstructions: string | null
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  distillConnectionId: null,
  inStageInstructions: null,
}

/** Hard cap on custom in-stage instructions; the whole note is capped at DIRECTIVE_TOKEN_CAP anyway. */
export const INSTRUCTIONS_MAX_CHARS = 400

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
  | { type: 'set_stage'; chatId: string; stageIndex: number; messageCount: number }
  | { type: 'set_inject_mode'; chatId: string; injectMode: InjectMode }
  | { type: 'set_depth'; chatId: string; depth: number }
  | { type: 'set_reminder_every'; chatId: string; every: number }
  | { type: 'set_transition'; chatId: string; hash: string; style: TransitionStyle }
  | { type: 'save_card'; chatId: string | null; card: StageCard }
  | { type: 'delete_card'; chatId: string | null; hash: string }
  | { type: 'distill'; chatId: string; hash: string; connectionId: string | null }
  | { type: 'set_settings'; chatId: string | null; settings: Partial<ExtensionSettings> }
  | { type: 'count_tokens'; requestId: string; text: string }

// ---- Backend → frontend messages ---------------------------------------------

export type BackendMessage =
  | { type: 'state'; state: PanelState }
  | { type: 'distill_result'; hash: string; card: Omit<StageCard, 'hash' | 'updatedAt'> }
  | { type: 'distill_error'; hash: string; message: string }
  | { type: 'token_count'; requestId: string; tokens: number; approximate: boolean }
  | { type: 'error'; message: string }

/** Soft token budget for the injected block (usable on a 4K-context connection). */
export const DIRECTIVE_TOKEN_CAP = 120
/** Soft target for a whole stage card. */
export const CARD_TOKEN_TARGET = 50
/** Hard cap for a whole stage card. */
export const CARD_TOKEN_CAP = 90
