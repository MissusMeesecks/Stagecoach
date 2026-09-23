import { describe, expect, test } from 'bun:test'
import { hashGreeting, normalizeGreeting, isValidHash } from './hash.ts'
import { chooseTier, highestHistoryIndex, countHistoryMessages, turnsInStage, reminderDue } from './tiers.ts'
import { renderDirective, substituteNames, truncateToChars, breakdownName, effectiveInstructions, TENSE_NOTE, DEFAULT_IN_STAGE_INSTRUCTIONS } from './templates.ts'
import { injectDirective, injectSystemAtDepth, appendToLastUser, wrapForAppend, type MessageLike } from './inject.ts'
import { matchGreeting, fuzzyScore, skeleton } from './opening.ts'
import { applyRoute, newRoute, normalizeRoute, setStage, depthFor, setDepth, setTransition, transitionFor, rewindTo, forkRoute } from './route.ts'
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
    expect(chooseTier({ stageIndex: 0, stageCount: 3, enteredAt: 0, currentIndex: 0 })).toBe('in-stage')
  })
  test('arrival for exactly one turn after advancing, then in-stage', () => {
    // Advance recorded at message count 10; user sends message index 10.
    expect(chooseTier({ stageIndex: 1, stageCount: 3, enteredAt: 10, currentIndex: 10 })).toBe('arrival')
    expect(chooseTier({ stageIndex: 1, stageCount: 3, enteredAt: 10, currentIndex: 11 })).toBe('arrival') // regenerate of that reply
    expect(chooseTier({ stageIndex: 1, stageCount: 3, enteredAt: 10, currentIndex: 12 })).toBe('in-stage')
    expect(chooseTier({ stageIndex: 1, stageCount: 3, enteredAt: 10, currentIndex: 14 })).toBe('in-stage')
    expect(turnsInStage(9, 10)).toBe(0)
  })
  test('reminderDue: one note per stage at arrival, never for stage 1', () => {
    // Stage 2 entered at 10. Turn 0 is arrival; nothing after that by default (every = 0).
    const at = (currentIndex: number, every = 0) => reminderDue({ stageIndex: 1, enteredAt: 10, currentIndex, every })
    expect(at(10)).toBe(true)   // turn 0, scene-change note
    expect(at(11)).toBe(true)   // a regenerate of that reply sees the same answer
    expect(at(12)).toBe(false)  // turn 1
    expect(at(14)).toBe(false)
    expect(at(40)).toBe(false)
    // Optional reminder (off by default): every 3 replies after arrival.
    expect(at(12, 3)).toBe(true)
    expect(at(14, 3)).toBe(false)
    expect(at(18, 3)).toBe(true)
    // Stage 1 never gets a note, whatever the settings.
    for (const i of [0, 1, 2, 6, 30]) {
      expect(reminderDue({ stageIndex: 0, enteredAt: 0, currentIndex: i, every: 0 })).toBe(false)
      expect(reminderDue({ stageIndex: 0, enteredAt: 0, currentIndex: i, every: 1 })).toBe(false)
    }
  })
  test('missing enteredAt degrades to in-stage', () => {
    expect(chooseTier({ stageIndex: 2, stageCount: 3, enteredAt: undefined, currentIndex: 50 })).toBe('in-stage')
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
    const r = injectDirective(msgs, 'D', 'append-to-last-user', 2)
    expect(r.appliedMode).toBe('system-at-depth')
    expect(r.injectedIndex).toBe(1)
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
