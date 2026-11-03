// sched-fixes — Director → PLAY GOD → CHANGES: one line per Director change,
// built in code from the change's own events (the `director.action`, its owner
// parts and what those caused), e.g.
//   "Schedule · Sat 31 Oct · home 01:15–02:30 'Stays up late…' · cancelled: Late-night snack run".
// Pure: no I/O; the caller hands the events, the state for names and an
// optional event reader (a decision no longer in the projection is named from
// its decision.opened). Codes, fictional names, places, times and the owner's
// own labels only: never chat text (a chat-made plan is "a plan from a chat"),
// never a JID or a real person.

import { dayLabel, hhmm } from '../clock.js';
import { chatMadeDecision } from '../planEdits.js';

const MAX = 240;
const LABEL_MAX = 28;
const CHAT_KINDS = new Set(['group', 'dm', 'call', 'ig']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const posInt = (v) => (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
const words = (s) => String(s ?? '').replace(/[_.:-]+/g, ' ').trim();
const cap1 = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
// Free text in quotes, cut short (an owner's label, a beat line).
const quote = (s, max = LABEL_MAX) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (t.length <= max) return `'${t}'`;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `'${(sp > max / 2 ? cut.slice(0, sp) : cut).trimEnd()}…'`;
};
const money = (n) => (finite(n) ? `${n < 0 ? '−' : ''}${Math.round(Math.abs(n)).toLocaleString('en-US')}` : '?');
const signed = (n) => (finite(n) ? `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(Math.round(n * 100) / 100)}` : '?');

/** The CHANGES head of a Director action kind. */
export const KIND_HEADS = Object.freeze({
  scene: 'Scene', schedule: 'Schedule', 'schedule.clear': 'Schedule cleared', quick: 'Quick',
  'decision.pick': 'Pick', outcome: 'Outcome', career: 'Career', money: 'Money', home: 'Home', mood: 'Mood', health: 'Health',
  'cast.depart': 'Cast leaves', 'cast.return': 'Cast returns', 'cast.metrics': 'Cast numbers', 'cast.edit': 'Cast edit',
  'cast.history': 'Cast history', 'cast.beat': 'Cast beat', weather: 'Weather', 'weather.end': 'Weather ended', goal: 'Goal',
  'goal.cancel': 'Goal cancelled', 'place.real': 'Place', 'place.edit': 'Place edit', 'places.realify': 'Places made real',
  'routes.refresh': 'Routes', 'arc.start': 'Storyline', 'arc.stage': 'Storyline', 'arc.end': 'Storyline ended', heavy: 'Hard stretch',
  'heavy.end': 'Hard stretch ended', 'tray.adopt': 'From the tray', 'proposal.approve': 'Weekly proposal', fate: 'Fate', slider: 'Slider',
  pin: 'Pin', unpin: 'Unpin', pause: 'Story paused', resume: 'Story resumed', bookmark: 'Bookmark', 'bookmark.remove': 'Bookmark removed',
  'seed.set': 'Seed', 'reconciler.mode': 'Reconciler', rewind: 'Rewind', retcon: 'Rewrite the past', wake: 'Wake him',
  // 016 scenes
  'scene.tone': 'Scene tone', 'scene.regenerate': 'Scene rewritten',
  // 019 his phone
  text: 'Text',
});

// 016: a scene's ending in words.
const ENDING_WORDS = Object.freeze({
  nothing: 'parted as usual', swapped_numbers: 'swapped numbers', plan_to_meet: 'plan to meet again',
  stayed_late: 'stayed late', left_early: 'left early', parted_badly: 'parted badly',
});
const WAKE_WORDS = Object.freeze({ cant_sleep: "can't sleep", woken_up: 'woken up', early_start: 'early start' });

function namesOf(state) {
  const cast = (id) => (typeof id === 'string' ? state?.cast?.get?.(id)?.name ?? state?.story?.departed?.[id]?.name ?? 'someone' : 'someone');
  const place = (id) => (typeof id === 'string' ? state?.places?.get?.(id)?.name ?? 'a place' : null);
  return { cast, place };
}

// A decision's label: a chat-made one never shows its own words.
function decisionName(state, id, eventOf) {
  const d = posInt(id) ? state?.decisions?.get?.(Number(id)) : null;
  if (d) {
    if (chatMadeDecision(d)) return 'a plan from a chat';
    const go = (Array.isArray(d.options) ? d.options : []).find(o => o?.id === 'go')?.label;
    return typeof go === 'string' && go ? go.slice(0, 60) : words(d.kind) || 'a plan';
  }
  let ev = null;
  try { ev = posInt(id) && typeof eventOf === 'function' ? eventOf(Number(id)) : null; } catch { ev = null; }
  if (ev && ev.type === 'decision.opened') {
    if (CHAT_KINDS.has(ev.originKind) || ev.subjectJid || ev.payload?.adopted === true) return 'a plan from a chat';
    const go = (Array.isArray(ev.payload?.options) ? ev.payload.options : []).find(o => o?.id === 'go')?.label;
    if (typeof go === 'string' && go) return go.slice(0, 60);
    if (ev.payload?.kind) return words(ev.payload.kind);
  }
  return `plan #${posInt(id) ?? '?'}`;
}

const span = (from, to, tz) => `${hhmm(from, tz)}–${hhmm(to, tz)}`;

const BACKGROUND = { off: 'day off', work_home: 'working from home', work_office: 'at the office' };
const ACTIVITY = { home: 'home', out: 'out', gym: 'gym', errand: 'errand', work_office: 'work at the office', sleep: 'sleep' };

function scheduleText(p, n, tz) {
  const out = [];
  const day = typeof p.date === 'string' ? p.date : null;
  const first = (p.ranges || [])[0]?.from ?? p.background?.from ?? p.moveTo;
  out.push(finite(first) ? dayLabel(first, tz) : day ?? '?');
  if (isObj(p.background)) {
    const what = BACKGROUND[p.background.activity] ?? words(p.background.activity);
    out.push(p.background.wholeDay ? `${what} (whole day)` : `${what} ${span(p.background.from, p.background.to, tz)}`);
  }
  for (const r of Array.isArray(p.ranges) ? p.ranges : []) {
    const where = r.activity === 'out' || ((r.activity === 'gym' || r.activity === 'errand') && r.placeId) ? ` at ${n.place(r.placeId)}` : '';
    out.push(`${ACTIVITY[r.activity] ?? words(r.activity)}${where} ${span(r.from, r.to, tz)}${r.label ? ` ${quote(r.label)}` : ''}`);
  }
  if (p.op === 'remove' && p.blockKind) out.push(`removes ${words(p.blockKind)}`);
  if (p.op === 'move' && p.blockKind) out.push(`moves ${words(p.blockKind)} to ${finite(p.moveTo) ? hhmm(p.moveTo, tz) : '?'}`);
  return out;
}

const CAREER = { hire: 'hired', fire: 'fired', quit: 'quits', promote: 'promoted', job: 'new job', salary: 'salary', pattern: 'work pattern' };

/** One owner / mind part → text pieces (none for bookkeeping). */
function partText(ev, ctx) {
  const { n, tz, state, eventOf, opened } = ctx;
  const p = isObj(ev.payload) ? ev.payload : {};
  switch (ev.type) {
    case 'decision.opened': {
      const go = (Array.isArray(p.options) ? p.options : []).find(o => o?.id === 'go')?.label;
      const s = isObj(p.subject) ? p.subject : {};
      const with_ = (Array.isArray(s.castIds) ? s.castIds : []).map(n.cast).slice(0, 3);
      const when = finite(s.eventAt) ? `${dayLabel(s.eventAt, tz)} ${finite(s.endAt) ? span(s.eventAt, s.endAt, tz) : hhmm(s.eventAt, tz)}` : null;
      // A visit's code label already says who and where ("<name> comes over to his place", outing.homeLabel).
      const home = typeof go === 'string' && / over to his place$/.test(go);
      return [[typeof go === 'string' && go ? go.slice(0, home ? 80 : 60) : words(p.kind), s.placeId && !home ? `at ${n.place(s.placeId)}` : null,
        with_.length && !home ? `with ${with_.join(', ')}` : null].filter(Boolean).join(' '), when].filter(Boolean);
    }
    case 'decision.committed': {
      if (opened.has(posInt(p.decisionId))) return [`committed: ${p.optionId}`];
      return [`${decisionName(state, p.decisionId, eventOf)} → ${p.optionId}`];
    }
    case 'decision.reversed': return [`${decisionName(state, p.decisionId, eventOf)}: ${p.from} → ${p.to}`];
    case 'decision.expired': return [`cancelled: ${decisionName(state, p.decisionId, eventOf)}`];
    case 'schedule.override_set': return scheduleText(p, n, tz);
    case 'schedule.override_cleared': {
      const o = posInt(p.overrideId) ? state?.scheduleOverrides?.[p.overrideId] : null;
      return [`schedule change #${posInt(p.overrideId) ?? '?'}${o?.date ? ` (${o.date})` : ''} cleared`];
    }
    case 'outcome.set': return [`${decisionName(state, p.decisionId, eventOf)} went ${p.outcome === 'well' ? 'well' : p.outcome === 'badly' ? 'badly' : words(p.outcome)}`];
    case 'career.set': {
      const bits = [CAREER[p.reason] ?? words(p.reason)];
      if (p.title) bits.push(quote(p.title, 40));
      if (finite(p.salary)) bits.push(`salary ${money(p.salary)}`);
      if (p.officePlaceId) bits.push(`office ${n.place(p.officePlaceId)}`);
      if (finite(p.effectiveAt)) bits.push(`from ${dayLabel(p.effectiveAt, tz)} ${hhmm(p.effectiveAt, tz)}`);
      return [bits.join(' ')];
    }
    case 'money.adjusted': return [`${words(p.mode) || 'adjust'} ${money(p.amount)}${p.label ? ` ${quote(p.label)}` : ''}`];
    case 'self.moved': return [`moves to ${n.place(p.homePlaceId) ?? 'a new home'}${finite(p.effectiveAt) ? ` on ${dayLabel(p.effectiveAt, tz)}` : ''}`];
    case 'wake.set': {
      const why = p.via === 'phone' ? 'woken up by his phone' : WAKE_WORDS[p.reason] ?? 'up';
      const until = finite(p.until) ? `, back to sleep ${hhmm(p.until, tz)}` : '';
      return [finite(p.at) ? `${why} · up at ${dayLabel(p.at, tz)} ${hhmm(p.at, tz)}${until}` : why];
    }
    case 'vitals.planned': {
      const d = isObj(p.delta) ? Object.entries(p.delta).filter(([, v]) => finite(v)).slice(0, 3).map(([k, v]) => `${k} ${signed(v)}`).join(', ') : '';
      const when = p.wakeDate ? `on waking ${p.wakeDate}` : finite(p.at) ? `at ${dayLabel(p.at, tz)} ${hhmm(p.at, tz)}` : '';
      return [[p.label ? quote(p.label) : null, d || null, when || null].filter(Boolean).join(' ')];
    }
    case 'vitals.nudged': {
      const d = isObj(p.delta) ? Object.entries(p.delta).filter(([, v]) => finite(v)).slice(0, 3).map(([k, v]) => `${k} ${signed(v)}`).join(', ') : '';
      return [d ? `nudge ${d}` : 'a nudge'];
    }
    case 'work.crunch': return ['a bad day at work'];
    case 'sick.started': return [`sick${finite(p.until) ? ` until ${dayLabel(p.until, tz)}` : ''}${finite(p.days) ? ` (${p.days} day${p.days === 1 ? '' : 's'})` : ''}`];
    case 'sick.planned': return [`sick from ${finite(p.startAt) ? `${dayLabel(p.startAt, tz)} ${hhmm(p.startAt, tz)}` : '?'} for ${p.days ?? '?'} days`];
    case 'sick.ended': return ['well again'];
    case 'plan.made': return p.amendedFor ? [] : ['a free evening'];
    case 'event.reverted': return [];
    // 019: "texts Lena · flirty · Sat 31 Oct 21:00 · 'ask about Sunday'"
    case 'phone.text_set': return [[p.from === 'them' ? `${n.cast(p.castId)} texts him` : `texts ${n.cast(p.castId)}`, p.tone ? words(p.tone) : null,
      finite(p.at) ? `${dayLabel(p.at, tz)} ${hhmm(p.at, tz)}` : null, p.words ? quote(p.words) : p.gist ? quote(p.gist) : null,
      p.chat === 'long' ? 'a long chat' : null].filter(Boolean).join(' · ')];
    case 'phone.message': return [p.dir === 'in' ? `${n.cast(p.castId)} texted` : `texted ${n.cast(p.castId)}`];
    case 'cast.departed': return [`${n.cast(p.castId)} leaves${p.how ? ` (${words(p.how)})` : ''}`];
    case 'cast.returned': return [`${n.cast(p.castId)} is back`];
    case 'cast.created': return [`new: ${typeof p.name === 'string' ? p.name.slice(0, 40) : 'someone'}${p.relation ? ` (${words(p.relation)})` : ''}`];
    case 'cast.updated': return [`${n.cast(p.castId)}: ${(isObj(p.fields) ? Object.keys(p.fields) : []).slice(0, 4).join(', ') || 'edited'}`];
    case 'cast.history_added': return [`${n.cast(p.castId)} history ${quote(p.text)}`];
    case 'cast.beat': return [`${n.cast(p.castId)}: ${words(p.kind)}${p.text ? ` ${quote(p.text)}` : ''}`];
    case 'relationship.changed': {
      if (p.step && p.step > 1) return [];
      const d = isObj(p.delta) ? Object.entries(p.delta).filter(([, v]) => finite(v)).slice(0, 4).map(([k, v]) => `${k} ${signed(v)}`).join(', ') : '';
      return [`${n.cast(p.castId)}${d ? ` ${d}` : ''}`];
    }
    case 'weather.window_set': return [`${words(p.sky)}${p.intensity ? ` (${words(p.intensity)})` : ''} ${finite(p.from) ? `${dayLabel(p.from, tz)} ${span(p.from, p.to, tz)}` : ''}`.trim()];
    case 'weather.window_ended': return [`window #${posInt(p.windowId) ?? '?'} ended`];
    case 'weather.changed': return [`${words(p.condition) || 'weather'}${finite(p.until) ? ` until ${hhmm(p.until, tz)}` : ''}`];
    case 'goal.set': return [[words(p.goalKind), p.label ? quote(p.label) : null, p.castId ? `with ${n.cast(p.castId)}` : null, p.placeId ? `at ${n.place(p.placeId)}` : null,
      finite(p.from) && finite(p.to) ? `${dayLabel(p.from, tz)} – ${dayLabel(p.to, tz)}` : null].filter(Boolean).join(' ')];
    case 'goal.cancelled': return [`goal #${posInt(p.goalId) ?? '?'} cancelled`];
    case 'place.created': return [`new place ${typeof p.name === 'string' ? p.name.slice(0, 40) : '?'}${p.kind ? ` (${words(p.kind)})` : ''}`];
    case 'place.updated': return [`${n.place(p.placeId) ?? 'a place'} ${p.name ? `renamed ${quote(p.name, 40)}` : 'updated'}`];
    case 'arc.started': return [`${words(p.category)} ${words(p.kind)}`.trim() + ' starts'];
    case 'arc.stage': return [`arc #${posInt(p.arcId) ?? '?'} → ${words(p.to ?? p.stage)}`];
    case 'arc.ended': return [`arc #${posInt(p.arcId) ?? '?'} ends${p.outcome ? ` (${words(p.outcome)})` : ''}`];
    case 'heavy.started': return [`${words(p.kind ?? p.heavyKind) || 'a hard stretch'}${finite(p.days ?? p.durationDays) ? `, ${p.days ?? p.durationDays} days` : ''}`];
    case 'heavy.ended': return ['the hard stretch ends'];
    case 'director.fate_set': return [`${words(p.category)}: ${words(p.mode)}`];
    case 'director.slider_set': return [`${words(p.slider)} ${p.value}`];
    case 'director.pin_set': return [`pin ${String(p.pinKey ?? '').slice(0, 40)}`];
    case 'director.pin_cleared': return [`unpin ${String(p.pinKey ?? '').slice(0, 40)}`];
    case 'director.paused': return ['story paused'];
    case 'director.resumed': return ['story resumed'];
    case 'director.bookmark': return [`bookmark ${quote(p.name)}`];
    case 'director.bookmark_removed': return [`bookmark #${posInt(p.bookmarkId) ?? '?'} removed`];
    case 'director.seed_set': return [`seed ${String(p.path ?? '').slice(0, 40)}`];
    case 'director.reconciler_mode': return [`reconciler ${words(p.mode)}`];
    case 'claim.adopted': return [`adopted from the tray (${words(p.as) || 'claim'})`];
    // 016 scenes: the owner's tone hint (owner text, quoted short), a rewrite, and the scene itself
    case 'scene.tone_set': return [`tone for ${decisionName(state, p.decisionId, eventOf)}: ${quote(p.tone, 40) || '?'}${['well', 'fine', 'flat', 'badly'].includes(p.outcome) ? ` (${p.outcome})` : ''}`];
    case 'scene.regenerated': return ['the old version reverted'];
    case 'scene.played': {
      const with_ = (Array.isArray(p.castIds) ? p.castIds : []).map(n.cast).slice(0, 3);
      return [[`scene${with_.length ? ` with ${with_.join(', ')}` : ''}`, ENDING_WORDS[p.ending] ?? null,
        Array.isArray(p.firstMeet) && p.firstMeet.length ? 'first meeting' : null, p.fallback ? 'one line only' : null].filter(Boolean).join(' · ')];
    }
    case 'scene.followup': return [`plans to see ${n.cast(p.castId)} again`];
    case 'scene.followup_lapsed': return ['a follow-up lapsed'];
    case 'route.recorded': case 'director.action': return [];
    default: return [words(ev.type)];
  }
}

/**
 * The CHANGES line of one Director change.
 * { action (the director.action event), parts (its owner / mind events), effects
 * (engine events they caused), state (names, decisions), tz, eventOf?(id) }
 * → string (≤ 240 chars).
 */
export function describeChange({ action, parts = [], effects = [], state = null, tz, eventOf = null } = {}) {
  const kind = typeof action?.payload?.kind === 'string' ? action.payload.kind : null;
  const shape = typeof action?.payload?.shape === 'string' ? action.payload.shape : null;
  const head = `${KIND_HEADS[kind] ?? (cap1(words(kind)) || 'Change')}${kind === 'scene' && shape ? ` (${words(shape)})` : ''}`;
  const n = namesOf(state);
  const list = (Array.isArray(parts) ? parts : []).filter(isObj).sort((a, b) => a.id - b.id);
  const opened = new Set(list.filter(e => e.type === 'decision.opened').map(e => e.id));
  const ctx = { n, tz, state, eventOf, opened };
  const pieces = [];
  for (const ev of list) {
    let t = [];
    try { t = partText(ev, ctx); } catch { t = [words(ev.type)]; }
    for (const x of t) if (x && !pieces.includes(x)) pieces.push(x);
  }
  // What the change cancelled on the way (a schedule edit's conflicts, a departure's plans).
  const cancelled = [];
  // Only what it cancelled when applied: a later engine expiry (he could not go) is not this change.
  const appliedAt = finite(action?.at) ? action.at : null;
  for (const ev of (Array.isArray(effects) ? effects : []).filter(isObj).sort((a, b) => a.id - b.id)) {
    if (ev.type !== 'decision.expired' || (appliedAt !== null && finite(ev.at) && ev.at > appliedAt + 60)) continue;
    const name = decisionName(state, ev.payload?.decisionId, eventOf);
    if (!cancelled.includes(name)) cancelled.push(name);
  }
  if (cancelled.length) pieces.push(`cancelled: ${cancelled.slice(0, 3).join(', ')}${cancelled.length > 3 ? ` +${cancelled.length - 3}` : ''}`);
  const text = [head, ...pieces].join(' · ');
  return text.length > MAX ? `${text.slice(0, MAX - 1).trimEnd()}…` : text;
}
