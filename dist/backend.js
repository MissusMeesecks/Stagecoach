// @bun
// src/shared/types.ts
var DEFAULT_SETTINGS = {
  distillConnectionId: null,
  inStageInstructions: null,
  closingLine: null,
  highTokenLimit: false
};
var STANDARD_TOKEN_LIMITS = { directive: 120, cardTarget: 50, cardCap: 90, instructionsChars: 400, distillWords: 25 };
var HIGH_TOKEN_LIMITS = { directive: 240, cardTarget: 100, cardCap: 180, instructionsChars: 800, distillWords: 50 };
function tokenLimitsFor(settings) {
  return settings.highTokenLimit ? HIGH_TOKEN_LIMITS : STANDARD_TOKEN_LIMITS;
}
var DIRECTIVE_TOKEN_CAP = STANDARD_TOKEN_LIMITS.directive;

// src/core/hash.ts
function normalizeGreeting(text) {
  return text.replace(/\r\n?/g, `
`).normalize("NFC").trim();
}
async function hashGreeting(text) {
  const bytes = new TextEncoder().encode(normalizeGreeting(text));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
function isValidHash(hash) {
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash);
}

// src/core/tiers.ts
var ARRIVAL_TURNS = 1;
function hasText(content) {
  if (typeof content === "string")
    return content.trim().length > 0;
  if (Array.isArray(content))
    return content.some((p) => p && typeof p === "object" && typeof p.text === "string" && p.text.trim().length > 0);
  return false;
}
function isLandedReply(m, excludeId) {
  if (m.__isChatHistory !== true || m.role !== "assistant")
    return false;
  if (excludeId && m.sourceMessageId === excludeId)
    return false;
  return hasText(m.content);
}
function repliesSince(messages, input) {
  const hist = messages.filter((m) => m.__isChatHistory === true);
  if (input.anchorId) {
    const at = hist.findIndex((m) => m.sourceMessageId === input.anchorId);
    if (at !== -1) {
      let replies = 0;
      for (let i = at + 1;i < hist.length; i++)
        if (isLandedReply(hist[i], input.excludeId))
          replies++;
      return { replies, by: "anchor" };
    }
  }
  const indexed = hist.some((m) => typeof m.sourceIndexInChat === "number" && Number.isFinite(m.sourceIndexInChat));
  let replies = 0;
  hist.forEach((m, pos) => {
    const idx = indexed && typeof m.sourceIndexInChat === "number" ? m.sourceIndexInChat : pos;
    if (idx >= input.enteredAt && isLandedReply(m, input.excludeId))
      replies++;
  });
  return { replies, by: indexed ? "index" : "position" };
}
var DEFAULT_REMINDER_EVERY = 0;
var MAX_REMINDER_EVERY = 10;
function reminderDue(input) {
  if (input.stageIndex <= 0)
    return false;
  const since = input.replies - ARRIVAL_TURNS;
  if (since < 0)
    return true;
  const every = Math.floor(input.every);
  if (!(every >= 1))
    return false;
  return since % every === 0;
}
function chooseTier(input) {
  const { stageIndex, enteredAt, replies } = input;
  if (stageIndex <= 0)
    return "in-stage";
  if (enteredAt === undefined)
    return "in-stage";
  return replies < ARRIVAL_TURNS ? "arrival" : "in-stage";
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
function effectiveClosing(custom) {
  const t = custom ? clean(custom) : "";
  return t.length > 0 ? t : TENSE_NOTE;
}
var DEFAULT_IN_STAGE_INSTRUCTIONS = `Keep the story inside this scene: let events and the conversation move forward within it, without leaving it or skipping ahead. ${TENSE_NOTE}`;
function effectiveInstructions(custom) {
  const t = custom ? clean(custom) : "";
  return t.length > 0 ? t : DEFAULT_IN_STAGE_INSTRUCTIONS;
}
function partnerLine(char, partner) {
  return partner ? ` This scene is between ${char} and ${partner}.` : "";
}
function frame(tier, style, scene, mood, instructions, closing, partner) {
  const where = `${scene}${partner}`;
  return tier === "arrival" ? `${arrivalFrame(style, where, mood)} ${closing}` : `${where} Mood: ${mood} ${instructions}`;
}
function renderDirective(tier, card, names, options = {}) {
  const style = effectiveTransition(options.transition);
  const capChars = (options.tokenCap ?? DIRECTIVE_TOKEN_CAP) * 4;
  const withField = options.group ? clean(card.with ?? "") || "{{user}}" : "";
  const partnerName = clean(substituteNames(withField, names));
  const cardNames = options.group && partnerName && partnerName !== names.user ? { ...names, user: partnerName } : names;
  let scene = clean(substituteNames(card.scene, cardNames));
  let mood = clean(substituteNames(card.mood, cardNames));
  const fullScene = scene;
  const fullMood = mood;
  const textNames = options.textNames ?? names;
  const instructions = clean(substituteNames(effectiveInstructions(options.instructions), textNames));
  const closing = clean(substituteNames(effectiveClosing(options.closing), textNames));
  const partner = partnerLine(names.char, partnerName);
  let body = frame(tier, style, scene, mood, instructions, closing, partner);
  let truncated = false;
  if (body.length > capChars) {
    const frameLen = body.length - scene.length - mood.length;
    const budget = Math.max(40, capChars - frameLen);
    if (scene.length + mood.length > budget)
      mood = truncateToChars(mood, Math.max(24, Math.floor(budget * 0.35)));
    if (scene.length + mood.length > budget)
      scene = truncateToChars(scene, Math.max(24, budget - mood.length));
    truncated = true;
    body = frame(tier, style, scene, mood, instructions, closing, partner);
    if (body.length > capChars)
      body = truncateToChars(body, capChars);
  }
  const tail = tier === "arrival" ? closing : instructions;
  const fieldsIntact = scene === fullScene && mood === fullMood && body.includes(`${scene}${partner} Mood: ${mood}`);
  return { text: body, estimatedTokens: estimateTokens(body), truncated, tailIntact: body.endsWith(tail), fieldsIntact };
}
function breakdownName(stageIndex, stageCount, tier) {
  return `Stagecoach \xB7 stage ${stageIndex + 1}/${stageCount} \xB7 ${tier}`;
}

// src/core/settings.ts
function normaliseInstructions(text, maxChars, builtIn = DEFAULT_IN_STAGE_INSTRUCTIONS) {
  const t = text.replace(/\s+/g, " ").trim().slice(0, maxChars);
  return t.length === 0 || t === builtIn ? null : t;
}
function storedText(v) {
  return typeof v === "string" && v ? v : null;
}
function normalizeSettings(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    distillConnectionId: typeof r.distillConnectionId === "string" && r.distillConnectionId ? r.distillConnectionId : null,
    inStageInstructions: storedText(r.inStageInstructions),
    closingLine: storedText(r.closingLine),
    highTokenLimit: r.highTokenLimit === true
  };
}
function applySettingsPatch(current, patch) {
  const highTokenLimit = typeof patch.highTokenLimit === "boolean" ? patch.highTokenLimit : current.highTokenLimit;
  const maxChars = tokenLimitsFor({ highTokenLimit }).instructionsChars;
  return {
    distillConnectionId: typeof patch.distillConnectionId === "string" && patch.distillConnectionId ? patch.distillConnectionId : patch.distillConnectionId === null ? null : current.distillConnectionId,
    inStageInstructions: typeof patch.inStageInstructions === "string" ? normaliseInstructions(patch.inStageInstructions, maxChars) : patch.inStageInstructions === null ? null : current.inStageInstructions,
    closingLine: typeof patch.closingLine === "string" ? normaliseInstructions(patch.closingLine, maxChars, TENSE_NOTE) : patch.closingLine === null ? null : current.closingLine,
    highTokenLimit
  };
}

// src/core/route.ts
var TRANSITION_VALUES = ["auto", "cut", "elapse", "flow"];
function isTransitionStyle(v) {
  return typeof v === "string" && TRANSITION_VALUES.includes(v);
}
var DEFAULT_DEPTH = 0;
var MAX_DEPTH = 20;
function newRoute(chatId, characterId) {
  return {
    chatId,
    characterId,
    enabled: false,
    route: [],
    stageIndex: 0,
    enteredAt: [0],
    strength: 3,
    injectMode: "append-to-last-user"
  };
}
function normalizeRoute(raw, chatId, characterId) {
  const base = newRoute(chatId, characterId);
  if (!raw || typeof raw !== "object")
    return base;
  const r = raw;
  const route = Array.isArray(r.route) ? r.route.filter((h) => typeof h === "string") : [];
  const maxIndex = Math.max(0, route.length - 1);
  const stageIndex = typeof r.stageIndex === "number" && Number.isFinite(r.stageIndex) ? Math.min(maxIndex, Math.max(0, Math.floor(r.stageIndex))) : 0;
  const enteredAt = Array.isArray(r.enteredAt) ? r.enteredAt.filter((n) => typeof n === "number" && Number.isFinite(n)).slice(0, stageIndex + 1) : [];
  while (enteredAt.length < stageIndex + 1)
    enteredAt.push(enteredAt[enteredAt.length - 1] ?? 0);
  const strength = [1, 2, 3, 4, 5].find((s) => s === r.strength) ?? 3;
  const injectMode = r.injectMode === "system-at-depth" ? "system-at-depth" : "append-to-last-user";
  const transitions = {};
  if (r.transitions && typeof r.transitions === "object") {
    for (const [hash, style] of Object.entries(r.transitions)) {
      if (route.includes(hash) && isTransitionStyle(style) && style !== "auto" && style !== "elapse")
        transitions[hash] = style;
    }
  }
  const anchors = {};
  if (r.anchors && typeof r.anchors === "object") {
    for (const [k, v] of Object.entries(r.anchors))
      if (/^\d+$/.test(k) && typeof v === "string" && v)
        anchors[k] = v;
  }
  return {
    ...base,
    characterId: typeof r.characterId === "string" && r.characterId ? r.characterId : characterId,
    enabled: r.enabled === true,
    route,
    stageIndex,
    enteredAt,
    strength,
    timing: r.timing && typeof r.timing === "object" ? r.timing : undefined,
    injectMode,
    transitions: Object.keys(transitions).length ? transitions : undefined,
    anchors: Object.keys(anchors).length ? anchors : undefined,
    skipNote: r.skipNote === true ? true : undefined
  };
}
function transitionFor(route, hash) {
  if (!hash)
    return "elapse";
  const s = route.transitions?.[hash];
  return isTransitionStyle(s) && s !== "auto" ? s : "elapse";
}
function setTransition(route, hash, style) {
  const transitions = { ...route.transitions ?? {} };
  if (style === "auto" || style === "elapse")
    delete transitions[hash];
  else
    transitions[hash] = style;
  return { ...route, transitions: Object.keys(transitions).length ? transitions : undefined };
}
function setStage(route, stageIndex, messageCount, latestMessageId) {
  const maxIndex = Math.max(0, route.route.length - 1);
  const target = Math.min(maxIndex, Math.max(0, Math.floor(stageIndex)));
  const enteredAt = route.enteredAt.slice(0, Math.min(route.enteredAt.length, target + 1));
  if (enteredAt.length === 0)
    enteredAt.push(0);
  const anchors = {};
  for (const [k, v] of Object.entries(route.anchors ?? {}))
    if (Number(k) < enteredAt.length)
      anchors[k] = v;
  while (enteredAt.length < target + 1) {
    if (latestMessageId)
      anchors[String(enteredAt.length)] = latestMessageId;
    enteredAt.push(Math.max(0, Math.floor(messageCount)));
  }
  return { ...route, stageIndex: target, enteredAt, anchors: Object.keys(anchors).length ? anchors : undefined, skipNote: undefined };
}
function replayStage(route, messageCount, latestMessageId) {
  if (route.stageIndex <= 0 || route.route.length === 0)
    return route;
  const enteredAt = [...route.enteredAt];
  while (enteredAt.length < route.stageIndex + 1)
    enteredAt.push(enteredAt[enteredAt.length - 1] ?? 0);
  enteredAt[route.stageIndex] = Math.max(0, Math.floor(messageCount));
  const anchors = { ...route.anchors ?? {} };
  if (latestMessageId)
    anchors[String(route.stageIndex)] = latestMessageId;
  else
    delete anchors[String(route.stageIndex)];
  return { ...route, enteredAt, anchors: Object.keys(anchors).length ? anchors : undefined, skipNote: undefined };
}
function skipNote(route) {
  return route.stageIndex <= 0 ? route : { ...route, skipNote: true };
}
function anchorFor(route) {
  return route.anchors?.[String(route.stageIndex)] ?? null;
}
function applyRoute(route, hashes, messageCount) {
  const unique = [];
  for (const h of hashes)
    if (!unique.includes(h))
      unique.push(h);
  const currentHash = route.route[route.stageIndex];
  const transitions = {};
  for (const [h, s] of Object.entries(route.transitions ?? {}))
    if (unique.includes(h))
      transitions[h] = s;
  const next = { ...route, route: unique, transitions: Object.keys(transitions).length ? transitions : undefined };
  const keep = currentHash !== undefined ? unique.indexOf(currentHash) : -1;
  if (keep === -1) {
    return { ...next, stageIndex: 0, enteredAt: [route.enteredAt[0] ?? 0] };
  }
  if (keep === route.stageIndex)
    return next;
  const entered = route.enteredAt[route.stageIndex] ?? messageCount;
  const enteredAt = route.enteredAt.slice(0, keep);
  while (enteredAt.length < keep)
    enteredAt.push(enteredAt[enteredAt.length - 1] ?? 0);
  enteredAt.push(entered);
  return { ...next, stageIndex: keep, enteredAt };
}
function rewindTo(route, messageCount, tolerance = 0) {
  const count = Math.max(0, Math.floor(messageCount));
  let stageIndex = route.stageIndex;
  const enteredAt = [...route.enteredAt];
  while (stageIndex > 0) {
    const entered = enteredAt[stageIndex];
    if (entered === undefined || count < entered - tolerance) {
      enteredAt.pop();
      stageIndex--;
    } else {
      break;
    }
  }
  if (stageIndex === route.stageIndex)
    return route;
  return { ...route, stageIndex, enteredAt };
}
function forkRoute(source, newChatId, messageCount) {
  return rewindTo({ ...source, chatId: newChatId, enteredAt: [...source.enteredAt] }, messageCount, 0);
}
function depthFor(route) {
  const d = route.timing?.depth;
  return typeof d === "number" && Number.isFinite(d) && d >= 0 ? Math.min(MAX_DEPTH, Math.floor(d)) : DEFAULT_DEPTH;
}
function reminderEveryFor(route) {
  const n = route.timing?.reminderEvery;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.min(MAX_REMINDER_EVERY, Math.floor(n)) : DEFAULT_REMINDER_EVERY;
}
function setReminderEvery(route, every) {
  const n = Number.isFinite(every) ? Math.min(MAX_REMINDER_EVERY, Math.max(0, Math.floor(every))) : DEFAULT_REMINDER_EVERY;
  return { ...route, timing: { ...route.timing ?? {}, reminderEvery: n } };
}
function setDepth(route, depth) {
  const d = Number.isFinite(depth) ? Math.min(MAX_DEPTH, Math.max(0, Math.floor(depth))) : DEFAULT_DEPTH;
  return { ...route, timing: { ...route.timing ?? {}, depth: d } };
}

// src/core/preview.ts
function noteOptions(route, hash, settings, group, drafts = {}) {
  return {
    transition: route ? transitionFor(route, hash) : DEFAULT_TRANSITION,
    tokenCap: tokenLimitsFor(settings).directive,
    instructions: drafts.instructions ?? settings.inStageInstructions,
    closing: drafts.closing ?? settings.closingLine,
    group
  };
}

// src/core/opening.ts
function comparable(text) {
  return normalizeGreeting(text).replace(/\s+/g, " ").toLowerCase();
}
function skeleton(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}
var CHUNK = 60;
var FUZZY_MIN = 40;
var WHOLE_MIN = 12;
var CHUNKS = 5;
function chunkStarts(n) {
  if (n <= CHUNK)
    return [0];
  const count = Math.min(CHUNKS, Math.floor(n / CHUNK) + 1);
  const last = n - CHUNK;
  const out = [];
  for (let i = 0;i < count; i++)
    out.push(Math.round(last * i / (count - 1)));
  return Array.from(new Set(out));
}
var WHOLE = CHUNKS + 1;
function fuzzyScore(greeting, haystack) {
  const g = skeleton(greeting);
  const h = skeleton(haystack);
  if (g.length < WHOLE_MIN || h.length === 0)
    return 0;
  if (h.includes(g))
    return WHOLE;
  if (g.length < FUZZY_MIN)
    return 0;
  const starts = chunkStarts(g.length);
  let hits = 0;
  for (const s of starts)
    if (h.includes(g.slice(s, s + CHUNK)))
      hits++;
  return hits >= Math.max(2, Math.ceil(starts.length / 2)) ? hits : 0;
}
function matchGreeting(greetings, readings) {
  const targets = readings.map(comparable).filter((t) => t.length > 0);
  if (targets.length === 0)
    return null;
  for (const g of greetings) {
    for (const t of g.texts)
      if (targets.includes(comparable(t)))
        return g.key;
  }
  let best = null;
  for (const g of greetings) {
    let score = 0;
    for (const t of g.texts)
      for (const r of readings)
        score = Math.max(score, fuzzyScore(t, r));
    if (score === 0)
      continue;
    const length = Math.max(...g.texts.map((t) => skeleton(t).length));
    const better = !best || score > best.score || score === WHOLE && best.score === WHOLE && length > best.length;
    if (better)
      best = { key: g.key, score, length };
  }
  return best ? best.key : null;
}
function sample(text, max = 90) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}\u2026` : t;
}

// src/core/group.ts
function groupInfo(metadata, characterId) {
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  const ids = Array.isArray(meta.character_ids) ? meta.character_ids.filter((v) => typeof v === "string" && v.length > 0) : [];
  const isGroup = meta.group === true && ids.length > 0;
  const memberIds = isGroup ? [characterId, ...ids.filter((id) => id !== characterId)] : [characterId];
  const agi = meta.activeGreetingIndex;
  const activeGreetingIndex = typeof agi === "number" && Number.isFinite(agi) && agi >= 0 ? Math.floor(agi) : null;
  return { isGroup, memberIds, activeGreetingIndex };
}

// src/core/inject.ts
function hasText2(content) {
  if (typeof content === "string")
    return content.trim().length > 0;
  return Array.isArray(content) && content.some((p) => typeof p.text === "string" && p.text.trim().length > 0);
}
function historyIndices(messages) {
  const out = [];
  messages.forEach((m, i) => {
    if (m.__isChatHistory === true)
      out.push(i);
  });
  return out;
}
function injectSystemAtDepth(messages, directive, depth) {
  const hist = historyIndices(messages);
  const d = Math.max(0, Math.floor(depth));
  let insertAt;
  if (hist.length === 0) {
    insertAt = messages.length;
  } else if (d === 0) {
    insertAt = hist[hist.length - 1] + 1;
  } else {
    const target = hist[Math.max(0, hist.length - d)];
    insertAt = target;
  }
  const injected = { role: "system", content: directive };
  const out = [...messages];
  out.splice(insertAt, 0, injected);
  return { messages: out, injectedIndex: insertAt, appliedMode: "system-at-depth" };
}
function wrapForAppend(directive) {
  return `(OOC: ${directive} Do not reply to this note.)`;
}
function appendToLastUser(messages, directive, fallbackDepth = 0) {
  const hist = historyIndices(messages).filter((i) => hasText2(messages[i].content));
  const idx = hist.length > 0 ? hist[hist.length - 1] : -1;
  if (idx === -1 || messages[idx].role !== "user")
    return injectSystemAtDepth(messages, directive, fallbackDepth);
  const src = messages[idx];
  const sep = `

`;
  const note = wrapForAppend(directive);
  let content;
  if (typeof src.content === "string") {
    content = src.content.length > 0 ? src.content + sep + note : note;
  } else if (Array.isArray(src.content)) {
    content = [...src.content, { type: "text", text: sep + note }];
  } else {
    content = note;
  }
  const out = [...messages];
  out[idx] = { ...src, content };
  return { messages: out, injectedIndex: null, appliedMode: "append-to-last-user" };
}
function injectDirective(messages, directive, mode, depth) {
  return mode === "append-to-last-user" ? appendToLastUser(messages, directive, depth) : injectSystemAtDepth(messages, directive, depth);
}

// src/backend.ts
var LOG = "[Stagecoach]";
var INTERCEPTOR_PRIORITY = 400;
var userCaches = new Map;
function cachesFor(userId) {
  const key = userId ?? "";
  let c = userCaches.get(key);
  if (!c) {
    c = { routes: new Map, cards: new Map, names: new Map, characters: new Map, chats: new Map, greetings: new Map, resolvedGreetings: new Map, openings: new Map, settings: null };
    userCaches.set(key, c);
  }
  return c;
}
function eachUser(fn) {
  for (const c of userCaches.values())
    fn(c);
}
var knownUsers = new Set;
function actingUser(id, record = true) {
  if (id) {
    if (record)
      knownUsers.add(id);
    return id;
  }
  return knownUsers.size === 1 ? knownUsers.values().next().value : undefined;
}
var fallbackIndexLogged = new Set;
function has(permission) {
  try {
    return spindle.permissions.has(permission);
  } catch {
    return false;
  }
}
function errMsg(err) {
  return err instanceof Error ? err.message : String(err);
}
function routePath(chatId) {
  return `chats/${encodeURIComponent(chatId)}.json`;
}
function cardPath(hash) {
  return `cards/${hash}.json`;
}
async function loadRoute(chatId, userId) {
  const cache = cachesFor(userId).routes;
  if (cache.has(chatId))
    return cache.get(chatId) ?? null;
  let route = null;
  try {
    const raw = await spindle.userStorage.getJson(routePath(chatId), { fallback: null, userId });
    if (raw && typeof raw === "object") {
      const characterId = typeof raw.characterId === "string" ? raw.characterId : "";
      route = normalizeRoute(raw, chatId, characterId);
    }
  } catch (err) {
    spindle.log.warn(`${LOG} could not read route for chat ${chatId}: ${errMsg(err)}`);
  }
  if (cache.has(chatId))
    return cache.get(chatId) ?? null;
  cache.set(chatId, route);
  return route;
}
async function saveRoute(route, userId) {
  await spindle.userStorage.setJson(routePath(route.chatId), route, { indent: 2, userId });
  cachesFor(userId).routes.set(route.chatId, route);
}
async function loadCard(hash, userId) {
  if (!isValidHash(hash))
    return null;
  const cache = cachesFor(userId).cards;
  if (cache.has(hash))
    return cache.get(hash) ?? null;
  let card = null;
  try {
    const raw = await spindle.userStorage.getJson(cardPath(hash), { fallback: null, userId });
    card = sanitizeCard(raw, hash);
  } catch (err) {
    spindle.log.warn(`${LOG} could not read card ${hash.slice(0, 8)}: ${errMsg(err)}`);
  }
  if (cache.has(hash))
    return cache.get(hash) ?? null;
  cache.set(hash, card);
  return card;
}
async function saveCard(card, userId) {
  await spindle.userStorage.setJson(cardPath(card.hash), card, { indent: 2, userId });
  cachesFor(userId).cards.set(card.hash, card);
}
async function deleteCard(hash, userId) {
  if (!isValidHash(hash))
    return;
  try {
    await spindle.userStorage.delete(cardPath(hash), userId);
  } catch {}
  cachesFor(userId).cards.set(hash, null);
}
async function loadSettings(userId) {
  const cache = cachesFor(userId);
  if (cache.settings)
    return cache.settings;
  let settings;
  try {
    settings = normalizeSettings(await spindle.userStorage.getJson("settings.json", { fallback: {}, userId }));
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  cache.settings ??= settings;
  return cache.settings;
}
async function saveSettings(settings, userId) {
  cachesFor(userId).settings = settings;
  await spindle.userStorage.setJson("settings.json", settings, { indent: 2, userId });
}
function str(v) {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}
function sanitizeCard(raw, hash) {
  if (!raw || typeof raw !== "object")
    return null;
  const r = raw;
  const source = r.source === "llm" || r.source === "edited" ? r.source : "manual";
  const updatedAt = typeof r.updatedAt === "number" ? r.updatedAt : Date.now();
  return {
    hash,
    label: str(r.label),
    presupposes: str(r.presupposes),
    scene: str(r.scene),
    mood: str(r.mood),
    doneWhen: str(r.doneWhen),
    with: str(r.with),
    source,
    updatedAt
  };
}
async function getChat(chatId, userId) {
  const cache = cachesFor(userId).chats;
  if (cache.has(chatId))
    return cache.get(chatId) ?? null;
  if (!has("chats"))
    return null;
  let chat = null;
  try {
    chat = await spindle.chats.get(chatId, userId);
  } catch (err) {
    spindle.log.warn(`${LOG} chats.get failed: ${errMsg(err)}`);
  }
  cache.set(chatId, chat);
  return chat;
}
async function getCharacter(characterId, userId) {
  const cache = cachesFor(userId).characters;
  if (cache.has(characterId))
    return cache.get(characterId) ?? null;
  if (!has("characters"))
    return null;
  let character = null;
  try {
    character = await spindle.characters.get(characterId, userId);
  } catch (err) {
    spindle.log.warn(`${LOG} characters.get failed: ${errMsg(err)}`);
  }
  cache.set(characterId, character);
  return character;
}
async function chatGreetings(chat, userId) {
  const cache = cachesFor(userId).greetings;
  const cached = cache.get(chat.id);
  if (cached)
    return cached;
  const info = groupInfo(chat.metadata, chat.character_id);
  const greetings = [];
  const members = [];
  const seen = new Set;
  for (const id of info.memberIds) {
    const character = await getCharacter(id, userId);
    if (!character) {
      if (id === chat.character_id)
        return null;
      spindle.log.warn(`${LOG} group member ${id} could not be loaded; its greetings are skipped`);
      continue;
    }
    members.push({ id, name: character.name });
    for (const g of greetingTexts(character)) {
      const hash = await hashGreeting(g.text);
      if (seen.has(hash))
        continue;
      seen.add(hash);
      greetings.push({ index: g.index, hash, text: g.text, characterId: id, characterName: character.name });
    }
  }
  const pooled = { greetings, members };
  cache.set(chat.id, pooled);
  return pooled;
}
function greetingTexts(character) {
  const out = [];
  if (typeof character.first_mes === "string" && character.first_mes.trim())
    out.push({ index: 0, text: character.first_mes });
  const alts = Array.isArray(character.alternate_greetings) ? character.alternate_greetings : [];
  alts.forEach((text, i) => {
    if (typeof text === "string" && text.trim())
      out.push({ index: i + 1, text });
  });
  return out;
}
async function resolveOne(macro, chatId, characterId, userId) {
  try {
    const { text } = await spindle.macros.resolve(macro, {
      chatId,
      characterId: characterId ?? undefined,
      userId,
      commit: false
    });
    const t = text.trim();
    if (!t || t.includes("{{"))
      return null;
    return t;
  } catch {
    return null;
  }
}
async function resolveNames(chatId, characterId, userId, preferRecord = false) {
  const cacheKey = `${chatId}:${characterId ?? ""}:${preferRecord ? "r" : "m"}`;
  const cache = cachesFor(userId).names;
  const cached = cache.get(cacheKey);
  if (cached)
    return cached;
  const [charName, userName] = await Promise.all([
    preferRecord ? Promise.resolve(null) : resolveOne("{{char}}", chatId, characterId, userId),
    resolveOne("{{user}}", chatId, characterId, userId)
  ]);
  let char = charName;
  if (!char && characterId)
    char = (await getCharacter(characterId, userId))?.name ?? null;
  const names = { char: char ?? "the character", user: userName ?? "the user" };
  cache.set(cacheKey, names);
  return names;
}
var interceptorRegistered = false;
function tryRegisterInterceptor() {
  if (interceptorRegistered || !has("interceptor"))
    return;
  spindle.registerInterceptor(async (messages, context) => {
    try {
      if (context.generationType === "impersonate" || context.generationType === "quiet")
        return messages;
      const chatId = context.chatId;
      if (!chatId)
        return messages;
      const userId = actingUser(context.userId, false);
      const route = await loadRoute(chatId, userId);
      if (!route || !route.enabled || route.route.length === 0)
        return messages;
      const stageHash = route.route[route.stageIndex];
      if (!stageHash)
        return messages;
      const card = await loadCard(stageHash, userId);
      if (!card)
        return messages;
      if (!card.scene && !card.mood)
        return messages;
      const enteredAt = route.enteredAt[route.stageIndex];
      const anchorId = anchorFor(route);
      const counted = repliesSince(messages, { anchorId, enteredAt: enteredAt ?? 0, excludeId: context.excludeMessageId ?? null });
      if (counted.by === "position" && !fallbackIndexLogged.has(chatId)) {
        fallbackIndexLogged.add(chatId);
        spindle.log.warn(`${LOG} sourceIndexInChat absent on history messages for chat ${chatId}; counting replies by position`);
      }
      const tier = chooseTier({ stageIndex: route.stageIndex, stageCount: route.route.length, enteredAt, replies: counted.replies });
      const due = reminderDue({ stageIndex: route.stageIndex, replies: counted.replies, every: reminderEveryFor(route) });
      const tail = messages.filter((m) => m.__isChatHistory === true).slice(-4).map((m) => `${m.role}#${m.sourceIndexInChat ?? "?"}${anchorId && m.sourceMessageId === anchorId ? "*" : ""}(${typeof m.content === "string" ? m.content.length : "parts"})`).join(" ");
      spindle.log.info(`${LOG} ${context.generationType}${context.isDryRun ? " dry-run" : ""} chat ${chatId} stage ${route.stageIndex + 1}: replies since entry ${counted.replies} by ${counted.by}${anchorId ? "" : " (no anchor)"}, ${due ? `${tier} note` : "no note"}; tail ${tail}${context.excludeMessageId ? ` exclude ${context.excludeMessageId}` : ""}`);
      if (!due)
        return messages;
      if (route.skipNote) {
        spindle.log.info(`${LOG} note skipped by the user for chat ${chatId} stage ${route.stageIndex + 1}`);
        return messages;
      }
      const chat = await getChat(chatId, userId);
      const pooled = chat ? await chatGreetings(chat, userId) : null;
      const owner = pooled?.greetings.find((g) => g.hash === stageHash)?.characterId ?? null;
      const speaker = context.characterId || route.characterId || null;
      const isGroup = chat ? groupInfo(chat.metadata, chat.character_id).isGroup : false;
      const names = await resolveNames(chatId, owner ?? speaker, userId, isGroup || owner !== null && owner !== speaker);
      const settings = await loadSettings(userId);
      const textNames = isGroup && speaker && speaker !== (owner ?? speaker) ? await resolveNames(chatId, speaker, userId, true) : names;
      const directive = renderDirective(tier, card, names, { ...noteOptions(route, stageHash, settings, isGroup), textNames });
      const result = injectDirective(messages, directive.text, route.injectMode, depthFor(route));
      spindle.log.info(`${LOG} injected as ${result.appliedMode} (speaker ${speaker ?? "?"}, card owner ${owner ?? "?"})`);
      if (result.injectedIndex === null)
        return { messages: result.messages };
      return {
        messages: result.messages,
        breakdown: [{ messageIndex: result.injectedIndex, name: breakdownName(route.stageIndex, route.route.length, tier) }]
      };
    } catch (err) {
      spindle.log.warn(`${LOG} interceptor degraded safely: ${errMsg(err)}`);
      return messages;
    }
  }, INTERCEPTOR_PRIORITY);
  interceptorRegistered = true;
  spindle.log.info(`${LOG} interceptor registered.`);
}
tryRegisterInterceptor();
spindle.permissions.onChanged(({ permission, granted }) => {
  if (granted && permission === "interceptor")
    tryRegisterInterceptor();
});
var onEvent = spindle.on;
var clearCharacters = () => eachUser((c) => {
  c.characters.clear();
  c.greetings.clear();
  c.names.clear();
});
onEvent("CHARACTER_EDITED", clearCharacters);
onEvent("CHARACTER_DELETED", clearCharacters);
onEvent("PERSONA_CHANGED", () => eachUser((c) => {
  c.names.clear();
  c.resolvedGreetings.clear();
}));
onEvent("CHAT_FORKED", (payload, eventUserId) => {
  (async () => {
    const p = payload;
    if (!p || typeof p.sourceChatId !== "string" || typeof p.forkedChatId !== "string")
      return;
    const userId = actingUser(eventUserId);
    if (!userId && knownUsers.size > 1) {
      spindle.log.warn(`${LOG} CHAT_FORKED arrived without a user id on a multi-user install; route not copied to ${p.forkedChatId}`);
      return;
    }
    try {
      const source = await loadRoute(p.sourceChatId, userId);
      if (!source)
        return;
      if (await loadRoute(p.forkedChatId, userId))
        return;
      const count = typeof p.forkedAtMessageIndex === "number" ? p.forkedAtMessageIndex + 1 : source.enteredAt[source.stageIndex] ?? 0;
      const copied = forkRoute(source, p.forkedChatId, count);
      await saveRoute(copied, userId);
      spindle.log.info(`${LOG} copied route to forked chat ${p.forkedChatId} (stage ${copied.stageIndex + 1}/${copied.route.length})`);
    } catch (err) {
      spindle.log.warn(`${LOG} could not copy route to forked chat: ${errMsg(err)}`);
    }
  })();
});
onEvent("CHAT_CHANGED", (payload) => {
  const id = payload?.chat?.id;
  if (typeof id === "string")
    eachUser((c) => {
      c.chats.delete(id);
      c.greetings.delete(id);
    });
});
async function listConnections(userId) {
  if (!has("generation"))
    return [];
  try {
    const list = await spindle.connections.list(userId);
    return list.map((c) => ({ id: c.id, name: c.name, provider: c.provider, model: c.model, is_default: c.is_default }));
  } catch (err) {
    spindle.log.warn(`${LOG} connections.list failed: ${errMsg(err)}`);
    return [];
  }
}
async function resolvedGreeting(chatId, characterId, hash, text, userId) {
  const key = `${chatId}:${hash}`;
  const cache = cachesFor(userId).resolvedGreetings;
  const cached = cache.get(key);
  if (cached !== undefined)
    return cached;
  let resolved = text;
  try {
    resolved = (await spindle.macros.resolve(text, { chatId, characterId, userId, commit: false })).text;
  } catch {}
  if (cache.size > 500)
    cache.clear();
  cache.set(key, resolved);
  return resolved;
}
async function matchOpening(chatId, characterId, greetings, readings, userId) {
  const candidates = [];
  for (const g of greetings) {
    if (g.index < 0)
      continue;
    const resolved = await resolvedGreeting(chatId, characterId, g.hash, g.text, userId);
    candidates.push({ key: g.hash, texts: resolved === g.text ? [g.text] : [g.text, resolved] });
  }
  return matchGreeting(candidates, readings);
}
async function buildPanelState(chatId, userId, openingText, openingProbe, openingCandidates) {
  if (chatId) {
    const openings = cachesFor(userId).openings;
    if (openingProbe !== undefined)
      openings.set(chatId, { text: openingText ?? null, probe: openingProbe, candidates: openingCandidates ?? [] });
    else {
      const prev = openings.get(chatId);
      if (prev) {
        openingText = prev.text;
        openingProbe = prev.probe;
        openingCandidates = prev.candidates;
      }
    }
  }
  const [permissions, settings, connections] = await Promise.all([
    spindle.permissions.getGranted().catch(() => []),
    loadSettings(userId),
    listConnections(userId)
  ]);
  const state = {
    chatId,
    characterId: null,
    characterName: null,
    greetings: [],
    route: null,
    connections,
    settings,
    permissions
  };
  if (!chatId)
    return state;
  const chat = await getChat(chatId, userId);
  if (!chat) {
    state.error = has("chats") ? "Could not load this chat." : 'The "chats" permission is required to read the active chat.';
    return state;
  }
  state.characterId = chat.character_id;
  const info = groupInfo(chat.metadata, chat.character_id);
  if (info.isGroup)
    state.isGroup = true;
  const pooled = await chatGreetings(chat, userId);
  if (!pooled) {
    state.error = has("characters") ? "Could not load the character for this chat." : 'The "characters" permission is required to read greetings.';
  } else {
    state.characterName = pooled.members[0]?.name ?? null;
    if (info.isGroup)
      state.members = pooled.members;
    const greetings = [];
    for (const g of pooled.greetings)
      greetings.push({ ...g, card: await loadCard(g.hash, userId) });
    state.greetings = greetings;
    const readings = [openingText, ...openingCandidates ?? []].filter((t) => typeof t === "string" && t.trim().length > 0);
    if (readings.length > 0) {
      state.openingHash = await matchOpening(chatId, chat.character_id, greetings, readings, userId);
      state.openingStatus = state.openingHash ? "matched" : "no-match";
      if (!state.openingHash)
        state.openingSample = sample(readings[0]);
      spindle.log.info(`${LOG} opening greeting ${state.openingStatus} for chat ${chatId} (${readings.length} readings, first ${readings[0].length} chars starting "${sample(readings[0], 60)}", ${greetings.length} greetings)`);
    } else {
      state.openingStatus = openingProbe ?? "no-text";
    }
    if (!state.openingHash && info.activeGreetingIndex !== null) {
      const byIndex = greetings.find((g) => g.characterId === chat.character_id && g.index === info.activeGreetingIndex);
      if (byIndex) {
        state.openingHash = byIndex.hash;
        state.openingStatus = "matched";
        delete state.openingSample;
        spindle.log.info(`${LOG} opening greeting taken from chat metadata (activeGreetingIndex ${info.activeGreetingIndex}) for chat ${chatId}`);
      }
    }
  }
  state.route = await loadRoute(chatId, userId);
  if (state.route) {
    for (const hash of state.route.route) {
      if (!state.greetings.some((g) => g.hash === hash)) {
        const card = await loadCard(hash, userId);
        if (card)
          state.greetings.push({ index: -1, hash, text: "", card });
      }
    }
  }
  return state;
}
function send(message, userId) {
  spindle.sendToFrontend(message, userId);
}
async function pushStateFor(chatId, userId, openingText, openingProbe, openingCandidates) {
  try {
    send({ type: "state", state: await buildPanelState(chatId, userId, openingText, openingProbe, openingCandidates) }, userId);
  } catch (err) {
    send({ type: "error", message: `Could not load Stagecoach state: ${errMsg(err)}` }, userId);
  }
}
async function routeForWrite(chatId, userId) {
  const existing = await loadRoute(chatId, userId);
  if (existing)
    return existing;
  const chat = await getChat(chatId, userId);
  if (!chat)
    return null;
  return newRoute(chatId, chat.character_id);
}
function distillSystem(words) {
  return [
    'You turn one greeting from a roleplay character card into a compact "stage card": a description of the story stage that greeting opens.',
    "Reply with a single JSON object and nothing else, with exactly these string keys:",
    '- "label": a 2-4 word name for this stage.',
    `- "presupposes": what must already be true before this scene can open. Describe STATE, not events. At most ${words} words.`,
    `- "scene": where and when, and what {{char}} is doing or has arranged. {{user}} may be present, but never describe anything {{user}} does, says, feels, or where {{user}} sits or stands. No dialogue. At most ${words} words.`,
    `- "mood": tone, plus an explicit ceiling on intimacy or heat for this stage. At most ${words} words.`,
    "Keep the placeholders {{char}} and {{user}} exactly as written; never replace them with names. Write in the present tense. Do not quote the greeting.",
    "",
    "Example output for a greeting where the character has invited the user to sit by the fire after weeks of riding together:",
    '{"label":"Fireside evening","presupposes":"Some weeks have passed. {{user}} has ridden with {{char}} several times and the formality between them has worn off.","scene":"Evening at the ranch house, fire lit, a bottle {{char}} has been saving. {{char}} has cleared the evening for just the two of them.","mood":"Warm, charged, unhurried. Flirtation is mutual; nothing physical has happened yet."}'
  ].join(`
`);
}
function extractContent(result) {
  if (typeof result === "string")
    return result;
  if (result && typeof result === "object") {
    const r = result;
    if (typeof r.content === "string")
      return r.content;
    if (typeof r.text === "string")
      return r.text;
    const choices = r.choices;
    const c = choices?.[0]?.message?.content;
    if (typeof c === "string")
      return c;
  }
  return "";
}
function parseStageJson(text) {
  let body = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start)
    throw new Error(`No JSON object in reply: ${text.slice(0, 200)}`);
  body = body.slice(start, end + 1);
  const parsed = JSON.parse(body);
  const card = {
    label: str(parsed.label),
    presupposes: str(parsed.presupposes),
    scene: str(parsed.scene),
    mood: str(parsed.mood),
    doneWhen: str(parsed.doneWhen),
    source: "llm"
  };
  if (!card.scene && !card.mood)
    throw new Error('Reply had no usable "scene" or "mood" field.');
  return card;
}
async function distill(chatId, hash, connectionId, runId, userId) {
  if (!has("generation"))
    throw new Error('The "generation" permission is required for Distill.');
  const chat = await getChat(chatId, userId);
  const pooled = chat ? await chatGreetings(chat, userId) : null;
  if (!pooled)
    throw new Error("Could not load the character for this chat.");
  const owned = pooled.greetings.find((g) => g.hash === hash) ?? null;
  const greeting = owned?.text ?? null;
  const characterId = owned?.characterId ?? chat.character_id;
  if (!greeting)
    throw new Error("That greeting is no longer on the character (it may have been edited).");
  let model;
  let resolvedConnectionId = connectionId ?? undefined;
  try {
    let conn = connectionId ? await spindle.connections.get(connectionId, userId) : null;
    if (!conn) {
      const list = await spindle.connections.list(userId);
      conn = list.find((c) => c.is_default) ?? list[0] ?? null;
      if (!conn)
        throw new Error("No connections are configured. Add one under Connections, then pick it in the Distill dropdown.");
    }
    resolvedConnectionId = conn.id;
    if (conn.model)
      model = conn.model;
  } catch (err) {
    throw new Error(`Could not resolve a connection for Distill: ${errMsg(err)}`);
  }
  const { distillWords } = tokenLimitsFor(await loadSettings(userId));
  const request = {
    type: "raw",
    messages: [
      { role: "system", content: distillSystem(distillWords) },
      { role: "user", content: `Greeting:

${greeting}` }
    ],
    connection_id: resolvedConnectionId,
    reasoning: { source: "off" },
    userId,
    signal: AbortSignal.timeout(120000)
  };
  if (model) {
    request.model = model;
    request.parameters = { model };
  }
  const result = await spindle.generate.raw(request);
  const card = parseStageJson(extractContent(result));
  send({ type: "distill_result", hash, runId, card }, userId);
}
spindle.onFrontendMessage(async (payload, userId) => {
  const uid = actingUser(userId);
  const msg = payload;
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string")
    return;
  if (!uid && knownUsers.size > 1) {
    spindle.log.warn(`${LOG} ${msg.type} arrived without a user id on a multi-user install; ignored`);
    return;
  }
  try {
    switch (msg.type) {
      case "get_state":
        await pushStateFor(msg.chatId, uid, msg.openingText, msg.openingProbe, Array.isArray(msg.openingCandidates) ? msg.openingCandidates.filter((t) => typeof t === "string") : undefined);
        break;
      case "set_reminder_every": {
        const route = await routeForWrite(msg.chatId, uid);
        if (!route)
          throw new Error("Could not load this chat.");
        await saveRoute(setReminderEvery(route, Number(msg.every)), uid);
        await pushStateFor(msg.chatId, uid);
        break;
      }
      case "sync_count": {
        const route = await loadRoute(msg.chatId, uid);
        if (!route)
          break;
        const rewound = rewindTo(route, Number(msg.messageCount) || 0, 1);
        if (rewound !== route) {
          await saveRoute(rewound, uid);
          spindle.toast.info(`Messages were deleted past a stage change. Stagecoach rewound to stage ${rewound.stageIndex + 1}.`, { userId: uid });
          await pushStateFor(msg.chatId, uid);
        }
        break;
      }
      case "set_enabled": {
        const route = await routeForWrite(msg.chatId, uid);
        if (!route)
          throw new Error("Could not load this chat.");
        await saveRoute({ ...route, enabled: msg.enabled === true }, uid);
        await pushStateFor(msg.chatId, uid);
        break;
      }
      case "set_route": {
        const route = await routeForWrite(msg.chatId, uid);
        if (!route)
          throw new Error("Could not load this chat.");
        const hashes = Array.isArray(msg.route) ? msg.route.filter(isValidHash) : [];
        await saveRoute(applyRoute(route, hashes, Number(msg.messageCount) || 0), uid);
        await pushStateFor(msg.chatId, uid);
        break;
      }
      case "set_stage": {
        const route = await routeForWrite(msg.chatId, uid);
        if (!route)
          throw new Error("Could not load this chat.");
        await saveRoute(setStage(route, Number(msg.stageIndex) || 0, Number(msg.messageCount) || 0, typeof msg.latestMessageId === "string" ? msg.latestMessageId : null), uid);
        await pushStateFor(msg.chatId, uid);
        break;
      }
      case "set_note": {
        const route = await routeForWrite(msg.chatId, uid);
        if (!route)
          throw new Error("Could not load this chat.");
        const next = msg.armed ? replayStage(route, Number(msg.messageCount) || 0, typeof msg.latestMessageId === "string" ? msg.latestMessageId : null) : skipNote(route);
        await saveRoute(next, uid);
        await pushStateFor(msg.chatId, uid);
        break;
      }
      case "set_inject_mode": {
        const route = await routeForWrite(msg.chatId, uid);
        if (!route)
          throw new Error("Could not load this chat.");
        const injectMode = msg.injectMode === "system-at-depth" ? "system-at-depth" : "append-to-last-user";
        await saveRoute({ ...route, injectMode }, uid);
        await pushStateFor(msg.chatId, uid);
        break;
      }
      case "set_depth": {
        const route = await routeForWrite(msg.chatId, uid);
        if (!route)
          throw new Error("Could not load this chat.");
        await saveRoute(setDepth(route, Number(msg.depth)), uid);
        await pushStateFor(msg.chatId, uid);
        break;
      }
      case "set_transition": {
        const route = await routeForWrite(msg.chatId, uid);
        if (!route)
          throw new Error("Could not load this chat.");
        if (!isValidHash(msg.hash) || !isTransitionStyle(msg.style))
          throw new Error("Invalid transition.");
        await saveRoute(setTransition(route, msg.hash, msg.style), uid);
        await pushStateFor(msg.chatId, uid);
        break;
      }
      case "save_card": {
        const raw = msg.card;
        if (!raw || !isValidHash(raw.hash))
          throw new Error("Invalid stage card.");
        const card = sanitizeCard(raw, raw.hash);
        if (!card)
          throw new Error("Invalid stage card.");
        card.updatedAt = Date.now();
        await saveCard(card, uid);
        const est = estimateTokens([card.presupposes, card.scene, card.mood, card.doneWhen].join(" "));
        spindle.toast.success(`Saved "${card.label || "stage card"}" (~${est} tokens).`, { userId: uid });
        await pushStateFor(msg.chatId, uid);
        break;
      }
      case "delete_card":
        await deleteCard(msg.hash, uid);
        await pushStateFor(msg.chatId, uid);
        break;
      case "distill":
        try {
          await distill(msg.chatId, msg.hash, msg.connectionId ?? null, typeof msg.runId === "string" ? msg.runId : undefined, uid);
        } catch (err) {
          send({ type: "distill_error", hash: msg.hash, runId: typeof msg.runId === "string" ? msg.runId : undefined, message: errMsg(err) }, uid);
        }
        break;
      case "set_settings": {
        const next = applySettingsPatch(await loadSettings(uid), msg.settings ?? {});
        await saveSettings(next, uid);
        await pushStateFor(msg.chatId, uid);
        break;
      }
      case "count_tokens": {
        const text = typeof msg.text === "string" ? msg.text : "";
        try {
          const r = await spindle.tokens.countText(text, { modelSource: "main", userId: uid });
          send({ type: "token_count", requestId: msg.requestId, tokens: r.total_tokens, approximate: r.approximate }, uid);
        } catch {
          send({ type: "token_count", requestId: msg.requestId, tokens: estimateTokens(text), approximate: true }, uid);
        }
        break;
      }
    }
  } catch (err) {
    spindle.log.error(`${LOG} ${msg.type} failed: ${errMsg(err)}`);
    send({ type: "error", message: errMsg(err) }, uid);
  }
});
spindle.log.info(`${LOG} backend loaded.`);
