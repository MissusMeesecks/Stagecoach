// src/shared/types.ts
var DIRECTIVE_TOKEN_CAP = 120;
var CARD_TOKEN_TARGET = 50;
var CARD_TOKEN_CAP = 90;

// src/core/tiers.ts
var ARRIVAL_TURNS = 1;
function turnsInStage(currentIndex, enteredAt) {
  return Math.max(0, Math.floor((currentIndex - enteredAt) / 2));
}
var DEFAULT_REMINDER_EVERY = 0;
var MAX_REMINDER_EVERY = 10;
function reminderDue(input) {
  if (input.stageIndex <= 0)
    return false;
  const turns = turnsInStage(input.currentIndex, input.enteredAt ?? 0);
  const since = turns - ARRIVAL_TURNS;
  if (since < 0)
    return true;
  const every = Math.floor(input.every);
  if (!(every >= 1))
    return false;
  return since % every === 0;
}
function chooseTier(input) {
  const { stageIndex, enteredAt, currentIndex } = input;
  if (stageIndex <= 0)
    return "in-stage";
  if (enteredAt === undefined)
    return "in-stage";
  return turnsInStage(currentIndex, enteredAt) < ARRIVAL_TURNS ? "arrival" : "in-stage";
}

// src/core/templates.ts
function substituteNames(text, names) {
  return text.replace(/\{\{\s*char\s*\}\}/gi, names.char).replace(/\{\{\s*user\s*\}\}/gi, names.user);
}
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}
function clean(s) {
  return s.replace(/\s+/g, " ").trim();
}
function truncateToChars(text, maxChars) {
  if (text.length <= maxChars)
    return text;
  const head = text.slice(0, maxChars);
  const cut = Math.max(head.lastIndexOf(". "), head.lastIndexOf("; "), head.lastIndexOf(", "));
  return (cut > maxChars * 0.5 ? head.slice(0, cut + 1) : head).trimEnd();
}
var DEFAULT_TRANSITION = "elapse";
var TRANSITION_STYLES = [
  { value: "elapse", label: "Skip time, narrate the gap (default)", hint: 'A short "later that week" passage on what changed, then the new scene.' },
  { value: "cut", label: "Hard cut", hint: "Jump straight into the new scene. Nothing about the gap." },
  { value: "flow", label: "Develop the transition in-scene", hint: "No skip. Carry the story from here to there on the page." }
];
function effectiveTransition(style) {
  return !style || style === "auto" ? DEFAULT_TRANSITION : style;
}
function arrivalFrame(style, scene, mood) {
  switch (effectiveTransition(style)) {
    case "cut":
      return `The story now moves to: ${scene} Mood: ${mood} Cut straight to this scene; do not narrate what came between.`;
    case "elapse":
      return `Time passes. Open with a short passage on what has changed since the last scene, then arrive at: ${scene} Mood: ${mood}`;
    case "flow":
      return `The story is moving toward: ${scene} Mood: ${mood} Carry the transition on the page: show how the scene shifts from here to there rather than cutting.`;
    default:
      return `Time passes. Open with a short passage on what has changed since the last scene, then arrive at: ${scene} Mood: ${mood}`;
  }
}
var TENSE_NOTE = "Keep the existing narrative tense and voice.";
function frame(tier, style, scene, mood) {
  const body = tier === "arrival" ? arrivalFrame(style, scene, mood) : `${scene} Mood: ${mood} Keep the story inside this scene: let events and the conversation move forward within it, without leaving it or skipping ahead.`;
  return `${body} ${TENSE_NOTE}`;
}
function renderDirective(tier, card, names, options = {}) {
  const style = effectiveTransition(options.transition);
  const capChars = (options.tokenCap ?? DIRECTIVE_TOKEN_CAP) * 4;
  let scene = clean(substituteNames(card.scene, names));
  let mood = clean(substituteNames(card.mood, names));
  let body = frame(tier, style, scene, mood);
  let truncated = false;
  if (body.length > capChars) {
    const frameLen = body.length - scene.length - mood.length;
    const budget = Math.max(40, capChars - frameLen);
    if (scene.length + mood.length > budget)
      mood = truncateToChars(mood, Math.max(24, Math.floor(budget * 0.35)));
    if (scene.length + mood.length > budget)
      scene = truncateToChars(scene, Math.max(24, budget - mood.length));
    truncated = true;
    body = frame(tier, style, scene, mood);
    if (body.length > capChars)
      body = truncateToChars(body, capChars);
  }
  return { text: body, estimatedTokens: estimateTokens(body), truncated };
}

// src/core/route.ts
var TRANSITION_VALUES = ["auto", "cut", "elapse", "flow"];
function isTransitionStyle(v) {
  return typeof v === "string" && TRANSITION_VALUES.includes(v);
}
var DEFAULT_DEPTH = 0;
var MAX_DEPTH = 20;
function transitionFor(route, hash) {
  if (!hash)
    return "elapse";
  const s = route.transitions?.[hash];
  return isTransitionStyle(s) && s !== "auto" ? s : "elapse";
}
function depthFor(route) {
  const d = route.timing?.depth;
  return typeof d === "number" && Number.isFinite(d) && d >= 0 ? Math.min(MAX_DEPTH, Math.floor(d)) : DEFAULT_DEPTH;
}
function reminderEveryFor(route) {
  const n = route.timing?.reminderEvery;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.min(MAX_REMINDER_EVERY, Math.floor(n)) : DEFAULT_REMINDER_EVERY;
}

// src/core/inject.ts
function wrapForAppend(directive) {
  return `(OOC: ${directive} Do not reply to this note.)`;
}

// src/frontend.ts
var REQUIRED_PERMISSIONS = ["characters", "chats", "interceptor"];
var LITERAL_NAMES = { char: "{{char}}", user: "{{user}}" };
var CSS = `
  .sc-root { display: flex; flex-direction: column; gap: 12px; padding: 10px 12px; font-size: 13px; color: var(--lumiverse-text); overflow-y: auto; }
  .sc-root * { box-sizing: border-box; }
  .sc-section { border: 1px solid var(--lumiverse-border); border-radius: var(--lumiverse-radius); padding: 10px; background: var(--lumiverse-fill-subtle); }
  .sc-section-title { font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--lumiverse-text-muted); margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
  .sc-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .sc-row + .sc-row { margin-top: 6px; }
  .sc-spacer { flex: 1; }
  .sc-muted { color: var(--lumiverse-text-dim); font-size: 12px; }
  .sc-hint { color: var(--lumiverse-text-dim); font-size: 11px; margin-top: 2px; }
  .sc-notice { border: 1px solid var(--lumiverse-border); border-left: 3px solid var(--lumiverse-accent); padding: 6px 8px; border-radius: var(--lumiverse-radius); font-size: 12px; }
  .sc-notice.sc-error { border-left-color: #d9534f; }
  .sc-status { font-size: 12px; line-height: 1.4; }
  .sc-status strong { color: var(--lumiverse-text); }
  .sc-root button { background: var(--lumiverse-fill); color: var(--lumiverse-text-muted); border: 1px solid var(--lumiverse-border); border-radius: var(--lumiverse-radius); padding: 4px 10px; cursor: pointer; font-size: 12px; }
  .sc-root button:hover:not(:disabled) { border-color: var(--lumiverse-border-hover); color: var(--lumiverse-text); }
  .sc-root button:disabled { opacity: 0.5; cursor: default; }
  .sc-root button.sc-primary { background: var(--lumiverse-accent); color: var(--lumiverse-accent-fg); border-color: var(--lumiverse-accent); }
  .sc-root button.sc-icon { padding: 2px 6px; min-width: 26px; }
  .sc-root select, .sc-root input[type="text"], .sc-root input[type="number"], .sc-root textarea { background: var(--lumiverse-fill); color: var(--lumiverse-text); border: 1px solid var(--lumiverse-border); border-radius: var(--lumiverse-radius); padding: 4px 6px; font-size: 12px; font-family: inherit; }
  .sc-root select { max-width: 100%; }
  .sc-root textarea { width: 100%; resize: vertical; min-height: 44px; line-height: 1.35; }
  .sc-root input[type="text"] { width: 100%; }
  .sc-list { display: flex; flex-direction: column; gap: 6px; }
  .sc-item { border: 1px solid var(--lumiverse-border); border-radius: var(--lumiverse-radius); padding: 6px 8px; background: var(--lumiverse-fill); }
  .sc-item.sc-current { border-color: var(--lumiverse-accent); }
  .sc-item-head { display: flex; align-items: center; gap: 6px; }
  .sc-item-title { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sc-item-preview { color: var(--lumiverse-text-dim); font-size: 11px; margin-top: 3px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .sc-badge { font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--lumiverse-border); color: var(--lumiverse-text-muted); white-space: nowrap; }
  .sc-badge.sc-ok { border-color: var(--lumiverse-accent); color: var(--lumiverse-accent); }
  .sc-field { margin-top: 8px; }
  .sc-field label { display: block; font-weight: 600; font-size: 12px; margin-bottom: 2px; }
  .sc-preview { white-space: pre-wrap; font-size: 11px; color: var(--lumiverse-text-muted); background: var(--lumiverse-fill); border: 1px dashed var(--lumiverse-border); border-radius: var(--lumiverse-radius); padding: 6px 8px; margin-top: 4px; }
  .sc-toggle { display: inline-flex; align-items: center; gap: 6px; }
  .sc-transition { margin-top: 5px; }
  .sc-transition select { font-size: 11px; padding: 2px 4px; }
`;
var ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="20" height="20"><path d="M2 5h3l1-2h8l1 2h3v2h-1l-1 8h-2a2 2 0 1 1-4 0H9a2 2 0 1 1-4 0H4L3 7H2V5zm5 1h6l-.5-1h-5L7 6z"/></svg>`;
function greetingTitle(g) {
  if (g.card?.label)
    return g.card.label;
  if (g.index === 0)
    return "First message";
  if (g.index > 0)
    return `Alternate greeting ${g.index}`;
  return "Card for a greeting no longer on this character";
}
function preview(text, max = 140) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
function cardTokens(c) {
  return [c.scene, c.mood].join(" ");
}
function setup(ctx) {
  const cleanups = [];
  cleanups.push(ctx.dom.addStyle(CSS));
  let state = null;
  let chatId = null;
  let editing = null;
  let editingNew = false;
  let distilling = null;
  let notice = null;
  let tokenRequestId = 0;
  let tokenLabel = null;
  let tokenTimer = null;
  const tab = ctx.ui.registerDrawerTab({
    id: "stagecoach",
    title: "Stagecoach",
    shortName: "Stages",
    headerTitle: "Stagecoach",
    description: "Steer the story through greetings as ordered stages",
    keywords: ["stage", "greeting", "story", "arc", "pacing", "stagecoach"],
    iconSvg: ICON
  });
  cleanups.push(() => tab.destroy());
  const root = tab.root;
  root.classList.add("sc-root");
  function send(message) {
    ctx.sendToBackend(message);
  }
  function activeChatId() {
    try {
      return ctx.getActiveChat().chatId;
    } catch {
      return null;
    }
  }
  function messageCount() {
    try {
      return ctx.messages.listMessageIds().length;
    } catch {
      return 0;
    }
  }
  async function openingText() {
    try {
      const id = ctx.messages.getMessageIdAtIndex(0);
      if (!id)
        return { text: null, probe: "no-first-message" };
      if (ctx.messages.get) {
        const m = await ctx.messages.get(id).catch(() => null);
        if (m) {
          if (m.is_user)
            return { text: null, probe: "first-message-is-yours" };
          const active = typeof m.content === "string" && m.content ? m.content : Array.isArray(m.swipes) ? m.swipes[m.swipe_id ?? 0] ?? null : null;
          if (active)
            return { text: active, probe: "ok" };
        }
      }
      const bubble = ctx.dom.findMessageElement(id);
      const text = bubble?.textContent?.trim() ?? "";
      if (text.length > 0)
        return { text, probe: "ok-dom" };
      return { text: null, probe: "first-message-not-on-screen" };
    } catch (err) {
      return { text: null, probe: `error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  let probeRun = 0;
  function requestState() {
    chatId = activeChatId();
    const forChat = chatId;
    const run = ++probeRun;
    openingText().then(({ text, probe }) => {
      if (chatId !== forChat || run !== probeRun)
        return;
      send({ type: "get_state", chatId: forChat, openingText: text, openingProbe: probe });
      if (text || !forChat)
        return;
      for (const delay of [600, 1500, 3500]) {
        setTimeout(() => {
          if (chatId !== forChat || run !== probeRun)
            return;
          openingText().then((again) => {
            if (!again.text || chatId !== forChat || run !== probeRun)
              return;
            probeRun++;
            send({ type: "get_state", chatId: forChat, openingText: again.text, openingProbe: again.probe });
          });
        }, delay);
      }
    });
  }
  function syncCount() {
    const id = activeChatId();
    if (!id)
      return;
    send({ type: "sync_count", chatId: id, messageCount: messageCount() });
  }
  function setNotice(kind, text) {
    notice = { kind, text };
    render();
  }
  ctx.permissions.getGranted().then((granted) => {
    const missing = REQUIRED_PERMISSIONS.filter((p) => !granted.includes(p));
    if (missing.length === 0)
      return;
    return ctx.ui.showConfirm({
      title: "Stagecoach needs permissions",
      message: `To read greetings and steer the prompt, Stagecoach needs: ${missing.join(", ")}. The optional "generation" permission is only requested when you press Distill.`,
      variant: "info",
      confirmLabel: "Grant",
      cancelLabel: "Not now"
    }).then(({ confirmed }) => {
      if (confirmed)
        return ctx.permissions.request(missing, { reason: "Read character greetings and the active chat; inject the current stage into the prompt." }).then(() => requestState());
    });
  }).catch(() => {
    return;
  });
  async function ensureGeneration() {
    const granted = await ctx.permissions.getGranted();
    if (granted.includes("generation"))
      return true;
    try {
      const next = await ctx.permissions.request(["generation"], { reason: "Distill runs one small LLM call per greeting on a connection you choose." });
      return next.includes("generation");
    } catch {
      return false;
    }
  }
  cleanups.push(ctx.onBackendMessage((payload) => {
    const msg = payload;
    if (!msg || typeof msg !== "object")
      return;
    switch (msg.type) {
      case "state": {
        if (msg.state.chatId !== chatId && msg.state.chatId !== null)
          return;
        state = msg.state;
        if (editing && !editingNew) {
          const g = state.greetings.find((x) => x.hash === editing.hash);
          if (!g)
            editing = null;
        }
        render();
        break;
      }
      case "distill_result": {
        distilling = null;
        if (editing && editing.hash === msg.hash) {
          editing = { ...editing, ...msg.card, source: "llm", dirtySinceDistill: false };
          notice = { kind: "info", text: "Distilled. Read it over, edit anything that is off, then Save." };
        }
        render();
        break;
      }
      case "distill_error":
        distilling = null;
        setNotice("error", `Distill failed: ${msg.message}`);
        break;
      case "token_count":
        if (msg.requestId === String(tokenRequestId) && tokenLabel) {
          tokenLabel.textContent = `${msg.approximate ? "~" : ""}${msg.tokens} tokens · target ${CARD_TOKEN_TARGET} · cap ${CARD_TOKEN_CAP}`;
          tokenLabel.style.color = msg.tokens > CARD_TOKEN_CAP ? "#d9534f" : "";
        }
        break;
      case "error":
        setNotice("error", msg.message);
        break;
    }
  }));
  for (const eventName of ["CHAT_SWITCHED", "CHAT_CHANGED", "CHARACTER_EDITED", "PERMISSION_CHANGED", "MESSAGE_SWIPED"]) {
    cleanups.push(ctx.events.on(eventName, () => setTimeout(requestState, 0)));
  }
  cleanups.push(ctx.events.on("MESSAGE_DELETED", () => setTimeout(() => {
    syncCount();
    requestState();
  }, 200)));
  cleanups.push(tab.onActivate(requestState));
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className)
      node.className = className;
    if (text !== undefined)
      node.textContent = text;
    return node;
  }
  function button(label, onClick, opts = {}) {
    const b = el("button", [opts.primary ? "sc-primary" : "", opts.icon ? "sc-icon" : ""].filter(Boolean).join(" "), label);
    b.type = "button";
    b.disabled = opts.disabled === true;
    if (opts.title)
      b.title = opts.title;
    b.addEventListener("click", onClick);
    return b;
  }
  function section(title) {
    const box = el("div", "sc-section");
    const head = el("div", "sc-section-title", title);
    box.appendChild(head);
    return { box, head };
  }
  function requestTokenCount() {
    if (!editing || !tokenLabel)
      return;
    const text = cardTokens(editing);
    tokenLabel.textContent = `~${estimateTokens(text)} tokens (estimate) · target ${CARD_TOKEN_TARGET} · cap ${CARD_TOKEN_CAP}`;
    if (tokenTimer)
      clearTimeout(tokenTimer);
    tokenTimer = setTimeout(() => {
      tokenRequestId += 1;
      send({ type: "count_tokens", requestId: String(tokenRequestId), text });
    }, 400);
  }
  function render() {
    root.textContent = "";
    tokenLabel = null;
    if (notice) {
      const n = el("div", `sc-notice${notice.kind === "error" ? " sc-error" : ""}`, notice.text);
      const close = button("×", () => {
        notice = null;
        render();
      }, { icon: true });
      close.style.float = "right";
      n.prepend(close);
      root.appendChild(n);
    }
    if (!state) {
      root.appendChild(el("div", "sc-muted", "Loading…"));
      return;
    }
    if (!state.chatId) {
      root.appendChild(el("div", "sc-muted", "Open a chat to set up its stages."));
      tab.setBadge(null);
      return;
    }
    if (state.error) {
      root.appendChild(el("div", "sc-notice sc-error", state.error));
    }
    const route = state.route;
    const stages = route ? route.route.map((h) => state.greetings.find((g) => g.hash === h) ?? null) : [];
    const enabled = route?.enabled === true;
    renderHeader(enabled);
    renderStatus(route, stages);
    renderPointer(route, stages);
    renderRoute(route, stages);
    if (editing)
      renderEditor();
    renderInjection(route);
    root.appendChild(el("div", "sc-hint", "Stagecoach never writes to character cards. Everything lives in your own extension storage."));
    tab.setBadge(enabled && route && route.route.length > 0 ? `${route.stageIndex + 1}/${route.route.length}` : null);
  }
  function renderHeader(enabled) {
    const { box } = section(state.characterName ? `Stagecoach · ${state.characterName}` : "Stagecoach");
    const row = el("div", "sc-row");
    const toggle = el("label", "sc-toggle");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = enabled;
    cb.addEventListener("change", () => send({ type: "set_enabled", chatId: state.chatId, enabled: cb.checked, messageCount: messageCount() }));
    toggle.append(cb, document.createTextNode("Enabled for this chat"));
    row.appendChild(toggle);
    row.appendChild(el("span", "sc-spacer"));
    row.appendChild(button("⟳", requestState, { icon: true, title: "Refresh" }));
    box.appendChild(row);
    root.appendChild(box);
  }
  function renderStatus(route, stages) {
    const status = el("div", "sc-status");
    if (!route || route.route.length === 0) {
      status.textContent = "No stages selected yet. Add greetings to the route below, in the order the story should move through them.";
    } else {
      const current = stages[route.stageIndex];
      const count = messageCount();
      const entered = route.enteredAt[route.stageIndex];
      const tier = chooseTier({ stageIndex: route.stageIndex, stageCount: route.route.length, enteredAt: entered, currentIndex: count });
      const turns = entered === undefined ? 0 : turnsInStage(count, entered);
      const due = reminderDue({ stageIndex: route.stageIndex, enteredAt: entered, currentIndex: count, every: reminderEveryFor(route) });
      const noteLabel = due ? tier === "arrival" ? "scene-change note" : "in-stage note" : "no note";
      const isFinal = route.stageIndex >= route.route.length - 1;
      const noteDetail = route.stageIndex === 0 ? isFinal ? " (stage 1 is where the chat opened; add more stages to steer)" : " (stage 1 is where the chat opened; nothing to steer yet)" : due ? "" : isFinal ? ` (final stage; the story is on its own from here)` : ` (turn ${turns} in this stage; press Advance when the scene feels finished)`;
      const missingCard = current && !current.card;
      status.innerHTML = "";
      status.append(document.createTextNode("Stage "), Object.assign(el("strong"), { textContent: `${route.stageIndex + 1}/${route.route.length}` }), document.createTextNode(` · ${current ? greetingTitle(current) : "unknown greeting"} · next reply: `), Object.assign(el("strong"), { textContent: noteLabel }), document.createTextNode(noteDetail));
      if (!route.enabled)
        status.append(el("div", "sc-hint", "Disabled: nothing is injected until you enable it above."));
      if (missingCard)
        status.append(el("div", "sc-hint", "This stage has no card yet, so nothing is injected. Edit it below and press Distill or fill it in by hand."));
    }
    root.appendChild(status);
  }
  function renderPointer(route, stages) {
    if (!route || route.route.length === 0)
      return;
    const { box } = section("Current stage");
    const row = el("div", "sc-row");
    const sel = el("select");
    stages.forEach((g, i) => {
      const opt = el("option", undefined, `${i + 1}. ${g ? greetingTitle(g) : "unknown"}`);
      opt.value = String(i);
      if (i === route.stageIndex)
        opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", () => send({ type: "set_stage", chatId: state.chatId, stageIndex: Number(sel.value), messageCount: messageCount() }));
    row.appendChild(sel);
    row.appendChild(button("◀ Back", () => send({ type: "set_stage", chatId: state.chatId, stageIndex: route.stageIndex - 1, messageCount: messageCount() }), { disabled: route.stageIndex <= 0 }));
    row.appendChild(button("Advance ▶", () => send({ type: "set_stage", chatId: state.chatId, stageIndex: route.stageIndex + 1, messageCount: messageCount() }), { primary: true, disabled: route.stageIndex >= route.route.length - 1 }));
    box.appendChild(row);
    box.appendChild(el("div", "sc-hint", route.stageIndex >= route.route.length - 1 ? "This is the last stage in the route. Add another greeting below if the story should go further." : 'Advance when the current scene feels finished. The next reply, and only that one, gets a scene-change note using the "Way in" chosen for the new stage. Stage 1 never gets a note: the chat opened with it.'));
    root.appendChild(box);
  }
  function renderRoute(route, stages) {
    const { box, head } = section("Route");
    head.appendChild(el("span", "sc-muted", "stages in story order"));
    const list = el("div", "sc-list");
    const hashes = route ? [...route.route] : [];
    const commit = (next) => send({ type: "set_route", chatId: state.chatId, route: next, messageCount: messageCount() });
    if (state.openingStatus && state.openingStatus !== "matched") {
      box.appendChild(el("div", "sc-hint", state.openingStatus === "first-message-not-on-screen" ? "Opening greeting not detected: scroll the chat to its first message and refresh (⟳)." : `Opening greeting not detected (${state.openingStatus}).`));
    }
    const opening = state.openingHash ? state.greetings.find((g) => g.hash === state.openingHash) ?? null : null;
    if (opening && hashes[0] !== opening.hash) {
      const n = el("div", "sc-notice");
      n.appendChild(el("span", undefined, `This chat opened with "${greetingTitle(opening)}". `));
      n.appendChild(button("Make it stage 1", () => commit([opening.hash, ...hashes.filter((h) => h !== opening.hash)]), { primary: true }));
      box.appendChild(n);
    }
    if (hashes.length === 0)
      list.appendChild(el("div", "sc-muted", "Empty. Add greetings from the list below."));
    stages.forEach((g, i) => {
      const item = el("div", `sc-item${route && i === route.stageIndex ? " sc-current" : ""}`);
      const headRow = el("div", "sc-item-head");
      headRow.appendChild(el("span", "sc-item-title", `${i + 1}. ${g ? greetingTitle(g) : "unknown greeting"}`));
      if (g && g.hash === state.openingHash)
        headRow.appendChild(el("span", "sc-badge", "chat opened here"));
      headRow.appendChild(el("span", `sc-badge${g?.card ? " sc-ok" : ""}`, g?.card ? "card ready" : "no card"));
      headRow.appendChild(button("▲", () => {
        const n = [...hashes];
        [n[i - 1], n[i]] = [n[i], n[i - 1]];
        commit(n);
      }, { icon: true, disabled: i === 0, title: "Move up" }));
      headRow.appendChild(button("▼", () => {
        const n = [...hashes];
        [n[i + 1], n[i]] = [n[i], n[i + 1]];
        commit(n);
      }, { icon: true, disabled: i === hashes.length - 1, title: "Move down" }));
      headRow.appendChild(button("Edit", () => openEditor(g, hashes[i])));
      headRow.appendChild(button("✕", () => commit(hashes.filter((_, j) => j !== i)), { icon: true, title: "Remove from route" }));
      item.appendChild(headRow);
      if (g?.text)
        item.appendChild(el("div", "sc-item-preview", preview(g.text)));
      if (i > 0 && route) {
        const trow = el("div", "sc-row sc-transition");
        trow.appendChild(el("span", "sc-muted", "Way in:"));
        const tsel = el("select");
        const current = transitionFor(route, hashes[i]);
        for (const t of TRANSITION_STYLES) {
          const opt = el("option", undefined, t.label);
          opt.value = t.value;
          opt.title = t.hint;
          if (t.value === current)
            opt.selected = true;
          tsel.appendChild(opt);
        }
        tsel.title = TRANSITION_STYLES.find((t) => t.value === current)?.hint ?? "";
        tsel.addEventListener("change", () => send({ type: "set_transition", chatId: state.chatId, hash: hashes[i], style: tsel.value }));
        trow.appendChild(tsel);
        item.appendChild(trow);
      }
      list.appendChild(item);
    });
    box.appendChild(list);
    const available = state.greetings.filter((g) => g.index >= 0 && !hashes.includes(g.hash));
    if (available.length > 0) {
      const sub = el("div", "sc-section-title", "Available greetings");
      sub.style.marginTop = "10px";
      box.appendChild(sub);
      const alist = el("div", "sc-list");
      for (const g of available) {
        const item = el("div", "sc-item");
        const headRow = el("div", "sc-item-head");
        headRow.appendChild(el("span", "sc-item-title", greetingTitle(g)));
        if (g.hash === state.openingHash)
          headRow.appendChild(el("span", "sc-badge", "chat opened here"));
        headRow.appendChild(el("span", `sc-badge${g.card ? " sc-ok" : ""}`, g.card ? "card ready" : "no card"));
        headRow.appendChild(button("+ Add", () => commit([...hashes, g.hash]), { primary: true }));
        headRow.appendChild(button("Edit", () => openEditor(g, g.hash)));
        item.appendChild(headRow);
        item.appendChild(el("div", "sc-item-preview", preview(g.text)));
        alist.appendChild(item);
      }
      box.appendChild(alist);
    } else if (state.greetings.length === 0 && !state.error) {
      box.appendChild(el("div", "sc-hint", "This character has no greetings."));
    }
    root.appendChild(box);
  }
  function openEditor(g, hash) {
    const card = g?.card ?? null;
    editingNew = !card;
    editing = card ? { ...card, dirtySinceDistill: false } : { hash, label: g ? greetingTitle(g) : "", presupposes: "", scene: "", mood: "", doneWhen: "", source: "manual", dirtySinceDistill: false };
    notice = null;
    render();
    root.querySelector(".sc-editor")?.scrollIntoView({ block: "nearest" });
  }
  function renderEditor() {
    const draft = editing;
    const g = state.greetings.find((x) => x.hash === draft.hash) ?? null;
    const { box, head } = section(`Stage card · ${g ? greetingTitle(g) : draft.hash.slice(0, 8)}`);
    box.classList.add("sc-editor");
    head.appendChild(el("span", "sc-muted", draft.source === "llm" ? "distilled" : draft.source));
    if (g?.text) {
      const src = el("details");
      src.appendChild(el("summary", "sc-muted", "Show greeting text"));
      src.appendChild(el("div", "sc-preview", g.text));
      box.appendChild(src);
    }
    const fields = [
      { key: "label", label: "Label", hint: 'Short name for this stage, e.g. "Riding lesson".', single: true },
      { key: "scene", label: "Scene", hint: "Setting and situation. No dialogue, no {{user}} actions. This goes to the model." },
      { key: "mood", label: "Mood", hint: "Tone, plus an explicit ceiling on intimacy or heat for this stage. This goes to the model." }
    ];
    let contextBox = null;
    const renderContext = () => {
      if (!contextBox)
        return;
      contextBox.style.display = draft.presupposes ? "" : "none";
      const body = contextBox.querySelector(".sc-preview");
      if (body)
        body.textContent = draft.presupposes;
    };
    for (const f of fields) {
      if (f.key === "scene") {
        contextBox = el("div", "sc-field");
        contextBox.appendChild(el("label", undefined, "Context (from Distill, not sent)"));
        contextBox.appendChild(el("div", "sc-preview"));
        contextBox.appendChild(el("div", "sc-hint", "The situation this greeting assumes, as Distill read it. Use it to sanity-check the scene and mood above and below."));
        box.appendChild(contextBox);
        renderContext();
      }
      const wrap = el("div", "sc-field");
      const lbl = el("label", undefined, f.label);
      wrap.appendChild(lbl);
      const input = f.single ? el("input") : el("textarea");
      if (input instanceof HTMLInputElement)
        input.type = "text";
      input.value = draft[f.key];
      input.addEventListener("input", () => {
        draft[f.key] = input.value;
        if (draft.source === "llm") {
          draft.source = "edited";
        }
        draft.dirtySinceDistill = true;
        requestTokenCount();
        updatePreview();
      });
      wrap.appendChild(input);
      wrap.appendChild(el("div", "sc-hint", f.hint));
      box.appendChild(wrap);
    }
    tokenLabel = el("div", "sc-hint");
    box.appendChild(tokenLabel);
    requestTokenCount();
    const previewBox = el("div", "sc-preview");
    const previewTitle = el("div", "sc-hint", `What the model will see (in-stage wording, names substituted at injection; cap ${DIRECTIVE_TOKEN_CAP} tokens):`);
    previewTitle.style.marginTop = "8px";
    box.appendChild(previewTitle);
    box.appendChild(previewBox);
    const updatePreview = () => {
      const r = renderDirective("in-stage", { ...draft, updatedAt: 0 }, LITERAL_NAMES);
      const shown = (state.route?.injectMode ?? "append-to-last-user") === "append-to-last-user" ? wrapForAppend(r.text) : r.text;
      previewBox.textContent = shown + (r.truncated ? `

(truncated to fit the cap: shorten scene or mood)` : "");
    };
    updatePreview();
    const drow = el("div", "sc-row");
    drow.style.marginTop = "10px";
    const connSel = el("select");
    const defaultConn = state.connections.find((c) => c.is_default) ?? state.connections[0];
    const noneOpt = el("option", undefined, defaultConn ? `Default: ${defaultConn.name} · ${defaultConn.model}` : 'Default connection (grant "generation" to list)');
    noneOpt.value = "";
    connSel.appendChild(noneOpt);
    for (const c of state.connections) {
      const opt = el("option", undefined, `${c.name} · ${c.model}${c.is_default ? " (default)" : ""}`);
      opt.value = c.id;
      if (state.settings.distillConnectionId === c.id)
        opt.selected = true;
      connSel.appendChild(opt);
    }
    connSel.addEventListener("change", () => send({ type: "set_settings", chatId: state.chatId, settings: { distillConnectionId: connSel.value || null } }));
    drow.appendChild(connSel);
    const canDistill = !!g?.text && distilling === null;
    drow.appendChild(button(distilling === draft.hash ? "Distilling…" : "Distill", async () => {
      if (!await ensureGeneration()) {
        setNotice("error", 'Distill needs the "generation" permission.');
        return;
      }
      distilling = draft.hash;
      render();
      send({ type: "distill", chatId: state.chatId, hash: draft.hash, connectionId: connSel.value || null });
    }, { disabled: !canDistill, title: g?.text ? "One small LLM call to draft the four fields" : "Greeting text unavailable" }));
    box.appendChild(drow);
    box.appendChild(el("div", "sc-hint", "Distill drafts the fields with one cheap LLM call, reasoning off. Nothing is saved until you press Save."));
    const arow = el("div", "sc-row");
    arow.style.marginTop = "10px";
    arow.appendChild(button("Save", () => {
      const { dirtySinceDistill: _d, ...card } = draft;
      send({ type: "save_card", chatId: state.chatId, card: { ...card, updatedAt: Date.now() } });
      editing = null;
      render();
    }, { primary: true }));
    arow.appendChild(button("Cancel", () => {
      editing = null;
      render();
    }));
    arow.appendChild(el("span", "sc-spacer"));
    if (!editingNew) {
      arow.appendChild(button("Delete card", async () => {
        const { confirmed } = await ctx.ui.showConfirm({ title: "Delete stage card", message: "Delete this stage card? The greeting itself is untouched.", variant: "danger", confirmLabel: "Delete" });
        if (!confirmed)
          return;
        send({ type: "delete_card", chatId: state.chatId, hash: draft.hash });
        editing = null;
        render();
      }));
    }
    box.appendChild(arow);
    root.appendChild(box);
  }
  function renderInjection(route) {
    const { box } = section("Injection");
    const row = el("div", "sc-row");
    row.appendChild(el("span", undefined, "Mode"));
    const sel = el("select");
    const modes = [
      { value: "append-to-last-user", label: "Append to the last user message (default)" },
      { value: "system-at-depth", label: "System message at a depth in history" }
    ];
    for (const m of modes) {
      const opt = el("option", undefined, m.label);
      opt.value = m.value;
      if ((route?.injectMode ?? "append-to-last-user") === m.value)
        opt.selected = true;
      sel.appendChild(opt);
    }
    sel.disabled = !route;
    sel.addEventListener("change", () => send({ type: "set_inject_mode", chatId: state.chatId, injectMode: sel.value }));
    row.appendChild(sel);
    box.appendChild(row);
    box.appendChild(el("div", "sc-hint", "Append mode merges the directive into your latest turn, which steered reliably in testing; it has no separate Prompt Breakdown entry. System mode shows up as its own block but some models ignore it."));
    if (route && route.injectMode === "system-at-depth") {
      const drow = el("div", "sc-row");
      drow.appendChild(el("span", undefined, "Depth"));
      const depthInput = el("input");
      depthInput.type = "number";
      depthInput.min = "0";
      depthInput.max = String(MAX_DEPTH);
      depthInput.step = "1";
      depthInput.value = String(depthFor(route));
      depthInput.style.width = "64px";
      depthInput.addEventListener("change", () => send({ type: "set_depth", chatId: state.chatId, depth: Number(depthInput.value) }));
      drow.appendChild(depthInput);
      drow.appendChild(el("span", "sc-muted", "history messages between the directive and the end of the chat"));
      box.appendChild(drow);
      box.appendChild(el("div", "sc-hint", "0 places it right after the latest message (strongest steer). Higher numbers push it further back and steer more gently."));
    }
    root.appendChild(box);
  }
  render();
  requestState();
  try {
    ctx.ready();
  } catch {}
  return () => {
    for (const fn of cleanups) {
      try {
        fn();
      } catch {}
    }
    ctx.dom.cleanup();
  };
}
export {
  setup
};
