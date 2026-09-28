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
  sourceMessageId?: string
}

export interface RepliesInput {
  /** Id of the latest message when the stage was entered (route.anchors). Preferred: immune to index offsets. */
  anchorId?: string | null
  /** Message count when the stage was entered (route.enteredAt). Fallback when the anchor is not in the window. */
  enteredAt: number
  /** Message the host says to leave out (the one being regenerated or written). Never counts as a reply. */
  excludeId?: string | null
}

function hasText(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0
  if (Array.isArray(content)) return content.some((p) => p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' && (p as { text: string }).text.trim().length > 0)
  return false
}

/** A character reply that has actually been written: not a placeholder row for the reply now being generated, not the excluded message. */
export function isLandedReply(m: HistoryLike, excludeId?: string | null): boolean {
  if (m.__isChatHistory !== true || m.role !== 'assistant') return false
  if (excludeId && m.sourceMessageId === excludeId) return false
  return hasText(m.content)
}

export interface RepliesSince {
  /** Character replies that landed after the stage was entered. */
  replies: number
  /** Which rule counted them. */
  by: 'anchor' | 'index' | 'position'
}

/**
 * How many character replies have landed since the stage was entered. This,
 * not a turn count, decides the scene-change note: in a group chat members
 * reply back to back with no user turn between, so "index delta / 2" fired
 * the note up to three times.
 *
 * Anchor first: count assistant history messages after the message that was
 * latest at Advance. If that message is not in the window (deleted, forked,
 * truncated away), fall back to `sourceIndexInChat >= enteredAt`, and to
 * array position when the host did not stamp indices.
 */
export function repliesSince(messages: readonly HistoryLike[], input: RepliesInput): RepliesSince {
  const hist = messages.filter((m) => m.__isChatHistory === true)
  if (input.anchorId) {
    const at = hist.findIndex((m) => m.sourceMessageId === input.anchorId)
    if (at !== -1) {
      let replies = 0
      for (let i = at + 1; i < hist.length; i++) if (isLandedReply(hist[i]!, input.excludeId)) replies++
      return { replies, by: 'anchor' }
    }
  }
  const indexed = hist.some((m) => typeof m.sourceIndexInChat === 'number' && Number.isFinite(m.sourceIndexInChat))
  let replies = 0
  hist.forEach((m, pos) => {
    const idx = indexed && typeof m.sourceIndexInChat === 'number' ? m.sourceIndexInChat : pos
    if (idx >= input.enteredAt && isLandedReply(m, input.excludeId)) replies++
  })
  return { replies, by: indexed ? 'index' : 'position' }
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

/** Panel-side estimate of replies since entry from a message count alone (the panel cannot see roles). Never negative. */
export function turnsInStage(currentIndex: number, enteredAt: number): number {
  return Math.max(0, Math.floor((currentIndex - enteredAt) / 2))
}

export interface TierInput {
  stageIndex: number
  stageCount: number
  /** enteredAt[stageIndex]; undefined when the route was created before v0 tracked it. */
  enteredAt: number | undefined
  /** Character replies since the stage was entered (repliesSince, or the panel's estimate). */
  replies: number
}

/** 0 = the in-stage note never repeats. One note per stage, at arrival, is the decided design. */
export const DEFAULT_REMINDER_EVERY = 0
export const MAX_REMINDER_EVERY = 10

export interface ReminderInput {
  stageIndex: number
  /** Character replies since the stage was entered. */
  replies: number
  every: number
}

/**
 * Whether this generation gets a note at all.
 *  - Stage 1 never does: the chat opened with that greeting, the scene is set.
 *  - The first reply after an Advance always does (the scene-change note).
 *  - After that, nothing, unless `every` >= 1 asks for an in-stage reminder
 *    every N replies (off by default; a repeated note looped the scene).
 * A regenerated or swiped reply is not in the prompt, so it counts as the
 * first reply again and gets the same note.
 */
export function reminderDue(input: ReminderInput): boolean {
  if (input.stageIndex <= 0) return false
  const since = input.replies - ARRIVAL_TURNS
  if (since < 0) return true
  const every = Math.floor(input.every)
  if (!(every >= 1)) return false
  return since % every === 0
}

export function chooseTier(input: TierInput): Tier {
  const { stageIndex, enteredAt, replies } = input
  // The starting stage is never "arrived at": the chat opened there.
  if (stageIndex <= 0) return 'in-stage'
  if (enteredAt === undefined) return 'in-stage'
  return replies < ARRIVAL_TURNS ? 'arrival' : 'in-stage'
}
