// =============================================================================
// Directive rendering. Draft wording from the brief; tune freely.
//
// Withholding rule (the point of the extension): only the CURRENT stage's
// fields are ever rendered here. Nothing about later stages exists in this
// module's inputs, so it cannot leak them.
// =============================================================================

import type { StageCard, TransitionStyle } from '../shared/types.ts'
import { DIRECTIVE_TOKEN_CAP } from '../shared/types.ts'
import type { Tier } from './tiers.ts'

export interface Names {
  char: string
  user: string
}

/** Cards keep {{char}} / {{user}} literally; the interceptor runs after macro resolution. */
export function substituteNames(text: string, names: Names): string {
  return text.replace(/\{\{\s*char\s*\}\}/gi, names.char).replace(/\{\{\s*user\s*\}\}/gi, names.user)
}

/** chars/4: the interceptor must not make RPCs, so no real tokenizer here. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** Cut at the last sentence/clause boundary before `maxChars`, else hard cut. */
export function truncateToChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = text.slice(0, maxChars)
  const cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('; '), head.lastIndexOf(', '))
  return (cut > maxChars * 0.5 ? head.slice(0, cut + 1) : head).trimEnd()
}

/** Human labels for the transition picker. Order is display order. */
export const DEFAULT_TRANSITION: TransitionStyle = 'elapse'

export const TRANSITION_STYLES: Array<{ value: TransitionStyle; label: string; hint: string }> = [
  { value: 'elapse', label: 'Skip time, narrate the gap (default)', hint: 'A short "later that week" passage on what changed, then the new scene.' },
  { value: 'cut', label: 'Hard cut', hint: 'Jump straight into the new scene. Nothing about the gap.' },
  { value: 'flow', label: 'Develop the transition in-scene', hint: 'No skip. Carry the story from here to there on the page.' },
]

/** 'auto' was the original default ("a time skip is fine"); routes saved with it now get the narrated skip. */
export function effectiveTransition(style: TransitionStyle | undefined): TransitionStyle {
  return !style || style === 'auto' ? DEFAULT_TRANSITION : style
}

/** Arrival wording for each transition style. Scene/mood are already cleaned and name-substituted. */
function arrivalFrame(style: TransitionStyle, scene: string, mood: string): string {
  switch (effectiveTransition(style)) {
    case 'cut':
      return `The story now moves to: ${scene} Mood: ${mood} Cut straight to this scene; do not narrate what came between.`
    case 'elapse':
      return `Time passes. Open with a short passage on what has changed since the last scene, then arrive at: ${scene} Mood: ${mood}`
    case 'flow':
      return `The story is moving toward: ${scene} Mood: ${mood} Carry the transition on the page: show how the scene shifts from here to there rather than cutting.`
    default:
      return `Time passes. Open with a short passage on what has changed since the last scene, then arrive at: ${scene} Mood: ${mood}`
  }
}

/** Appended to every directive. Models otherwise drift to present tense or second person on a scene change. */
export const TENSE_NOTE = 'Keep the existing narrative tense and voice.'

function frame(tier: Tier, style: TransitionStyle, scene: string, mood: string): string {
  const body = tier === 'arrival'
    ? arrivalFrame(style, scene, mood)
    : `${scene} Mood: ${mood} Keep the story inside this scene: let events and the conversation move forward within it, without leaving it or skipping ahead.`
  return `${body} ${TENSE_NOTE}`
}

export interface RenderOptions {
  transition?: TransitionStyle
  tokenCap?: number
}

export interface RenderedDirective {
  text: string
  estimatedTokens: number
  truncated: boolean
}

export function renderDirective(tier: Tier, card: StageCard, names: Names, options: RenderOptions = {}): RenderedDirective {
  const style = effectiveTransition(options.transition)
  const capChars = (options.tokenCap ?? DIRECTIVE_TOKEN_CAP) * 4
  let scene = clean(substituteNames(card.scene, names))
  let mood = clean(substituteNames(card.mood, names))

  let body = frame(tier, style, scene, mood)
  let truncated = false
  if (body.length > capChars) {
    // Trim the two card fields, mood first, until the frame fits.
    const frameLen = body.length - scene.length - mood.length
    const budget = Math.max(40, capChars - frameLen)
    if (scene.length + mood.length > budget) mood = truncateToChars(mood, Math.max(24, Math.floor(budget * 0.35)))
    if (scene.length + mood.length > budget) scene = truncateToChars(scene, Math.max(24, budget - mood.length))
    truncated = true
    body = frame(tier, style, scene, mood)
    if (body.length > capChars) body = truncateToChars(body, capChars)
  }

  return { text: body, estimatedTokens: estimateTokens(body), truncated }
}

export function breakdownName(stageIndex: number, stageCount: number, tier: Tier): string {
  return `Stagecoach · stage ${stageIndex + 1}/${stageCount} · ${tier}`
}
