// =============================================================================
// Matching the chat's first message back to one of the character's greetings.
// Pure string work so it can be unit-tested; the backend feeds it the raw
// greeting texts, their macro-resolved forms, and whatever the frontend could
// read from the first message (API content, DOM bubble text, or both).
// =============================================================================

import { normalizeGreeting } from './hash.ts'

/** Whitespace-folded, case-folded text for exact comparison. */
export function comparable(text: string): string {
  return normalizeGreeting(text).replace(/\s+/g, ' ').toLowerCase()
}

/** Letters and digits only, for a tolerant comparison that survives regex/markdown/macro/HTML differences. */
export function skeleton(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** Skeleton characters per sampled chunk. */
export const CHUNK = 60
/** Below this many skeleton characters a greeting is only matched when the whole of it appears in the reading. */
export const FUZZY_MIN = 40
/** Below this many skeleton characters a greeting is too short to match at all except exactly. */
export const WHOLE_MIN = 12
/** How many chunks are sampled across a long greeting. */
const CHUNKS = 5

/** Start offsets of the chunks sampled from a skeleton of length `n`. */
function chunkStarts(n: number): number[] {
  if (n <= CHUNK) return [0]
  const count = Math.min(CHUNKS, Math.floor(n / CHUNK) + 1)
  const last = n - CHUNK
  const out: number[] = []
  for (let i = 0; i < count; i++) out.push(Math.round((last * i) / (count - 1)))
  return Array.from(new Set(out))
}

/** Score for a reading that contains the whole greeting; above any chunk tally. */
export const WHOLE = CHUNKS + 1

/**
 * How strongly `haystack` (the first message as read) contains `greeting`.
 * 0 = no evidence. Whole-text containment scores above any chunk tally so
 * an exact-but-decorated bubble (name, timestamp, swipe counter) always
 * wins, and is the only loose match allowed for short greetings.
 */
export function fuzzyScore(greeting: string, haystack: string): number {
  const g = skeleton(greeting)
  const h = skeleton(haystack)
  if (g.length < WHOLE_MIN || h.length === 0) return 0
  if (h.includes(g)) return WHOLE
  if (g.length < FUZZY_MIN) return 0
  const starts = chunkStarts(g.length)
  let hits = 0
  for (const s of starts) if (h.includes(g.slice(s, s + CHUNK))) hits++
  // At least half the sampled chunks, and never a single chunk alone on a long greeting.
  return hits >= Math.max(2, Math.ceil(starts.length / 2)) ? hits : 0
}

export interface OpeningCandidate<T> {
  key: T
  /** Text forms to try: raw card text and, when available, the macro-resolved text. */
  texts: string[]
}

/**
 * Pick the greeting the first message came from. Exact comparison first, then
 * the highest fuzzy score across every text form and every reading of the
 * first message. When two greetings are both wholly contained (one is a
 * prefix or substring of the other) the longer one wins; other ties keep
 * the earliest greeting (card order).
 */
export function matchGreeting<T>(greetings: Array<OpeningCandidate<T>>, readings: string[]): T | null {
  const targets = readings.map(comparable).filter((t) => t.length > 0)
  if (targets.length === 0) return null
  for (const g of greetings) {
    for (const t of g.texts) if (targets.includes(comparable(t))) return g.key
  }
  let best: { key: T; score: number; length: number } | null = null
  for (const g of greetings) {
    let score = 0
    for (const t of g.texts) for (const r of readings) score = Math.max(score, fuzzyScore(t, r))
    if (score === 0) continue
    const length = Math.max(...g.texts.map((t) => skeleton(t).length))
    const better = !best || score > best.score || (score === WHOLE && best.score === WHOLE && length > best.length)
    if (better) best = { key: g.key, score, length }
  }
  return best ? best.key : null
}

/** Short excerpt of what was read, for the panel and the host log. */
export function sample(text: string, max = 90): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}
