// =============================================================================
// Group-chat facts read from a chat's metadata bag. Pure, so it is testable.
//
// Observed on Lumiverse (Sept 2026 probe): a group chat's metadata holds
//   group: true
//   character_ids: string[]          (every member)
//   activeGreetingIndex: number      (which greeting opened the chat)
//   talkativeness_overrides: ...     (unused here)
// A solo chat has none of these, or `group` absent.
// =============================================================================

export interface GroupInfo {
  isGroup: boolean
  /** Every character whose greetings belong in the panel. Solo: just the chat's character. The chat's own character is always first. */
  memberIds: string[]
  /** Index into [first_mes, ...alternate_greetings] of the greeting the chat opened with, when the host recorded it. */
  activeGreetingIndex: number | null
}

export function groupInfo(metadata: unknown, characterId: string): GroupInfo {
  const meta = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {}
  const ids = Array.isArray(meta.character_ids) ? meta.character_ids.filter((v): v is string => typeof v === 'string' && v.length > 0) : []
  const isGroup = meta.group === true && ids.length > 0
  const memberIds = isGroup ? [characterId, ...ids.filter((id) => id !== characterId)] : [characterId]
  const agi = meta.activeGreetingIndex
  const activeGreetingIndex = typeof agi === 'number' && Number.isFinite(agi) && agi >= 0 ? Math.floor(agi) : null
  return { isGroup, memberIds, activeGreetingIndex }
}
