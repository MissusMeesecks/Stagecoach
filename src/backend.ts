// =============================================================================
// Stagecoach — Backend (Bun worker)
//
// Rules this file follows (see docs/stagecoach-brief.md):
//  - Never writes to character cards. Only spindle.userStorage.
//  - The interceptor is pure: read cached state, splice, return. No LLM calls,
//    no storage writes, no state mutation. Dry runs go through it too.
//  - Only the CURRENT stage's card ever reaches the prompt.
// =============================================================================

import type {
  SpindleAPI,
  LlmMessageDTO,
  InterceptorContextDTO,
  CharacterDTO,
  ChatDTO,
  GenerationRequestDTO,
} from 'lumiverse-spindle-types'
import type {
  BackendMessage,
  ChatRoute,
  ConnectionInfo,
  ExtensionSettings,
  FrontendMessage,
  GreetingInfo,
  PanelState,
  StageCard,
} from './shared/types.ts'
import { DEFAULT_SETTINGS, tokenLimitsFor } from './shared/types.ts'
import { hashGreeting, isValidHash } from './core/hash.ts'
import { chooseTier, repliesSince, reminderDue } from './core/tiers.ts'
import { breakdownName, renderDirective, estimateTokens, type Names } from './core/templates.ts'
import { applySettingsPatch, normalizeSettings } from './core/settings.ts'
import { noteOptions } from './core/preview.ts'
import { matchGreeting, sample } from './core/opening.ts'
import { groupInfo } from './core/group.ts'
import { injectDirective } from './core/inject.ts'
import { applyRoute, depthFor, forkRoute, isTransitionStyle, newRoute, normalizeRoute, reminderEveryFor, rewindTo, setDepth, setReminderEvery, setStage, setTransition, anchorFor, replayStage, skipNote } from './core/route.ts'

declare const spindle: SpindleAPI

const LOG = '[Stagecoach]'
const INTERCEPTOR_PRIORITY = 400

// ---------------------------------------------------------------------------
// Caches. The interceptor reads only these; UI handlers and events write them.
//
// One worker can serve several users (operator installs), and everything
// stored lives in per-user storage, so every cache is per user too. Cards are
// content-addressed: two users with the same public card share greeting
// hashes, and a shared cache would hand one user's stage cards to the other.
// ---------------------------------------------------------------------------
interface UserCaches {
  routes: Map<string, ChatRoute | null>
  cards: Map<string, StageCard | null>
  names: Map<string, Names>
  characters: Map<string, CharacterDTO | null>
  chats: Map<string, ChatDTO | null>
  /** Per chat. Cleared with the characters and when the chat record changes (membership lives in chat metadata). */
  greetings: Map<string, PooledGreetings>
  /** Greeting text with macros resolved for a chat, keyed by `${chatId}:${hash}`. Used to match the chat's opening message. */
  resolvedGreetings: Map<string, string>
  /** Last opening-message probe the frontend sent for a chat, reused by state refreshes that do not re-probe. */
  openings: Map<string, { text: string | null; probe: string; candidates: string[] }>
  settings: ExtensionSettings | null
}

const userCaches = new Map<string, UserCaches>()

function cachesFor(userId: string | undefined): UserCaches {
  const key = userId ?? ''
  let c = userCaches.get(key)
  if (!c) {
    c = { routes: new Map(), cards: new Map(), names: new Map(), characters: new Map(), chats: new Map(), greetings: new Map(), resolvedGreetings: new Map(), openings: new Map(), settings: null }
    userCaches.set(key, c)
  }
  return c
}

/** Invalidation from host events, which may not say whose data changed: clearing too much only costs a re-read. */
function eachUser(fn: (c: UserCaches) => void): void {
  for (const c of userCaches.values()) fn(c)
}

/** Host-supplied user ids seen since the worker started (frontend messages and events). */
const knownUsers = new Set<string>()

/**
 * The user a call acts for. A host-supplied id always wins. Events may omit
 * it: then the call falls back to the only user seen since the worker
 * started. That is right on a single-user install, and keeps it on one set of
 * caches; on an operator install it can be another user who has not been
 * seen yet, so anything acting on a fallback must stay harmless if the guess
 * is wrong. Once several users have been seen there is no fallback at all.
 * `record: false` resolves without remembering the id (the interceptor stays
 * free of side effects).
 */
function actingUser(id: string | null | undefined, record = true): string | undefined {
  if (id) { if (record) knownUsers.add(id); return id }
  return knownUsers.size === 1 ? knownUsers.values().next().value : undefined
}

const fallbackIndexLogged = new Set<string>()

function has(permission: string): boolean {
  try { return spindle.permissions.has(permission) } catch { return false }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
function routePath(chatId: string): string { return `chats/${encodeURIComponent(chatId)}.json` }
function cardPath(hash: string): string { return `cards/${hash}.json` }

async function loadRoute(chatId: string, userId?: string): Promise<ChatRoute | null> {
  const cache = cachesFor(userId).routes
  if (cache.has(chatId)) return cache.get(chatId) ?? null
  let route: ChatRoute | null = null
  try {
    const raw = await spindle.userStorage.getJson<unknown>(routePath(chatId), { fallback: null, userId })
    if (raw && typeof raw === 'object') {
      const characterId = typeof (raw as { characterId?: unknown }).characterId === 'string'
        ? (raw as { characterId: string }).characterId
        : ''
      route = normalizeRoute(raw, chatId, characterId)
    }
  } catch (err) {
    spindle.log.warn(`${LOG} could not read route for chat ${chatId}: ${errMsg(err)}`)
  }
  // A save that landed while this read was in flight is newer than what was read.
  if (cache.has(chatId)) return cache.get(chatId) ?? null
  cache.set(chatId, route)
  return route
}

async function saveRoute(route: ChatRoute, userId?: string): Promise<void> {
  await spindle.userStorage.setJson(routePath(route.chatId), route, { indent: 2, userId })
  cachesFor(userId).routes.set(route.chatId, route)
}

async function loadCard(hash: string, userId?: string): Promise<StageCard | null> {
  if (!isValidHash(hash)) return null
  const cache = cachesFor(userId).cards
  if (cache.has(hash)) return cache.get(hash) ?? null
  let card: StageCard | null = null
  try {
    const raw = await spindle.userStorage.getJson<unknown>(cardPath(hash), { fallback: null, userId })
    card = sanitizeCard(raw, hash)
  } catch (err) {
    spindle.log.warn(`${LOG} could not read card ${hash.slice(0, 8)}: ${errMsg(err)}`)
  }
  if (cache.has(hash)) return cache.get(hash) ?? null
  cache.set(hash, card)
  return card
}

async function saveCard(card: StageCard, userId?: string): Promise<void> {
  await spindle.userStorage.setJson(cardPath(card.hash), card, { indent: 2, userId })
  cachesFor(userId).cards.set(card.hash, card)
}

async function deleteCard(hash: string, userId?: string): Promise<void> {
  if (!isValidHash(hash)) return
  try { await spindle.userStorage.delete(cardPath(hash), userId) } catch { /* already gone */ }
  cachesFor(userId).cards.set(hash, null)
}

async function loadSettings(userId?: string): Promise<ExtensionSettings> {
  const cache = cachesFor(userId)
  if (cache.settings) return cache.settings
  let settings: ExtensionSettings
  try {
    settings = normalizeSettings(await spindle.userStorage.getJson<unknown>('settings.json', { fallback: {}, userId }))
  } catch {
    settings = { ...DEFAULT_SETTINGS }
  }
  // Settings saved while this read was in flight win.
  cache.settings ??= settings
  return cache.settings
}

async function saveSettings(settings: ExtensionSettings, userId?: string): Promise<void> {
  cachesFor(userId).settings = settings
  await spindle.userStorage.setJson('settings.json', settings, { indent: 2, userId })
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''
}

function sanitizeCard(raw: unknown, hash: string): StageCard | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const source = r.source === 'llm' || r.source === 'edited' ? r.source : 'manual'
  const updatedAt = typeof r.updatedAt === 'number' ? r.updatedAt : Date.now()
  return {
    hash,
    label: str(r.label),
    presupposes: str(r.presupposes),
    scene: str(r.scene),
    mood: str(r.mood),
    doneWhen: str(r.doneWhen),
    with: str(r.with),
    source,
    updatedAt,
  }
}

// ---------------------------------------------------------------------------
// Chat / character lookups (permissions: chats, characters)
// ---------------------------------------------------------------------------
async function getChat(chatId: string, userId?: string): Promise<ChatDTO | null> {
  const cache = cachesFor(userId).chats
  if (cache.has(chatId)) return cache.get(chatId) ?? null
  if (!has('chats')) return null
  let chat: ChatDTO | null = null
  try { chat = await spindle.chats.get(chatId, userId) } catch (err) {
    spindle.log.warn(`${LOG} chats.get failed: ${errMsg(err)}`)
  }
  cache.set(chatId, chat)
  return chat
}

async function getCharacter(characterId: string, userId?: string): Promise<CharacterDTO | null> {
  const cache = cachesFor(userId).characters
  if (cache.has(characterId)) return cache.get(characterId) ?? null
  if (!has('characters')) return null
  let character: CharacterDTO | null = null
  try { character = await spindle.characters.get(characterId, userId) } catch (err) {
    spindle.log.warn(`${LOG} characters.get failed: ${errMsg(err)}`)
  }
  cache.set(characterId, character)
  return character
}

interface OwnedGreeting {
  index: number
  hash: string
  text: string
  characterId: string
  characterName: string
}
interface PooledGreetings {
  greetings: OwnedGreeting[]
  /** Members in host order, the chat's own character first. Solo chats: one entry. */
  members: Array<{ id: string; name: string }>
}

/**
 * Every greeting the panel and the interceptor may use for this chat, with
 * its owner. Group chats pool all members; the same text on two cards keeps
 * the first owner (hashes are content-addressed, so the card is shared).
 * Returns null only when the chat's own character cannot be loaded.
 */
async function chatGreetings(chat: ChatDTO, userId?: string): Promise<PooledGreetings | null> {
  const cache = cachesFor(userId).greetings
  const cached = cache.get(chat.id)
  if (cached) return cached
  const info = groupInfo(chat.metadata, chat.character_id)
  const greetings: OwnedGreeting[] = []
  const members: Array<{ id: string; name: string }> = []
  const seen = new Set<string>()
  for (const id of info.memberIds) {
    const character = await getCharacter(id, userId)
    if (!character) {
      if (id === chat.character_id) return null
      spindle.log.warn(`${LOG} group member ${id} could not be loaded; its greetings are skipped`)
      continue
    }
    members.push({ id, name: character.name })
    for (const g of greetingTexts(character)) {
      const hash = await hashGreeting(g.text)
      if (seen.has(hash)) continue
      seen.add(hash)
      greetings.push({ index: g.index, hash, text: g.text, characterId: id, characterName: character.name })
    }
  }
  const pooled = { greetings, members }
  cache.set(chat.id, pooled)
  return pooled
}

/** [first_mes, ...alternate_greetings] with original indices; empty entries skipped. */
function greetingTexts(character: CharacterDTO): Array<{ index: number; text: string }> {
  const out: Array<{ index: number; text: string }> = []
  if (typeof character.first_mes === 'string' && character.first_mes.trim()) out.push({ index: 0, text: character.first_mes })
  const alts = Array.isArray(character.alternate_greetings) ? character.alternate_greetings : []
  alts.forEach((text, i) => {
    if (typeof text === 'string' && text.trim()) out.push({ index: i + 1, text })
  })
  return out
}

async function resolveCharacterId(chatId: string, hint: string | null | undefined, userId?: string): Promise<string | null> {
  if (typeof hint === 'string' && hint) return hint
  const chat = await getChat(chatId, userId)
  return chat?.character_id ?? null
}

// ---------------------------------------------------------------------------
// Names. Cards keep {{char}}/{{user}} literally; we substitute at injection.
// Resolved through the host macro engine (free tier) and cached per chat.
// ---------------------------------------------------------------------------
async function resolveOne(macro: string, chatId: string, characterId: string | null, userId?: string): Promise<string | null> {
  try {
    const { text } = await spindle.macros.resolve(macro, {
      chatId,
      characterId: characterId ?? undefined,
      userId,
      commit: false,
    })
    const t = text.trim()
    if (!t || t.includes('{{')) return null
    return t
  } catch {
    return null
  }
}

/**
 * Names for substitution. Keyed by character too: in a group chat the card's
 * owner may not be the member generating this reply. `preferRecord` takes the
 * character record's name over the macro engine, for the case where the
 * engine would resolve {{char}} to the speaker rather than the owner.
 */
async function resolveNames(chatId: string, characterId: string | null, userId?: string, preferRecord = false): Promise<Names> {
  const cacheKey = `${chatId}:${characterId ?? ''}:${preferRecord ? 'r' : 'm'}`
  const cache = cachesFor(userId).names
  const cached = cache.get(cacheKey)
  if (cached) return cached
  const [charName, userName] = await Promise.all([
    preferRecord ? Promise.resolve(null) : resolveOne('{{char}}', chatId, characterId, userId),
    resolveOne('{{user}}', chatId, characterId, userId),
  ])
  let char = charName
  if (!char && characterId) char = (await getCharacter(characterId, userId))?.name ?? null
  const names: Names = { char: char ?? 'the character', user: userName ?? 'the user' }
  cache.set(cacheKey, names)
  return names
}


// ---------------------------------------------------------------------------
// Interceptor
// ---------------------------------------------------------------------------
let interceptorRegistered = false

function tryRegisterInterceptor(): void {
  if (interceptorRegistered || !has('interceptor')) return
  spindle.registerInterceptor(async (messages: LlmMessageDTO[], context: InterceptorContextDTO) => {
    try {
      if (context.generationType === 'impersonate' || context.generationType === 'quiet') return messages
      const chatId = context.chatId
      if (!chatId) return messages
      const userId = actingUser(context.userId, false)

      const route = await loadRoute(chatId, userId)
      if (!route || !route.enabled || route.route.length === 0) return messages

      const stageHash = route.route[route.stageIndex]
      if (!stageHash) return messages
      const card = await loadCard(stageHash, userId)
      if (!card) return messages
      if (!card.scene && !card.mood) return messages

      const enteredAt = route.enteredAt[route.stageIndex]
      const anchorId = anchorFor(route)
      const counted = repliesSince(messages, { anchorId, enteredAt: enteredAt ?? 0, excludeId: context.excludeMessageId ?? null })
      if (counted.by === 'position' && !fallbackIndexLogged.has(chatId)) {
        fallbackIndexLogged.add(chatId)
        spindle.log.warn(`${LOG} sourceIndexInChat absent on history messages for chat ${chatId}; counting replies by position`)
      }

      const tier = chooseTier({ stageIndex: route.stageIndex, stageCount: route.route.length, enteredAt, replies: counted.replies })
      const due = reminderDue({ stageIndex: route.stageIndex, replies: counted.replies, every: reminderEveryFor(route) })
      // One line per generation so a "nothing fired" report can be read off the host log.
      const tail = messages.filter((m) => m.__isChatHistory === true).slice(-4)
        .map((m) => `${m.role}#${m.sourceIndexInChat ?? '?'}${anchorId && m.sourceMessageId === anchorId ? '*' : ''}(${typeof m.content === 'string' ? m.content.length : 'parts'})`).join(' ')
      spindle.log.info(`${LOG} ${context.generationType}${context.isDryRun ? ' dry-run' : ''} chat ${chatId} stage ${route.stageIndex + 1}: replies since entry ${counted.replies} by ${counted.by}${anchorId ? '' : ' (no anchor)'}, ${due ? `${tier} note` : 'no note'}; tail ${tail}${context.excludeMessageId ? ` exclude ${context.excludeMessageId}` : ''}`)
      if (!due) return messages
      if (route.skipNote) {
        spindle.log.info(`${LOG} note skipped by the user for chat ${chatId} stage ${route.stageIndex + 1}`)
        return messages
      }

      // {{char}} on a card is the card's owner: in a group the speaker may be another member.
      const chat = await getChat(chatId, userId)
      const pooled = chat ? await chatGreetings(chat, userId) : null
      const owner = pooled?.greetings.find((g) => g.hash === stageHash)?.characterId ?? null
      const speaker = context.characterId || route.characterId || null
      const isGroup = chat ? groupInfo(chat.metadata, chat.character_id).isGroup : false
      // Group chats take names from the character record: the host's card-macro mode may resolve {{char}} to whoever is active.
      const names = await resolveNames(chatId, owner ?? speaker, userId, isGroup || (owner !== null && owner !== speaker))
      const settings = await loadSettings(userId)
      // The same options the editor preview renders with (core/preview.ts), so the preview shows what is sent.
      // The user's own texts (closing line, reminder wording) are global: in a group, {{char}} there is whoever replies.
      const textNames = isGroup && speaker && speaker !== (owner ?? speaker) ? await resolveNames(chatId, speaker, userId, true) : names
      const directive = renderDirective(tier, card, names, { ...noteOptions(route, stageHash, settings, isGroup), textNames })
      const result = injectDirective(messages, directive.text, route.injectMode, depthFor(route))
      spindle.log.info(`${LOG} injected as ${result.appliedMode} (speaker ${speaker ?? '?'}, card owner ${owner ?? '?'})`)

      if (result.injectedIndex === null) return { messages: result.messages }
      return {
        messages: result.messages,
        breakdown: [{ messageIndex: result.injectedIndex, name: breakdownName(route.stageIndex, route.route.length, tier) }],
      }
    } catch (err) {
      spindle.log.warn(`${LOG} interceptor degraded safely: ${errMsg(err)}`)
      return messages
    }
  }, INTERCEPTOR_PRIORITY)
  interceptorRegistered = true
  spindle.log.info(`${LOG} interceptor registered.`)
}

tryRegisterInterceptor()
spindle.permissions.onChanged(({ permission, granted }) => {
  if (granted && permission === 'interceptor') tryRegisterInterceptor()
  // The frontend re-requests state on PERMISSION_CHANGED; nothing to push here.
})

// ---------------------------------------------------------------------------
// Events — cache invalidation only. No prompt-side state changes happen here.
// ---------------------------------------------------------------------------
const onEvent = spindle.on as unknown as (event: string, handler: (payload: unknown, userId?: string) => void) => () => void

const clearCharacters = () => eachUser((c) => { c.characters.clear(); c.greetings.clear(); c.names.clear() })
onEvent('CHARACTER_EDITED', clearCharacters)
onEvent('CHARACTER_DELETED', clearCharacters)
onEvent('PERSONA_CHANGED', () => eachUser((c) => { c.names.clear(); c.resolvedGreetings.clear() }))
onEvent('CHAT_FORKED', (payload, eventUserId) => {
  void (async () => {
    const p = payload as { sourceChatId?: unknown; forkedChatId?: unknown; forkedAtMessageIndex?: unknown } | null
    if (!p || typeof p.sourceChatId !== 'string' || typeof p.forkedChatId !== 'string') return
    const userId = actingUser(eventUserId)
    if (!userId && knownUsers.size > 1) {
      spindle.log.warn(`${LOG} CHAT_FORKED arrived without a user id on a multi-user install; route not copied to ${p.forkedChatId}`)
      return
    }
    try {
      const source = await loadRoute(p.sourceChatId, userId)
      if (!source) return
      if (await loadRoute(p.forkedChatId, userId)) return
      const count = typeof p.forkedAtMessageIndex === 'number' ? p.forkedAtMessageIndex + 1 : source.enteredAt[source.stageIndex] ?? 0
      const copied = forkRoute(source, p.forkedChatId, count)
      await saveRoute(copied, userId)
      spindle.log.info(`${LOG} copied route to forked chat ${p.forkedChatId} (stage ${copied.stageIndex + 1}/${copied.route.length})`)
    } catch (err) {
      spindle.log.warn(`${LOG} could not copy route to forked chat: ${errMsg(err)}`)
    }
  })()
})
onEvent('CHAT_CHANGED', (payload) => {
  const id = (payload as { chat?: { id?: unknown } } | null)?.chat?.id
  if (typeof id === 'string') eachUser((c) => { c.chats.delete(id); c.greetings.delete(id) })
})

// ---------------------------------------------------------------------------
// Panel state
// ---------------------------------------------------------------------------
async function listConnections(userId?: string): Promise<ConnectionInfo[]> {
  if (!has('generation')) return []
  try {
    const list = await spindle.connections.list(userId)
    return list.map((c) => ({ id: c.id, name: c.name, provider: c.provider, model: c.model, is_default: c.is_default }))
  } catch (err) {
    spindle.log.warn(`${LOG} connections.list failed: ${errMsg(err)}`)
    return []
  }
}

/** Resolve a greeting's macros the way the host did when it opened the chat, so the stored first message can be matched. */
async function resolvedGreeting(chatId: string, characterId: string, hash: string, text: string, userId?: string): Promise<string> {
  const key = `${chatId}:${hash}`
  const cache = cachesFor(userId).resolvedGreetings
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  let resolved = text
  try {
    resolved = (await spindle.macros.resolve(text, { chatId, characterId, userId, commit: false })).text
  } catch { /* fall back to the raw text */ }
  if (cache.size > 500) cache.clear()
  cache.set(key, resolved)
  return resolved
}

/** `readings` are every text the frontend could get for the first message (API content, DOM bubble, first mounted bubble). */
async function matchOpening(chatId: string, characterId: string, greetings: GreetingInfo[], readings: string[], userId?: string): Promise<string | null> {
  const candidates: Array<{ key: string; texts: string[] }> = []
  for (const g of greetings) {
    if (g.index < 0) continue
    const resolved = await resolvedGreeting(chatId, characterId, g.hash, g.text, userId)
    candidates.push({ key: g.hash, texts: resolved === g.text ? [g.text] : [g.text, resolved] })
  }
  return matchGreeting(candidates, readings)
}

async function buildPanelState(chatId: string | null, userId?: string, openingText?: string | null, openingProbe?: string, openingCandidates?: string[]): Promise<PanelState> {
  if (chatId) {
    const openings = cachesFor(userId).openings
    if (openingProbe !== undefined) openings.set(chatId, { text: openingText ?? null, probe: openingProbe, candidates: openingCandidates ?? [] })
    else {
      const prev = openings.get(chatId)
      if (prev) { openingText = prev.text; openingProbe = prev.probe; openingCandidates = prev.candidates }
    }
  }
  const [permissions, settings, connections] = await Promise.all([
    spindle.permissions.getGranted().catch(() => [] as string[]),
    loadSettings(userId),
    listConnections(userId),
  ])
  const state: PanelState = {
    chatId,
    characterId: null,
    characterName: null,
    greetings: [],
    route: null,
    connections,
    settings,
    permissions,
  }
  if (!chatId) return state

  const chat = await getChat(chatId, userId)
  if (!chat) {
    state.error = has('chats') ? 'Could not load this chat.' : 'The "chats" permission is required to read the active chat.'
    return state
  }
  state.characterId = chat.character_id
  // From the chat record, as the interceptor reads it, so the preview renders group notes even when a character fails to load.
  const info = groupInfo(chat.metadata, chat.character_id)
  if (info.isGroup) state.isGroup = true
  const pooled = await chatGreetings(chat, userId)
  if (!pooled) {
    state.error = has('characters') ? 'Could not load the character for this chat.' : 'The "characters" permission is required to read greetings.'
  } else {
    state.characterName = pooled.members[0]?.name ?? null
    if (info.isGroup) state.members = pooled.members
    const greetings: GreetingInfo[] = []
    for (const g of pooled.greetings) greetings.push({ ...g, card: await loadCard(g.hash, userId) })
    state.greetings = greetings
    const readings = [openingText, ...(openingCandidates ?? [])].filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    if (readings.length > 0) {
      state.openingHash = await matchOpening(chatId, chat.character_id, greetings, readings, userId)
      state.openingStatus = state.openingHash ? 'matched' : 'no-match'
      if (!state.openingHash) state.openingSample = sample(readings[0]!)
      spindle.log.info(`${LOG} opening greeting ${state.openingStatus} for chat ${chatId} (${readings.length} readings, first ${readings[0]!.length} chars starting "${sample(readings[0]!, 60)}", ${greetings.length} greetings)`)
    } else {
      state.openingStatus = openingProbe ?? 'no-text'
    }
    // The host records which greeting opened the chat; use it when the text could not be matched or read.
    if (!state.openingHash && info.activeGreetingIndex !== null) {
      const byIndex = greetings.find((g) => g.characterId === chat.character_id && g.index === info.activeGreetingIndex)
      if (byIndex) {
        state.openingHash = byIndex.hash
        state.openingStatus = 'matched'
        delete state.openingSample
        spindle.log.info(`${LOG} opening greeting taken from chat metadata (activeGreetingIndex ${info.activeGreetingIndex}) for chat ${chatId}`)
      }
    }
  }
  state.route = await loadRoute(chatId, userId)
  // Cards referenced by the route but not present on the character (author rewrote the greeting).
  if (state.route) {
    for (const hash of state.route.route) {
      if (!state.greetings.some((g) => g.hash === hash)) {
        const card = await loadCard(hash, userId)
        if (card) state.greetings.push({ index: -1, hash, text: '', card })
      }
    }
  }
  return state
}

function send(message: BackendMessage, userId?: string): void {
  spindle.sendToFrontend(message, userId)
}

async function pushStateFor(chatId: string | null, userId?: string, openingText?: string | null, openingProbe?: string, openingCandidates?: string[]): Promise<void> {
  try {
    send({ type: 'state', state: await buildPanelState(chatId, userId, openingText, openingProbe, openingCandidates) }, userId)
  } catch (err) {
    send({ type: 'error', message: `Could not load Stagecoach state: ${errMsg(err)}` }, userId)
  }
}

async function routeForWrite(chatId: string, userId?: string): Promise<ChatRoute | null> {
  const existing = await loadRoute(chatId, userId)
  if (existing) return existing
  const chat = await getChat(chatId, userId)
  if (!chat) return null
  return newRoute(chatId, chat.character_id)
}

// ---------------------------------------------------------------------------
// Distill — one generate.raw call per greeting, reasoning off, JSON out.
// Result goes to the editor; nothing is saved until the user clicks Save.
// ---------------------------------------------------------------------------
/** `words` is the per-field limit, which follows the higher-token-limit setting. */
function distillSystem(words: number): string {
  return [
    'You turn one greeting from a roleplay character card into a compact "stage card": a description of the story stage that greeting opens.',
    'Reply with a single JSON object and nothing else, with exactly these string keys:',
    '- "label": a 2-4 word name for this stage.',
    `- "presupposes": what must already be true before this scene can open. Describe STATE, not events. At most ${words} words.`,
    `- "scene": where and when, and what {{char}} is doing or has arranged. {{user}} may be present, but never describe anything {{user}} does, says, feels, or where {{user}} sits or stands. No dialogue. At most ${words} words.`,
    `- "mood": tone, plus an explicit ceiling on intimacy or heat for this stage. At most ${words} words.`,
    'Keep the placeholders {{char}} and {{user}} exactly as written; never replace them with names. Write in the present tense. Do not quote the greeting.',
    '',
    'Example output for a greeting where the character has invited the user to sit by the fire after weeks of riding together:',
    '{"label":"Fireside evening","presupposes":"Some weeks have passed. {{user}} has ridden with {{char}} several times and the formality between them has worn off.","scene":"Evening at the ranch house, fire lit, a bottle {{char}} has been saving. {{char}} has cleared the evening for just the two of them.","mood":"Warm, charged, unhurried. Flirtation is mutual; nothing physical has happened yet."}',
  ].join('\n')
}

function extractContent(result: unknown): string {
  if (typeof result === 'string') return result
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>
    if (typeof r.content === 'string') return r.content
    if (typeof r.text === 'string') return r.text
    const choices = r.choices as Array<{ message?: { content?: unknown } }> | undefined
    const c = choices?.[0]?.message?.content
    if (typeof c === 'string') return c
  }
  return ''
}

function parseStageJson(text: string): Omit<StageCard, 'hash' | 'updatedAt'> {
  let body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) throw new Error(`No JSON object in reply: ${text.slice(0, 200)}`)
  body = body.slice(start, end + 1)
  const parsed = JSON.parse(body) as Record<string, unknown>
  const card = {
    label: str(parsed.label),
    presupposes: str(parsed.presupposes),
    scene: str(parsed.scene),
    mood: str(parsed.mood),
    doneWhen: str(parsed.doneWhen),
    source: 'llm' as const,
  }
  if (!card.scene && !card.mood) throw new Error('Reply had no usable "scene" or "mood" field.')
  return card
}

async function distill(chatId: string, hash: string, connectionId: string | null, runId: string | undefined, userId?: string): Promise<void> {
  if (!has('generation')) throw new Error('The "generation" permission is required for Distill.')
  const chat = await getChat(chatId, userId)
  const pooled = chat ? await chatGreetings(chat, userId) : null
  if (!pooled) throw new Error('Could not load the character for this chat.')
  // Pooled across group members, so a card owned by any member can be distilled.
  const owned = pooled.greetings.find((g) => g.hash === hash) ?? null
  const greeting = owned?.text ?? null
  const characterId = owned?.characterId ?? chat!.character_id
  if (!greeting) throw new Error('That greeting is no longer on the character (it may have been edited).')

  // The host does not always carry the connection's model into a raw call
  // (OpenRouter answers "No models provided"), so resolve it from the profile
  // and send it both top-level and in parameters, whichever path the runtime honours.
  // The host resolves neither a default connection nor the connection's model
  // for raw calls on every provider ("Unknown provider:", "No models provided"),
  // so pick the connection ourselves and send the model both top-level and in
  // parameters, whichever path the runtime honours.
  let model: string | undefined
  let resolvedConnectionId = connectionId ?? undefined
  try {
    let conn = connectionId ? await spindle.connections.get(connectionId, userId) : null
    if (!conn) {
      const list = await spindle.connections.list(userId)
      conn = list.find((c) => c.is_default) ?? list[0] ?? null
      if (!conn) throw new Error('No connections are configured. Add one under Connections, then pick it in the Distill dropdown.')
    }
    resolvedConnectionId = conn.id
    if (conn.model) model = conn.model
  } catch (err) {
    throw new Error(`Could not resolve a connection for Distill: ${errMsg(err)}`)
  }
  const { distillWords } = tokenLimitsFor(await loadSettings(userId))
  const request: GenerationRequestDTO & { model?: string } = {
    type: 'raw',
    messages: [
      { role: 'system', content: distillSystem(distillWords) },
      { role: 'user', content: `Greeting:\n\n${greeting}` },
    ],
    connection_id: resolvedConnectionId,
    reasoning: { source: 'off' },
    userId,
    signal: AbortSignal.timeout(120_000),
  }
  if (model) {
    request.model = model
    request.parameters = { model }
  }
  const result = await spindle.generate.raw(request)
  const card = parseStageJson(extractContent(result))
  send({ type: 'distill_result', hash, runId, card }, userId)
}

// ---------------------------------------------------------------------------
// Frontend messages
// ---------------------------------------------------------------------------
spindle.onFrontendMessage(async (payload: unknown, userId: string) => {
  const uid = actingUser(userId)
  const msg = payload as FrontendMessage
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return
  // With several users about, a reply to nobody in particular would be broadcast to all of them.
  if (!uid && knownUsers.size > 1) {
    spindle.log.warn(`${LOG} ${msg.type} arrived without a user id on a multi-user install; ignored`)
    return
  }
  try {
    switch (msg.type) {
      case 'get_state':
        await pushStateFor(msg.chatId, uid, msg.openingText, msg.openingProbe, Array.isArray(msg.openingCandidates) ? msg.openingCandidates.filter((t): t is string => typeof t === 'string') : undefined)
        break

      case 'set_reminder_every': {
        const route = await routeForWrite(msg.chatId, uid)
        if (!route) throw new Error('Could not load this chat.')
        await saveRoute(setReminderEvery(route, Number(msg.every)), uid)
        await pushStateFor(msg.chatId, uid)
        break
      }

      case 'sync_count': {
        const route = await loadRoute(msg.chatId, uid)
        if (!route) break
        const rewound = rewindTo(route, Number(msg.messageCount) || 0, 1)
        if (rewound !== route) {
          await saveRoute(rewound, uid)
          spindle.toast.info(`Messages were deleted past a stage change. Stagecoach rewound to stage ${rewound.stageIndex + 1}.`, { userId: uid })
          await pushStateFor(msg.chatId, uid)
        }
        break
      }

      case 'set_enabled': {
        const route = await routeForWrite(msg.chatId, uid)
        if (!route) throw new Error('Could not load this chat.')
        await saveRoute({ ...route, enabled: msg.enabled === true }, uid)
        await pushStateFor(msg.chatId, uid)
        break
      }

      case 'set_route': {
        const route = await routeForWrite(msg.chatId, uid)
        if (!route) throw new Error('Could not load this chat.')
        const hashes = Array.isArray(msg.route) ? msg.route.filter(isValidHash) : []
        await saveRoute(applyRoute(route, hashes, Number(msg.messageCount) || 0), uid)
        await pushStateFor(msg.chatId, uid)
        break
      }

      case 'set_stage': {
        const route = await routeForWrite(msg.chatId, uid)
        if (!route) throw new Error('Could not load this chat.')
        await saveRoute(setStage(route, Number(msg.stageIndex) || 0, Number(msg.messageCount) || 0, typeof msg.latestMessageId === 'string' ? msg.latestMessageId : null), uid)
        await pushStateFor(msg.chatId, uid)
        break
      }

      case 'set_note': {
        const route = await routeForWrite(msg.chatId, uid)
        if (!route) throw new Error('Could not load this chat.')
        const next = msg.armed
          ? replayStage(route, Number(msg.messageCount) || 0, typeof msg.latestMessageId === 'string' ? msg.latestMessageId : null)
          : skipNote(route)
        await saveRoute(next, uid)
        await pushStateFor(msg.chatId, uid)
        break
      }

      case 'set_inject_mode': {
        const route = await routeForWrite(msg.chatId, uid)
        if (!route) throw new Error('Could not load this chat.')
        const injectMode = msg.injectMode === 'system-at-depth' ? 'system-at-depth' : 'append-to-last-user'
        await saveRoute({ ...route, injectMode }, uid)
        await pushStateFor(msg.chatId, uid)
        break
      }

      case 'set_depth': {
        const route = await routeForWrite(msg.chatId, uid)
        if (!route) throw new Error('Could not load this chat.')
        await saveRoute(setDepth(route, Number(msg.depth)), uid)
        await pushStateFor(msg.chatId, uid)
        break
      }

      case 'set_transition': {
        const route = await routeForWrite(msg.chatId, uid)
        if (!route) throw new Error('Could not load this chat.')
        if (!isValidHash(msg.hash) || !isTransitionStyle(msg.style)) throw new Error('Invalid transition.')
        await saveRoute(setTransition(route, msg.hash, msg.style), uid)
        await pushStateFor(msg.chatId, uid)
        break
      }

      case 'save_card': {
        const raw = msg.card as Partial<StageCard> | undefined
        if (!raw || !isValidHash(raw.hash)) throw new Error('Invalid stage card.')
        const card = sanitizeCard(raw, raw.hash)
        if (!card) throw new Error('Invalid stage card.')
        card.updatedAt = Date.now()
        await saveCard(card, uid)
        const est = estimateTokens([card.presupposes, card.scene, card.mood, card.doneWhen].join(' '))
        spindle.toast.success(`Saved "${card.label || 'stage card'}" (~${est} tokens).`, { userId: uid })
        await pushStateFor(msg.chatId, uid)
        break
      }

      case 'delete_card':
        await deleteCard(msg.hash, uid)
        await pushStateFor(msg.chatId, uid)
        break

      case 'distill':
        try {
          await distill(msg.chatId, msg.hash, msg.connectionId ?? null, typeof msg.runId === 'string' ? msg.runId : undefined, uid)
        } catch (err) {
          send({ type: 'distill_error', hash: msg.hash, runId: typeof msg.runId === 'string' ? msg.runId : undefined, message: errMsg(err) }, uid)
        }
        break

      case 'set_settings': {
        const next = applySettingsPatch(await loadSettings(uid), msg.settings ?? {})
        await saveSettings(next, uid)
        await pushStateFor(msg.chatId, uid)
        break
      }

      case 'count_tokens': {
        const text = typeof msg.text === 'string' ? msg.text : ''
        try {
          const r = await spindle.tokens.countText(text, { modelSource: 'main', userId: uid })
          send({ type: 'token_count', requestId: msg.requestId, tokens: r.total_tokens, approximate: r.approximate }, uid)
        } catch {
          send({ type: 'token_count', requestId: msg.requestId, tokens: estimateTokens(text), approximate: true }, uid)
        }
        break
      }
    }
  } catch (err) {
    spindle.log.error(`${LOG} ${msg.type} failed: ${errMsg(err)}`)
    send({ type: 'error', message: errMsg(err) }, uid)
  }
})

spindle.log.info(`${LOG} backend loaded.`)
