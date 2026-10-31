// =============================================================================
// Global settings: what storage holds and what the panel may change. Pure.
// =============================================================================

import type { ExtensionSettings } from '../shared/types.ts'
import { tokenLimitsFor } from '../shared/types.ts'
import { DEFAULT_IN_STAGE_INSTRUCTIONS, TENSE_NOTE } from './templates.ts'

/** Blank or built-in text stores as null (= use the built-in default); anything else is trimmed and length-capped. */
export function normaliseInstructions(text: string, maxChars: number, builtIn: string = DEFAULT_IN_STAGE_INSTRUCTIONS): string | null {
  const t = text.replace(/\s+/g, ' ').trim().slice(0, maxChars)
  return t.length === 0 || t === builtIn ? null : t
}

function storedText(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

/**
 * settings.json as written by any build, with missing or malformed fields at
 * their defaults. Stored instructions are not re-capped here: switching the
 * higher token limit off must not destroy text written while it was on.
 */
export function normalizeSettings(raw: unknown): ExtensionSettings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    distillConnectionId: typeof r.distillConnectionId === 'string' && r.distillConnectionId ? r.distillConnectionId : null,
    inStageInstructions: storedText(r.inStageInstructions),
    closingLine: storedText(r.closingLine),
    highTokenLimit: r.highTokenLimit === true,
  }
}

/** Apply a panel patch: fields absent from the patch keep their value, null resets one to its default. */
export function applySettingsPatch(current: ExtensionSettings, patch: Partial<ExtensionSettings>): ExtensionSettings {
  const highTokenLimit = typeof patch.highTokenLimit === 'boolean' ? patch.highTokenLimit : current.highTokenLimit
  const maxChars = tokenLimitsFor({ highTokenLimit }).instructionsChars
  return {
    distillConnectionId: typeof patch.distillConnectionId === 'string' && patch.distillConnectionId
      ? patch.distillConnectionId
      : patch.distillConnectionId === null ? null : current.distillConnectionId,
    inStageInstructions: typeof patch.inStageInstructions === 'string'
      ? normaliseInstructions(patch.inStageInstructions, maxChars)
      : patch.inStageInstructions === null ? null : current.inStageInstructions,
    closingLine: typeof patch.closingLine === 'string'
      ? normaliseInstructions(patch.closingLine, maxChars, TENSE_NOTE)
      : patch.closingLine === null ? null : current.closingLine,
    highTokenLimit,
  }
}
