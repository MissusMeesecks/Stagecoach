// =============================================================================
// Tier selection — a pure function of route state and the current message
// index. v0 implements arrival and in-stage only; wind-down and bridge arrive
// with pacing in v1 and slot in here without touching the interceptor.
// =============================================================================

export type Tier = 'arrival' | 'in-stage'

/** How many turns a freshly entered stage uses the arrival wording. Exactly one: a repeated scene-change note restarted the scene in testing. */
export const ARRIVAL_TURNS = 1

interface HistoryLike {
  role?: unknown
  content?: unknown
  __isChatHistory?: boolean
  sourceIndexInChat?: number
}

/**
 * Highest `sourceIndexInChat` among chat-history messages. Using the index
 * rather than counting messages keeps this correct when a small context window
 * truncates history, and makes swipes/regenerations harmless (the index of the
 * latest kept message does not move).
 *
 * Returns null when the host did not stamp indices, so the caller can fall back.
 */
export function highestHistoryIndex(messages: readonly HistoryLike[]): number | null {
  let max: number | null = null
  for (const m of messages) {
    if (m.__isChatHistory !== true) continue
    if (typeof m.sourceIndexInChat !== 'number' || !Number.isFinite(m.sourceIndexInChat)) continue
    if (max === null || m.sourceIndexInChat > max) max = m.sourceIndexInChat
  }
  return max
}

/** Fallback when indices are absent: count the history messages present. */
export function countHistoryMessages(messages: readonly HistoryLike[]): number {
  let n = 0
  for (const m of messages) if (m.__isChatHistory === true) n++
  return n
}

/** Full user+assistant exchanges since the stage was entered. Never negative. */
export function turnsInStage(currentIndex: number, enteredAt: number): number {
  return Math.max(0, Math.floor((currentIndex - enteredAt) / 2))
}

export interface TierInput {
  stageIndex: number
  stageCount: number
  /** enteredAt[stageIndex]; undefined when the route was created before v0 tracked it. */
  enteredAt: number | undefined
  currentIndex: number
}

/** 0 = the in-stage note never repeats. One note per stage, at arrival, is the decided design. */
export const DEFAULT_REMINDER_EVERY = 0
export const MAX_REMINDER_EVERY = 10

export interface ReminderInput {
  stageIndex: number
  enteredAt: number | undefined
  currentIndex: number
  every: number
}

/**
 * Whether this generation gets a note at all.
 *  - Stage 1 never does: the chat opened with that greeting, the scene is set.
 *  - The first reply after an Advance always does (the scene-change note).
 *  - After that, nothing, unless `every` >= 1 asks for an in-stage reminder
 *    every N replies (off by default; a repeated note looped the scene).
 * Depends only on message indices, so swipes and regenerates agree.
 */
export function reminderDue(input: ReminderInput): boolean {
  if (input.stageIndex <= 0) return false
  const turns = turnsInStage(input.currentIndex, input.enteredAt ?? 0)
  const since = turns - ARRIVAL_TURNS
  if (since < 0) return true
  const every = Math.floor(input.every)
  if (!(every >= 1)) return false
  return since % every === 0
}

export function chooseTier(input: TierInput): Tier {
  const { stageIndex, enteredAt, currentIndex } = input
  // The starting stage is never "arrived at": the chat opened there.
  if (stageIndex <= 0) return 'in-stage'
  if (enteredAt === undefined) return 'in-stage'
  return turnsInStage(currentIndex, enteredAt) < ARRIVAL_TURNS ? 'arrival' : 'in-stage'
}
