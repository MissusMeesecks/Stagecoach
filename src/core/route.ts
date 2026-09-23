// =============================================================================
// ChatRoute state transitions. Pure; the backend persists what these return.
// =============================================================================

import type { ChatRoute, InjectMode, TransitionStyle } from '../shared/types.ts'
import { DEFAULT_REMINDER_EVERY, MAX_REMINDER_EVERY } from './tiers.ts'

const TRANSITION_VALUES: readonly TransitionStyle[] = ['auto', 'cut', 'elapse', 'flow']

export function isTransitionStyle(v: unknown): v is TransitionStyle {
  return typeof v === 'string' && (TRANSITION_VALUES as readonly string[]).includes(v)
}

/** 0 = directly after the latest history message. Testing showed depth 2 was too gentle to steer. */
export const DEFAULT_DEPTH = 0
export const MAX_DEPTH = 20

export function newRoute(chatId: string, characterId: string): ChatRoute {
  return {
    chatId,
    characterId,
    enabled: false,
    route: [],
    stageIndex: 0,
    enteredAt: [0],
    strength: 3,
    // Live testing: a trailing system message was ignored by the roleplay
    // model while the same text appended to the user turn steered at once.
    injectMode: 'append-to-last-user',
  }
}

/** Fill gaps in routes written by older builds so the interceptor can trust the shape. */
export function normalizeRoute(raw: unknown, chatId: string, characterId: string): ChatRoute {
  const base = newRoute(chatId, characterId)
  if (!raw || typeof raw !== 'object') return base
  const r = raw as Partial<ChatRoute>
  const route = Array.isArray(r.route) ? r.route.filter((h): h is string => typeof h === 'string') : []
  const maxIndex = Math.max(0, route.length - 1)
  const stageIndex = typeof r.stageIndex === 'number' && Number.isFinite(r.stageIndex)
    ? Math.min(maxIndex, Math.max(0, Math.floor(r.stageIndex)))
    : 0
  const enteredAt = Array.isArray(r.enteredAt)
    ? r.enteredAt.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)).slice(0, stageIndex + 1)
    : []
  while (enteredAt.length < stageIndex + 1) enteredAt.push(enteredAt[enteredAt.length - 1] ?? 0)
  const strength = ([1, 2, 3, 4, 5] as const).find((s) => s === r.strength) ?? 3
  const injectMode: InjectMode = r.injectMode === 'system-at-depth' ? 'system-at-depth' : 'append-to-last-user'
  const transitions: Record<string, TransitionStyle> = {}
  if (r.transitions && typeof r.transitions === 'object') {
    for (const [hash, style] of Object.entries(r.transitions)) {
      if (route.includes(hash) && isTransitionStyle(style) && style !== 'auto' && style !== 'elapse') transitions[hash] = style
    }
  }
  return {
    ...base,
    characterId: typeof r.characterId === 'string' && r.characterId ? r.characterId : characterId,
    enabled: r.enabled === true,
    route,
    stageIndex,
    enteredAt,
    strength,
    timing: r.timing && typeof r.timing === 'object' ? r.timing : undefined,
    injectMode,
    transitions: Object.keys(transitions).length ? transitions : undefined,
  }
}

export function transitionFor(route: ChatRoute, hash: string | undefined): TransitionStyle {
  if (!hash) return 'elapse'
  const s = route.transitions?.[hash]
  return isTransitionStyle(s) && s !== 'auto' ? s : 'elapse'
}

export function setTransition(route: ChatRoute, hash: string, style: TransitionStyle): ChatRoute {
  const transitions = { ...(route.transitions ?? {}) }
  if (style === 'auto' || style === 'elapse') delete transitions[hash]
  else transitions[hash] = style
  return { ...route, transitions: Object.keys(transitions).length ? transitions : undefined }
}

/**
 * Move the pointer to `stageIndex`. Moving forward records `messageCount` as
 * the entry index of every stage passed; moving back forgets the entries of
 * the stages left, so returning to a stage later counts as a fresh arrival.
 */
export function setStage(route: ChatRoute, stageIndex: number, messageCount: number): ChatRoute {
  const maxIndex = Math.max(0, route.route.length - 1)
  const target = Math.min(maxIndex, Math.max(0, Math.floor(stageIndex)))
  const enteredAt = route.enteredAt.slice(0, Math.min(route.enteredAt.length, target + 1))
  if (enteredAt.length === 0) enteredAt.push(0)
  while (enteredAt.length < target + 1) enteredAt.push(Math.max(0, Math.floor(messageCount)))
  return { ...route, stageIndex: target, enteredAt }
}

/** Replace the ordered hash list, keeping the pointer on the same card where possible. */
export function applyRoute(route: ChatRoute, hashes: string[], messageCount: number): ChatRoute {
  const unique: string[] = []
  for (const h of hashes) if (!unique.includes(h)) unique.push(h)
  const currentHash = route.route[route.stageIndex]
  // Transition choices ride with their stage; drop entries for stages that left the route.
  const transitions: Record<string, TransitionStyle> = {}
  for (const [h, s] of Object.entries(route.transitions ?? {})) if (unique.includes(h)) transitions[h] = s
  const next: ChatRoute = { ...route, route: unique, transitions: Object.keys(transitions).length ? transitions : undefined }
  const keep = currentHash !== undefined ? unique.indexOf(currentHash) : -1
  if (keep === -1) {
    // Current stage vanished (or route was empty): restart from the top.
    return { ...next, stageIndex: 0, enteredAt: [route.enteredAt[0] ?? 0] }
  }
  if (keep === route.stageIndex) return next
  // Same card, different position: shift the entry record with it.
  const entered = route.enteredAt[route.stageIndex] ?? messageCount
  const enteredAt = route.enteredAt.slice(0, keep)
  while (enteredAt.length < keep) enteredAt.push(enteredAt[enteredAt.length - 1] ?? 0)
  enteredAt.push(entered)
  return { ...next, stageIndex: keep, enteredAt }
}

/**
 * Rewind the pointer after the chat was cut back to `messageCount` messages.
 * A stage entered at message index E is gone once fewer than E - tolerance
 * messages remain. Deletions use tolerance 1: a composer regenerate removes
 * exactly one message and must not rewind a stage the user just advanced to.
 * Forks use tolerance 0 because the fork point is exact.
 */
export function rewindTo(route: ChatRoute, messageCount: number, tolerance = 0): ChatRoute {
  const count = Math.max(0, Math.floor(messageCount))
  let stageIndex = route.stageIndex
  const enteredAt = [...route.enteredAt]
  while (stageIndex > 0) {
    const entered = enteredAt[stageIndex]
    if (entered === undefined || count < entered - tolerance) {
      enteredAt.pop()
      stageIndex--
    } else {
      break
    }
  }
  if (stageIndex === route.stageIndex) return route
  return { ...route, stageIndex, enteredAt }
}

/** Copy a route onto a forked chat that holds the first `messageCount` messages of the source. */
export function forkRoute(source: ChatRoute, newChatId: string, messageCount: number): ChatRoute {
  return rewindTo({ ...source, chatId: newChatId, enteredAt: [...source.enteredAt] }, messageCount, 0)
}

export function depthFor(route: ChatRoute): number {
  const d = route.timing?.depth
  return typeof d === 'number' && Number.isFinite(d) && d >= 0 ? Math.min(MAX_DEPTH, Math.floor(d)) : DEFAULT_DEPTH
}

export function reminderEveryFor(route: ChatRoute): number {
  const n = route.timing?.reminderEvery
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.min(MAX_REMINDER_EVERY, Math.floor(n)) : DEFAULT_REMINDER_EVERY
}

export function setReminderEvery(route: ChatRoute, every: number): ChatRoute {
  const n = Number.isFinite(every) ? Math.min(MAX_REMINDER_EVERY, Math.max(0, Math.floor(every))) : DEFAULT_REMINDER_EVERY
  return { ...route, timing: { ...(route.timing ?? {}), reminderEvery: n } }
}

export function setDepth(route: ChatRoute, depth: number): ChatRoute {
  const d = Number.isFinite(depth) ? Math.min(MAX_DEPTH, Math.max(0, Math.floor(depth))) : DEFAULT_DEPTH
  return { ...route, timing: { ...(route.timing ?? {}), depth: d } }
}
