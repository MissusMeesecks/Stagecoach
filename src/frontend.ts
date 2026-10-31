// =============================================================================
// Stagecoach — Frontend (drawer tab)
// =============================================================================

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import type {
  BackendMessage,
  ChatRoute,
  FrontendMessage,
  GreetingInfo,
  InjectMode,
  PanelState,
  StageCard,
  TokenLimits,
} from './shared/types.ts'
import { DEFAULT_SETTINGS, HIGH_TOKEN_LIMITS, STANDARD_TOKEN_LIMITS, tokenLimitsFor } from './shared/types.ts'
import { chooseTier, turnsInStage, reminderDue } from './core/tiers.ts'
import { estimateTokens, effectiveInstructions, effectiveClosing, DEFAULT_IN_STAGE_INSTRUCTIONS, TENSE_NOTE, TRANSITION_STYLES } from './core/templates.ts'
import { previewNote, type NotePreview } from './core/preview.ts'
import { depthFor, MAX_DEPTH, transitionFor, reminderEveryFor } from './core/route.ts'
import { wrapForAppend } from './core/inject.ts'
import type { TransitionStyle } from './shared/types.ts'

/** Without these the panel cannot work at all. */
const CORE_PERMISSIONS = ['characters', 'chats', 'interceptor']
/** Asked for together at startup; generation is what Distill and the connection list need. */
const STARTUP_PERMISSIONS = [...CORE_PERMISSIONS, 'generation']
const LITERAL_NAMES = { char: '{{char}}', user: '{{user}}' }

const CSS = /* css */ `
  .sc-root { display: flex; flex-direction: column; gap: 12px; padding: 10px 12px; font-size: 13px; color: var(--lumiverse-text); overflow-y: auto; }
  .sc-root * { box-sizing: border-box; }
  .sc-section { border: 1px solid var(--lumiverse-border); border-radius: var(--lumiverse-radius); padding: 10px; background: var(--lumiverse-fill-subtle); }
  .sc-section-title { font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--lumiverse-text-muted); margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
  .sc-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .sc-row + .sc-row { margin-top: 6px; }
  .sc-spacer { flex: 1; }
  .sc-muted { color: var(--lumiverse-text-dim); font-size: 12px; }
  .sc-hint { color: var(--lumiverse-text-dim); font-size: 11px; margin-top: 2px; }
  /* Theme colours: the user's accent is --lumiverse-primary, with --lumiverse-primary-contrast legible on top of it (Lumiverse's own
     theme engine computes both, so custom themes carry over). Fallbacks are Lumiverse's defaults, for hosts that lack a variable. */
  .sc-notice { border: 1px solid var(--lumiverse-border); border-left: 3px solid var(--lumiverse-primary, rgba(147, 112, 219, 0.9)); padding: 6px 8px; border-radius: var(--lumiverse-radius); font-size: 12px; }
  .sc-notice.sc-error { border-left-color: var(--lumiverse-danger, #d9534f); }
  .sc-status { font-size: 12px; line-height: 1.4; }
  .sc-status strong { color: var(--lumiverse-text); }
  .sc-root button { background: var(--lumiverse-fill); color: var(--lumiverse-text-muted); border: 1px solid var(--lumiverse-border); border-radius: var(--lumiverse-radius); padding: 4px 10px; cursor: pointer; font-size: 12px; }
  .sc-root button:hover:not(:disabled) { border-color: var(--lumiverse-border-hover); color: var(--lumiverse-text); }
  .sc-root button:disabled { opacity: 0.5; cursor: default; }
  /* Filled like Lumiverse's own primary buttons (Button variant="primary"). The hover rule must restate the label colour,
     or the generic button hover above turns it to --lumiverse-text. */
  .sc-root button.sc-primary { background: var(--lumiverse-primary, rgba(147, 112, 219, 0.9)); border-color: var(--lumiverse-primary, rgba(147, 112, 219, 0.9)); color: var(--lumiverse-primary-contrast, #fff); }
  .sc-root button.sc-primary:hover:not(:disabled) { background: var(--lumiverse-primary-hover, rgba(167, 132, 239, 0.95)); border-color: var(--lumiverse-primary-hover, rgba(167, 132, 239, 0.95)); color: var(--lumiverse-primary-contrast, #fff); }
  .sc-root button.sc-icon { padding: 2px 6px; min-width: 26px; }
  .sc-root select, .sc-root input[type="text"], .sc-root input[type="number"], .sc-root textarea { background: var(--lumiverse-fill); color: var(--lumiverse-text); border: 1px solid var(--lumiverse-border); border-radius: var(--lumiverse-radius); padding: 4px 6px; font-size: 12px; font-family: inherit; }
  .sc-root select { max-width: 100%; }
  .sc-root textarea { width: 100%; resize: vertical; min-height: 44px; line-height: 1.35; }
  .sc-root input[type="text"] { width: 100%; }
  .sc-root input[type="checkbox"] { accent-color: var(--lumiverse-primary, rgba(147, 112, 219, 0.9)); }
  .sc-list { display: flex; flex-direction: column; gap: 6px; }
  .sc-item { border: 1px solid var(--lumiverse-border); border-radius: var(--lumiverse-radius); padding: 6px 8px; background: var(--lumiverse-fill); }
  .sc-item.sc-current { border-color: var(--lumiverse-primary, rgba(147, 112, 219, 0.9)); background: var(--lumiverse-primary-010, rgba(147, 112, 219, 0.1)); }
  .sc-item-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; }
  .sc-item-title { font-weight: 600; flex: 1 1 9em; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sc-item-controls { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 4px 6px; margin-left: auto; }
  .sc-item-badges, .sc-item-buttons { display: flex; align-items: center; gap: 6px; }
  .sc-item-badges { flex-wrap: wrap; justify-content: flex-end; }
  .sc-item-preview { color: var(--lumiverse-text-dim); font-size: 11px; margin-top: 3px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .sc-badge { font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--lumiverse-border); color: var(--lumiverse-text-muted); white-space: nowrap; }
  /* Accent-coloured text: --lumiverse-primary-text reads best on dark surfaces, the accent itself on light ones. */
  .sc-badge.sc-ok { border-color: var(--lumiverse-primary, rgba(147, 112, 219, 0.9)); color: var(--lumiverse-primary-text, rgba(186, 135, 255, 0.95)); }
  :root[data-theme-mode="light"] .sc-badge.sc-ok { color: color-mix(in srgb, var(--lumiverse-primary, rgba(147, 112, 219, 0.9)) 60%, var(--lumiverse-text)); }
  .sc-field { margin-top: 8px; }
  .sc-field label { display: block; font-weight: 600; font-size: 12px; margin-bottom: 2px; }
  .sc-preview { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; color: var(--lumiverse-text-muted); background: var(--lumiverse-fill); border: 1px dashed var(--lumiverse-border); border-radius: var(--lumiverse-radius); padding: 6px 8px; margin-top: 4px; }
  .sc-toggle { display: inline-flex; align-items: center; gap: 6px; }
  .sc-transition { margin-top: 5px; }
  .sc-transition select { font-size: 11px; padding: 2px 4px; }
  .sc-instructions { margin-top: 4px; }
  .sc-instructions .sc-field { margin-top: 4px; }
  .sc-group + .sc-group { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--lumiverse-border); }
  .sc-group-title { font-weight: 600; font-size: 12px; margin-bottom: 6px; }
  .sc-group-title .sc-muted { font-weight: 400; margin-left: 4px; }
  .sc-sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  .sc-nowrap { white-space: nowrap; }
  .sc-group-inline { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
  .sc-error-text { color: var(--lumiverse-danger, #d9534f); }
  .sc-preview.sc-dim { opacity: 0.6; }
  /* Trimming: the warning colour, bold, impossible to miss. */
  .sc-warning { margin-top: 6px; padding: 6px 8px; font-size: 12px; line-height: 1.4; color: var(--lumiverse-text); border: 1px solid var(--lumiverse-warning, #e0a030); border-left-width: 4px; border-radius: var(--lumiverse-radius); background: color-mix(in srgb, var(--lumiverse-warning, #e0a030) 14%, transparent); }
  .sc-warning strong { color: var(--lumiverse-warning, #e0a030); }
  /* Amber text on a light surface is faint: darken it toward the text colour there. */
  :root[data-theme-mode="light"] .sc-warning strong, :root[data-theme-mode="light"] .sc-warn-text, :root[data-theme-mode="light"] .sc-warn-line { color: color-mix(in srgb, var(--lumiverse-warning, #e0a030) 60%, var(--lumiverse-text)); }
  .sc-preview.sc-trimmed { border-style: solid; border-color: var(--lumiverse-warning, #e0a030); }
  .sc-warn-text { color: var(--lumiverse-warning, #e0a030); font-weight: 600; }
  .sc-warn-line { margin-top: 4px; font-size: 11px; font-weight: 600; color: var(--lumiverse-warning, #e0a030); }
  .sc-light { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--lumiverse-text-muted); }
  .sc-light::before { content: ''; flex: none; width: 10px; height: 10px; border-radius: 50%; background: var(--sc-light); box-shadow: 0 0 0 3px color-mix(in srgb, var(--sc-light) 25%, transparent); }
  .sc-light.sc-running { --sc-light: var(--lumiverse-danger, #d9534f); }
  .sc-light.sc-running::before { animation: sc-pulse 1.1s ease-in-out infinite; }
  .sc-light.sc-done { --sc-light: var(--lumiverse-success, #3fb950); }
  .sc-light.sc-failed { --sc-light: var(--lumiverse-warning, #e0a030); }
  @keyframes sc-pulse { 50% { opacity: 0.35; } }
  @media (prefers-reduced-motion: reduce) { .sc-light.sc-running::before { animation: none; } }
`

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="20" height="20"><path d="M2 5h3l1-2h8l1 2h3v2h-1l-1 8h-2a2 2 0 1 1-4 0H9a2 2 0 1 1-4 0H4L3 7H2V5zm5 1h6l-.5-1h-5L7 6z"/></svg>`

type EditorDraft = Omit<StageCard, 'hash' | 'updatedAt'> & { hash: string; dirtySinceDistill: boolean }

function greetingTitle(g: GreetingInfo): string {
  if (g.card?.label) return g.card.label
  if (g.index === 0) return 'First message'
  if (g.index > 0) return `Alternate greeting ${g.index}`
  return 'Card for a greeting no longer on this character'
}

function preview(text: string, max = 140): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** Global text settings edited under the card preview. */
type TextKey = 'closingLine' | 'inStageInstructions'

const TEXT_SETTINGS: Record<TextKey, { builtIn: string; effective: (text: string) => string; open: string; hide: string; title: string; hint: string }> = {
  closingLine: {
    builtIn: TENSE_NOTE,
    effective: effectiveClosing,
    open: 'Edit the closing line',
    hide: 'Hide the closing line',
    title: 'Change the last sentence of every scene-change note',
    hint: `The last sentence of every scene-change note, for every stage card in every chat. Blank means the original ("${TENSE_NOTE}"). Saved on its own when you click away; the card's Save and Cancel do not affect it.`,
  },
  inStageInstructions: {
    builtIn: DEFAULT_IN_STAGE_INSTRUCTIONS,
    effective: effectiveInstructions,
    open: 'Edit the reminder wording',
    hide: 'Hide the reminder wording',
    title: 'Change the standing wording of the in-stage reminder',
    hint: 'Ends the in-stage reminder, which only chats where an older version switched reminders on still send. Applies wherever it is used. Blank means the original. Saved on its own when you click away; the card\'s Save and Cancel do not affect it.',
  },
}

/** Only scene, mood and the scene partner reach the prompt, so only they count. */
function cardTokens(c: Pick<StageCard, 'scene' | 'mood' | 'with'>): string {
  return [c.scene, c.mood, c.with ?? ''].join(' ')
}

export function setup(ctx: SpindleFrontendContext) {
  const cleanups: Array<() => void> = []
  cleanups.push(ctx.dom.addStyle(CSS))

  let state: PanelState | null = null
  let chatId: string | null = null
  let editing: EditorDraft | null = null
  let editingNew = false
  /** The chat the editor was opened on. A card editor never outlives its chat. */
  let editingChatId: string | null = null
  /** The draft's fields as opened, to tell whether closing it loses anything. */
  let editingOriginal = ''
  /** The editor was opened on a greeting that is on a character right now (not an orphaned card or an unknown hash). */
  let editingLive = false
  /** The last chat a state was shown for. The home screen (no chat) in between does not count as a change. */
  let lastChatId: string | null = null
  /** Distill status per greeting hash. Several cards may distill at once; the light reads this. */
  /** runId names the press that set it; replies carry it back, so a stale reply (given up on, or superseded) is ignored. */
  const distillStatus = new Map<string, { state: 'running' | 'done' | 'failed'; error?: string; runId?: string }>()
  let distillRuns = 0
  /** Gives up on a Distill that never answers (worker restart, lost message), so its card can try again. */
  const distillTimers = new Map<string, ReturnType<typeof setTimeout>>()
  type Notice = { kind: 'info' | 'error'; text: string }
  let notice: Notice | null = null
  let tokenRequestId = 0
  let tokenLabel: HTMLElement | null = null
  let tokenTimer: ReturnType<typeof setTimeout> | null = null
  /** The text-setting editors under the preview (closing line; legacy reminder wording): open state and unsaved text (null = the saved value). Global settings, so they survive chat changes. */
  const textOpen: Partial<Record<TextKey, boolean>> = {}
  const textDraft: Partial<Record<TextKey, string | null>> = {}
  /** Unsaved digits in the depth box, kept across rebuilds. */
  let depthDraft: string | null = null

  const tab = ctx.ui.registerDrawerTab({
    id: 'stagecoach',
    title: 'Stagecoach',
    shortName: 'Stages',
    headerTitle: 'Stagecoach',
    description: 'Steer the story through greetings as ordered stages',
    keywords: ['stage', 'greeting', 'story', 'arc', 'pacing', 'stagecoach'],
    iconSvg: ICON,
  })
  cleanups.push(() => tab.destroy())
  const root = tab.root
  root.classList.add('sc-root')
  // One live region for the whole panel, kept across renders: a region rebuilt with its text already
  // in place is either not announced or announced again on every unrelated render.
  const announcer = document.createElement('div')
  announcer.className = 'sc-sr-only'
  announcer.setAttribute('role', 'status')
  root.appendChild(announcer)
  cleanups.push(() => { for (const t of distillTimers.values()) clearTimeout(t) })

  function announce(text: string): void {
    // Cleared first so the same words twice in a row (two failures) are still read out.
    announcer.textContent = ''
    setTimeout(() => { announcer.textContent = text }, 50)
  }

  /** The backend gives up on a Distill call after 120 s; past this, no answer is coming. */
  const DISTILL_NO_REPLY_MS = 130_000

  function setDistill(hash: string, next: 'running' | 'done' | 'failed', opts: { error?: string; runId?: string } = {}): void {
    const timer = distillTimers.get(hash)
    if (timer) { clearTimeout(timer); distillTimers.delete(hash) }
    const prev = distillStatus.get(hash)?.state
    distillStatus.set(hash, { state: next, error: opts.error, runId: opts.runId })
    // Read out changes only; every failure counts as one.
    if (editing?.hash === hash && (prev !== next || next === 'failed')) {
      announce(next === 'running' ? 'Distill running' : next === 'done' ? 'Distill done. Read the fields over, then Save.' : opts.error ?? 'Distill failed')
    }
  }

  /** Started when the call goes out, not before the permission prompt (which can sit open as long as it likes). */
  function armNoReplyTimer(hash: string, runId: string): void {
    distillTimers.set(hash, setTimeout(() => {
      distillTimers.delete(hash)
      const cur = distillStatus.get(hash)
      if (cur?.state !== 'running' || cur.runId !== runId) return
      setDistill(hash, 'failed', { error: 'Distill got no reply after two minutes. Try again, or pick another model under Settings.' })
      render()
    }, DISTILL_NO_REPLY_MS))
  }

  /** A reply belongs to the run it names, and only while that run is still the running one. */
  function isCurrentRun(hash: string, runId: string | undefined): boolean {
    const cur = distillStatus.get(hash)
    return cur?.state === 'running' && (runId === undefined || cur.runId === runId)
  }

  function send(message: FrontendMessage): void {
    ctx.sendToBackend(message)
  }

  /** Budgets for the current "Higher token limit" setting. */
  function limits(): TokenLimits {
    return tokenLimitsFor(state?.settings ?? DEFAULT_SETTINGS)
  }

  function tokenText(tokens: number, approximate: boolean, suffix = ''): string {
    const l = limits()
    return `Card: ${approximate ? '~' : ''}${tokens} tokens${suffix} · target ${l.cardTarget} · cap ${l.cardCap}`
  }

  function activeChatId(): string | null {
    try { return ctx.getActiveChat().chatId } catch { return null }
  }

  function messageCount(): number {
    try { return ctx.messages.listMessageIds().length } catch { return 0 }
  }

  /** Panel-side view of whether the next reply gets the scene-change note. Same estimate the status line uses. */
  function noteArmed(route: ChatRoute): boolean {
    if (route.stageIndex <= 0 || route.skipNote) return false
    const entered = route.enteredAt[route.stageIndex]
    const turns = entered === undefined ? 0 : turnsInStage(messageCount(), entered)
    return reminderDue({ stageIndex: route.stageIndex, replies: turns, every: reminderEveryFor(route) })
  }

  /** Anchor for "first reply after Advance": the interceptor counts replies after this message. */
  function latestMessageId(): string | null {
    try { return ctx.messages.getLatestMessageId() } catch { return null }
  }

  /** Text of the chat's first message, for matching the greeting it opened with. Optional host APIs; null when unavailable. */
  /**
   * Text of the chat's first message, for matching the greeting it opened with.
   * Tries the host's optional messages API, then the mounted message bubble in
   * the DOM (present on a fresh chat, which is when detection matters most).
   */
  async function openingText(): Promise<{ text: string | null; probe: string; candidates: string[] }> {
    // Every reading of the first message is sent and the backend tries them all: the default
    // greeting can be a synthetic row that the message list and the mounted bubbles disagree on.
    const candidates: string[] = []
    try {
      const id = ctx.messages.getMessageIdAtIndex(0)
      let probe = 'no-first-message'
      if (id) {
        if (ctx.messages.get) {
          const m = await ctx.messages.get(id).catch(() => null)
          if (m) {
            // A user turn at index 0 means the greeting was not in the list; the topmost bubble is still checked below.
            if (m.is_user) probe = 'first-message-is-yours'
            const active = m.is_user ? null : typeof m.content === 'string' && m.content
              ? m.content
              : Array.isArray(m.swipes) ? m.swipes[m.swipe_id ?? 0] ?? null : null
            if (active) { candidates.push(active); probe = 'ok' }
          }
        }
        const bubble = probe === 'first-message-is-yours' ? null : ctx.dom.findMessageElement(id)
        const text = bubble?.textContent?.trim() ?? ''
        if (text.length > 0) { candidates.push(text); if (probe === 'no-first-message') probe = 'ok-dom' }
        else if (probe === 'no-first-message') probe = 'first-message-not-on-screen'
      }
      // The topmost mounted bubble, when it is not the one the message list calls index 0.
      try {
        const top = ctx.dom.listMessageElements()[0]
        if (top && top.messageId !== id) {
          const text = top.element.textContent?.trim() ?? ''
          if (text.length > 0) { candidates.push(text); if (candidates.length === 1) probe = 'ok-dom-top' }
        }
      } catch { /* optional host API */ }
      return { text: candidates[0] ?? null, probe, candidates: candidates.slice(1) }
    } catch (err) {
      return { text: candidates[0] ?? null, probe: `error: ${err instanceof Error ? err.message : String(err)}`, candidates: candidates.slice(1) }
    }
  }

  let probeRun = 0
  function requestState(): void {
    chatId = activeChatId()
    const forChat = chatId
    const run = ++probeRun
    void openingText().then(({ text, probe, candidates }) => {
      if (chatId !== forChat || run !== probeRun) return
      send({ type: 'get_state', chatId: forChat, openingText: text, openingProbe: probe, openingCandidates: candidates })
      if (text || !forChat) return
      // On a fresh chat the first bubble is not mounted yet when CHAT_SWITCHED fires. Try again a few times.
      for (const delay of [600, 1500, 3500]) {
        setTimeout(() => {
          if (chatId !== forChat || run !== probeRun) return
          void openingText().then((again) => {
            if (!again.text || chatId !== forChat || run !== probeRun) return
            probeRun++
            send({ type: 'get_state', chatId: forChat, openingText: again.text, openingProbe: again.probe, openingCandidates: again.candidates })
          })
        }, delay)
      }
    })
  }

  function syncCount(): void {
    const id = activeChatId()
    if (!id) return
    send({ type: 'sync_count', chatId: id, messageCount: messageCount() })
  }

  function setNotice(kind: 'info' | 'error', text: string): void {
    notice = { kind, text }
    render()
  }

  // ---- Permissions -----------------------------------------------------------
  // A fresh install is asked for all four at once. The prompt comes back only while a core
  // permission is missing, so someone who declined generation is not asked on every load;
  // Distill and "List connections" still ask for it (ensureGeneration).
  ctx.permissions.getGranted().then((granted) => {
    if (CORE_PERMISSIONS.every((p) => granted.includes(p))) return
    const missing = STARTUP_PERMISSIONS.filter((p) => !granted.includes(p))
    const withGeneration = missing.includes('generation')
    return ctx.ui.showConfirm({
      title: 'Stagecoach needs permissions',
      message: 'Stagecoach reads your characters\' greetings and the open chat, and adds a short scene note to the prompt when you move to the next stage. It never edits your character cards.'
        + (withGeneration ? ' The Distill button also makes one small AI call to draft a stage card, only when you press it.' : '')
        + ` Permissions: ${missing.join(', ')}. Lumiverse will ask you to confirm next.`,
      variant: 'info',
      confirmLabel: 'Continue',
      cancelLabel: 'Not now',
    }).then(({ confirmed }) => {
      if (!confirmed) return
      return ctx.permissions.request(missing, { reason: 'Read character greetings and the open chat, add the current stage to the prompt' + (withGeneration ? ', and run Distill when you press it.' : '.') })
        .then(() => requestState())
        // The host's prompt is all or nothing. Someone who refused it over the AI calls can still have the rest.
        .catch(() => withGeneration ? offerWithoutDistill(missing.filter((p) => p !== 'generation')) : undefined)
    })
  }).catch(() => undefined)

  async function offerWithoutDistill(core: string[]): Promise<void> {
    const { confirmed } = await ctx.ui.showConfirm({
      title: 'Use Stagecoach without Distill?',
      message: 'Stagecoach can steer your story without making AI calls of its own. Only the Distill button needs that, and it will ask again if you press it.',
      variant: 'info',
      confirmLabel: 'Continue without Distill',
      cancelLabel: 'Not now',
    })
    if (!confirmed) return
    await ctx.permissions.request(core, { reason: 'Read character greetings and the open chat, and add the current stage to the prompt.' })
    requestState()
  }

  async function ensureGeneration(): Promise<boolean> {
    const granted = await ctx.permissions.getGranted()
    if (granted.includes('generation')) return true
    try {
      const next = await ctx.permissions.request(['generation'], { reason: 'Distill runs one small LLM call per greeting on a connection you choose.' })
      return next.includes('generation')
    } catch {
      return false
    }
  }

  // ---- Backend messages ------------------------------------------------------
  cleanups.push(ctx.onBackendMessage((payload: unknown) => {
    const msg = payload as BackendMessage
    if (!msg || typeof msg !== 'object') return
    switch (msg.type) {
      case 'state': {
        // Ignore stale answers for a chat we already left.
        if (msg.state.chatId !== chatId && msg.state.chatId !== null) return
        state = msg.state
        // The home screen (no chat) is not a change of chat: going A -> home -> A keeps an open draft,
        // which render() simply does not show while no chat is open.
        const shown = state.chatId
        const chatChanged = shown !== null && lastChatId !== null && shown !== lastChatId
        if (shown !== null) lastChatId = shown
        // Notices belong to the chat being left, and the home screen has none. So does a half-typed depth (a per-chat setting);
        // the text-editor drafts are global settings and stay.
        if (chatChanged || shown === null) notice = null
        if (chatChanged) depthDraft = null
        if (editing && shown !== null) {
          const otherChat = editingChatId !== shown
          // A live greeting that is no longer on any of the chat's characters (its text was edited, or its member left a group)
          // takes its editor with it. A state that failed to load greetings says nothing about that, so it is not counted.
          const vanished = editingLive && !state.error && !state.greetings.some((x) => x.hash === editing!.hash && x.index >= 0)
          if (otherChat || vanished) {
            const lost = draftChanged()
            closeEditor()
            if (lost) notice = { kind: 'info', text: otherChat
              ? 'The chat changed, so the stage card you were editing was closed without saving.'
              : 'The greeting that stage card belongs to is no longer on this chat\'s characters (edited or removed), so the card editor was closed without saving.' }
          }
        }
        render()
        break
      }
      case 'distill_result': {
        // A run the panel gave up on, or replaced with a retry, must not overwrite what was typed since.
        if (!isCurrentRun(msg.hash, msg.runId)) break
        setDistill(msg.hash, 'done')
        if (editing && editing.hash === msg.hash) editing = { ...editing, ...msg.card, source: 'llm', dirtySinceDistill: false }
        render()
        break
      }
      case 'distill_error':
        // Shown under the Distill row of that card's editor, where it is on screen. A card that is not open shows nothing (reopening starts fresh).
        if (!isCurrentRun(msg.hash, msg.runId)) break
        setDistill(msg.hash, 'failed', { error: `Distill failed: ${msg.message}` })
        render()
        break
      case 'token_count':
        if (msg.requestId === String(tokenRequestId) && tokenLabel) {
          tokenLabel.textContent = tokenText(msg.tokens, msg.approximate)
          tokenLabel.style.color = msg.tokens > limits().cardCap ? 'var(--lumiverse-danger, #d9534f)' : ''
        }
        break
      case 'error':
        setNotice('error', msg.message)
        break
    }
  }))

  // MESSAGE_SWIPED: swiping the first message changes which greeting the chat opened with.
  for (const eventName of ['CHAT_SWITCHED', 'CHAT_CHANGED', 'CHARACTER_EDITED', 'PERMISSION_CHANGED', 'MESSAGE_SWIPED']) {
    cleanups.push(ctx.events.on(eventName, () => setTimeout(requestState, 0)))
  }
  // Deleting back past a stage change rewinds the pointer. Give the host a beat to settle the message list first.
  cleanups.push(ctx.events.on('MESSAGE_DELETED', () => setTimeout(() => { syncCount(); requestState() }, 200)))
  cleanups.push(tab.onActivate(requestState))

  // ---- Rendering helpers -----------------------------------------------------
  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  /**
   * A route or greeting row's head: the title, then its badges and buttons as one cluster. The title keeps about 9em;
   * when the row is too narrow for that and the cluster, the whole cluster wraps under the title (right-aligned, so the
   * buttons line up with rows that fit), instead of squeezing the title or leaving a button on a line of its own. On a
   * narrower panel the buttons wrap under the badges, still together; only badges ever wrap among themselves.
   */
  function itemHead(title: string, badges: HTMLElement[], buttons: HTMLElement[]): HTMLElement {
    const head = el('div', 'sc-item-head')
    const t = el('span', 'sc-item-title', title)
    t.title = title
    const group = (className: string, items: HTMLElement[]) => { const g = el('span', className); g.append(...items); return g }
    const controls = group('sc-item-controls', [group('sc-item-badges', badges), group('sc-item-buttons', buttons)])
    head.append(t, controls)
    return head
  }

  function button(label: string, onClick: () => void, opts: { primary?: boolean; icon?: boolean; disabled?: boolean; title?: string } = {}): HTMLButtonElement {
    const b = el('button', [opts.primary ? 'sc-primary' : '', opts.icon ? 'sc-icon' : ''].filter(Boolean).join(' '), label)
    b.type = 'button'
    b.disabled = opts.disabled === true
    if (opts.title) b.title = opts.title
    b.addEventListener('click', onClick)
    return b
  }

  function section(title: string): { box: HTMLElement; head: HTMLElement } {
    const box = el('div', 'sc-section')
    const head = el('div', 'sc-section-title', title)
    box.appendChild(head)
    return { box, head }
  }

  function requestTokenCount(): void {
    if (!editing || !tokenLabel) return
    const text = cardTokens(editing)
    tokenLabel.textContent = tokenText(estimateTokens(text), true, ' (estimate)')
    if (tokenTimer) clearTimeout(tokenTimer)
    tokenTimer = setTimeout(() => {
      tokenRequestId += 1
      send({ type: 'count_tokens', requestId: String(tokenRequestId), text })
    }, 400)
  }

  // ---- Render ----------------------------------------------------------------
  /**
   * True while render() rebuilds the panel. Removing a focused field fires blur and change on it, and that must not
   * count as the user leaving it: no save, and the draft carries over to the rebuilt field.
   */
  let rendering = false

  // A rebuild between mousedown and mouseup replaces the button under the pointer and the click never fires (a blur that
  // saves, and the backend's reply, can land in that gap). While a pointer is down in the panel, rebuilds wait for it.
  // The release can go missing (pressed on a dropdown and released inside its popup), so a value picked in the panel also
  // ends the press, and a press held past HELD_PRESS_MS stops holding rebuilds back.
  const HELD_PRESS_MS = 1000
  let pointerDown = false
  let renderPending = false
  let pressTimer: ReturnType<typeof setTimeout> | null = null
  root.addEventListener('pointerdown', () => {
    pointerDown = true
    if (pressTimer) clearTimeout(pressTimer)
    pressTimer = setTimeout(pointerReleased, HELD_PRESS_MS)
  }, true)
  function pointerReleased(): void {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null }
    if (!pointerDown) return
    pointerDown = false
    // After this task, so the click (dispatched in the same task as pointerup) lands on the button first.
    if (renderPending) setTimeout(() => { if (renderPending) render() }, 0)
  }
  document.addEventListener('pointerup', pointerReleased, true)
  document.addEventListener('pointercancel', pointerReleased, true)
  root.addEventListener('change', pointerReleased, true)
  cleanups.push(() => {
    if (pressTimer) clearTimeout(pressTimer)
    document.removeEventListener('pointerup', pointerReleased, true)
    document.removeEventListener('pointercancel', pointerReleased, true)
  })

  /** The notice and the state error last brought into view, so each is scrolled to once and the panel does not keep jumping to it. */
  let revealedNotice: Notice | null = null
  let revealedError = ''

  /**
   * Notices are drawn at the top of the panel and render() keeps the scroll position, so a new notice or state error is
   * brought into view once. A notice counts as new even with the same words as the last (a retry that fails again), and
   * one going away never scrolls. Not while a text field is being typed in: the next keystroke would scroll back to the
   * caret and the notice out of view again, so it waits for the next render with no text field focused.
   */
  function revealNotice(typing: boolean): void {
    const errorEl = root.querySelector('.sc-state-error')
    const error = errorEl?.textContent ?? ''
    if (!error) revealedError = ''
    const newNotice = notice !== null && notice !== revealedNotice
    const newError = error !== '' && error !== revealedError
    if (!(newNotice || newError) || typing) return
    const target = newNotice ? root.querySelector('.sc-panel-notice') : errorEl
    target?.scrollIntoView({ block: 'nearest' })
    revealedNotice = notice
    revealedError = error
  }

  /**
   * Rebuild the panel, keeping the focused field (marked data-focus-key) focused across the rebuild: text fields with
   * their caret when their text is unchanged (when a Distill result replaced it, focus is dropped rather than leaving the
   * caret at a stale offset inside the new text); the Way in pickers even when their value changed (a select has no caret).
   */
  function render(): void {
    if (pointerDown) { renderPending = true; return }
    renderPending = false
    const active = document.activeElement
    const focusKey = active instanceof HTMLElement && root.contains(active) ? active.dataset.focusKey ?? null : null
    const field = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : null
    const before = field?.value ?? null
    let caret: [number | null, number | null] = [null, null]
    if (focusKey && field) { try { caret = [field.selectionStart, field.selectionEnd] } catch { /* input types without a caret */ } }
    // Removing the focused element mid-rebuild (a clicked button keeps focus) makes the browser lay out the half-emptied
    // panel, which clamps whatever scrolls it (the panel itself or a host container) towards the top, and nothing scrolls it
    // back. Remember every scroll position on the way up and put them back after the rebuild.
    const scrolled: Array<[Element, number]> = []
    for (let n: Element | null = root; n; n = n.parentElement) if (n.scrollTop > 0) scrolled.push([n, n.scrollTop])
    const page = document.scrollingElement
    if (page && page.scrollTop > 0 && !scrolled.some(([n]) => n === page)) scrolled.push([page, page.scrollTop])
    rendering = true
    try { renderPanel() } finally { rendering = false }
    for (const [n, top] of scrolled) n.scrollTop = top
    const again = focusKey ? root.querySelector(`[data-focus-key="${focusKey}"]`) : null
    const typing = (again instanceof HTMLInputElement || again instanceof HTMLTextAreaElement) && again.value === before ? again : null
    revealNotice(typing !== null)
    if (again instanceof HTMLSelectElement) { again.focus({ preventScroll: true }); return }
    if (!typing) return
    typing.focus({ preventScroll: true })
    if (caret[0] !== null && caret[1] !== null) { try { typing.setSelectionRange(caret[0], caret[1]) } catch { /* no caret */ } }
  }

  function renderPanel(): void {
    for (const node of [...root.childNodes]) if (node !== announcer) node.remove()
    tokenLabel = null

    if (notice) {
      const n = el('div', `sc-notice sc-panel-notice${notice.kind === 'error' ? ' sc-error' : ''}`, notice.text)
      const close = button('×', () => { notice = null; render() }, { icon: true })
      close.style.float = 'right'
      n.prepend(close)
      root.appendChild(n)
    }

    if (!state) {
      root.appendChild(el('div', 'sc-muted', 'Loading…'))
      return
    }
    if (!state.chatId) {
      root.appendChild(el('div', 'sc-muted', 'Open a chat to set up its stages.'))
      renderSettings(null)
      tab.setBadge(null)
      return
    }
    if (state.error) {
      root.appendChild(el('div', 'sc-notice sc-error sc-state-error', state.error))
    }

    const route = state.route
    const stages = route ? route.route.map((h) => state!.greetings.find((g) => g.hash === h) ?? null) : []
    const enabled = route?.enabled === true

    renderHeader(enabled)
    renderStatus(route, stages)
    renderPointer(route, stages)
    renderRoute(route, stages)
    if (editing) renderEditor()
    renderSettings(route)

    root.appendChild(el('div', 'sc-hint', 'Stagecoach never writes to character cards. Everything lives in your own extension storage.'))
    tab.setBadge(enabled && route && route.route.length > 0 ? `${route.stageIndex + 1}/${route.route.length}` : null)
  }

  function renderHeader(enabled: boolean): void {
    const title = state!.isGroup && state!.members
      ? `Stagecoach · group: ${state!.members.map((m) => m.name).join(', ')}`
      : state!.characterName ? `Stagecoach · ${state!.characterName}` : 'Stagecoach'
    const { box } = section(title)
    const row = el('div', 'sc-row')
    const toggle = el('label', 'sc-toggle')
    const cb = el('input')
    cb.type = 'checkbox'
    cb.checked = enabled
    cb.addEventListener('change', () => send({ type: 'set_enabled', chatId: state!.chatId!, enabled: cb.checked, messageCount: messageCount() }))
    toggle.append(cb, document.createTextNode('Enabled for this chat'))
    row.appendChild(toggle)
    row.appendChild(el('span', 'sc-spacer'))
    row.appendChild(button('⟳', requestState, { icon: true, title: 'Refresh' }))
    box.appendChild(row)
    root.appendChild(box)
  }

  function renderStatus(route: ChatRoute | null, stages: Array<GreetingInfo | null>): void {
    const status = el('div', 'sc-status')
    if (!route || route.route.length === 0) {
      status.textContent = 'No stages selected yet. Add greetings to the route below, in the order the story should move through them.'
    } else {
      const current = stages[route.stageIndex]
      const count = messageCount()
      const entered = route.enteredAt[route.stageIndex]
      // The panel cannot see message roles, so it estimates replies since entry from the count.
      const turns = entered === undefined ? 0 : turnsInStage(count, entered)
      const tier = chooseTier({ stageIndex: route.stageIndex, stageCount: route.route.length, enteredAt: entered, replies: turns })
      const due = !route.skipNote && reminderDue({ stageIndex: route.stageIndex, replies: turns, every: reminderEveryFor(route) })
      const noteLabel = due ? (tier === 'arrival' ? 'scene-change note' : 'in-stage note') : 'no note'
      const isFinal = route.stageIndex >= route.route.length - 1
      const noteDetail = route.stageIndex === 0
        ? (isFinal ? ' (stage 1 is where the chat opened; add more stages to steer)' : ' (stage 1 is where the chat opened; nothing to steer yet)')
        : due ? '' : route.skipNote ? ' (skipped for this stage)' : isFinal ? ` (final stage; the story is on its own from here)` : ` (turn ${turns} in this stage; press Advance when the scene feels finished)`
      const missingCard = current && !current.card
      status.innerHTML = ''
      status.append(
        document.createTextNode('Stage '),
        Object.assign(el('strong'), { textContent: `${route.stageIndex + 1}/${route.route.length}` }),
        document.createTextNode(` · ${current ? greetingTitle(current) : 'unknown greeting'} · next reply: `),
        Object.assign(el('strong'), { textContent: noteLabel }),
        document.createTextNode(noteDetail),
      )
      if (!route.enabled) status.append(el('div', 'sc-hint', 'Disabled: nothing is injected until you enable it above.'))
      if (missingCard) status.append(el('div', 'sc-hint', 'This stage has no card yet, so nothing is injected. Edit it below and press Distill or fill it in by hand.'))
    }
    root.appendChild(status)
  }

  function renderPointer(route: ChatRoute | null, stages: Array<GreetingInfo | null>): void {
    if (!route || route.route.length === 0) return
    const { box } = section('Current stage')
    const row = el('div', 'sc-row')
    const sel = el('select')
    stages.forEach((g, i) => {
      const opt = el('option', undefined, `${i + 1}. ${g ? greetingTitle(g) : 'unknown'}`)
      opt.value = String(i)
      if (i === route.stageIndex) opt.selected = true
      sel.appendChild(opt)
    })
    sel.addEventListener('change', () => send({ type: 'set_stage', chatId: state!.chatId!, stageIndex: Number(sel.value), messageCount: messageCount(), latestMessageId: latestMessageId() }))
    row.appendChild(sel)
    // Moving the pointer while the extension is off records an entry that never fires; keep the controls locked until it is on.
    sel.disabled = !route.enabled
    row.appendChild(button('◀ Back', () => send({ type: 'set_stage', chatId: state!.chatId!, stageIndex: route.stageIndex - 1, messageCount: messageCount(), latestMessageId: latestMessageId() }), { disabled: !route.enabled || route.stageIndex <= 0, title: route.enabled ? undefined : 'Enable Stagecoach for this chat first' }))
    row.appendChild(button('Advance ▶', () => send({ type: 'set_stage', chatId: state!.chatId!, stageIndex: route.stageIndex + 1, messageCount: messageCount(), latestMessageId: latestMessageId() }), { primary: true, disabled: !route.enabled || route.stageIndex >= route.route.length - 1, title: route.enabled ? undefined : 'Enable Stagecoach for this chat first' }))
    // The note is a separate control from the pointer: one button that reads the current state and offers the opposite.
    const armed = noteArmed(route)
    row.appendChild(button(armed ? '✕ Skip this note' : '↻ Send scene note', () => send({ type: 'set_note', chatId: state!.chatId!, armed: !armed, messageCount: messageCount(), latestMessageId: latestMessageId() }), {
      disabled: !route.enabled || route.stageIndex <= 0,
      title: route.stageIndex <= 0 ? 'Stage 1 never gets a note: the chat opened with it' : armed ? 'Move on without the scene-change note for this stage' : 'Send this stage\'s scene-change note on the next reply',
    }))
    if (!route.enabled) box.appendChild(el('div', 'sc-hint', 'Stagecoach is off for this chat. Tick "Enabled for this chat" at the top to move between stages.'))
    box.appendChild(row)
    box.appendChild(el('div', 'sc-hint', route.stageIndex >= route.route.length - 1
      ? 'This is the last stage in the route. Add another greeting below if the story should go further.'
      : 'Advance when the current scene feels finished: the next reply, and only that one, gets a scene-change note using the "Way in" chosen for the new stage. Back moves without sending anything. The note button skips a note you do not want, or sends the current stage\'s note again. Stage 1 never gets a note: the chat opened with it.'))
    root.appendChild(box)
  }

  /** The "Way in" picker for a stage on this chat's route: shown in the route list and again in that stage's card editor. */
  function wayInRow(route: ChatRoute, hash: string, where: 'route' | 'editor'): HTMLElement {
    const trow = el('div', 'sc-row sc-transition')
    trow.appendChild(el('span', 'sc-muted', 'Way in:'))
    const tsel = el('select')
    tsel.dataset.focusKey = `wayin:${where}:${hash}`
    const current = transitionFor(route, hash)
    for (const t of TRANSITION_STYLES) {
      const opt = el('option', undefined, t.label)
      opt.value = t.value
      opt.title = t.hint
      if (t.value === current) opt.selected = true
      tsel.appendChild(opt)
    }
    tsel.title = TRANSITION_STYLES.find((t) => t.value === current)?.hint ?? ''
    tsel.addEventListener('change', () => send({ type: 'set_transition', chatId: state!.chatId!, hash, style: tsel.value as TransitionStyle }))
    trow.appendChild(tsel)
    return trow
  }

  /** The saved card's scene-change note is cut to fit the cap (names as written, like the editor's preview). */
  function noteTrimmed(card: StageCard, route: ChatRoute): boolean {
    const p = previewNote({ card, route, settings: state!.settings, group: state!.isGroup === true, names: LITERAL_NAMES })
    return p.placement === 'sent' && (p.arrival?.truncated === true || p.reminder?.note.truncated === true)
  }

  function renderRoute(route: ChatRoute | null, stages: Array<GreetingInfo | null>): void {
    const { box, head } = section('Route')
    head.appendChild(el('span', 'sc-muted', 'stages in story order'))
    const list = el('div', 'sc-list')
    const hashes = route ? [...route.route] : []

    const commit = (next: string[]) => send({ type: 'set_route', chatId: state!.chatId!, route: next, messageCount: messageCount() })

    if (state!.openingStatus && state!.openingStatus !== 'matched') {
      box.appendChild(el('div', 'sc-hint', state!.openingStatus === 'first-message-not-on-screen'
        ? 'Opening greeting not detected: scroll the chat to its first message and refresh (⟳).'
        : state!.openingStatus === 'no-match' && state!.openingSample
          ? `Opening greeting not detected: the first message reads "${state!.openingSample}" and no greeting on this card matches it.`
          : `Opening greeting not detected (${state!.openingStatus}).`))
    }
    if (state!.isGroup && state!.members) {
      box.appendChild(el('div', 'sc-hint', `Group chat: ${state!.members.map((m) => m.name).join(', ')}. Greetings from every member are listed; the badge shows whose card each is, and {{char}} on that card means them.`))
    }
    const opening = state!.openingHash ? state!.greetings.find((g) => g.hash === state!.openingHash) ?? null : null
    if (opening && hashes[0] !== opening.hash) {
      const n = el('div', 'sc-notice')
      n.appendChild(el('span', undefined, `This chat opened with "${greetingTitle(opening)}". `))
      n.appendChild(button('Make it stage 1', () => commit([opening.hash, ...hashes.filter((h) => h !== opening.hash)]), { primary: true }))
      box.appendChild(n)
    }

    /** Whose card it is (groups), where the chat opened, and whether it has a card. */
    const greetingBadges = (g: GreetingInfo | null): HTMLElement[] => [
      ...(state!.isGroup && g?.characterName ? [el('span', 'sc-badge', g.characterName)] : []),
      ...(g && g.hash === state!.openingHash ? [el('span', 'sc-badge', 'chat opened here')] : []),
      el('span', `sc-badge${g?.card ? ' sc-ok' : ''}`, g?.card ? 'card ready' : 'no card'),
    ]

    if (hashes.length === 0) list.appendChild(el('div', 'sc-muted', 'Empty. Add greetings from the list below.'))
    stages.forEach((g, i) => {
      const item = el('div', `sc-item${route && i === route.stageIndex ? ' sc-current' : ''}`)
      item.appendChild(itemHead(`${i + 1}. ${g ? greetingTitle(g) : 'unknown greeting'}`, greetingBadges(g), [
        button('▲', () => { const n = [...hashes]; [n[i - 1], n[i]] = [n[i]!, n[i - 1]!]; commit(n) }, { icon: true, disabled: i === 0, title: 'Move up' }),
        button('▼', () => { const n = [...hashes]; [n[i + 1], n[i]] = [n[i]!, n[i + 1]!]; commit(n) }, { icon: true, disabled: i === hashes.length - 1, title: 'Move down' }),
        button('Edit', () => openEditor(g, hashes[i]!)),
        button('✕', () => commit(hashes.filter((_, j) => j !== i)), { icon: true, title: 'Remove from route' }),
      ]))
      if (g?.text) item.appendChild(el('div', 'sc-item-preview', preview(g.text)))
      // On its own line: the head row has no room to spare, and a badge there would look like "card ready" on amber themes.
      if (i > 0 && route && g?.card && noteTrimmed(g.card, route)) {
        const warn = el('div', 'sc-warn-line', `⚠ Note trimmed: over the ~${limits().directive}-token cap, so part of it is cut before sending.`)
        warn.title = 'Counted with {{char}} and {{user}} as written; long names can push a note that is close to the cap over it. Open Edit to see what is cut.'
        item.appendChild(warn)
      }
      if (i > 0 && route) item.appendChild(wayInRow(route, hashes[i]!, 'route'))
      list.appendChild(item)
    })
    box.appendChild(list)

    const available = state!.greetings.filter((g) => g.index >= 0 && !hashes.includes(g.hash))
    if (available.length > 0) {
      const sub = el('div', 'sc-section-title', 'Available greetings')
      sub.style.marginTop = '10px'
      box.appendChild(sub)
      const alist = el('div', 'sc-list')
      for (const g of available) {
        const item = el('div', 'sc-item')
        item.appendChild(itemHead(greetingTitle(g), greetingBadges(g), [
          button('+ Add', () => commit([...hashes, g.hash]), { primary: true }),
          button('Edit', () => openEditor(g, g.hash)),
        ]))
        item.appendChild(el('div', 'sc-item-preview', preview(g.text)))
        alist.appendChild(item)
      }
      box.appendChild(alist)
    } else if (state!.greetings.length === 0 && !state!.error) {
      box.appendChild(el('div', 'sc-hint', 'This character has no greetings.'))
    }
    root.appendChild(box)
  }

  function openEditor(g: GreetingInfo | null, hash: string): void {
    const card = g?.card ?? null
    editingNew = !card
    editing = card
      ? { ...card, dirtySinceDistill: false }
      : { hash, label: g ? greetingTitle(g) : '', presupposes: '', scene: '', mood: '', doneWhen: '', with: '', source: 'manual', dirtySinceDistill: false }
    editingChatId = state!.chatId
    editingOriginal = draftFields(editing)
    editingLive = g !== null && g.index >= 0
    // A finished light belongs to the draft it filled; a fresh editor starts dark. A running one stays lit.
    if (distillStatus.get(hash)?.state !== 'running') distillStatus.delete(hash)
    notice = null
    render()
    root.querySelector('.sc-editor')?.scrollIntoView({ block: 'nearest' })
  }

  function closeEditor(): void {
    editing = null
    editingNew = false
    editingChatId = null
    editingLive = false
  }

  function draftFields(d: EditorDraft): string {
    return JSON.stringify([d.label, d.presupposes, d.scene, d.mood, d.with ?? ''])
  }

  /** The open draft differs from what it was opened with (typed into, or filled by Distill). */
  function draftChanged(): boolean {
    return editing !== null && draftFields(editing) !== editingOriginal
  }

  function renderEditor(): void {
    const draft = editing!
    const g = state!.greetings.find((x) => x.hash === draft.hash) ?? null
    const owner = state!.isGroup && g?.characterName ? ` · ${g.characterName}` : ''
    const { box, head } = section(`Stage card · ${g ? greetingTitle(g) : draft.hash.slice(0, 8)}${owner}`)
    box.classList.add('sc-editor')
    head.appendChild(el('span', 'sc-muted', draft.source === 'llm' ? 'distilled' : draft.source))

    if (g?.text) {
      const src = el('details')
      src.appendChild(el('summary', 'sc-muted', 'Show greeting text'))
      src.appendChild(el('div', 'sc-preview', g.text))
      box.appendChild(src)
    }

    const fields: Array<{ key: 'label' | 'scene' | 'with' | 'mood'; label: string; hint: string; single?: boolean }> = [
      { key: 'label', label: 'Label', hint: 'Short name for this stage, e.g. "Riding lesson".', single: true },
      { key: 'scene', label: 'Scene', hint: 'Setting and situation. No dialogue, no {{user}} actions. This goes to the model.' },
      // Group chats only: solo chats ignore the field entirely, so it is not shown there.
      ...(state!.isGroup ? [{ key: 'with' as const, label: 'Scene is with', hint: 'Who this card\'s character shares the scene with. Blank means {{user}}. Name another character and {{user}} in the scene and mood above becomes them. Ignored in solo chats. This goes to the model.', single: true }] : []),
      { key: 'mood', label: 'Mood', hint: 'Tone, plus an intimacy ceiling for the transition message. This goes to the model.' },
    ]
    let contextBox: HTMLElement | null = null
    const renderContext = () => {
      if (!contextBox) return
      contextBox.style.display = draft.presupposes ? '' : 'none'
      const body = contextBox.querySelector('.sc-preview')
      if (body) body.textContent = draft.presupposes
    }
    for (const f of fields) {
      if (f.key === 'scene') {
        // Read-only context from Distill: the situation this greeting assumes. Never sent to the model; here to vibe-check scene and mood against.
        contextBox = el('div', 'sc-field')
        contextBox.appendChild(el('label', undefined, 'Context (from Distill, not sent)'))
        contextBox.appendChild(el('div', 'sc-preview'))
        contextBox.appendChild(el('div', 'sc-hint', 'The situation this greeting assumes, as Distill read it. Use it to sanity-check the scene and mood above and below.'))
        box.appendChild(contextBox)
        renderContext()
      }
      const wrap = el('div', 'sc-field')
      const lbl = el('label', undefined, f.label)
      wrap.appendChild(lbl)
      const input = f.single ? el('input') : el('textarea')
      input.dataset.focusKey = `field:${f.key}`
      if (input instanceof HTMLInputElement) input.type = 'text'
      if (f.key === 'with' && input instanceof HTMLInputElement && state!.isGroup && state!.members) {
        // Other members as quick picks; free text still allowed.
        const list = el('datalist')
        list.id = 'sc-partner-names'
        for (const m of state!.members) {
          if (m.id === g?.characterId) continue
          const opt = el('option')
          opt.value = m.name
          list.appendChild(opt)
        }
        input.setAttribute('list', list.id)
        input.placeholder = '{{user}}'
        wrap.appendChild(list)
      }
      input.value = draft[f.key] ?? ''
      input.addEventListener('input', () => {
        draft[f.key] = input.value
        if (draft.source === 'llm') { draft.source = 'edited' }
        draft.dirtySinceDistill = true
        requestTokenCount()
        updatePreview()
      })
      wrap.appendChild(input)
      wrap.appendChild(el('div', 'sc-hint', f.hint))
      box.appendChild(wrap)
    }

    // The preview shows the note this card sends in this chat (core/preview.ts, the same options the interceptor uses).
    const route = state!.route
    const previewHead = el('div', 'sc-hint')
    previewHead.style.marginTop = '8px'
    const previewBox = el('div', 'sc-preview')
    const previewFoot = el('div', 'sc-hint')
    // Directly under the note, in the warning colour: the note is cut before it is sent.
    const trimWarning = el('div', 'sc-warning')
    box.append(previewHead, previewBox, trimWarning)

    // Counts sit under the note they measure: the card's own fields against the card budget, then the note against its cap.
    // Each wraps as a unit.
    const counts = el('div', 'sc-hint')
    tokenLabel = el('span', 'sc-nowrap')
    const noteLabel = el('span')
    noteLabel.title = 'Characters ÷ 4, counted without the (OOC: …) wrapper, as the cap is; the wrapper adds about 9 tokens. {{char}} and {{user}} are counted as written: long names can push the note that is sent over the cap, which trims the mood first.'
    const trimFlag = el('span', 'sc-nowrap sc-warn-text', ' · trimmed')
    const reminderLabel = el('span', 'sc-nowrap')
    const reminderTrimFlag = el('span', 'sc-nowrap sc-warn-text', ' · trimmed')
    // A break opportunity before each flag and the reminder count, so a narrow panel wraps the line instead of cutting it off.
    const wbr = () => document.createElement('wbr')
    counts.append(tokenLabel, document.createTextNode(' · '), noteLabel, wbr(), trimFlag, wbr(), reminderLabel, wbr(), reminderTrimFlag)
    box.appendChild(counts)
    // How the note goes in, and anything that stops it, under the count.
    box.appendChild(previewFoot)
    requestTokenCount()

    // The in-stage reminder, only on chats an older version left with reminders on.
    const reminderHead = el('div', 'sc-hint')
    reminderHead.style.marginTop = '8px'
    const reminderBox = el('div', 'sc-preview')
    const reminderWarning = el('div', 'sc-warning')
    box.append(reminderHead, reminderBox, reminderWarning)

    const updatePreview = () => {
      const p = previewNote({
        card: { ...draft, updatedAt: 0 },
        route,
        settings: state!.settings,
        group: state!.isGroup === true,
        names: LITERAL_NAMES,
        drafts: { closing: textDraft.closingLine, instructions: textDraft.inStageInstructions },
      })
      const mode = route?.injectMode ?? 'append-to-last-user'
      const shown = (text: string) => mode === 'append-to-last-user' ? wrapForAppend(text) : text
      previewHead.textContent = previewHeading(p)
      previewBox.classList.toggle('sc-dim', p.placement !== 'sent')
      previewBox.style.display = p.arrival ? '' : 'none'
      previewBox.textContent = p.arrival ? shown(p.arrival.text) : ''
      const trimmed = p.arrival?.truncated === true
      previewBox.classList.toggle('sc-trimmed', trimmed)
      showWarning(trimWarning, trimmed ? trimmedNote(p) : null)
      trimFlag.style.display = trimmed ? '' : 'none'
      previewFoot.textContent = previewFootnote(p)
      previewFoot.style.display = previewFoot.textContent ? '' : 'none'
      const cap = limits().directive
      // Two units, so the longest label ("not sent in this chat") can wrap before its count on a narrow panel.
      const nowrap = (text: string) => el('span', 'sc-nowrap', text)
      noteLabel.replaceChildren(...(!p.arrival
        ? [nowrap('No note')]
        : [nowrap(`Scene-change note${p.placement === 'sent' ? '' : ' (not sent in this chat)'}:`), ' ', nowrap(`~${p.arrival.estimatedTokens} of ${cap} tokens`)]))
      reminderLabel.textContent = p.reminder ? ` · reminder: ~${p.reminder.note.estimatedTokens} of ${cap}` : ''
      reminderTrimFlag.style.display = p.reminder?.note.truncated ? '' : 'none'
      reminderHead.style.display = reminderBox.style.display = p.reminder ? '' : 'none'
      if (p.reminder) {
        const skipped = route?.skipNote && p.stageNumber === route.stageIndex + 1
        reminderHead.textContent = `Then on the 2nd reply in this stage and every ${p.reminder.every} after it: the in-stage reminder, which an older version switched on for this chat (there is no control for it in the panel any more)${skipped ? '. Skipped too, for the current visit' : ''}:`
        reminderBox.classList.toggle('sc-dim', skipped === true)
        reminderBox.textContent = shown(p.reminder.note.text)
        reminderBox.classList.toggle('sc-trimmed', p.reminder.note.truncated)
        showWarning(reminderWarning, p.reminder.note.truncated
          ? { lead: `Trimmed to fit the ~${cap}-token cap.`, text: 'The reminder above is cut before it is sent: shorten the scene, the mood or the reminder wording.' }
          : null)
      } else showWarning(reminderWarning, null)
    }

    function previewHeading(p: NotePreview): string {
      const way = TRANSITION_STYLES.find((t) => t.value === p.transition)?.label.replace(/\s*\(default\)$/, '') ?? p.transition
      switch (p.placement) {
        case 'sent': return `What the model gets, once, on the first reply after the story moves forward onto stage ${p.stageNumber} of ${p.stageCount} (Way in: ${way}). Names are filled in when it is sent:`
        case 'stage-one': return `Not sent: this is stage 1 of this chat's route${state!.openingHash && state!.openingHash === route?.route[0] ? ', where the chat opened' : ''}, and stage 1 never gets a note. Placed later in the route, its note would read:`
        case 'off-route': return `Not on this chat's route, so nothing is sent. Added as a later stage (Way in: ${way}), its note would read:`
        case 'empty': return 'Nothing is sent while the scene and the mood are both empty.'
      }
    }

    function previewFootnote(p: NotePreview): string {
      const lines: string[] = []
      if (p.arrival && p.placement === 'sent') {
        const depth = route ? depthFor(route) : 0
        lines.push((route?.injectMode ?? 'append-to-last-user') === 'append-to-last-user'
          ? 'It is added to the end of your latest message. When a reply comes without a fresh message from you (a group member speaking on, Continue, or a dry run before you send), it goes in as a system message instead, without the (OOC: …) wrapper.'
          : `It goes in as a system message ${depth} message${depth === 1 ? '' : 's'} from the end of the chat.`)
      }
      if (p.placement === 'sent' && route && !route.enabled) lines.push('Stagecoach is off for this chat, so nothing is sent until you enable it at the top.')
      if (p.placement === 'sent' && route && route.skipNote && p.stageNumber === route.stageIndex + 1) lines.push('Skipped for the current visit to this stage; the note button above can still send it.')
      if (editingNew) { if (p.placement === 'sent') lines.push('Not saved yet: nothing is sent for this stage until you press Save.') }
      else if (draftChanged()) lines.push('Unsaved changes: the saved card is what goes out until you press Save.')
      // The cap is checked with the real names; here they are counted as written, so allow each one about 3 tokens more
      // (a 20-character name), and never less than 6 tokens in all.
      const a = p.arrival
      const names = a?.text.match(/\{\{\s*(char|user)\s*\}\}/gi)?.length ?? 0
      if (a && !a.truncated && names > 0 && a.estimatedTokens >= limits().directive - Math.max(6, 3 * names)) {
        lines.push('Close to the cap: names longer than {{char}} and {{user}} could trim it when it is sent.')
      }
      return lines.join(' ')
    }

    /** Says what the trimming actually cut (renderDirective reports it), and what would fix it. */
    function trimmedNote(p: NotePreview): { lead: string; text: string } {
      const withName = state!.isGroup && (draft.with ?? '').trim() ? ', the "Scene is with" name' : ''
      const higher = state!.settings.highTokenLimit ? '' : ', or turn on Higher token limit under Settings'
      const sent = p.placement === 'sent'
      const fieldsCut = p.arrival?.fieldsIntact === false
      const closingCut = p.arrival?.tailIntact === false
      const what = fieldsCut && closingCut ? 'part of the scene or mood, and the end of your closing line'
        : closingCut ? 'the end of your closing line (the scene and mood fit)'
        : 'part of the scene or mood (a long mood is shortened first)'
      const fix = closingCut && !fieldsCut ? `Shorten the closing line${higher}.`
        : closingCut ? `Shorten the closing line first, then the scene or the mood${withName}${higher}.`
        : `Shorten the scene, the mood${withName} or the closing line${higher}.`
      return {
        lead: `${sent ? 'Trimmed' : 'Would be trimmed'} to fit the ~${limits().directive}-token cap.`,
        text: `The note above ${sent ? 'is what goes out, already cut' : 'shows it cut'}: ${what} ${fieldsCut && closingCut ? 'are' : 'is'} dropped. ${fix}`,
      }
    }

    function showWarning(target: HTMLElement, warning: { lead: string; text: string } | null): void {
      target.style.display = warning ? '' : 'none'
      target.textContent = ''
      if (!warning) return
      target.append(el('strong', undefined, `⚠ ${warning.lead}`), document.createTextNode(` ${warning.text}`))
    }
    updatePreview()

    // Distill row: [Distill + its light] and [closing-line toggle + badge] (plus the reminder wording on legacy chats), each pair wrapping as one unit.
    // The model is picked once, under Settings.
    const drow = el('div', 'sc-row')
    drow.style.marginTop = '10px'
    const status = distillStatus.get(draft.hash)
    const running = status?.state === 'running'
    const distillGroup = el('span', 'sc-group-inline')
    distillGroup.appendChild(button('Distill', async () => {
      const forChat = state!.chatId!
      const hash = draft.hash
      if (distillStatus.get(hash)?.state === 'running') return
      // Lit before the permission check (a host round trip), so a second click cannot send a second call.
      const runId = String(++distillRuns)
      setDistill(hash, 'running', { runId })
      render()
      const granted = await ensureGeneration()
      if (distillStatus.get(hash)?.runId !== runId) return
      if (!granted) { setDistill(hash, 'failed', { error: 'Distill needs the "generation" permission.' }); render(); return }
      // The permission prompt can sit open while the chat or the open card changes.
      if (state?.chatId !== forChat || editing?.hash !== hash) {
        distillStatus.delete(hash)
        announce('Distill was not sent: the chat or the card changed while the permission prompt was open.')
        render()
        return
      }
      send({ type: 'distill', chatId: forChat, hash, connectionId: state!.settings.distillConnectionId, runId })
      armNoReplyTimer(hash, runId)
    }, {
      primary: true,
      disabled: !g?.text || running,
      title: !g?.text ? 'Greeting text unavailable' : running ? 'Distill is running for this card' : 'One small LLM call to draft the four fields',
    }))
    if (status) {
      // Decoration with a text label; the announcer reads changes out.
      const light = el('span', `sc-light sc-${status.state}`, running ? 'Distilling…' : status.state === 'done' ? 'Done' : 'Failed')
      distillGroup.appendChild(light)
    }
    drow.appendChild(distillGroup)
    // The closing line ends every scene-change note; the reminder wording matters only where reminders are still on.
    const textEditors = [renderTextSettingEditor('closingLine', updatePreview)]
    if (route && reminderEveryFor(route) >= 1) textEditors.push(renderTextSettingEditor('inStageInstructions', updatePreview))
    for (const t of textEditors) {
      const group = el('span', 'sc-group-inline')
      group.append(...t.controls)
      drow.appendChild(group)
    }
    box.appendChild(drow)
    if (status?.state === 'failed' && status.error) box.appendChild(el('div', 'sc-hint sc-error-text', status.error))
    if (status?.state === 'done') box.appendChild(el('div', 'sc-hint', 'Distilled. Read the fields over, change anything that is off, then Save.'))
    box.appendChild(el('div', 'sc-hint', `Model: ${distillModelLabel()} (change it under Settings at the bottom of the panel). Distill fills in the card fields above with one cheap LLM call, reasoning off; the card is not saved until you press Save.`))
    for (const t of textEditors) if (t.panel) box.appendChild(t.panel)

    // The stage's Way in, again here beside the preview it shapes (the route list has the same picker).
    const pos = route ? route.route.indexOf(draft.hash) : -1
    if (route && pos >= 1) {
      const way = wayInRow(route, draft.hash, 'editor')
      way.style.marginTop = '10px'
      box.appendChild(way)
      box.appendChild(el('div', 'sc-hint', 'How the scene-change note gets into this stage. Saved for this chat as soon as you pick it; Save and Cancel do not affect it.'))
    } else {
      const why = pos === 0 ? 'this card is stage 1 here, which never gets a note' : 'this card is not on this chat\'s route'
      const hint = el('div', 'sc-hint', `Way in: set for stage 2 onwards on the route; ${why}.`)
      hint.style.marginTop = '10px'
      box.appendChild(hint)
    }

    // Actions
    const arow = el('div', 'sc-row')
    arow.style.marginTop = '10px'
    arow.appendChild(button('Save', () => {
      const { dirtySinceDistill: _d, ...card } = draft
      send({ type: 'save_card', chatId: state!.chatId, card: { ...card, updatedAt: Date.now() } })
      closeEditor()
      render()
    }, { primary: true }))
    arow.appendChild(button('Cancel', () => { closeEditor(); render() }))
    arow.appendChild(el('span', 'sc-spacer'))
    if (!editingNew) {
      arow.appendChild(button('Delete card', async () => {
        const forChat = state!.chatId
        const hash = draft.hash
        const { confirmed } = await ctx.ui.showConfirm({ title: 'Delete stage card', message: 'Delete this stage card? The greeting itself is untouched.', variant: 'danger', confirmLabel: 'Delete' })
        if (!confirmed || state?.chatId !== forChat || editing?.hash !== hash) return
        send({ type: 'delete_card', chatId: forChat, hash })
        closeEditor()
        render()
      }))
    }
    box.appendChild(arow)
    root.appendChild(box)
  }

  /**
   * Editor for one global text setting (the closing line, or the legacy
   * reminder wording). Saved on blur, so a re-render from the backend does not
   * steal focus mid-sentence; the unsaved text lives in textDraft so renders
   * keep it. Returns the toggle (button plus badge, placed in the Distill row)
   * and, when open, the panel that goes under that row.
   */
  function renderTextSettingEditor(key: TextKey, onChange: () => void): { controls: HTMLElement[]; panel: HTMLElement | null } {
    const def = TEXT_SETTINGS[key]
    const saved = state!.settings[key] ?? null
    const customised = saved !== null && saved !== def.builtIn
    const controls: HTMLElement[] = [button(textOpen[key] ? def.hide : def.open, () => {
      textOpen[key] = !textOpen[key]
      if (!textOpen[key]) textDraft[key] = null
      render()
    }, { title: def.title })]
    if (customised) controls.push(el('span', 'sc-badge sc-ok', 'customized'))
    if (!textOpen[key]) return { controls, panel: null }

    const wrap = el('div', 'sc-instructions')
    const field = el('div', 'sc-field')
    const ta = el('textarea')
    ta.dataset.focusKey = `text:${key}`
    ta.value = textDraft[key] ?? saved ?? def.builtIn
    ta.maxLength = limits().instructionsChars
    ta.rows = key === 'closingLine' ? 2 : 4
    const meter = el('div', 'sc-hint')
    const updateMeter = () => {
      const l = limits()
      const tokens = estimateTokens(def.effective(ta.value))
      // Text written under the higher limit survives switching it off, but an edit saves at most the current limit.
      const over = ta.value.length > l.instructionsChars
      // Past about 40% of the cap there is little room left for the scene and mood themselves.
      const long = tokens > l.directive * 0.4
      meter.textContent = `~${tokens} tokens of the ${l.directive} shared with the scene and mood`
        + (long ? ' · long: it leaves less room for the scene and mood (the preview shows any trimming)' : '')
        + (over ? ` · longer than the ${l.instructionsChars}-character limit, so an edit saves only the first ${l.instructionsChars} characters` : '')
    }
    // Blur (change) and the Done button can both fire for one edit; send each value once.
    let sent: string | null = saved
    const save = () => {
      // A re-render removing this box fires change too; that is not the user leaving it.
      if (rendering) return
      const next = ta.value.replace(/\s+/g, ' ').trim()
      const value = next.length === 0 || next === def.builtIn ? null : next
      textDraft[key] = null
      // Nothing to store. No re-render here: this runs on blur, and rebuilding the panel would swallow the click that caused it.
      if (value === sent) { onChange(); return }
      sent = value
      send({ type: 'set_settings', chatId: state!.chatId, settings: { [key]: value } })
    }
    const resetBtn = button('Reset to original', () => {
      ta.value = def.builtIn
      textDraft[key] = null
      onChange()
      if (sent !== null) { sent = null; send({ type: 'set_settings', chatId: state!.chatId, settings: { [key]: null } }) }
      else render()
    }, { title: 'Put the built-in wording back' })
    const updateReset = () => { resetBtn.disabled = ta.value.replace(/\s+/g, ' ').trim() === def.builtIn }
    ta.addEventListener('input', () => { textDraft[key] = ta.value; updateMeter(); updateReset(); onChange() })
    // Blur, not change: a box rebuilt with the draft and refocused by render() fires no change when the user leaves it.
    ta.addEventListener('blur', save)
    field.appendChild(ta)
    updateMeter()
    field.appendChild(meter)
    field.appendChild(el('div', 'sc-hint', `${def.hint} In append mode the whole note is wrapped as "(OOC: … Do not reply to this note.)"; that wrapper is fixed.`))
    const arow = el('div', 'sc-row')
    arow.style.marginTop = '6px'
    updateReset()
    arow.appendChild(resetBtn)
    arow.appendChild(button('Done', () => { textOpen[key] = false; save(); render() }))
    field.appendChild(arow)
    wrap.appendChild(field)
    return { controls, panel: wrap }
  }

  /** Connection Distill will use: the saved pick while it still exists, else the default (as the backend resolves it). */
  function distillModelLabel(): string {
    const conns = state!.connections
    const picked = conns.find((c) => c.id === state!.settings.distillConnectionId)
    if (picked) return `${picked.name} · ${picked.model}`
    const def = conns.find((c) => c.is_default) ?? conns[0]
    return def ? `default (${def.name} · ${def.model})` : 'your default connection'
  }

  function subsection(box: HTMLElement, title: string, note?: string): HTMLElement {
    const g = el('div', 'sc-group')
    const head = el('div', 'sc-group-title', title)
    if (note) head.appendChild(el('span', 'sc-muted', note))
    g.appendChild(head)
    box.appendChild(g)
    return g
  }

  /** Global settings (model, token limit) and this chat's injection settings. Rendered without a chat too, minus injection. */
  function renderSettings(route: ChatRoute | null): void {
    const { box } = section('Settings')

    // ---- Distill model (global) ----
    const model = subsection(box, 'Distill model', 'all chats')
    const mrow = el('div', 'sc-row')
    const connSel = el('select')
    const defaultConn = state!.connections.find((c) => c.is_default) ?? state!.connections[0]
    const noneOpt = el('option', undefined, defaultConn ? `Default: ${defaultConn.name} · ${defaultConn.model}` : 'Default connection')
    noneOpt.value = ''
    connSel.appendChild(noneOpt)
    for (const c of state!.connections) {
      const opt = el('option', undefined, `${c.name} · ${c.model}${c.is_default ? ' (default)' : ''}`)
      opt.value = c.id
      if (state!.settings.distillConnectionId === c.id) opt.selected = true
      connSel.appendChild(opt)
    }
    connSel.addEventListener('change', () => send({ type: 'set_settings', chatId: state!.chatId, settings: { distillConnectionId: connSel.value || null } }))
    mrow.appendChild(connSel)
    // Connections are listed only with "generation". Distill used to ask for it from the editor; offer it here too.
    const canList = state!.permissions.includes('generation')
    if (!canList) {
      mrow.appendChild(button('List connections', async () => {
        if (await ensureGeneration()) requestState()
        else setNotice('error', 'Listing connections needs the "generation" permission.')
      }, { title: 'Grant the "generation" permission so your connections can be listed here' }))
    }
    model.appendChild(mrow)
    model.appendChild(el('div', 'sc-hint', canList
      ? 'The connection the Distill button uses on every stage card. Default follows your default connection.'
      : 'The connection the Distill button uses on every stage card. Grant "generation" to pick one; until then Distill uses your default connection.'))

    // ---- Token limit (global) ----
    const tokens = subsection(box, 'Token limit', 'all chats')
    const toggle = el('label', 'sc-toggle')
    const cb = el('input')
    cb.type = 'checkbox'
    cb.checked = state!.settings.highTokenLimit
    cb.addEventListener('change', () => send({ type: 'set_settings', chatId: state!.chatId, settings: { highTokenLimit: cb.checked } }))
    toggle.append(cb, document.createTextNode('Higher token limit'))
    tokens.appendChild(toggle)
    const s = STANDARD_TOKEN_LIMITS
    const h = HIGH_TOKEN_LIMITS
    tokens.appendChild(el('div', 'sc-hint', `Off (default): scene-change notes are capped at ~${s.directive} tokens and stage cards aim for ${s.cardTarget} (cap ${s.cardCap}), sized for small-context models. `
      + `On: notes up to ~${h.directive} tokens, cards aim for ${h.cardTarget} (cap ${h.cardCap}), Distill writes up to ${h.distillWords} words per field instead of ${s.distillWords}, and the closing line can run to ${h.instructionsChars} characters. `
      + 'Saved cards are never rewritten either way; the cap only decides how much of them is sent.'))

    // ---- Injection (this chat) ----
    if (!state!.chatId) {
      root.appendChild(box)
      return
    }
    const injection = subsection(box, 'Injection', 'this chat')
    const row = el('div', 'sc-row')
    row.appendChild(el('span', undefined, 'Mode'))
    const sel = el('select')
    const modes: Array<{ value: InjectMode; label: string }> = [
      { value: 'append-to-last-user', label: 'Append to the last user message (default)' },
      { value: 'system-at-depth', label: 'System message at a depth in history' },
    ]
    for (const m of modes) {
      const opt = el('option', undefined, m.label)
      opt.value = m.value
      if ((route?.injectMode ?? 'append-to-last-user') === m.value) opt.selected = true
      sel.appendChild(opt)
    }
    sel.disabled = !route
    sel.addEventListener('change', () => send({ type: 'set_inject_mode', chatId: state!.chatId!, injectMode: sel.value as InjectMode }))
    row.appendChild(sel)
    injection.appendChild(row)
    injection.appendChild(el('div', 'sc-hint', 'Append mode merges the directive into your latest turn, which steered reliably in testing; it has no separate Prompt Breakdown entry. System mode shows up as its own block but some models ignore it.'))


    if (route) {
      const systemMode = route.injectMode === 'system-at-depth'
      const drow = el('div', 'sc-row')
      drow.appendChild(el('span', undefined, systemMode ? 'Depth' : 'Fallback depth'))
      const depthInput = el('input')
      depthInput.type = 'number'
      depthInput.min = '0'
      depthInput.max = String(MAX_DEPTH)
      depthInput.step = '1'
      // Half-typed digits carry over a rebuild (depthDraft); a change fired by the rebuild itself is not a commit.
      depthInput.dataset.focusKey = 'depth'
      depthInput.value = depthDraft ?? String(depthFor(route))
      depthInput.style.width = '64px'
      depthInput.addEventListener('input', () => { depthDraft = depthInput.value })
      depthInput.addEventListener('change', () => {
        if (rendering) return
        depthDraft = null
        send({ type: 'set_depth', chatId: state!.chatId!, depth: Number(depthInput.value) })
      })
      drow.appendChild(depthInput)
      drow.appendChild(el('span', 'sc-muted', 'history messages between the directive and the end of the chat'))
      injection.appendChild(drow)
      injection.appendChild(el('div', 'sc-hint', systemMode
        ? '0 places it right after the latest message (strongest steer). Higher numbers push it further back and steer more gently.'
        : 'Used only when the latest message is not yours, as when a group member speaks without a fresh turn from you: the note then goes in as a system message at this depth instead of being appended. 0 = right after the latest message.'))
    }
    root.appendChild(box)
  }

  // ---- Boot ------------------------------------------------------------------
  render()
  requestState()
  try { ctx.ready() } catch { /* older hosts */ }

  return () => {
    for (const fn of cleanups) { try { fn() } catch { /* ignore */ } }
    ctx.dom.cleanup()
  }
}
