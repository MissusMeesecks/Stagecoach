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
import { DEFAULT_SETTINGS } from './shared/types.ts'
import { hashGreeting, isValidHash, normalizeGreeting } from './core/hash.ts'
import { chooseTier, countHistoryMessages, highestHistoryIndex, reminderDue } from './core/tiers.ts'
import { breakdownName, renderDirective, estimateTokens, type Names } from './core/templates.ts'
import { injectDirective } from './core/inject.ts'
import { applyRoute, depthFor, forkRoute, isTransitionStyle, newRoute, normalizeRoute, reminderEveryFor, rewindTo, setDepth, setReminderEvery, setStage, setTransition, transitionFor } from './core/route.ts'

declare const spindle: SpindleAPI

const LOG = '[Stagecoach]'
const INTERCEPTOR_PRIORITY = 400

// ---------------------------------------------------------------------------
// Caches. The interceptor reads only these; UI handlers and events write them.
// ---------------------------------------------------------------------------
const routeCache = new Map<string, ChatRoute | null>()
const cardCache = new Map<string, StageCard | null>()
const namesCache = new Map<string, Names>()
const characterCache = new Map<string, CharacterDTO | null>()
const chatCache = new Map<string, ChatDTO | null>()
const fallbackIndexLogged = new Set<string>()
/** Greeting text with macros resolved for a chat, keyed by `${chatId}:${hash}`. Used to match the chat's opening message. */
const resolvedGreetingCache = new Map<string, string>()
/** Last opening-message probe the frontend sent for a chat, reused by state refreshes that do not re-probe. */
const lastOpening = new Map<string, { text: string | null; probe: string }>()
let settingsCache: ExtensionSettings | null = null
let currentUserId: string | undefined

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
  if (routeCache.has(chatId)) return routeCache.get(chatId) ?? null
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
  routeCache.set(chatId, route)
  return route
}

async function saveRoute(route: ChatRoute, userId?: string): Promise<void> {
  await spindle.userStorage.setJson(routePath(route.chatId), route, { indent: 2, userId })
  routeCache.set(route.chatId, route)
}

async function loadCard(hash: string, userId?: string): Promise<StageCard | null> {
  if (!isValidHash(hash)) return null
  if (cardCache.has(hash)) return cardCache.get(hash) ?? null
  let card: StageCard | null = null
  try {
    const raw = await spindle.userStorage.getJson<unknown>(cardPath(hash), { fallback: null, userId })
    card = sanitizeCard(raw, hash)
  } catch (err) {
    spindle.log.warn(`${LOG} could not read card ${hash.slice(0, 8)}: ${errMsg(err)}`)
  }
  cardCache.set(hash, card)
  return card
}

async function saveCard(card: StageCard, userId?: string): Promise<void> {
  await spindle.userStorage.setJson(cardPath(card.hash), card, { indent: 2, userId })
  cardCache.set(card.hash, card)
}

async function deleteCard(hash: string, userId?: string): Promise<void> {
  if (!isValidHash(hash)) return
  try { await spindle.userStorage.delete(cardPath(hash), userId) } catch { /* already gone */ }
  cardCache.set(hash, null)
}

async function loadSettings(userId?: string): Promise<ExtensionSettings> {
  if (settingsCache) return settingsCache
  try {
    const raw = await spindle.userStorage.getJson<Partial<ExtensionSettings>>('settings.json', { fallback: {}, userId })
    settingsCache = { ...DEFAULT_SETTINGS, ...(raw ?? {}) }
  } catch {
    settingsCache = { ...DEFAULT_SETTINGS }
  }
  return settingsCache
}

async function saveSettings(settings: ExtensionSettings, userId?: string): Promise<void> {
  settingsCache = settings
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
    source,
    updatedAt,
  }
}

// ---------------------------------------------------------------------------
// Chat / character lookups (permissions: chats, characters)
// ---------------------------------------------------------------------------
async function getChat(chatId: string, userId?: string): Promise<ChatDTO | null> {
  if (chatCache.has(chatId)) return chatCache.get(chatId) ?? null
  if (!has('chats')) return null
  let chat: ChatDTO | null = null
  try { chat = await spindle.chats.get(chatId, userId) } catch (err) {
    spindle.log.warn(`${LOG} chats.get failed: ${errMsg(err)}`)
  }
  chatCache.set(chatId, chat)
  return chat
}

async function getCharacter(characterId: string, userId?: string): Promise<CharacterDTO | null> {
  if (characterCache.has(characterId)) return characterCache.get(characterId) ?? null
  if (!has('characters')) return null
  let character: CharacterDTO | null = null
  try { character = await spindle.characters.get(characterId, userId) } catch (err) {
    spindle.log.warn(`${LOG} characters.get failed: ${errMsg(err)}`)
  }
  characterCache.set(characterId, character)
  return character
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

async function resolveNames(chatId: string, characterId: string | null, userId?: string): Promise<Names> {
  const cached = namesCache.get(chatId)
  if (cached) return cached
  const [charName, userName] = await Promise.all([
    resolveOne('{{char}}', chatId, characterId, userId),
    resolveOne('{{user}}', chatId, characterId, userId),
  ])
  let char = charName
  if (!char && characterId) char = (await getCharacter(characterId, userId))?.name ?? null
  const names: Names = { char: char ?? 'the character', user: userName ?? 'the user' }
  namesCache.set(chatId, names)
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
      const userId = context.userId || currentUserId

      const route = await loadRoute(chatId, userId)
      if (!route || !route.enabled || route.route.length === 0) return messages

      const stageHash = route.route[route.stageIndex]
      if (!stageHash) return messages
      const card = await loadCard(stageHash, userId)
      if (!card) return messages
      if (!card.scene && !card.mood) return messages

      let currentIndex = highestHistoryIndex(messages)
      if (currentIndex === null) {
        currentIndex = Math.max(0, countHistoryMessages(messages) - 1)
        if (!fallbackIndexLogged.has(chatId)) {
          fallbackIndexLogged.add(chatId)
          spindle.log.warn(`${LOG} sourceIndexInChat absent on history messages for chat ${chatId}; falling back to message count`)
        }
      }

      const tier = chooseTier({
        stageIndex: route.stageIndex,
        stageCount: route.route.length,
        enteredAt: route.enteredAt[route.stageIndex],
        currentIndex,
      })

      const due = reminderDue({ stageIndex: route.stageIndex, enteredAt: route.enteredAt[route.stageIndex], currentIndex, every: reminderEveryFor(route) })
      if (!due) return messages

      const names = await resolveNames(chatId, context.characterId || route.characterId || null, userId)
      const directive = renderDirective(tier, card, names, { transition: transitionFor(route, stageHash) })
      const result = injectDirective(messages, directive.text, route.injectMode, depthFor(route))

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

onEvent('CHARACTER_EDITED', () => { characterCache.clear(); namesCache.clear() })
onEvent('CHARACTER_DELETED', () => { characterCache.clear(); namesCache.clear() })
onEvent('PERSONA_CHANGED', () => { namesCache.clear(); resolvedGreetingCache.clear() })
onEvent('CHAT_FORKED', (payload, eventUserId) => {
  void (async () => {
    const p = payload as { sourceChatId?: unknown; forkedChatId?: unknown; forkedAtMessageIndex?: unknown } | null
    if (!p || typeof p.sourceChatId !== 'string' || typeof p.forkedChatId !== 'string') return
    const userId = eventUserId || currentUserId
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
  if (typeof id === 'string') chatCache.delete(id)
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

function comparable(text: string): string {
  return normalizeGreeting(text).replace(/\s+/g, ' ').toLowerCase()
}

/** Resolve a greeting's macros the way the host did when it opened the chat, so the stored first message can be matched. */
async function resolvedGreeting(chatId: string, characterId: string, hash: string, text: string, userId?: string): Promise<string> {
  const key = `${chatId}:${hash}`
  const cached = resolvedGreetingCache.get(key)
  if (cached !== undefined) return cached
  let resolved = text
  try {
    resolved = (await spindle.macros.resolve(text, { chatId, characterId, userId, commit: false })).text
  } catch { /* fall back to the raw text */ }
  if (resolvedGreetingCache.size > 500) resolvedGreetingCache.clear()
  resolvedGreetingCache.set(key, resolved)
  return resolved
}

/** Letters and digits only, for a tolerant prefix comparison that survives regex/markdown/macro differences. */
function skeleton(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}
const FUZZY_PREFIX = 160
const FUZZY_MIN = 40

/** Does `haystack` (the chat's first message, possibly DOM text with name/timestamp) contain the start of `greeting`? */
function fuzzyContains(greeting: string, haystack: string): boolean {
  const g = skeleton(greeting)
  const h = skeleton(haystack)
  const n = Math.min(g.length, FUZZY_PREFIX)
  if (n < FUZZY_MIN || h.length < n) return false
  return h.includes(g.slice(0, n))
}

async function matchOpening(chatId: string, characterId: string, greetings: GreetingInfo[], openingText: string, userId?: string): Promise<string | null> {
  const target = comparable(openingText)
  if (!target) return null
  for (const g of greetings) {
    if (g.index < 0) continue
    if (comparable(g.text) === target) return g.hash
  }
  for (const g of greetings) {
    if (g.index < 0) continue
    const resolved = await resolvedGreeting(chatId, characterId, g.hash, g.text, userId)
    if (comparable(resolved) === target) return g.hash
  }
  for (const g of greetings) {
    if (g.index < 0) continue
    const resolved = resolvedGreetingCache.get(`${chatId}:${g.hash}`) ?? g.text
    if (fuzzyContains(resolved, openingText) || fuzzyContains(g.text, openingText)) return g.hash
  }
  return null
}

async function buildPanelState(chatId: string | null, userId?: string, openingText?: string | null, openingProbe?: string): Promise<PanelState> {
  if (chatId) {
    if (openingProbe !== undefined) lastOpening.set(chatId, { text: openingText ?? null, probe: openingProbe })
    else {
      const prev = lastOpening.get(chatId)
      if (prev) { openingText = prev.text; openingProbe = prev.probe }
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
  const character = await getCharacter(chat.character_id, userId)
  if (!character) {
    state.error = has('characters') ? 'Could not load the character for this chat.' : 'The "characters" permission is required to read greetings.'
  } else {
    state.characterName = character.name
    const greetings: GreetingInfo[] = []
    for (const g of greetingTexts(character)) {
      const hash = await hashGreeting(g.text)
      greetings.push({ index: g.index, hash, text: g.text, card: await loadCard(hash, userId) })
    }
    state.greetings = greetings
    if (typeof openingText === 'string' && openingText.trim()) {
      state.openingHash = await matchOpening(chatId, chat.character_id, greetings, openingText, userId)
      state.openingStatus = state.openingHash ? 'matched' : 'no-match'
      spindle.log.info(`${LOG} opening greeting ${state.openingStatus} for chat ${chatId} (first message ${openingText.length} chars, ${greetings.length} greetings)`)
    } else {
      state.openingStatus = openingProbe ?? 'no-text'
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

async function pushStateFor(chatId: string | null, userId?: string, openingText?: string | null, openingProbe?: string): Promise<void> {
  try {
    send({ type: 'state', state: await buildPanelState(chatId, userId, openingText, openingProbe) }, userId)
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
const DISTILL_SYSTEM = [
  'You turn one greeting from a roleplay character card into a compact "stage card": a description of the story stage that greeting opens.',
  'Reply with a single JSON object and nothing else, with exactly these string keys:',
  '- "label": a 2-4 word name for this stage.',
  '- "presupposes": what must already be true before this scene can open. Describe STATE, not events. At most 25 words.',
  '- "scene": where and when, and what {{char}} is doing or has arranged. {{user}} may be present, but never describe anything {{user}} does, says, feels, or where {{user}} sits or stands. No dialogue. At most 25 words.',
  '- "mood": tone, plus an explicit ceiling on intimacy or heat for this stage. At most 25 words.',
  'Keep the placeholders {{char}} and {{user}} exactly as written; never replace them with names. Write in the present tense. Do not quote the greeting.',
  '',
  'Example output for a greeting where the character has invited the user to sit by the fire after weeks of riding together:',
  '{"label":"Fireside evening","presupposes":"Some weeks have passed. {{user}} has ridden with {{char}} several times and the formality between them has worn off.","scene":"Evening at the ranch house, fire lit, a bottle {{char}} has been saving. {{char}} has cleared the evening for just the two of them.","mood":"Warm, charged, unhurried. Flirtation is mutual; nothing physical has happened yet."}',
].join('\n')

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

async function distill(chatId: string, hash: string, connectionId: string | null, userId?: string): Promise<void> {
  if (!has('generation')) throw new Error('The "generation" permission is required for Distill.')
  const characterId = await resolveCharacterId(chatId, null, userId)
  const character = characterId ? await getCharacter(characterId, userId) : null
  if (!character) throw new Error('Could not load the character for this chat.')
  let greeting: string | null = null
  for (const g of greetingTexts(character)) {
    if ((await hashGreeting(g.text)) === hash) { greeting = g.text; break }
  }
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
  const request: GenerationRequestDTO & { model?: string } = {
    type: 'raw',
    messages: [
      { role: 'system', content: DISTILL_SYSTEM },
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
  send({ type: 'distill_result', hash, card }, userId)
}

// ---------------------------------------------------------------------------
// Frontend messages
// ---------------------------------------------------------------------------
spindle.onFrontendMessage(async (payload: unknown, userId: string) => {
  currentUserId = userId || currentUserId
  const uid = userId || currentUserId
  const msg = payload as FrontendMessage
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return
  try {
    switch (msg.type) {
      case 'get_state':
        await pushStateFor(msg.chatId, uid, msg.openingText, msg.openingProbe)
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
        await saveRoute(setStage(route, Number(msg.stageIndex) || 0, Number(msg.messageCount) || 0), uid)
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
          await distill(msg.chatId, msg.hash, msg.connectionId ?? null, uid)
        } catch (err) {
          send({ type: 'distill_error', hash: msg.hash, message: errMsg(err) }, uid)
        }
        break

      case 'set_settings': {
        const current = await loadSettings(uid)
        const patch = msg.settings ?? {}
        const next: ExtensionSettings = {
          ...current,
          distillConnectionId: typeof patch.distillConnectionId === 'string' && patch.distillConnectionId
            ? patch.distillConnectionId
            : patch.distillConnectionId === null ? null : current.distillConnectionId,
        }
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
