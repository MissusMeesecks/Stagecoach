// =============================================================================
// Per-user isolation in the backend. One worker can serve several users, and
// stage cards are content-addressed: two users who import the same public card
// share greeting hashes. These tests run the real backend against a fake host
// with per-user storage and check that nothing crosses between users.
//
// backend.ts reads the global `spindle` at call time and keeps its caches in
// module state, so every test boots its own copy (a fresh module via a query
// string) against a freshly reset fake host. No test depends on another.
// =============================================================================

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { hashGreeting } from './core/hash.ts'
import { previewNote } from './core/preview.ts'
import { wrapForAppend } from './core/inject.ts'

type Handler = (...args: any[]) => any

const GREETINGS = ['Dusk settles over the ranch.', 'Two weeks later, the fences are done.']
let H0 = ''
let H1 = ''

// ---- Fake host -----------------------------------------------------------------
let storage = new Map<string, Map<string, unknown>>()
/** Every userId a storage call was made with, in order. */
let storageUsers: Array<string | undefined> = []
let sentTo: Array<{ userId: string | undefined; message: any }> = []
let events = new Map<string, Handler>()
let onMessage: Handler = () => undefined
let interceptor: Handler = () => undefined
/** Holds the next read of one user's file until released, to stage a save landing during a cold read. */
let gate: { userId: string; path: string; release: () => void; held: Promise<void>; used: boolean } | null = null

function holdNextRead(userId: string, path: string): () => void {
  let release = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  gate = { userId, path, release, held, used: false }
  return release
}

function bucket(userId: string | undefined): Map<string, unknown> {
  storageUsers.push(userId)
  // Operator installs need a user for per-user storage; a call without one is a bug in the extension.
  if (!userId) throw new Error('userStorage call without a userId')
  if (!storage.has(userId)) storage.set(userId, new Map())
  return storage.get(userId)!
}

/** Read a user's stored file without counting it as a call the extension made. */
function stored(userId: string, path: string): any {
  return storage.get(userId)?.get(path)
}

// The same public card imported by both users: different character and chat ids, same greeting text.
const chats: Record<string, Record<string, unknown>> = {
  A: { chatA: { id: 'chatA', character_id: 'charA', metadata: {} }, groupA: { id: 'groupA', character_id: 'charA', metadata: { group: true, character_ids: ['charA', 'charA2'] } }, groupGone: { id: 'groupGone', character_id: 'charGone', metadata: { group: true, character_ids: ['charGone', 'charA'] } } },
  B: { chatB: { id: 'chatB', character_id: 'charB', metadata: {} } },
}
const characters: Record<string, Record<string, unknown>> = {
  A: { charA: { id: 'charA', name: 'Wade', first_mes: GREETINGS[0], alternate_greetings: [GREETINGS[1]] }, charA2: { id: 'charA2', name: 'Mara', first_mes: 'The lighthouse lamp gutters.', alternate_greetings: [] } },
  B: { charB: { id: 'charB', name: 'Wade', first_mes: GREETINGS[0], alternate_greetings: [GREETINGS[1]] } },
}

const fakeSpindle = {
  log: { info() {}, warn() {}, error() {} },
  permissions: { has: () => true, getGranted: async () => ['characters', 'chats', 'interceptor', 'generation'], onChanged: () => () => {} },
  registerInterceptor: (fn: Handler) => { interceptor = fn },
  on: (event: string, fn: Handler) => { events.set(event, fn); return () => {} },
  onFrontendMessage: (fn: Handler) => { onMessage = fn },
  sendToFrontend: (message: unknown, userId?: string) => { sentTo.push({ userId, message }) },
  toast: { success() {}, info() {} },
  tokens: { countText: async (text: string) => ({ total_tokens: Math.ceil(text.length / 4), approximate: true }) },
  macros: { resolve: async (text: string) => ({ text: text.replace(/\{\{char\}\}/g, 'Wade').replace(/\{\{user\}\}/g, 'Cherlene') }) },
  connections: { list: async () => [], get: async () => null },
  generate: { raw: async () => ({ content: '{}' }) },
  chats: { get: async (id: string, userId?: string) => chats[userId ?? '']?.[id] ?? null },
  characters: { get: async (id: string, userId?: string) => characters[userId ?? '']?.[id] ?? null },
  userStorage: {
    getJson: async (path: string, opts: { fallback: unknown; userId?: string }) => {
      const b = bucket(opts.userId)
      const value = b.has(path) ? structuredClone(b.get(path)) : opts.fallback
      if (gate && !gate.used && gate.userId === opts.userId && gate.path === path) { gate.used = true; await gate.held }
      return value
    },
    setJson: async (path: string, value: unknown, opts: { userId?: string }) => { bucket(opts.userId).set(path, structuredClone(value)) },
    delete: async (path: string, userId?: string) => { bucket(userId).delete(path) },
  },
}

function route(chatId: string, characterId: string) {
  // On stage 2, entered at message 1, no reply since: the next generation gets the scene-change note.
  return { chatId, characterId, enabled: true, route: [H0, H1], stageIndex: 1, enteredAt: [0, 1], strength: 3, injectMode: 'append-to-last-user' }
}

function stageCard(scene: string) {
  return { hash: H1, label: 'Fences', presupposes: '', scene, mood: 'Easy.', doneWhen: '', with: '', source: 'manual', updatedAt: 1 }
}

/** Unique per evaluation of this file (reruns re-evaluate it), so every boot gets a module Bun has not cached. */
const RUN = crypto.randomUUID()
let boots = 0

/** Reset the fake host, seed both users' storage, and load a fresh copy of the backend against it. */
async function boot(): Promise<void> {
  storage = new Map()
  storageUsers = []
  sentTo = []
  events = new Map()
  gate = null
  storage.set('A', new Map<string, unknown>([['chats/chatA.json', route('chatA', 'charA')], ['chats/groupA.json', route('groupA', 'charA')], [`cards/${H1}.json`, stageCard("A's fence scene")]]))
  storage.set('B', new Map<string, unknown>([['chats/chatB.json', route('chatB', 'charB')]]))
  ;(globalThis as { spindle?: unknown }).spindle = fakeSpindle
  // Not a literal, so tsc does not try to resolve the query string.
  const specifier = `./backend.ts?run=${RUN}&boot=${++boots}`
  await import(specifier)
}

async function frontend(userId: string, message: Record<string, unknown>) {
  sentTo = []
  await onMessage(message, userId)
  return sentTo
}

async function panel(userId: string, chatId: string) {
  const out = await frontend(userId, { type: 'get_state', chatId })
  return out.find((s) => s.message.type === 'state')?.message.state
}

/** What the next generation in this user's chat would send, as text. */
async function generate(userId: string, chatId: string, characterId?: string): Promise<string> {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi', __isChatHistory: true, sourceIndexInChat: 0, sourceMessageId: 'm0' },
  ]
  const result = await interceptor(messages, { chatId, userId, generationType: 'normal', characterId })
  const out = Array.isArray(result) ? result : result.messages
  return JSON.stringify(out)
}

/** CHAT_FORKED is handled fire-and-forget; give its async body a moment to finish. */
async function fork(sourceChatId: string, forkedChatId: string, userId?: string) {
  await events.get('CHAT_FORKED')!({ sourceChatId, forkedChatId, forkedAtMessageIndex: 5 }, userId)
  await Bun.sleep(20)
}

beforeAll(async () => {
  H0 = await hashGreeting(GREETINGS[0]!)
  H1 = await hashGreeting(GREETINGS[1]!)
})

afterAll(() => {
  delete (globalThis as { spindle?: unknown }).spindle
})

describe('one user', () => {
  beforeEach(boot)

  test('an event without a user id acts for the only user seen', async () => {
    await panel('A', 'chatA')
    await fork('chatA', 'forkA')
    expect(stored('A', 'chats/forkA.json')?.route).toEqual([H0, H1])
  })
})

describe('two users with the same public card', () => {
  // Both users have been seen, as on a live operator install.
  beforeEach(async () => {
    await boot()
    await panel('A', 'chatA')
    await panel('B', 'chatB')
  })

  test("a user never sees another user's stage card for the same greeting", async () => {
    expect((await panel('A', 'chatA')).greetings.find((g: any) => g.hash === H1).card.scene).toBe("A's fence scene")
    expect((await panel('B', 'chatB')).greetings.find((g: any) => g.hash === H1).card).toBeNull()
  })

  test("another user's card never reaches the prompt", async () => {
    expect(await generate('A', 'chatA')).toContain("A's fence scene")
    expect(await generate('B', 'chatB')).not.toContain('fence scene')
  })

  test("saving and deleting a card only touches the saver's own, in memory and in storage", async () => {
    await generate('A', 'chatA') // A's card is cached before B writes
    await frontend('B', { type: 'save_card', chatId: 'chatB', card: stageCard("B's fence scene") })
    expect(stored('B', `cards/${H1}.json`)).toMatchObject({ scene: "B's fence scene" })
    expect(stored('A', `cards/${H1}.json`)).toMatchObject({ scene: "A's fence scene" })
    expect(await generate('B', 'chatB')).toContain("B's fence scene")
    expect(await generate('A', 'chatA')).toContain("A's fence scene")
    await frontend('B', { type: 'delete_card', chatId: 'chatB', hash: H1 })
    expect(stored('B', `cards/${H1}.json`)).toBeUndefined()
    expect(stored('A', `cards/${H1}.json`)).toMatchObject({ scene: "A's fence scene" })
    expect(await generate('B', 'chatB')).not.toContain('fence scene')
    expect(await generate('A', 'chatA')).toContain("A's fence scene")
  })

  test('settings are per user, in the panel and in storage', async () => {
    await frontend('A', { type: 'set_settings', chatId: 'chatA', settings: { highTokenLimit: true, inStageInstructions: 'Stay in second person.' } })
    expect((await panel('A', 'chatA')).settings).toMatchObject({ highTokenLimit: true, inStageInstructions: 'Stay in second person.' })
    expect((await panel('B', 'chatB')).settings).toMatchObject({ highTokenLimit: false, inStageInstructions: null })
    await frontend('B', { type: 'set_settings', chatId: 'chatB', settings: { distillConnectionId: 'conn-b' } })
    expect((await panel('A', 'chatA')).settings.distillConnectionId).toBeNull()
    expect(stored('B', 'settings.json')).toMatchObject({ distillConnectionId: 'conn-b', inStageInstructions: null, highTokenLimit: false })
    expect(stored('A', 'settings.json')).toMatchObject({ distillConnectionId: null, highTokenLimit: true })
  })

  test("the interceptor uses the generating user's token limit", async () => {
    const long = 'Rail by rail the fence goes up along the ridge. '.repeat(20)
    await frontend('A', { type: 'save_card', chatId: 'chatA', card: stageCard(long) })
    await frontend('B', { type: 'save_card', chatId: 'chatB', card: stageCard(long) })
    await frontend('A', { type: 'set_settings', chatId: 'chatA', settings: { highTokenLimit: true } })
    await frontend('B', { type: 'set_settings', chatId: 'chatB', settings: { highTokenLimit: false } })
    // Whichever user's settings were touched last must not decide the other's cap.
    await panel('A', 'chatA')
    const b = await generate('B', 'chatB')
    await panel('B', 'chatB')
    const a = await generate('A', 'chatA')
    expect(a.length).toBeGreaterThan(b.length + 200)
  })

  test("each user's closing line reaches their own prompt, and only theirs", async () => {
    await frontend('A', { type: 'set_settings', chatId: 'chatA', settings: { closingLine: 'Write it in past tense, A.' } })
    await frontend('B', { type: 'save_card', chatId: 'chatB', card: stageCard("B's fence scene") })
    expect(await generate('A', 'chatA')).toContain('Write it in past tense, A.')
    const b = await generate('B', 'chatB')
    expect(b).toContain('Keep the existing narrative tense and voice.')
    expect(b).not.toContain('past tense, A')
  })

  test('the editor preview is exactly the note the interceptor sends', async () => {
    await frontend('A', { type: 'set_transition', chatId: 'chatA', hash: H1, style: 'cut' })
    await frontend('A', { type: 'set_settings', chatId: 'chatA', settings: { closingLine: 'Stay in past tense.' } })
    const state = await panel('A', 'chatA')
    const card = state.greetings.find((g: any) => g.hash === H1).card
    // The fake host resolves {{char}} to Wade and {{user}} to Cherlene; the panel would show them literally.
    const preview = previewNote({ card, route: state.route, settings: state.settings, group: false, names: { char: 'Wade', user: 'Cherlene' } })
    expect(preview.placement).toBe('sent')
    expect(preview.arrival!.text).toContain('Cut straight to this scene')
    expect(await generate('A', 'chatA')).toContain(JSON.stringify(wrapForAppend(preview.arrival!.text)).slice(1, -1))
  })

  test('in a group chat too, with a partner and the higher cap, the preview is exactly what is sent', async () => {
    const long = { ...stageCard('{{user}} and {{char}} ride the fence line at dawn, checking every post. '.repeat(14)), with: 'Mara' }
    await frontend('A', { type: 'save_card', chatId: 'groupA', card: long })
    await frontend('A', { type: 'set_settings', chatId: 'groupA', settings: { highTokenLimit: true, closingLine: 'Never speak for {{user}}.' } })
    const state = await panel('A', 'groupA')
    expect(state.isGroup).toBe(true)
    const card = state.greetings.find((g: any) => g.hash === H1).card
    const preview = previewNote({ card, route: state.route, settings: state.settings, group: true, names: { char: 'Wade', user: 'Cherlene' } })
    expect(preview.arrival!.text).toContain('This scene is between Wade and Mara.')
    expect(preview.arrival!.text).toContain('Mara and Wade ride the fence line')
    expect(preview.arrival!.estimatedTokens).toBeGreaterThan(120)
    expect(await generate('A', 'groupA')).toContain(JSON.stringify(wrapForAppend(preview.arrival!.text)).slice(1, -1))
  })

  test("in a group, {{char}} in the closing line names whoever replies, not the card's owner", async () => {
    await frontend('A', { type: 'set_settings', chatId: 'groupA', settings: { closingLine: 'Write only as {{char}}; never speak for {{user}}.' } })
    const fromMara = await generate('A', 'groupA', 'charA2')
    expect(fromMara).toContain('Write only as Mara; never speak for Cherlene.')
    expect(fromMara).toContain("A's fence scene") // the card itself is still Wade's
    expect(await generate('A', 'groupA', 'charA')).toContain('Write only as Wade; never speak for Cherlene.')
  })

  test("a group chat whose own character cannot be loaded still previews as a group", async () => {
    const state = await panel('A', 'groupGone')
    expect(state.error).toBeTruthy()
    expect(state.isGroup).toBe(true)
    expect(state.members).toBeUndefined()
  })

  test('replies go only to the user who asked', async () => {
    const out = await frontend('B', { type: 'get_state', chatId: 'chatB' })
    expect(out.length).toBeGreaterThan(0)
    expect(out.every((s) => s.userId === 'B')).toBe(true)
  })

  test('a message without a user id is dropped, not broadcast', async () => {
    expect(await frontend('', { type: 'get_state', chatId: 'chatA' })).toHaveLength(0)
  })

  test('an event with a user id acts for that user', async () => {
    await fork('chatB', 'forkB2', 'B')
    expect(stored('B', 'chats/forkB2.json')?.route).toEqual([H0, H1])
    expect(stored('A', 'chats/forkB2.json')).toBeUndefined()
  })

  test("an event without a user id does not guess: no user's storage is touched", async () => {
    // A copy of chatB's route in A's storage, so acting as A would visibly write forkB there.
    storage.get('A')!.set('chats/chatB.json', route('chatB', 'charB'))
    storageUsers = []
    await fork('chatB', 'forkB')
    // toStrictEqual: toEqual would accept [undefined], a storage call made for nobody.
    expect(storageUsers).toStrictEqual([])
    expect(stored('A', 'chats/forkB.json')).toBeUndefined()
    expect(stored('B', 'chats/forkB.json')).toBeUndefined()
  })
})

describe('saves that land during a cold read', () => {
  // No warm-up here: every cache starts cold, so the first read of each file can be held open.
  beforeEach(boot)

  test('an Advance or Back saved during the first route read is not undone', async () => {
    const release = holdNextRead('A', 'chats/chatA.json')
    const coldRead = generate('A', 'chatA') // the interceptor's read, held with the stage-2 route
    await frontend('A', { type: 'set_stage', chatId: 'chatA', stageIndex: 0, messageCount: 2 })
    release()
    await coldRead
    expect((await panel('A', 'chatA')).route.stageIndex).toBe(0)
  })

  test('a card saved during the first card read is not undone', async () => {
    const release = holdNextRead('A', `cards/${H1}.json`)
    const coldRead = onMessage({ type: 'get_state', chatId: 'chatA' }, 'A') // reads A's old card, held
    await Bun.sleep(5)
    await frontend('A', { type: 'save_card', chatId: 'chatA', card: stageCard('Saved while the read was held.') })
    release()
    await coldRead
    expect(await generate('A', 'chatA')).toContain('Saved while the read was held.')
  })

  test('settings saved during the first settings read are not undone', async () => {
    const release = holdNextRead('A', 'settings.json')
    const coldRead = onMessage({ type: 'get_state', chatId: 'chatA' }, 'A') // reads A's (default) settings, held
    await Bun.sleep(5)
    await frontend('A', { type: 'set_settings', chatId: 'chatA', settings: { highTokenLimit: true } })
    release()
    await coldRead
    expect((await panel('A', 'chatA')).settings.highTokenLimit).toBe(true)
  })

  test('a generation does not count as having seen its user (the interceptor stays free of side effects)', async () => {
    await panel('A', 'chatA')
    await generate('B', 'chatB')
    // Had the generation recorded B, two users would be known and an id-less event would be skipped.
    await fork('chatA', 'forkA')
    expect(stored('A', 'chats/forkA.json')?.route).toEqual([H0, H1])
  })
})
