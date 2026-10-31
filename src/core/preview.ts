// =============================================================================
// The notes a stage card produces in one chat. Pure.
//
// The interceptor renders with noteOptions and the editor preview with
// previewNote, which uses noteOptions too, so the preview cannot drift from
// what is sent. Withholding rule: only the one card passed in is rendered.
// =============================================================================

import type { ChatRoute, ExtensionSettings, StageCard, TransitionStyle } from '../shared/types.ts'
import { tokenLimitsFor } from '../shared/types.ts'
import { DEFAULT_TRANSITION, renderDirective, type Names, type RenderedDirective, type RenderOptions } from './templates.ts'
import { reminderEveryFor, transitionFor } from './route.ts'

type NoteSettings = Pick<ExtensionSettings, 'highTokenLimit' | 'closingLine' | 'inStageInstructions'>

/** Unsaved text from the panel's editors; null or absent means "use the saved setting". */
export interface TextDrafts {
  closing?: string | null
  instructions?: string | null
}

/** Render options for a card's notes in this chat: its Way in, the token cap, and the user's closing line and instructions. */
export function noteOptions(route: ChatRoute | null, hash: string, settings: NoteSettings, group: boolean, drafts: TextDrafts = {}): RenderOptions {
  return {
    transition: route ? transitionFor(route, hash) : DEFAULT_TRANSITION,
    tokenCap: tokenLimitsFor(settings).directive,
    instructions: drafts.instructions ?? settings.inStageInstructions,
    closing: drafts.closing ?? settings.closingLine,
    group,
  }
}

/**
 * Where the card sits in this chat, which decides whether its note is sent:
 *  - 'sent': stage 2 or later; the scene-change note goes out on the first reply after the story moves forward onto it.
 *  - 'stage-one': the chat opened with it, so it never gets a note here.
 *  - 'off-route': not on this chat's route, so nothing is sent here.
 *  - 'empty': scene and mood are both blank, so nothing is sent anywhere.
 */
export type NotePlacement = 'sent' | 'stage-one' | 'off-route' | 'empty'

export interface NotePreview {
  placement: NotePlacement
  /** 1-based position on this chat's route; null when the card is not on it. */
  stageNumber: number | null
  stageCount: number
  transition: TransitionStyle
  /** The scene-change note: sent ('sent') or what it would read placed later ('stage-one', 'off-route'). null when empty. */
  arrival: RenderedDirective | null
  /** The in-stage reminder, only on routes an older version left with reminders on (no control in the panel any more). */
  reminder: { every: number; note: RenderedDirective } | null
}

function blank(text: string | undefined): boolean {
  return !text || text.replace(/\s+/g, ' ').trim().length === 0
}

export function previewNote(input: { card: StageCard; route: ChatRoute | null; settings: NoteSettings; group: boolean; names: Names; drafts?: TextDrafts }): NotePreview {
  const { card, route } = input
  const options = noteOptions(route, card.hash, input.settings, input.group, input.drafts)
  const pos = route ? route.route.indexOf(card.hash) : -1
  const common = { stageNumber: pos >= 0 ? pos + 1 : null, stageCount: route?.route.length ?? 0, transition: options.transition ?? DEFAULT_TRANSITION }
  // The interceptor sends nothing for a card with neither scene nor mood.
  if (blank(card.scene) && blank(card.mood)) return { placement: 'empty', ...common, arrival: null, reminder: null }
  const arrival = renderDirective('arrival', card, input.names, options)
  if (pos >= 1) {
    const every = reminderEveryFor(route!)
    return { placement: 'sent', ...common, arrival, reminder: every >= 1 ? { every, note: renderDirective('in-stage', card, input.names, options) } : null }
  }
  return { placement: pos === 0 ? 'stage-one' : 'off-route', ...common, arrival, reminder: null }
}
