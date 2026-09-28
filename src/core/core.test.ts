import { describe, expect, test } from 'bun:test'
import { hashGreeting, normalizeGreeting, isValidHash } from './hash.ts'
import { chooseTier, highestHistoryIndex, countHistoryMessages, turnsInStage, reminderDue, repliesSince } from './tiers.ts'
import { renderDirective, substituteNames, truncateToChars, breakdownName, effectiveInstructions, TENSE_NOTE, DEFAULT_IN_STAGE_INSTRUCTIONS } from './templates.ts'
import { injectDirective, injectSystemAtDepth, appendToLastUser, wrapForAppend, type MessageLike } from './inject.ts'
import { matchGreeting, fuzzyScore, skeleton } from './opening.ts'
import { groupInfo } from './group.ts'
import { applyRoute, newRoute, normalizeRoute, setStage, depthFor, setDepth, setTransition, transitionFor, rewindTo, forkRoute, anchorFor, replayStage, skipNote } from './route.ts'
import type { StageCard } from '../shared/types.ts'

const card: StageCard = {
  hash: 'a'.repeat(64),
  label: 'Fireside',
  presupposes: 'Some weeks have passed. {{user}} has ridden with {{char}} several times.',
  scene: 'Evening at the ranch house, fire lit, a bottle {{char}} has been saving. Just the two of them.',
  mood: 'Warm, charged, unhurried. Flirtation is mutual; nothing physical has happened yet.',
  doneWhen: 'One of them has openly acknowledged the tension.',
  source: 'manual',
  updatedAt: 0,
}
const names = { char: 'Wade', user: 'Cherlene' }

describe('hash', () => {
  test('normalises line endings, whitespace and unicode form', async () => {
    const a = await hashGreeting('  Hello\r\nworldé \n')
    const b = await hashGreeting('Hello\nworldé')
    expect(a).toBe(b)
    expect(isValidHash(a)).toBe(true)
    expect(normalizeGreeting('x\r\ny\r')).toBe('x\ny')
  })
  test('different text yields different hash', async () => {
    expect(await hashGreeting('a')).not.toBe(await hashGreeting('b'))
  })
  test('rejects non-hash strings', () => {
    expect(isValidHash('../etc/passwd')).toBe(false)
    expect(isValidHash('A'.repeat(64))).toBe(false)
  })
})

describe('tiers', () => {
  const hist = (i: number, role: 'user' | 'assistant' = 'user') => ({ role, content: 'x', __isChatHistory: true, sourceIndexInChat: i })
  test('highestHistoryIndex ignores non-history and unstamped messages', () => {
    expect(highestHistoryIndex([{ role: 'system', content: 's' }, hist(4), hist(7), { role: 'user', content: 'nudge' }])).toBe(7)
    expect(highestHistoryIndex([{ role: 'user', content: 'x', __isChatHistory: true }])).toBeNull()
    expect(countHistoryMessages([hist(1), hist(2), { role: 'system', content: 's' }])).toBe(2)
  })
  test('starting stage is always in-stage', () => {
    expect(chooseTier({ stageIndex: 0, stageCount: 3, enteredAt: 0, replies: 0 })).toBe('in-stage')
  })
  test('arrival until the first reply after advancing has landed, then in-stage', () => {
    expect(chooseTier({ stageIndex: 1, stageCount: 3, enteredAt: 10, replies: 0 })).toBe('arrival')
    expect(chooseTier({ stageIndex: 1, stageCount: 3, enteredAt: 10, replies: 1 })).toBe('in-stage')
    expect(chooseTier({ stageIndex: 1, stageCount: 3, enteredAt: 10, replies: 4 })).toBe('in-stage')
    expect(turnsInStage(9, 10)).toBe(0)
    expect(turnsInStage(13, 10)).toBe(1)
  })
  test('reminderDue: one note per stage at arrival, never for stage 1', () => {
    const at = (replies: number, every = 0) => reminderDue({ stageIndex: 1, replies, every })
    expect(at(0)).toBe(true)    // scene-change note
    expect(at(1)).toBe(false)
    expect(at(2)).toBe(false)
    expect(at(15)).toBe(false)
    // Optional reminder (off by default): every 3 replies after arrival.
    expect(at(1, 3)).toBe(true)
    expect(at(2, 3)).toBe(false)
    expect(at(4, 3)).toBe(true)
    // Stage 1 never gets a note, whatever the settings.
    for (const i of [0, 1, 2, 6, 30]) {
      expect(reminderDue({ stageIndex: 0, replies: i, every: 0 })).toBe(false)
      expect(reminderDue({ stageIndex: 0, replies: i, every: 1 })).toBe(false)
    }
  })
  test('missing enteredAt degrades to in-stage', () => {
    expect(chooseTier({ stageIndex: 2, stageCount: 3, enteredAt: undefined, replies: 0 })).toBe('in-stage')
  })
})

describe('templates', () => {
  test('substitutes names case-insensitively with spaces', () => {
    expect(substituteNames('{{ Char }} and {{user}}', names)).toBe('Wade and Cherlene')
  })
  test('in-stage directive carries only scene and mood', () => {
    const r = renderDirective('in-stage', card, names)
    expect(r.text).toContain('ranch house')
    expect(r.text).toContain('Wade')
    expect(r.text).not.toContain('{{')
    expect(r.text).not.toContain('weeks have passed')          // presupposes withheld
    expect(r.text).not.toContain('acknowledged the tension')   // doneWhen withheld
    expect(r.text).not.toContain('moves to')
    expect(r.text).toContain('move forward within it')
    expect(r.text.endsWith(TENSE_NOTE)).toBe(true)
    expect(r.truncated).toBe(false)
  })
  test('arrival directive defaults to the narrated time skip', () => {
    const r = renderDirective('arrival', card, names)
    expect(r.text.startsWith('Time passes.')).toBe(true)
    expect(r.text).toContain('ranch house')
    expect(renderDirective('arrival', card, names, { transition: 'auto' }).text).toBe(r.text) // legacy value
    expect(r.text.endsWith(TENSE_NOTE)).toBe(true)
  })
  test('transition styles change only the arrival frame', () => {
    const cut = renderDirective('arrival', card, names, { transition: 'cut' }).text
    const elapse = renderDirective('arrival', card, names, { transition: 'elapse' }).text
    const flow = renderDirective('arrival', card, names, { transition: 'flow' }).text
    expect(cut).toContain('Cut straight')
    expect(cut).not.toContain('time skip')
    expect(elapse.startsWith('Time passes.')).toBe(true)
    expect(elapse).toContain('what has changed')
    expect(flow).toContain('rather than cutting')
    for (const t of [cut, elapse, flow]) {
      expect(t).toContain('ranch house')
      expect(t).not.toContain('weeks have passed')
    }
    // In-stage wording ignores the transition style entirely.
    expect(renderDirective('in-stage', card, names, { transition: 'cut' }).text).toBe(renderDirective('in-stage', card, names).text)
    // Oversized cards still fit under every style.
    const fat = { ...card, scene: 'word '.repeat(300), mood: 'tone '.repeat(200) }
    for (const transition of ['cut', 'elapse', 'flow'] as const) {
      expect(renderDirective('arrival', fat, names, { transition }).estimatedTokens).toBeLessThanOrEqual(120)
    }
  })
  test('scene partner (group only) rides with the scene and survives trimming', () => {
    const withPartner = { ...card, with: 'Jake' }
    const g = { group: true }
    const r = renderDirective('in-stage', withPartner, names, g).text
    expect(r).toContain('Just the two of them. This scene is between Wade and Jake. Mood:')
    expect(renderDirective('arrival', withPartner, names, { ...g, transition: 'cut' }).text).toContain('This scene is between Wade and Jake. Mood:')
    expect(renderDirective('in-stage', { ...card, with: '{{user}}' }, names, g).text).toContain('between Wade and Cherlene.')
    expect(renderDirective('in-stage', { ...card, with: '  ' }, names, g).text).toContain('between Wade and Cherlene.')
    // Solo chats ignore the field completely, whatever a shared card says.
    expect(renderDirective('in-stage', withPartner, names).text).not.toContain('This scene is between')
    expect(renderDirective('arrival', withPartner, names).text).not.toContain('Jake')
    const fat = { ...withPartner, scene: 'word '.repeat(300), mood: 'tone '.repeat(200) }
    const t = renderDirective('in-stage', fat, names, g)
    expect(t.truncated).toBe(true)
    expect(t.text).toContain('This scene is between Wade and Jake.')
    expect(t.estimatedTokens).toBeLessThanOrEqual(120)
  })
  test('custom in-stage instructions replace the default tail; arrival ignores them', () => {
    const base = renderDirective('in-stage', card, names).text
    expect(base.endsWith(DEFAULT_IN_STAGE_INSTRUCTIONS)).toBe(true)
    const custom = renderDirective('in-stage', card, names, { instructions: 'Stay in the scene.  Short replies. ' }).text
    expect(custom.endsWith('Stay in the scene. Short replies.')).toBe(true)
    expect(custom).not.toContain('move forward within it')
    expect(custom).toContain('ranch house')
    // Blank or unset falls back to the default wording.
    expect(renderDirective('in-stage', card, names, { instructions: '   ' }).text).toBe(base)
    expect(renderDirective('in-stage', card, names, { instructions: null }).text).toBe(base)
    expect(effectiveInstructions(undefined)).toBe(DEFAULT_IN_STAGE_INSTRUCTIONS)
    // Arrival wording is untouched by the setting.
    const arrival = renderDirective('arrival', card, names).text
    expect(renderDirective('arrival', card, names, { instructions: 'Stay in the scene.' }).text).toBe(arrival)
    // Long instructions still leave room for the card and stay under the cap.
    const long = renderDirective('in-stage', card, names, { instructions: 'rule '.repeat(80) })
    expect(long.estimatedTokens).toBeLessThanOrEqual(120)
    expect(long.truncated).toBe(true)
  })
  test('token cap is enforced on oversized cards', () => {
    const fat = { ...card, scene: 'word '.repeat(300), mood: 'tone '.repeat(200) }
    const r = renderDirective('in-stage', fat, names)
    expect(r.truncated).toBe(true)
    expect(r.estimatedTokens).toBeLessThanOrEqual(120)
    expect(truncateToChars('one. two. three.', 12)).toBe('one. two.')
  })
  test('breakdown name', () => {
    expect(breakdownName(1, 4, 'arrival')).toBe('Stagecoach · stage 2/4 · arrival')
  })
})

describe('inject', () => {
  const base: MessageLike[] = [
    { role: 'system', content: 'preset system' },
    { role: 'user', content: 'u1', __isChatHistory: true },
    { role: 'assistant', content: 'a1', __isChatHistory: true },
    { role: 'user', content: 'u2', __isChatHistory: true },
    { role: 'assistant', content: 'a2', __isChatHistory: true },
    { role: 'user', content: 'u3', __isChatHistory: true },
    { role: 'assistant', content: 'prefill' },
  ]
  test('system-at-depth places relative to history, keeping the prefill last', () => {
    const r = injectSystemAtDepth(base, 'D', 2)
    expect(r.injectedIndex).toBe(4)
    expect(r.messages[4]).toEqual({ role: 'system', content: 'D' }) // no OOC wrapper in system mode
    expect(r.messages[r.messages.length - 1]!.content).toBe('prefill')
    expect(r.messages.length).toBe(base.length + 1)
    expect(base.length).toBe(7) // input untouched
  })
  test('depth 0 goes directly after the last history message', () => {
    const r = injectSystemAtDepth(base, 'D', 0)
    expect(r.injectedIndex).toBe(6)
  })
  test('depth larger than history clamps to before the first history message', () => {
    const r = injectSystemAtDepth(base, 'D', 99)
    expect(r.injectedIndex).toBe(1)
  })
  test('empty chat appends at the end', () => {
    const r = injectSystemAtDepth([{ role: 'system', content: 's' }], 'D', 2)
    expect(r.injectedIndex).toBe(1)
  })
  test('append mode appends to the last user turn, string content', () => {
    const r = appendToLastUser(base, 'D')
    expect(r.injectedIndex).toBeNull()
    expect(r.messages[5]!.content).toBe('u3\n\n(OOC: D Do not reply to this note.)')
    expect(r.messages.length).toBe(base.length)
    expect(base[5]!.content).toBe('u3')
  })
  test('append mode adds a text part for array content', () => {
    const msgs: MessageLike[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }], __isChatHistory: true }]
    const r = appendToLastUser(msgs, 'D')
    expect(r.messages[0]!.content).toEqual([{ type: 'text', text: 'hi' }, { type: 'text', text: '\n\n(OOC: D Do not reply to this note.)' }])
    expect(wrapForAppend('x')).toBe('(OOC: x Do not reply to this note.)')
  })
  test('append mode falls back to a system message when there is no user turn', () => {
    const msgs: MessageLike[] = [{ role: 'assistant', content: 'a', __isChatHistory: true }]
    // The fallback honours the route depth: depth 2 with one history message lands before it, depth 0 after it.
    const r = injectDirective(msgs, 'D', 'append-to-last-user', 2)
    expect(r.appliedMode).toBe('system-at-depth')
    expect(r.injectedIndex).toBe(0)
    expect(injectDirective(msgs, 'D', 'append-to-last-user', 0).injectedIndex).toBe(1)
  })
})

describe('route', () => {
  const h = (c: string) => c.repeat(64)
  test('setStage forward records entry, back forgets it', () => {
    let r = { ...newRoute('c', 'ch'), route: [h('a'), h('b'), h('c')] }
    r = setStage(r, 1, 10)
    expect(r.stageIndex).toBe(1)
    expect(r.enteredAt).toEqual([0, 10])
    r = setStage(r, 2, 20)
    expect(r.enteredAt).toEqual([0, 10, 20])
    r = setStage(r, 0, 30)
    expect(r.enteredAt).toEqual([0])
    r = setStage(r, 2, 40)
    expect(r.enteredAt).toEqual([0, 40, 40])
    expect(setStage(r, 99, 50).stageIndex).toBe(2)
  })
  test('applyRoute keeps the pointer on the same card', () => {
    let r = { ...newRoute('c', 'ch'), route: [h('a'), h('b'), h('c')], stageIndex: 1, enteredAt: [0, 10] }
    r = applyRoute(r, [h('c'), h('a'), h('b')], 99)
    expect(r.stageIndex).toBe(2)
    expect(r.route[2]).toBe(h('b'))
    expect(r.enteredAt.length).toBe(3)
    expect(r.enteredAt[2]).toBe(10)
    const gone = applyRoute(r, [h('a')], 99)
    expect(gone.stageIndex).toBe(0)
    expect(gone.enteredAt).toEqual([0])
    expect(applyRoute(r, [h('a'), h('a')], 0).route).toEqual([h('a')])
  })
  test('transitions ride with their stage hash', () => {
    let r = { ...newRoute('c', 'ch'), route: [h('a'), h('b'), h('c')] }
    r = setTransition(r, h('b'), 'cut')
    r = setTransition(r, h('c'), 'flow')
    expect(transitionFor(r, h('b'))).toBe('cut')
    expect(transitionFor(r, h('a'))).toBe('elapse') // unset = narrated skip
    r = applyRoute(r, [h('c'), h('b')], 0)
    expect(transitionFor(r, h('b'))).toBe('cut')
    expect(transitionFor(r, h('c'))).toBe('flow')
    r = applyRoute(r, [h('b')], 0)
    expect(r.transitions).toEqual({ [h('b')]: 'cut' })
    r = setTransition(r, h('b'), 'elapse')
    expect(r.transitions).toBeUndefined() // the default is never stored
    expect(transitionFor(setTransition(r, h('b'), 'auto'), h('b'))).toBe('elapse') // legacy value
    const n = normalizeRoute({ route: [h('a')], transitions: { [h('a')]: 'cut', [h('z')]: 'flow', [h('b')]: 'bogus' } }, 'c', 'ch')
    expect(n.transitions).toEqual({ [h('a')]: 'cut' })
  })
  test('rewindTo pops stages whose entry point was deleted', () => {
    const r = { ...newRoute('c', 'ch'), route: [h('a'), h('b'), h('c')], stageIndex: 2, enteredAt: [0, 10, 20] }
    // Fork semantics (tolerance 0): keeping exactly the messages before the advance keeps the stage.
    expect(rewindTo(r, 20, 0).stageIndex).toBe(2)
    expect(rewindTo(r, 19, 0)).toEqual({ ...r, stageIndex: 1, enteredAt: [0, 10] })
    expect(rewindTo(r, 5, 0)).toEqual({ ...r, stageIndex: 0, enteredAt: [0] })
    // Deletion semantics (tolerance 1): a single regenerate-delete does not rewind.
    expect(rewindTo(r, 19, 1)).toBe(r)
    expect(rewindTo(r, 18, 1).stageIndex).toBe(1)
    expect(rewindTo(r, 25, 1)).toBe(r)
  })
  test('forkRoute copies onto the new chat and rewinds to the fork point', () => {
    const r = { ...newRoute('c', 'ch'), route: [h('a'), h('b'), h('c')], stageIndex: 2, enteredAt: [0, 10, 20], transitions: { [h('c')]: 'flow' as const } }
    const f = forkRoute(r, 'fork', 12)
    expect(f.chatId).toBe('fork')
    expect(f.stageIndex).toBe(1)
    expect(f.enteredAt).toEqual([0, 10])
    expect(f.transitions).toEqual({ [h('c')]: 'flow' })
    expect(r.enteredAt).toEqual([0, 10, 20])
  })
  test('normalizeRoute repairs garbage', () => {
    const r = normalizeRoute({ route: [h('a'), 5, h('b')], stageIndex: 9, enteredAt: ['x'], injectMode: 'nope', strength: 7 }, 'c', 'ch')
    expect(r.route).toEqual([h('a'), h('b')])
    expect(r.stageIndex).toBe(1)
    expect(r.enteredAt).toEqual([0, 0])
    expect(r.injectMode).toBe('append-to-last-user')
    expect(normalizeRoute({ injectMode: 'system-at-depth' }, 'c', 'ch').injectMode).toBe('system-at-depth')
    expect(r.strength).toBe(3)
    expect(r.enabled).toBe(false)
    expect(depthFor(r)).toBe(0)
    expect(depthFor({ ...r, timing: { depth: 1 } })).toBe(1)
    expect(depthFor(setDepth(r, 3))).toBe(3)
    expect(depthFor(setDepth(r, -4))).toBe(0)
    expect(depthFor(setDepth(r, 999))).toBe(20)
  })
})

describe('opening greeting match', () => {
  const intro = 'The ranch house creaks in the wind as evening settles over the valley. Wade sets his hat on the table and looks at you for a long moment before speaking.'
  const g0 = `${intro} "You came back," he says. "Did not think you would." He pours two cups of coffee and slides one across the table.`
  const g1 = `${intro} "Barn is on fire," he says flatly, already reaching for the bucket. "Grab the other one and follow me."`
  const g2 = 'A completely different opening: morning at the county fair, kettle corn and dust, the judge calling the next entry.'
  const gs = [{ key: 'h0', texts: [g0] }, { key: 'h1', texts: [g1] }, { key: 'h2', texts: [g2] }]

  test('exact and decorated readings match', () => {
    expect(matchGreeting(gs, [g1])).toBe('h1')
    expect(matchGreeting(gs, [`Wade\n10:42 PM\n${g1}\n1 / 3`])).toBe('h1')
    expect(matchGreeting(gs, ['  ' + g2.toUpperCase() + '  '])).toBe('h2')
  })
  test('shared intro paragraph does not pick the wrong alternate', () => {
    expect(matchGreeting(gs, [g0])).toBe('h0')
    expect(matchGreeting(gs, [g1])).toBe('h1')
    expect(fuzzyScore(g0, g1)).toBeLessThan(fuzzyScore(g1, g1))
  })
  test('a rewritten opening (image, html or macro at the top) still matches on the rest', () => {
    // First sentence lost to an image or html block at the top of the bubble.
    const firstSentence = intro.indexOf('. ') + 2
    expect(matchGreeting(gs, [g0.slice(firstSentence)])).toBe('h0')
    // Most of the greeting missing is not enough evidence.
    expect(matchGreeting(gs, [g0.slice(intro.length)])).toBeNull()
    const resolved = g1.replace('you', 'Cherlene')
    expect(matchGreeting([{ key: 'h1', texts: [g1, resolved] }], [`<img> ${resolved}`])).toBe('h1')
  })
  test('short greetings match when the whole text sits inside a decorated bubble', () => {
    const short = 'Evening comes down slow over the ranch.'
    const longer = 'Evening comes down slow over the ranch. Wade is already on the porch.'
    const card = [{ key: 'short', texts: [short] }, { key: 'longer', texts: [longer] }, { key: 'h2', texts: [g2] }]
    expect(matchGreeting(card, [`TThe Ranch Demo Card#0·Sep 23, 12:26 PM${short} Greetings3`])).toBe('short')
    // One greeting being a prefix of another: the reading decides, longer wins when both fit.
    expect(matchGreeting(card, [`Wade
${longer}
2 / 3`])).toBe('longer')
    // Too short to trust loosely: only an exact reading matches.
    const tiny = [{ key: 'tiny', texts: ['Hello.'] }]
    expect(matchGreeting(tiny, ['Wade 12:26 PM Hello. 1 / 3'])).toBeNull()
    expect(matchGreeting(tiny, ['Hello.'])).toBe('tiny')
  })
  test('several readings are all tried', () => {
    expect(matchGreeting(gs, ['Hi there, my first user turn.', g2])).toBe('h2')
  })
  test('unrelated or empty text does not match', () => {
    expect(matchGreeting(gs, ['A user message that is long enough to have chunks of its own but shares nothing with the greetings at all, really nothing.'])).toBeNull()
    expect(matchGreeting(gs, ['', '   '])).toBeNull()
    expect(fuzzyScore('short', 'short')).toBe(0) // below WHOLE_MIN
    expect(skeleton('Hé, "you"—there! 42')).toBe('héyouthere42')
  })
})


describe('append fallback', () => {
  const h = (role: MessageLike['role'], content: string): MessageLike => ({ role, content, __isChatHistory: true })
  test('an empty assistant placeholder after the user turn still appends to the user turn', () => {
    const msgs = [h('user', 'u1'), h('assistant', 'a1'), h('user', 'u2'), h('assistant', '')]
    const r = appendToLastUser(msgs, 'D', 0)
    expect(r.appliedMode).toBe('append-to-last-user')
    expect(r.messages[2]!.content).toBe('u2\n\n(OOC: D Do not reply to this note.)')
    expect(r.messages[3]!.content).toBe('')
  })
  test('appends when the latest history message is the user turn', () => {
    const msgs = [{ role: 'system', content: 'sys' } as MessageLike, h('user', 'u1'), h('assistant', 'a1'), h('user', 'u2')]
    const r = appendToLastUser(msgs, 'D', 3)
    expect(r.appliedMode).toBe('append-to-last-user')
    expect(r.messages[3]!.content).toBe('u2\n\n(OOC: D Do not reply to this note.)')
  })
  test('falls back to a system message at the given depth when a member spoke last', () => {
    const msgs = [{ role: 'system', content: 'sys' } as MessageLike, h('user', 'u1'), h('assistant', 'a1'), h('assistant', 'a2'), { role: 'assistant', content: 'prefill' } as MessageLike]
    const r = appendToLastUser(msgs, 'D', 0)
    expect(r.appliedMode).toBe('system-at-depth')
    expect(r.injectedIndex).toBe(4)
    expect(r.messages[4]).toEqual({ role: 'system', content: 'D' })
    expect(r.messages[5]!.content).toBe('prefill')
    expect(r.messages[1]!.content).toBe('u1') // the older user turn is untouched
    expect(injectDirective(msgs, 'D', 'append-to-last-user', 1).injectedIndex).toBe(3)
  })
})


describe('group info', () => {
  test('solo chat: just the chat character, no opening index unless recorded', () => {
    expect(groupInfo(undefined, 'c1')).toEqual({ isGroup: false, memberIds: ['c1'], activeGreetingIndex: null })
    expect(groupInfo({ activeGreetingIndex: 2 }, 'c1')).toEqual({ isGroup: false, memberIds: ['c1'], activeGreetingIndex: 2 })
  })
  test('group chat as probed on Lumiverse: members with the chat character first', () => {
    const meta = { group: true, character_ids: ['c2', 'c1'], activeGreetingIndex: 0, talkativeness_overrides: {} }
    expect(groupInfo(meta, 'c1')).toEqual({ isGroup: true, memberIds: ['c1', 'c2'], activeGreetingIndex: 0 })
    expect(groupInfo({ group: true, character_ids: ['c2', 'c3'] }, 'c1').memberIds).toEqual(['c1', 'c2', 'c3'])
  })
  test('malformed metadata degrades to solo', () => {
    expect(groupInfo({ group: true, character_ids: [] }, 'c1').isGroup).toBe(false)
    expect(groupInfo({ group: 'yes', character_ids: ['c2'] }, 'c1').isGroup).toBe(false)
    expect(groupInfo({ group: true, character_ids: [1, null, 'c2'] }, 'c1').memberIds).toEqual(['c1', 'c2'])
    expect(groupInfo({ activeGreetingIndex: -1 }, 'c1').activeGreetingIndex).toBeNull()
    expect(groupInfo({ activeGreetingIndex: 1.7 }, 'c1').activeGreetingIndex).toBe(1)
  })
})


describe('replies since entry', () => {
  const h = (role: string, idx: number, id = `m${idx}`) => ({ role, content: `${role} ${idx}`, __isChatHistory: true, sourceIndexInChat: idx, sourceMessageId: id })
  const sys = { role: 'system', content: 'preset' }
  test('solo: note on the first reply after Advance, not the second', () => {
    // Advance at count 4 (messages 0..3, latest m3), user sends m4, generation:
    const before = [sys, h('assistant', 0), h('user', 1), h('assistant', 2), h('user', 3), h('user', 4)]
    expect(repliesSince(before, { anchorId: 'm3', enteredAt: 4 })).toEqual({ replies: 0, by: 'anchor' })
    // Reply m5 landed; next generation:
    const after = [...before, h('assistant', 5), h('user', 6)]
    expect(repliesSince(after, { anchorId: 'm3', enteredAt: 4 })).toEqual({ replies: 1, by: 'anchor' })
    expect(reminderDue({ stageIndex: 1, replies: 0, every: 0 })).toBe(true)
    expect(reminderDue({ stageIndex: 1, replies: 1, every: 0 })).toBe(false)
    expect(chooseTier({ stageIndex: 1, stageCount: 2, enteredAt: 4, replies: 0 })).toBe('arrival')
    expect(chooseTier({ stageIndex: 1, stageCount: 2, enteredAt: 4, replies: 1 })).toBe('in-stage')
  })
  test('group: members replying back to back get exactly one note', () => {
    // Advance at count 4 (latest m3); member A replies without a user turn:
    const gen1 = [sys, h('assistant', 0), h('user', 1), h('assistant', 2), h('assistant', 3)]
    expect(repliesSince(gen1, { anchorId: 'm3', enteredAt: 4 }).replies).toBe(0)
    // A's reply m4 landed; member B generates next, still no user turn:
    const gen2 = [...gen1, h('assistant', 4)]
    expect(repliesSince(gen2, { anchorId: 'm3', enteredAt: 4 }).replies).toBe(1)
    const gen3 = [...gen2, h('assistant', 5)]
    expect(repliesSince(gen3, { anchorId: 'm3', enteredAt: 4 }).replies).toBe(2)
    // The old index rule would have fired on gen2 and gen3 as well.
  })
  test('anchor missing falls back to index, then to position', () => {
    const msgs = [sys, h('assistant', 0), h('user', 1), h('assistant', 2), h('user', 3), h('assistant', 4)]
    expect(repliesSince(msgs, { anchorId: 'gone', enteredAt: 4 })).toEqual({ replies: 1, by: 'index' })
    expect(repliesSince(msgs, { anchorId: null, enteredAt: 5 })).toEqual({ replies: 0, by: 'index' })
    const unstamped = msgs.map((m) => ('sourceIndexInChat' in m ? { ...m, sourceIndexInChat: undefined } : m))
    expect(repliesSince(unstamped, { anchorId: 'gone', enteredAt: 4 })).toEqual({ replies: 1, by: 'position' })
  })
  test('a placeholder for the reply being written, or the excluded message, is not a landed reply', () => {
    const anchored = [sys, h('assistant', 0), h('user', 1), h('assistant', 2), h('user', 3), h('user', 4), { ...h('assistant', 5), content: '' }]
    expect(repliesSince(anchored, { anchorId: 'm3', enteredAt: 4 })).toEqual({ replies: 0, by: 'anchor' })
    const parts = [...anchored.slice(0, -1), { ...h('assistant', 5), content: [{ type: 'text', text: '  ' }] }]
    expect(repliesSince(parts, { anchorId: 'm3', enteredAt: 4 }).replies).toBe(0)
    const regen = [sys, h('assistant', 0), h('user', 1), h('user', 2), { ...h('assistant', 3), content: 'old reply' }]
    expect(repliesSince(regen, { anchorId: 'm1', enteredAt: 2, excludeId: 'm3' }).replies).toBe(0)
    expect(repliesSince(regen, { anchorId: 'm1', enteredAt: 2 }).replies).toBe(1)
    expect(repliesSince(regen, { anchorId: 'gone', enteredAt: 2, excludeId: 'm3' })).toEqual({ replies: 0, by: 'index' })
  })
  test('a swiped reply is out of the prompt and gets the note again', () => {
    const msgs = [sys, h('assistant', 0), h('user', 1), h('user', 2)]
    expect(repliesSince(msgs, { anchorId: 'm1', enteredAt: 2 }).replies).toBe(0)
  })
})

describe('back then advance again', () => {
  const h = (role: string, idx: number) => ({ role, content: `${role} ${idx}`, __isChatHistory: true, sourceIndexInChat: idx, sourceMessageId: `m${idx}` })
  test('re-entering a stage counts replies from the new anchor, so the note fires again', () => {
    let route = { ...newRoute('chat', 'char'), enabled: true, route: ['a', 'b'] }
    // Advance at 4 messages (latest m3); user sends m4; reply m5 lands with the note.
    route = setStage(route, 1, 4, 'm3')
    const first = [h('assistant', 0), h('user', 1), h('assistant', 2), h('user', 3), h('user', 4)]
    expect(reminderDue({ stageIndex: 1, replies: repliesSince(first, { anchorId: anchorFor(route), enteredAt: route.enteredAt[1]! }).replies, every: 0 })).toBe(true)
    const after = [...first, h('assistant', 5), h('user', 6)]
    expect(reminderDue({ stageIndex: 1, replies: repliesSince(after, { anchorId: anchorFor(route), enteredAt: route.enteredAt[1]! }).replies, every: 0 })).toBe(false)
    // Back to stage 1, then Advance again at 7 messages (latest m6): the old anchor is gone, the new one is m6.
    route = setStage(route, 0, 7, 'm6')
    expect(route.anchors).toBeUndefined()
    route = setStage(route, 1, 7, 'm6')
    expect(anchorFor(route)).toBe('m6')
    expect(route.enteredAt).toEqual([0, 7])
    const again = [...after, h('user', 7)]
    const counted = repliesSince(again, { anchorId: anchorFor(route), enteredAt: 7 })
    expect(counted).toEqual({ replies: 0, by: 'anchor' })
    expect(reminderDue({ stageIndex: 1, replies: counted.replies, every: 0 })).toBe(true)
    // Same answer if the anchor id were not in the prompt.
    expect(repliesSince(again, { anchorId: 'gone', enteredAt: 7 })).toEqual({ replies: 0, by: 'index' })
  })
})

describe('replay note', () => {
  const base = { ...newRoute('chat', 'char'), enabled: true, route: ['a', 'b', 'c'] }
  test('Back onto a stage keeps its old entry (silent undo); Replay re-enters it', () => {
    const r3 = setStage(setStage(base, 1, 4, 'm3'), 2, 9, 'm8')
    const back = setStage(r3, 1, 12, 'm11')
    expect(back.enteredAt).toEqual([0, 4])          // stage 2's original entry survives: no note
    expect(anchorFor(back)).toBe('m3')
    expect(turnsInStage(12, 4)).toBeGreaterThan(0)
    const replayed = replayStage(back, 12, 'm11')
    expect(replayed.stageIndex).toBe(1)
    expect(replayed.enteredAt).toEqual([0, 12])     // fresh entry: note due again
    expect(anchorFor(replayed)).toBe('m11')
    expect(turnsInStage(12, 12)).toBe(0)
  })
  test('Replay on stage 1 or an empty route is a no-op; a missing anchor id clears the old one', () => {
    expect(replayStage(base, 12, 'm11')).toBe(base)
    const r2 = setStage(base, 1, 4, 'm3')
    const noId = replayStage(r2, 12, null)
    expect(noId.enteredAt).toEqual([0, 12])
    expect(noId.anchors).toBeUndefined()
  })
})

describe('skip note', () => {
  const base = { ...newRoute('chat', 'char'), enabled: true, route: ['a', 'b', 'c'] }
  test('skip marks the current entry; any pointer move or replay clears it; stage 1 ignores it', () => {
    const r2 = setStage(base, 1, 4, 'm3')
    const skipped = skipNote(r2)
    expect(skipped.skipNote).toBe(true)
    expect(skipped.stageIndex).toBe(1)
    expect(replayStage(skipped, 6, 'm5').skipNote).toBeUndefined()
    expect(setStage(skipped, 2, 6, 'm5').skipNote).toBeUndefined()
    expect(setStage(skipped, 0, 6, 'm5').skipNote).toBeUndefined()
    expect(skipNote(base).skipNote).toBeUndefined()
    expect(normalizeRoute({ ...skipped }, 'chat', 'char').skipNote).toBe(true)
    expect(normalizeRoute({ ...skipped, skipNote: 'yes' }, 'chat', 'char').skipNote).toBeUndefined()
  })
})

describe('stage anchors', () => {
  const base = { ...newRoute('chat', 'char'), route: ['a', 'b', 'c'] }
  test('Advance records the latest message id; Back drops it; re-entering records a new one', () => {
    const r1 = setStage(base, 1, 4, 'm3')
    expect(r1.anchors).toEqual({ '1': 'm3' })
    expect(anchorFor(r1)).toBe('m3')
    const r2 = setStage(r1, 2, 9, 'm8')
    expect(r2.anchors).toEqual({ '1': 'm3', '2': 'm8' })
    const back = setStage(r2, 1, 12, 'm11')
    expect(back.anchors).toEqual({ '1': 'm3' })
    expect(setStage(back, 2, 12, 'm11').anchors).toEqual({ '1': 'm3', '2': 'm11' })
    expect(setStage(base, 2, 4, 'm3').anchors).toEqual({ '1': 'm3', '2': 'm3' })
    expect(setStage(base, 1, 4, null).anchors).toBeUndefined()
  })
  test('normalizeRoute keeps well-formed anchors only', () => {
    const r = normalizeRoute({ ...base, anchors: { '1': 'm3', x: 'bad', '2': 7 } }, 'chat', 'char')
    expect(r.anchors).toEqual({ '1': 'm3' })
  })
})

describe('group partner rules', () => {
  const card2 = { ...card, scene: 'Behind the ranch house, {{char}} pours whiskey for {{user}}.', mood: 'Warm. {{user}} is teasing.' }
  test('group default: the partner line always appears, {{user}} by default', () => {
    const r = renderDirective('in-stage', card2, names, { group: true }).text
    expect(r).toContain('pours whiskey for Cherlene. This scene is between Wade and Cherlene. Mood:')
    expect(renderDirective('in-stage', card2, names).text).not.toContain('This scene is between')
  })
  test('group with another member named: {{user}} in the card becomes them', () => {
    const r = renderDirective('in-stage', { ...card2, with: 'Jake' }, names, { group: true }).text
    expect(r).toContain('pours whiskey for Jake. This scene is between Wade and Jake. Mood: Warm. Jake is teasing.')
    // Solo chats keep {{user}} as the user and add no partner line, even when the shared card names one.
    const solo = renderDirective('in-stage', { ...card2, with: 'Jake' }, names).text
    expect(solo).toContain('pours whiskey for Cherlene. Mood:')
    expect(solo).not.toContain('Jake')
  })
})
