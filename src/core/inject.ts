// =============================================================================
// Splicing the directive into the assembled message array. Pure.
//
// Placement is always relative to the last chat-history message, never to the
// end of the array: a preset may end with an assistant prefill or nudge blocks,
// and those must stay where the host put them.
// =============================================================================

import type { InjectMode } from '../shared/types.ts'

/** Minimal structural view of LlmMessageDTO; the real type flows through the generic. */
export interface MessageLike {
  role: 'system' | 'user' | 'assistant'
  content: string | Array<{ type: string; text?: string }>
  __isChatHistory?: boolean
}

export interface InjectResult<M extends MessageLike> {
  messages: M[]
  /** Index of the inserted system message; null in append mode (no new message). */
  injectedIndex: number | null
  /** Which mode actually applied (append mode falls back when there is no user turn). */
  appliedMode: InjectMode
}

function historyIndices(messages: readonly MessageLike[]): number[] {
  const out: number[] = []
  messages.forEach((m, i) => { if (m.__isChatHistory === true) out.push(i) })
  return out
}

/**
 * `system-at-depth`: insert a system message so that `depth` history messages
 * follow it. depth 0 = directly after the last history message.
 */
export function injectSystemAtDepth<M extends MessageLike>(messages: readonly M[], directive: string, depth: number): InjectResult<M> {
  const hist = historyIndices(messages)
  const d = Math.max(0, Math.floor(depth))
  let insertAt: number
  if (hist.length === 0) {
    // No history at all (first turn on an empty chat): place at the very end.
    insertAt = messages.length
  } else if (d === 0) {
    insertAt = (hist[hist.length - 1] as number) + 1
  } else {
    const target = hist[Math.max(0, hist.length - d)] as number
    insertAt = target
  }
  const injected = { role: 'system', content: directive } as unknown as M
  const out = [...messages]
  out.splice(insertAt, 0, injected)
  return { messages: out, injectedIndex: insertAt, appliedMode: 'system-at-depth' }
}

/**
 * Out-of-character wrapper for text that rides inside the user turn. Without
 * it, models sometimes quote the directive back as if the user had said it.
 * Parentheses rather than square brackets: the host's own regen-feedback
 * marker is `[OOC: …]` on the last user message, and Prompt Breakdown labels
 * anything of that shape as regen feedback.
 */
export function wrapForAppend(directive: string): string {
  return `(OOC: ${directive} Do not reply to this note.)`
}

/**
 * `append-to-last-user`: append the directive to the last user history turn.
 * Safe for strict-alternation chat templates. Content may be an array of parts;
 * a text part is appended in that case. Falls back to system-at-depth 0 when
 * there is no user history turn (e.g. some continue generations).
 */
export function appendToLastUser<M extends MessageLike>(messages: readonly M[], directive: string): InjectResult<M> {
  let idx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as M
    if (m.__isChatHistory === true && m.role === 'user') { idx = i; break }
  }
  if (idx === -1) return injectSystemAtDepth(messages, directive, 0)

  const src = messages[idx] as M
  const sep = '\n\n'
  const note = wrapForAppend(directive)
  let content: string | Array<{ type: string; text?: string }>
  if (typeof src.content === 'string') {
    content = src.content.length > 0 ? src.content + sep + note : note
  } else if (Array.isArray(src.content)) {
    content = [...src.content, { type: 'text', text: sep + note }]
  } else {
    content = note
  }
  const out = [...messages]
  out[idx] = { ...src, content } as unknown as M
  return { messages: out, injectedIndex: null, appliedMode: 'append-to-last-user' }
}

export function injectDirective<M extends MessageLike>(messages: readonly M[], directive: string, mode: InjectMode, depth: number): InjectResult<M> {
  return mode === 'append-to-last-user'
    ? appendToLastUser(messages, directive)
    : injectSystemAtDepth(messages, directive, depth)
}
