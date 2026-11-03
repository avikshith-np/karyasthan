// The rules of a changing mind (plan 020 B). Pure: no DB, no clock, no model. Interests and opinions move
// only from evidence he lived, a little at a time, pulled back toward who he is. Every value is a fold over
// live evidence, so undoing the evidence recomputes it exactly.
//
//   evidenceFrom(events, ctx)   world events → evidence items (signed weight, event ids, origin, cause code)
//   stepNight(row, value, items, ctx)  one night → the next value and confidence
//   replay(row, nights, itemsByNight)  the whole fold from base_value
//   whyWords(item, ctx), lineFor(row, label), trendOf(history)
//
// Evidence is world events only: never a stance, a thought, an episode or a model's words, so a reflection
// can't cite a reflection. A chat's evidence is a code and an origin; its share of a night is capped, so the
// last person to speak can't move him much. No evidence: a value only drifts toward its anchor.

export const STEP = Object.freeze({ interest: 0.07, opinion: 0.09 });   // the most a night can move it, at uptake 1: a strong outing shows
export const ANCHOR_PULL = 0.03;          // the share of the distance to the anchor closed each night
export const REACH = Object.freeze({ interest: 0.3, opinion: 0.5 });   // how far he can go from who he is: a step away shrinks with the room left
export const GRACE_NIGHTS = 7;            // no evidence for this long: the pull starts
export const FADE_AFTER_NIGHTS = 14;      // an interest unused this long fades below its anchor
export const FADE_BELOW = 0.1;
export const FADE_RATE = 0.004;
export const CHAT_NIGHT_MAX = 0.14;       // chats' whole say in a night's sum
export const CHAT_PER_CHAT = 0.07;        // one chat's say
export const NIGHT_SUM_MAX = 1;
export const BOTH_MIN = 0.2;
export const HABIT_NIGHTS = 7;            // done on most of the last week: it counts for less
export const HABIT_MIN = 5;
export const HABIT_SCALE = 0.25;
export const EVIDENCE_NIGHTS = 60;
export const CONF_FLOOR = 0.1;

const CHAT_ORIGINS = new Set(['group', 'dm', 'call', 'ig']);
const OUTCOME_WEIGHT = Object.freeze({ well: 1, fine: 0.05, flat: -0.4, badly: -1 });
const AFFECT_WEIGHT = Object.freeze({ praise: 0.3, support: 0.3, good_news: 0.15, roast: -0.3, argument: -0.35, bad_news: -0.15, flirt: 0.15 });
const ROUTINE_NO_TIME = new Set(['work', 'meeting', 'commute', 'lunch', 'breakfast', 'dinner', 'snack', 'sleep', 'free', 'sick', 'rest', 'groceries', 'errand', 'call', 'idle']);
const TIRED_ENERGY = 40;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const round = (x) => Math.round(x * 10000) / 10000;

export const rangeOf = (kind) => (kind === 'opinion' ? [-1, 1] : [0, 1]);
export const neutralOf = (kind) => (kind === 'opinion' ? 0 : 0.5);
export const kindOfTopic = (topic) => (String(topic).startsWith('kind:') || String(topic).startsWith('place:') ? 'interest' : 'opinion');
export const uptakeOf = (topic) => (String(topic).startsWith('fixed:') ? 0.6 : String(topic).startsWith('place:') ? 0.8 : 1);
const originOf = (e) => ({ ...(CHAT_ORIGINS.has(e?.originKind) ? { kind: e.originKind, jid: e.originJid ?? null } : { kind: 'self', jid: null }), subject: e?.subjectJid ?? null });

/**
 * World events (live, in id order) → evidence items. ctx: { homeIds: Set, activeCast: Set, heavyAt(at), startOf(activityId), energyAt(at),
 * kindOfDecision(id) }. An item: { topic, source, cause, weight, eventIds, originKind, originJid, at, details }.
 */
export function evidenceFrom(events, ctx = {}) {
  const out = [];
  const heavyAt = ctx.heavyAt ?? (() => false);
  const push = (e, topic, source, cause, weight, details = null, origin = originOf(e), extraIds = []) => {
    if (!topic || !finite(weight) || weight === 0) return;
    out.push({ topic, source, cause, weight: round(weight), eventIds: [e.id, ...extraIds], originKind: origin.kind, originJid: origin.jid, subjectJid: origin.subject ?? null, at: e.at, details,
      // The chat's own time, not the life event's: the audience rule is checked there. Unknown → 0, which fails closed.
      ...(CHAT_ORIGINS.has(origin.kind) ? { originAt: ctx.originAt ? ctx.originAt(e, origin) ?? 0 : e.at } : {}) });
  };
  const placeTopic = (id) => (typeof id === 'string' && id.startsWith('place:') && !ctx.homeIds?.has?.(id) ? id : null);
  for (const e of events) {
    if (e?.redacted || e?.heavy === true || ctx.isHeavyChain?.(e) || heavyAt(e.at)) continue;
    const p = e.payload ?? {};
    switch (e.type) {
      case 'scene.played': {
        const w = OUTCOME_WEIGHT[p.outcome];
        if (w === undefined || p.heavyWindow === true) break;
        const chat = CHAT_ORIGINS.has(e.originKind) || e.subjectJid;
        const scale = chat ? 0.4 : 1;
        const cause = `scene:${p.outcome}`;
        const details = { kind: p.kind ?? null, placeId: p.placeId ?? null };
        push(e, p.kind ? `kind:${p.kind}` : null, 'scene', cause, w * scale, details);
        push(e, placeTopic(p.placeId), 'scene', cause, w * scale * 0.8, details);
        if (!chat && p.mode === 'full') for (const id of Array.isArray(p.castIds) ? p.castIds : []) if (ctx.activeCast?.has?.(id) && String(id).startsWith('cast:')) push(e, id, 'scene', cause, w, details);
        // He went tired, and it told on him: a little against this kind of outing.
        const energy = ctx.energyAt?.(p.startAt ?? e.at);
        if (!chat && finite(energy) && energy < TIRED_ENERGY && p.kind) push(e, `kind:${p.kind}`, 'tired', 'tired_out', -0.12, details);
        break;
      }
      case 'activity.ended': {
        const start = ctx.startOf?.(e.causeId);
        const kind = start?.payload?.kind;
        if (!kind || ROUTINE_NO_TIME.has(kind) || !finite(start.at)) break;
        const hours = (e.at - start.at) / 3600;
        if (hours < 0.5) break;
        const w = 0.025 * Math.min(hours, 3);   // being there keeps it alive; how it went says which way
        const details = { hours: Math.round(hours * 10) / 10, kind, placeId: start.payload?.placeId ?? null };
        const origin = originOf(start);
        const scale = origin.kind === 'self' && !start.subjectJid ? 1 : 0.4;
        push(e, `kind:${kind}`, 'time', 'time_spent', w * scale, details, origin, [start.id]);
        push(e, placeTopic(start.payload?.placeId), 'time', 'time_spent', w * scale * 0.8, details, origin, [start.id]);
        break;
      }
      case 'money.spent': {
        if (!['outing', 'food'].includes(p.for) || !p.kind || ROUTINE_NO_TIME.has(p.kind)) break;
        const details = { kind: p.kind, placeId: p.placeId ?? null };
        push(e, `kind:${p.kind}`, 'money', 'money_spent', e.subjectJid || CHAT_ORIGINS.has(e.originKind) ? 0.005 : 0.012, details);
        break;
      }
      case 'decision.committed':
      case 'decision.reversed': {
        // He had the chance and chose not to. Only for what he already has a view on; the owner's calls aren't his.
        if (e.actor === 'owner') break;
        const opened = ctx.decisionOf?.(p.decisionId);
        const optionId = e.type === 'decision.committed' ? p.optionId : p.to;
        const option = opened?.payload?.options?.find?.(o => o?.id === optionId);
        if (!option || option.go === true || option.go === 'late' || optionId === 'go' || optionId === 'late') break;
        const scale = CHAT_ORIGINS.has(opened.originKind) || opened.subjectJid ? 0.4 : 1;
        const origin = originOf(opened);
        const details = { placeId: opened.payload?.subject?.placeId ?? null };
        const before = out.length;
        if (typeof opened.payload?.kind === 'string') push(e, `kind:${opened.payload.kind}`, 'choice', 'chose_not_to', -0.05 * scale, details, origin);
        push(e, placeTopic(opened.payload?.subject?.placeId), 'choice', 'chose_not_to', -0.04 * scale, details, origin);
        for (const it of out.slice(before)) it.existingOnly = true;
        break;
      }
      case 'work.late': push(e, 'fixed:work', 'work', 'work_late', -0.2); break;
      case 'work.crunch': push(e, 'fixed:work', 'work', 'work_crunch', -0.3); break;
      case 'career.appraisal': {
        const band = p.band;
        if (band === 'good' || band === 'great') push(e, 'fixed:work', 'work', 'appraisal_good', 0.8);
        else if (band === 'poor') push(e, 'fixed:work', 'work', 'appraisal_poor', -0.8);
        break;
      }
      case 'commute.soaked': push(e, 'fixed:weather', 'weather', 'soaked', -0.25); break;
      case 'money.salary': push(e, 'fixed:money', 'money', 'salary', 0.1); break;
      case 'meal': {
        if (p.good === true) push(e, 'fixed:food', 'meal', 'good_meal', 0.02);
        break;
      }
      case 'chat.perceived': {
        // A chat's mark: its affect code and its origin, never a word.
        if (p.kind !== 'affect' || !CHAT_ORIGINS.has(e.originKind)) break;
        const w = AFFECT_WEIGHT[p.affect];
        if (w !== undefined) push(e, 'fixed:people', 'chat', `chat:${p.affect}`, w);
        break;
      }
      case 'invite.answered': {
        if (!CHAT_ORIGINS.has(e.originKind)) break;
        const kind = ctx.decisionOf?.(p.decisionId)?.payload?.kind;
        if (typeof kind !== 'string') break;
        const yes = p.answer === 'yes' || p.answer === 'late';
        if (yes || p.answer === 'no') push(e, `kind:${kind}`, 'chat', yes ? 'invite_yes' : 'invite_no', yes ? 0.05 : -0.03, { kind });
        break;
      }
      default:
    }
  }
  return out;
}

// A night's say: chats capped, per chat and in all; then the whole sum.
export function nightSum(items) {
  let own = 0;
  const perChat = new Map();
  for (const i of items) {
    if (CHAT_ORIGINS.has(i.originKind)) {
      const k = i.originJid ?? '?';
      perChat.set(k, (perChat.get(k) ?? 0) + i.weight);
    } else own += i.weight;
  }
  let chats = 0;
  for (const v of perChat.values()) chats += clamp(v, -CHAT_PER_CHAT, CHAT_PER_CHAT);
  chats = clamp(chats, -CHAT_NIGHT_MAX, CHAT_NIGHT_MAX);
  return clamp(own + chats, -NIGHT_SUM_MAX, NIGHT_SUM_MAX);
}

/**
 * One night. ctx: { nightsSince } = nights since evidence last touched it. → { value, confidence, moved }.
 * With evidence: a bounded step, halved when it pulls both ways, and a small pull back to the anchor. Without:
 * nothing for a while, then only toward the anchor, and an interest long unused fades a little below it.
 */
export function stepNight(row, value, items, { nightsSince = 0, confidence = row.confidence ?? 0.5 } = {}) {
  const [lo, hi] = rangeOf(row.kind);
  const span = hi - lo;
  let v = value;
  let c = confidence;
  if (items.length) {
    const sum = nightSum(items);
    // Pulled both ways by things that mattered: being there doesn't soften a bad night.
    const both = items.some(i => i.weight >= BOTH_MIN) && items.some(i => i.weight <= -BOTH_MIN);
    const e = clamp(sum / NIGHT_SUM_MAX, -1, 1);
    const away = e !== 0 && (e > 0) === (value >= row.anchor);
    const reach = REACH[row.kind] ?? REACH.interest;
    const room = away ? Math.max(0, 1 - Math.abs(value - row.anchor) / reach) : 1;
    const step = (row.uptake ?? 1) * e * (STEP[row.kind] ?? STEP.interest) * (both ? 0.5 : 1) * room;
    const pulled = (row.anchor - v) * ANCHOR_PULL;
    v = v + step + pulled;
    // Sure of it when the evidence agrees with where he stands; less sure when it doesn't, or pulls both ways.
    const agrees = Math.sign(sum) === Math.sign(value - (lo + span / 2)) || value === lo + span / 2;
    c += both ? -0.02 : agrees ? 0.01 : -0.015;
  } else if (nightsSince >= GRACE_NIGHTS) {
    const fading = row.kind === 'interest' && nightsSince >= FADE_AFTER_NIGHTS;
    const target = fading ? Math.max(lo, row.anchor - FADE_BELOW) : row.anchor;
    if (v > target) v = Math.max(target, v - Math.max((v - target) * ANCHOR_PULL, fading ? FADE_RATE : 0));
    else if (v < target && !fading) v = Math.min(target, v + (target - v) * ANCHOR_PULL);
    c -= 0.002;
  }
  return { value: round(clamp(v, lo, hi)), confidence: round(clamp(c, CONF_FLOOR, 1)) };
}

/**
 * The fold: base_value through every night after base_night. nights: ascending keys. itemsByNight: Map(night → items).
 * → { value, confidence, rows: [{ night, before, after, confidence, count, since }], lastReinforcedNight }.
 */
export function replay(row, nights, itemsByNight) {
  let value = row.baseValue;
  let confidence = row.baseConfidence ?? 0.5;
  let since = row.baseSince ?? 0;
  const rows = [];
  let lastNight = null;
  const habit = Array.isArray(row.baseHabit) ? [...row.baseHabit] : [];   // the recent nights with time spent on it, oldest first (carried past a base)
  for (const night of nights) {
    const raw = itemsByNight.get(night) ?? [];
    // Done most days it stops telling him anything new.
    const spent = raw.some(i => i.cause === 'time_spent');
    const used = habit.slice(-(HABIT_NIGHTS - 1)).filter(Boolean).length + (spent ? 1 : 0);
    const items = spent && used >= HABIT_MIN ? raw.map(i => (i.cause === 'time_spent' ? { ...i, weight: i.weight * HABIT_SCALE } : i)) : raw;
    habit.push(spent);
    const before = value;
    const r = stepNight(row, value, items, { nightsSince: since, confidence });
    value = r.value;
    confidence = r.confidence;
    if (items.length) { since = 0; lastNight = night; } else since += 1;
    rows.push({ night, before, after: value, confidence, count: items.length, since, habit: habit.slice(-(HABIT_NIGHTS - 1)) });
  }
  return { value, confidence, rows, lastReinforcedNight: lastNight };
}

/** Up, down or flat over the last few nights. */
export function trendOf(history, nights = 7) {
  const recent = history.slice(-nights);
  if (!recent.length) return 'flat';
  const d = recent.at(-1).after - recent[0].before;
  return d > 0.01 ? 'up' : d < -0.01 ? 'down' : 'flat';
}

// ── words ───────────────────────────────────────────────────────────────────

const WHY = Object.freeze({
  'scene:well': 'it went well', 'scene:fine': 'it was fine', 'scene:flat': 'it fell flat', 'scene:badly': 'it went badly',
  time_spent: 'time spent on it', money_spent: 'money spent on it', tired_out: 'he went tired, and it told',
  work_late: 'a late night at work', work_crunch: 'a crunch at work', appraisal_good: 'a good appraisal', appraisal_poor: 'a poor appraisal', chose_not_to: 'he had the chance and chose not to',
  soaked: 'soaked on the way somewhere', salary: 'payday', good_meal: 'a good meal', invite_yes: 'said yes to an invitation', invite_no: 'said no to an invitation',
});

/** One piece of evidence in plain words. A chat's: a feeling and that it was a chat, never what was said. */
export function whyWords(item) {
  const fromChat = CHAT_ORIGINS.has(item.originKind);
  const cause = String(item.cause ?? '');
  if (cause === 'cited') return fromChat ? 'it came up in a chat' : 'it came up in his day';
  if (cause === 'moved_up') return fromChat ? 'something in a chat warmed him to it' : 'something he came across warmed him to it';
  if (cause === 'moved_down') return fromChat ? 'something in a chat put him off it' : 'something he came across put him off it';
  if (cause.startsWith('chat:')) {
    const a = cause.slice(5);
    return { good_news: 'good news in a chat', bad_news: 'bad news in a chat', praise: 'kind words in a chat', support: 'support in a chat', roast: 'a roasting in a chat', argument: 'an argument in a chat', flirt: 'some flirting in a chat' }[a] ?? 'something in a chat';
  }
  const base = WHY[cause] ?? cause.replace(/[_:]+/g, ' ');
  const hours = item.details?.hours;
  const more = finite(hours) ? `${base} (${hours} h)` : base;
  return fromChat ? `${more}, on a plan from a chat` : more;
}

// What a kind of outing is called in a sentence, and what actually raises it in talk. A kind with no entry has no line: a bare slug reads as broken
// English, and a bare word like "walk" or "out" turns up in everything.
const KIND_TERMS = Object.freeze({
  cafe: { phrase: 'cafes', re: /\b(caf[eé]s?|coffee)\b/i }, coffee: { phrase: 'cafes', re: /\b(caf[eé]s?|coffee)\b/i },
  walk: { phrase: 'going for walks', re: /\b(a walk|walks|go(ing)? walking|went walking)\b/i },
  gym: { phrase: 'the gym', re: /\b(gym|working out)\b/i },
  tv: { phrase: 'watching TV', re: /\b(tv|netflix|a series|watching (a |some )?shows?)\b/i },
  'eat-out': { phrase: 'eating out', re: /\b(eat(ing)? out|ate out|restaurants?|dinner out)\b/i },
  movie: { phrase: 'movies', re: /\b(movies?|films?|cinema)\b/i }, cinema: { phrase: 'movies', re: /\b(movies?|films?|cinema)\b/i },
  hangout: { phrase: 'hanging out', re: /\b(hang(ing)? out|hangout)\b/i },
  drinks: { phrase: 'going for drinks', re: /\b(drinks|a drink|pubs?)\b/i }, bar: { phrase: 'going for drinks', re: /\b(drinks|a drink|pubs?|bars?)\b/i },
  park: { phrase: 'parks', re: /\bparks?\b/i }, shopping: { phrase: 'shopping', re: /\b(shopping|the mall)\b/i },
  hike: { phrase: 'hiking', re: /\b(hik(e|es|ing))\b/i }, concert: { phrase: 'concerts', re: /\bconcerts?\b/i }, gig: { phrase: 'gigs', re: /\bgigs?\b/i },
  books: { phrase: 'books', re: /\b(books|novels?|(a|the|this|that|good|new) book)\b/i }, bookshop: { phrase: 'bookshops', re: /\bbookshops?\b/i },
  badminton: { phrase: 'badminton', re: /\bbadminton\b/i }, cricket: { phrase: 'cricket', re: /\bcricket\b/i }, football: { phrase: 'football', re: /\bfootball\b/i },
  tennis: { phrase: 'tennis', re: /\btennis\b/i }, bowling: { phrase: 'bowling', re: /\bbowling\b/i },
});
// A place's word that only says what kind of place it is ("a cafe", "Restaurant"): two real cafes would contradict each other, and it fires on everything.
const GENERIC_PLACE = /^(?:an? |the )?(?:caf[eé]|coffee shop|restaurant|bar|pub|cinema|mall|gym|park|shop|grocery store|supermarket|bookshop|landmark|office|home|family home|out|somewhere|market|beach|lake|temple|church|mosque|library|museum|theatre|theater|station|school|college|club|hall|court|courts|garden|square|hotel|hospital|clinic|salon|bakery)$/i;
// A name that is also an everyday word ("Will", "Mini", "Market"), matched in any case, turns up in everything. It counts only as a name: capitalized and inside a sentence.
const COMMON_WORDS = new Set(['will', 'mark', 'bill', 'may', 'june', 'april', 'august', 'summer', 'autumn', 'dawn', 'rose', 'lily', 'ivy', 'holly', 'hazel', 'violet', 'iris', 'daisy', 'grace', 'hope', 'faith', 'joy', 'charity', 'patience', 'honor', 'amber', 'ruby', 'pearl', 'jade', 'penny', 'sandy', 'rusty', 'sunny', 'happy', 'baby', 'honey', 'candy', 'mini', 'max', 'art', 'pat', 'sue', 'rob', 'nick', 'jack', 'frank', 'chase', 'hunter', 'mason', 'carter', 'rich', 'gene', 'drew', 'guy', 'ray', 'dean', 'earl', 'king', 'queen', 'prince', 'duke', 'angel', 'market', 'corner', 'city', 'town', 'place', 'work', 'home', 'river', 'hill', 'stone', 'wood', 'lane', 'star', 'moon', 'sky', 'rain', 'sage', 'reed', 'cliff', 'gray', 'grey', 'white', 'black', 'brown', 'green', 'young', 'long', 'short', 'best', 'little', 'big', 'buddy', 'champ', 'boss', 'chief', 'doc', 'kid']);

const escapeRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wholeWord = (word, text) => word.length >= 3 && new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(word)}($|[^\\p{L}\\p{N}])`, 'iu').test(text);
const bareWord = (label) => String(label).toLowerCase().replace(/^(an?|the)\s+/, '').trim();
const asName = (word, text) => {
  const name = word.charAt(0).toUpperCase() + word.slice(1);
  return new RegExp(`(?<=[^\\s.!?][ \\t]+)${escapeRe(name)}(?![\\p{L}\\p{N}])`, 'u').test(text);
};

/** What a row is called in a sentence, or null when it can't be said well. */
export function lineLabel(row) {
  const t = String(row?.topic ?? '');
  if (t.startsWith('kind:')) return KIND_TERMS[t.slice(5)]?.phrase ?? null;
  if (t.startsWith('place:')) return row.label && !GENERIC_PLACE.test(String(row.label).trim()) ? row.label : null;
  return row?.label || null;
}

/**
 * Is someone actually raising this? A kind by its own terms, a place or a person by name. The everyday `fixed:` words (work, people, money, food, the weather)
 * turn up in everything, so only a question about how he feels about them counts.
 */
export function raises(row, text) {
  const t = String(row?.topic ?? '');
  if (typeof text !== 'string' || !text.trim()) return false;
  if (t.startsWith('kind:')) return KIND_TERMS[t.slice(5)]?.re.test(text) === true;
  const word = bareWord(row.label);
  if (t.startsWith('fixed:')) return askedAbout(word, text);
  return COMMON_WORDS.has(word) ? asName(word, text) : wholeWord(word, text);
}

// Someone asking him: the you or your is on the topic itself. "how's work" could be anyone's, "how is rahul's work" is Rahul's, "sick of work" is the speaker's.
const YOU = '(?:you|u|ya)';
const YOUR = '(?:your|ur|yr)';
function askedAbout(word, text) {
  const w = `(?:the |this |that |all (?:the |this )?)?${escapeRe(word)}\\b`;
  return new RegExp(`\\b(?:`
    + `how(?:['’]?s| is| are| was| were)\\s+${YOUR}\\s+(?:[\\p{L}'’-]+\\s+)?${escapeRe(word)}\\b`
    + `|how(?:['’]?s| is| are)\\s+${w}\\s+(?:at|in|on|near|around|over)\\s+${YOUR}\\b`
    + `|what (?:do|did) ${YOU} (?:think|make) (?:of|about)\\s+${w}`
    + `|how (?:do|did) ${YOU} feel about\\s+${w}`
    + `|(?:do|did|don['’]?t) ${YOU} (?:like|hate|enjoy|mind|love)\\s+${w}`
    + `|${YOU} (?:like|hate|enjoy|love)\\s+${w}`
    + `|${YOUR} (?:take|view|views|opinion|thoughts?) (?:on|about)\\s+${w}`
    + `|(?:are |r )?${YOU}(?:['’]?re)? (?:sick|tired) of\\s+${w}`
    + `)`, 'iu').test(text);
}

/** Did he just say it himself? The plain word is enough for that. */
export function voiced(row, text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  if (String(row?.topic ?? '').startsWith('kind:')) return raises(row, text);
  return wholeWord(bareWord(row.label), text);
}

/**
 * A line for a reply ("You ...") or a writer's sheet (third person), or null when there's nothing to say about where he stands. "Lately" is only said while it's
 * really moving (trend, from recent evidence): distance from where he started is who he's become, not news. The label is lineLabel's.
 */
export function lineFor(row, label, { third = false, trend = 'flat' } = {}) {
  if (!label) return null;
  const say = (you, he) => (third ? he : you);
  const v = row.value;
  const lean = row.value - row.anchor;
  if (row.kind === 'interest') {
    if (v >= 0.72) return trend === 'up' ? say(`You've been enjoying ${label} more lately.`, `He's been enjoying ${label} more lately.`) : say(`You like ${label}.`, `He likes ${label}.`);
    if (v <= 0.28) return trend === 'down' ? say(`You've gone off ${label} a bit.`, `He's gone off ${label} a bit.`) : say(`${label} isn't really your thing.`, `${label} isn't really his thing.`);
    if (lean >= 0.05 && trend === 'up') return say(`You've been warming to ${label}.`, `He's been warming to ${label}.`);
    if (lean <= -0.05 && trend === 'down') return say(`You've cooled on ${label}.`, `He's cooled on ${label}.`);
    return null;
  }
  if (v >= 0.45) return lean > 0.05 ? say(`You've come to think well of ${label}.`, `He's come to think well of ${label}.`) : say(`You think well of ${label}.`, `He thinks well of ${label}.`);
  if (v <= -0.45) return trend === 'down' ? say(`You've got less patient with ${label}.`, `He's got less patient with ${label}.`) : say(`You're not a fan of ${label}.`, `He's not a fan of ${label}.`);
  if (lean >= 0.08 && trend === 'up') return say(`You feel a bit better about ${label} than you used to.`, `He feels a bit better about ${label} than he used to.`);
  if (lean <= -0.08 && trend === 'down') return say(`You feel a bit worse about ${label} than you used to.`, `He feels a bit worse about ${label} than he used to.`);
  return null;
}
