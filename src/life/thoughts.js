// The thought stream (plan 020 F2): what passes through his head, in code. Pure: the facade hands in the
// state and the reads, stores what comes back. No model, no world event, and nothing here feeds a
// decision: a thought is not a fact of his life, it only rests on some.
//
// Each tick, candidates compete and the strongest surface: about 2–6 an hour awake, sparse and
// varied, and silence is allowed. A candidate's score is salience × novelty × decay × urgency, less
// for a family just heard from. A phrase used lately is out; one used often counts less. Asleep:
// nothing. After downtime: at most one, never a backfill.
//
// Privacy: a thought from a chat is a code-built feeling and its origin, never a word of a chat. A plan
// with a real person or made in a chat reads "plans with a friend". A private (explicit-register)
// session gets neutral words; a heavy stretch is quiet and invents nothing dark.
import { REACTIONS, WANT_SHOULD, PUTTING_OFF, BODY, PEOPLE, WORDLESS, EXCUSES, PLAN_WITH_A_FRIEND } from './thoughtPhrases.js';
import { pronounsOf } from './liveSession.js';
import { chatMadeDecision } from './planEdits.js';
import { voiceLine, bankVersion } from './phraseBank.js';
import { timeOfDay } from './phraseCheck.js';

export const FAMILIES = Object.freeze(['reaction', 'want_should', 'putting_off', 'body', 'people', 'wordless', 'excuse']);
export const THOUGHT_TYPES = Object.freeze(['weather.changed', 'commute.soaked', 'decision.expired', 'decision.committed', 'decision.reversed', 'scene.played',
  'money.salary', 'money.spent', 'work.late', 'work.crunch', 'sick.started', 'sick.ended', 'phone.message', 'relationship.changed',
  'cast.beat', 'cast.departed', 'cast.returned', 'arc.stage', 'chat.perceived', 'family.call', 'woke', 'birthday', 'career.set', 'self.moved']);

const MIN = 60;
const HOUR = 3600;
const DAY = 86400;
export const EVIDENCE_WINDOW_SEC = 45 * MIN;   // news goes stale: what lost the competition this long ago is gone
export const MEMORY_DAYS = 7;
const PHRASE_BLOCK_SEC = 3 * DAY;              // the same words don't come back for days
export const MAX_PER_HOUR = 6;
const MAX_PER_TICK = 2;
const CATCHUP_QUIET_SEC = 5 * MIN;
const MIN_GAP_SEC = 4 * MIN;                   // two thoughts don't land on top of each other
const CHAT_ORIGINS = new Set(['group', 'dm', 'call', 'ig']);

// Thoughts an hour, by what he's doing. Absorbed in something → fewer.
const RATE = Object.freeze({ work: 2.6, meeting: 1.6, commute: 4, meal: 3, gym: 2, tv: 3.5, home: 5, outside: 4.5, errand: 3, outing: 2.6, sick: 2.2, other: 3.5, heavy: 1 });
// How soon a family may speak again without losing out.
const COOLDOWN_MIN = Object.freeze({ reaction: 20, want_should: 90, putting_off: 75, body: 50, people: 30, wordless: 25, excuse: 240 });

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const posInt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
const chatOrigin = (e) => CHAT_ORIGINS.has(e?.originKind);
const KIND_WORDS = Object.freeze({
  'eat-out': 'dinner out', dinner: 'dinner', lunch: 'lunch', movie: 'the film', cinema: 'the film', cafe: 'coffee', coffee: 'coffee', drinks: 'drinks', walk: 'the walk',
  'career:interview': 'the interview', interview: 'the interview', party: 'the party', concert: 'the concert', shopping: 'shopping',
});

/** What he's doing, as a phrase set and a rate. */
export function contextOf(s, live, { heavy = false } = {}) {
  if (heavy) return 'heavy';
  if (s?.vitals?.sick === true || s?.activity?.kind === 'sick') return 'sick';
  if (live?.active) return 'outing';
  const k = String(s?.activity?.kind ?? '').replace(/^[a-z]+:/, '');
  if (s?.position?.travel || k === 'commute') return 'commute';
  if (k === 'work') return 'work';
  if (k === 'meeting') return 'meeting';
  if (['breakfast', 'lunch', 'dinner', 'snack'].includes(k)) return 'meal';
  if (k === 'gym') return 'gym';
  if (k === 'tv') return 'tv';
  if (['errand', 'groceries', 'shopping'].includes(k)) return 'errand';
  const home = s?.self?.homePlaceId;
  const here = s?.activity?.placeId ?? s?.position?.placeId;
  if (home && here === home) return 'home';
  return ['free', 'rest', 'idle'].includes(k) || !k ? 'outside' : 'other';
}

function planWord(d, s, nameOf) {
  if (chatMadeDecision(d)) return PLAN_WITH_A_FRIEND;
  const kind = String(d?.kind ?? '');
  const ids = Array.isArray(d?.subject?.castIds) ? d.subject.castIds : [];
  const name = ids.length ? nameOf(ids[0]) : null;
  const what = KIND_WORDS[kind] ?? KIND_WORDS[kind.replace(/^[a-z]+:/, '')] ?? null;
  if (what && name) return `${what} with ${name}`;
  if (what) return what;
  if (name) return `seeing ${name}`;
  return 'tonight';
}

function originOfDecision(d) {
  const o = Array.isArray(d?.origins) ? d.origins.find(x => CHAT_ORIGINS.has(x?.kind)) : null;
  return o ? { kind: o.kind, jid: o.jid ?? null } : null;
}

/** Everything that wants to be thought right now. */
function candidatesOf(c) {
  const { s, at, events, live, ctx, heavy, hour, rng, nameOf } = c;
  const out = [];
  const add = (family, pool, salience, opts = {}) => {
    if (pool?.length) out.push({ family, pool, salience, urgency: 1, evidence: [], ...opts });
  };
  const v = s.vitals ?? {};
  const onOuting = ctx === 'outing';
  const quiet = heavy;

  // ── his body ──
  if (live?.private !== true) {
    if (v.sick === true) add('body', BODY.sick, 0.75, { cause: 'sick' });
    if (finite(v.hunger) && v.hunger >= 80) add('body', BODY.starving, 0.8, { cause: 'hunger' });
    else if (finite(v.hunger) && v.hunger >= 62) add('body', BODY.peckish, 0.4, { cause: 'hunger' });
    if (finite(v.energy) && v.energy <= 22) add('body', BODY.wrecked, 0.75, { cause: 'energy' });
    else if (finite(v.energy) && v.energy <= 38) add('body', BODY.tired, 0.42, { cause: 'energy' });
    else if (finite(v.energy) && v.energy >= 82 && hour < 13 && !quiet) add('body', BODY.rested, 0.25, { cause: 'energy' });
    if (finite(v.sleepDebt) && v.sleepDebt >= 4) add('body', BODY.sleep_debt, 0.4, { cause: 'sleep_debt' });
    if (!quiet && finite(v.stress) && v.stress >= 70) add('body', BODY.stress, 0.5, { cause: 'stress' });
    if (!quiet && !onOuting && finite(v.socialBattery) && v.socialBattery <= 20) add('body', BODY.people_out, 0.45, { cause: 'social' });
    if (!quiet && ['work', 'meeting'].includes(ctx)) add('body', BODY.back, 0.18, { cause: 'desk' });
    const temp = s.weather?.tempC;
    if (!quiet && finite(temp) && temp >= 34) add('body', BODY.hot, 0.3, { cause: 'hot' });
    else if (!quiet && finite(temp) && temp <= 8) add('body', BODY.cold, 0.3, { cause: 'cold' });
  }

  // ── a private session: neutral words and nothing else ──
  if (live?.private === true) { add('wordless', WORDLESS.private, 0.3); return out; }

  // ── wordless, always there: the mind wanders ──
  const valence = finite(v.mood?.valence) ? v.mood.valence : 0;
  if (quiet) {
    add('wordless', WORDLESS.heavy, 0.3);
    return out;   // a heavy stretch: his body and this, nothing else
  }
  add('wordless', WORDLESS.neutral, 0.3);
  if (valence >= 0.3) add('wordless', WORDLESS.warm, 0.34);
  if (valence <= -0.25) add('wordless', WORDLESS.flat, 0.36);
  if (finite(v.stress) && v.stress >= 55) add('wordless', WORDLESS.uneasy, 0.34);

  // ── what just happened ──
  for (const e of events) {
    const p = e.payload ?? {};
    const key = `e${e.id}`;
    const ev = { evidence: [e.id], key, eventAt: e.at };
    const origin = chatOrigin(e) ? { kind: e.originKind, jid: e.originJid } : null;
    switch (e.type) {
      case 'weather.changed':
        if (p.rain === true) add('reaction', REACTIONS.rain_start, 0.6, { ...ev, cause: 'rain' });
        break;
      case 'commute.soaked': add('reaction', REACTIONS.soaked, 0.8, { ...ev, cause: 'soaked' }); break;
      case 'decision.expired': {
        if (origin) break;
        const missed = p.reason === 'could_not_go';
        if (missed || ['fell_through', 'owner_cancelled', 'schedule', 'owner_plan', 'inviter_cancelled'].includes(p.reason)) {
          add('reaction', missed ? REACTIONS.missed : REACTIONS.plan_off, 0.7, { ...ev, cause: `expired:${p.reason}` });
        }
        break;
      }
      case 'scene.played': {
        if (origin || e.subjectJid || p.mode !== 'full') break;
        const pool = { well: REACTIONS.scene_well, fine: REACTIONS.scene_fine, flat: REACTIONS.scene_flat, badly: REACTIONS.scene_badly }[p.outcome];
        if (pool) add('reaction', pool, p.outcome === 'fine' ? 0.4 : 0.75, { ...ev, cause: `scene:${p.outcome}` });
        break;
      }
      case 'money.salary': add('reaction', REACTIONS.salary, 0.6, { ...ev, cause: 'salary' }); break;
      case 'money.spent':
        if (origin || e.subjectJid) break;
        if (p.for === 'rent') add('reaction', REACTIONS.rent, 0.6, { ...ev, cause: 'rent' });
        else if (['outing', 'food', 'groceries', 'bills'].includes(p.for) && finite(p.amount) && finite(c.moneyRef) && p.amount >= c.moneyRef * 0.02) add('reaction', REACTIONS.big_spend, 0.45, { ...ev, cause: 'spend' });
        break;
      case 'work.late': add('reaction', REACTIONS.work_late, 0.6, { ...ev, cause: 'work_late' }); break;
      case 'work.crunch': add('reaction', REACTIONS.crunch, 0.65, { ...ev, cause: 'crunch' }); break;
      case 'sick.started': add('reaction', REACTIONS.sick_start, 0.8, { ...ev, cause: 'sick' }); break;
      case 'sick.ended': add('reaction', REACTIONS.sick_end, 0.7, { ...ev, cause: 'sick_end' }); break;
      case 'birthday': if (!p.castId) add('reaction', REACTIONS.birthday, 0.7, { ...ev, cause: 'birthday' }); break;
      case 'woke': {
        const pool = p.interrupted === true ? REACTIONS.woken : (hour >= 10 ? REACTIONS.woke_late : REACTIONS.woke);
        add('reaction', pool, 0.65, { ...ev, cause: 'woke' });
        break;
      }
      case 'career.set': {
        if (p.change === 'fire' || p.action === 'fire' || p.change === 'quit' || p.action === 'quit') add('reaction', REACTIONS.job_gone, 0.85, { ...ev, cause: 'job' });
        else if (p.change === 'hire' || p.action === 'hire') add('reaction', REACTIONS.job_new, 0.8, { ...ev, cause: 'job' });
        break;
      }
      case 'self.moved': add('reaction', REACTIONS.moved, 0.7, { ...ev, cause: 'moved' }); break;
      case 'chat.perceived': {
        // A chat's mark on him: a feeling and its origin, never a word.
        if (!origin || p.kind !== 'affect') break;
        const pool = { praise: WORDLESS.chat_warm, support: WORDLESS.chat_warm, good_news: WORDLESS.chat_warm, roast: WORDLESS.chat_sting, argument: WORDLESS.chat_sting,
          flirting: WORDLESS.chat_flirt, flirt: WORDLESS.chat_flirt, bad_news: WORDLESS.chat_worry }[p.affect] ?? WORDLESS.chat_plain;
        add('wordless', pool, 0.62, { ...ev, origin, cause: `chat:${String(p.affect ?? 'plain').slice(0, 20)}` });
        break;
      }
      case 'phone.message': {
        const id = p.castId;
        if (typeof id !== 'string' || e.subjectJid) break;
        const name = nameOf(id);
        if (!name) break;
        if (p.dir === 'in') {
          const here = onOuting && live.mode === 'full' && !live.them?.some(x => x.castId === id);
          if (here) add('people', PEOPLE.text_in_with, 0.6, { ...ev, cause: 'text' });
          else if (!onOuting) add('people', PEOPLE.text_in, 0.55, { ...ev, vars: { name }, cause: 'text' });
        } else if (!onOuting) add('people', PEOPLE.text_sent, 0.4, { ...ev, vars: { name }, cause: 'text_sent' });
        break;
      }
      case 'relationship.changed': {
        if (origin || e.subjectJid || onOuting) break;
        const id = p.castId;
        const name = typeof id === 'string' ? nameOf(id) : null;
        const d = p.delta ?? {};
        if (!name) break;
        if (finite(d.tension) && d.tension >= 0.03) add('people', PEOPLE.further, 0.55, { ...ev, vars: { name }, cause: 'tension' });
        else if (finite(d.closeness) && d.closeness >= 0.02) add('people', PEOPLE.closer, 0.45, { ...ev, vars: { name }, cause: 'closer' });
        break;
      }
      case 'arc.stage': {
        const partner = s.story?.arcs?.[p.arcId]?.partnerId;
        const name = partner ? nameOf(partner) : null;
        if (name && !onOuting) add('people', PEOPLE.romance, 0.7, { ...ev, vars: { name }, cause: 'romance' });
        break;
      }
      case 'cast.beat': {
        const name = typeof p.castId === 'string' ? nameOf(p.castId) : null;
        if (name && !onOuting && !origin) add('people', PEOPLE.news, 0.42, { ...ev, vars: { name }, cause: 'news' });
        break;
      }
      case 'cast.departed': { const name = c.anyName(p.castId); if (name) add('people', PEOPLE.gone_now, 0.75, { ...ev, vars: { name }, cause: 'departed' }); break; }
      case 'cast.returned': { const name = c.anyName(p.castId); if (name) add('people', PEOPLE.back_now, 0.7, { ...ev, vars: { name }, cause: 'returned' }); break; }
      case 'family.call': if (!onOuting) add('people', PEOPLE.family, 0.45, { ...ev, cause: 'family' }); break;
      default:
    }
  }

  // ── on an outing: what fits its phase and who's there ──
  if (onOuting) {
    if (live.mode !== 'full') { add('people', PEOPLE.out_plain, 0.5, { cause: 'out' }); return out; }
    const who = live.them ?? [];
    const pron = pronounsOf(who.map(x => c.memberOf(x.castId)));
    const mood = who[0]?.mood ?? 'ok';
    const pools = {
      arriving: c.firstMeet ? PEOPLE.out_arriving_first : PEOPLE.out_arriving, settling: PEOPLE.out_settling, lull: PEOPLE.out_lull,
      winding: PEOPLE.out_winding, leaving: PEOPLE.out_leaving,
      main: { high: PEOPLE.out_main_high, ok: PEOPLE.out_main_ok, low: PEOPLE.out_main_low }[mood],
    };
    add('people', pools[live.phase] ?? PEOPLE.out_plain, 0.55, { vars: { pron }, cause: `out:${live.phase}` });
    if (who.length > 1) add('people', PEOPLE.out_group, 0.4, { vars: { pron }, cause: 'out:group' });
    return out;
  }

  // ── want vs should, putting off ──
  for (const d of s.decisions instanceof Map ? s.decisions.values() : []) {
    const eventAt = d?.subject?.eventAt;
    if (!finite(eventAt) || eventAt <= at || eventAt > at + 8 * HOUR) continue;
    const plan = planWord(d, s, nameOf);
    const origin = originOfDecision(d);
    const ev = { evidence: [d.id, d.committed?.eventId, d.lean?.eventId].filter(posInt), vars: { plan }, origin };
    if (d.status === 'committed' && ['go', 'late'].includes(d.committed?.optionId)) {
      const near = eventAt - at < 3 * HOUR;
      const leanStay = d.lean && !['go', 'late'].includes(d.lean.optionId);
      if (finite(v.energy) && v.energy < 32 && near) add('want_should', WANT_SHOULD.committed_tired, 0.7, { ...ev, key: `tired:${d.id}`, cause: 'committed_tired' });
      else if (finite(v.socialBattery) && v.socialBattery < 28 && near) add('want_should', WANT_SHOULD.committed_people, 0.65, { ...ev, key: `people:${d.id}`, cause: 'committed_people' });
      else if (leanStay && near) add('want_should', WANT_SHOULD.committed_dont_feel, 0.65, { ...ev, key: `dont:${d.id}`, cause: 'lean_vs_commit' });
    } else if (d.status === 'open' && d.lean) {
      const leansGo = ['go', 'late'].includes(d.lean.optionId);
      add('want_should', leansGo ? WANT_SHOULD.open_want_go : WANT_SHOULD.open_should_go, 0.45, { ...ev, key: `open:${d.id}`, cause: leansGo ? 'want' : 'should' });
      add('putting_off', PUTTING_OFF.decide_later, 0.4, { ...ev, key: `later:${d.id}`, cause: 'decide_later' });
    }
  }
  for (const i of c.intentions ?? []) {
    const pool = WANT_SHOULD.intention[i.kind];
    if (!pool || !finite(i.createdAt) || at - i.createdAt < 2 * HOUR) continue;
    add('want_should', pool, 0.5, { key: `intent:${i.id}`, origin: i.origin ?? null, cause: `intention:${i.kind}`, codes: { intention: i.kind } });
  }

  // Someone is waiting on an answer.
  for (const e of c.unanswered ?? []) {
    const name = nameOf(e.payload?.castId);
    if (name) add('putting_off', PUTTING_OFF.reply_later, 0.5, { evidence: [e.id], key: `reply:${e.id}`, vars: { name }, cause: 'reply_later' });
  }

  const free = ['home', 'outside', 'tv'].includes(ctx);
  if (free && (hour >= 23 || hour < 4)) {
    add('putting_off', PUTTING_OFF.bedtime, 0.55, { cause: 'bedtime' });
    add('want_should', WANT_SHOULD.should_sleep, 0.4, { cause: 'should_sleep' });
  }
  if (free && hour >= 6 && hour < 9) add('putting_off', PUTTING_OFF.morning, 0.3, { cause: 'morning' });
  if (ctx === 'home' || ctx === 'tv') add('putting_off', PUTTING_OFF.chores, 0.3, { cause: 'chores' });
  if (['work', 'meeting'].includes(ctx)) add('putting_off', PUTTING_OFF.work, 0.32, { cause: 'work' });
  if (free && (hour >= 17 || hour < 2) && finite(v.workPressure) && v.workPressure >= 58 && c.employed !== false) add('want_should', WANT_SHOULD.should_work, 0.42, { cause: 'should_work' });
  if (ctx === 'tv' && finite(v.energy) && v.energy >= 45) add('want_should', WANT_SHOULD.should_move, 0.3, { cause: 'should_move' });
  if (free && finite(v.hunger) && v.hunger >= 50 && rng() < 0.5) add('want_should', WANT_SHOULD.should_eat, 0.3, { cause: 'should_eat' });
  if (free && rng() < 0.05) add('want_should', WANT_SHOULD.should_call_home, 0.3, { cause: 'call_home' });
  if ((c.goalsOpen ?? 0) > 0 && free) add('putting_off', PUTTING_OFF.goal, 0.32, { cause: 'goal' });
  if (free && Array.isArray(c.departed) && c.departed.length && rng() < 0.04) {
    add('people', PEOPLE.departed, 0.35, { vars: { name: c.departed[Math.floor(rng() * c.departed.length)] }, cause: 'departed' });
  }

  // ── people, for no particular reason ──
  const around = Array.isArray(s.activity?.withCast) ? s.activity.withCast.map(nameOf).filter(Boolean) : [];
  const atHome = (s.activity?.placeId ?? s.position?.placeId) === s.self?.homePlaceId;
  if (around.length && ['home', 'tv', 'meal'].includes(ctx)) {
    add('people', atHome ? PEOPLE.with_home : PEOPLE.with_work, 0.38, { vars: { name: around[Math.floor(rng() * around.length)] }, cause: atHome ? 'with_home' : 'with_work' });
  } else if (c.closest?.length && rng() < 0.3) {
    const pick = c.closest[Math.floor(rng() * c.closest.length)];
    add('people', pick.partner ? PEOPLE.romance_ambient : PEOPLE.ambient, 0.36, { vars: { name: pick.name }, cause: pick.partner ? 'romance' : 'ambient' });
  }

  // ── a little of whatever he's doing ──
  const ambient = { work: REACTIONS.work, meeting: REACTIONS.meeting, commute: REACTIONS.commute, meal: REACTIONS.meal, gym: REACTIONS.gym, tv: REACTIONS.tv, home: REACTIONS.home, outside: REACTIONS.outside, errand: REACTIONS.errand }[ctx];
  if (ambient) add('reaction', ambient, 0.4, { cause: ctx });
  return out;
}

function fill(text, vars = {}) {
  const p = vars.pron ?? {};
  return String(text)
    .replaceAll("{she's}", p["she's"] ?? "they're").replaceAll('{she}', p.she ?? 'they').replaceAll('{her}', p.her ?? 'their').replaceAll('{them}', p.them ?? 'them')
    .replaceAll('{name}', vars.name ?? 'them').replaceAll('{plan}', vars.plan ?? 'tonight');
}

/**
 * One tick's thoughts. c: { s (the view), at, tickSec, steps, tz deps: hourOf, rng(key) → rng, events (live,
 * in the last EVIDENCE_WINDOW_SEC), live (liveSession at `at`), deeds (rows of today against his lean),
 * intentions [{id, kind, createdAt, origin}], unanswered, recent (rows since MEMORY_DAYS ago), memberOf(id), nameOf(id),
 * anyName(id), departed [names], closest [{name, partner}], wokeAt, employed, goalsOpen, moneyRef, heavy, asOf (log head), firstMeet }.
 * → rows for the store, oldest first.
 */
export function tickThoughts(c) {
  const { s, at, recent = [] } = c;
  if (!s || s.genesisAt === null || s.genesisAt === undefined) return [];
  if (s.activity?.kind === 'sleep') return [];
  // A tick run again (a restart in the middle of it): its thoughts are there already.
  if (recent.some(r => r.codes?.tick === at)) return [];
  const catchUp = c.steps > 1 || c.reanchored === true;
  if (catchUp && recent.some(r => at - r.at < CATCHUP_QUIET_SEC)) return [];

  const rng = c.rng(`tick:${at}`);
  const hour = c.hourOf(at);
  const heavy = c.heavy === true;
  const ctx = contextOf(s, c.live, { heavy });
  const candidates = candidatesOf({ ...c, heavy, ctx, hour, rng });
  // Against his lean: the excuse, right after the choice.
  if (!heavy && !c.live?.active) {
    for (const r of c.deeds ?? []) {
      if (!r.against || !finite(r.deed?.at) || at - r.deed.at > 90 * MIN || r.deed.at > at) continue;
      if (r.deed.status === 'expired' || r.deed.status === 'open') continue;
      const pool = ['go', 'late'].includes(r.deed.optionId) ? EXCUSES.went : ['stay', 'skip', 'decline'].includes(r.deed.optionId) ? EXCUSES.stayed : EXCUSES.other;
      candidates.push({ family: 'excuse', pool, salience: 0.72, urgency: 1, key: `excuse:${r.id}`, evidence: [r.id, r.lastLean?.eventId].filter(posInt),
        origin: r.origin ?? null, cause: `against_lean:${r.deed.cause}`, codes: { lean: r.lastLean?.optionId ?? null, did: r.deed.optionId ?? null, p: r.lastLean?.p ?? null }, eventAt: r.deed.at });
    }
  }

  // ── the memory ──
  const used = new Map();
  const familyLast = {};
  for (const r of recent) {
    if (r.phraseKey) {
      const u = used.get(r.phraseKey) ?? { n: 0, last: 0 };
      u.n += 1; u.last = Math.max(u.last, r.at);
      used.set(r.phraseKey, u);
    }
    familyLast[r.family] = Math.max(familyLast[r.family] ?? 0, r.at);
  }
  const seen = new Set(recent.map(r => r.dedupeKey).filter(Boolean));
  // A thought is dated inside its tick, so the last hour reaches back a tick further.
  const lastHour = recent.filter(r => at - r.at < HOUR + (c.tickSec ?? 900)).length;
  const room = Math.max(0, MAX_PER_HOUR - lastHour);
  if (!room) return [];

  // How many this tick: the rate for what he's doing, drawn; silence is allowed.
  const expected = (RATE[ctx] ?? RATE.other) * ((c.tickSec ?? 900) / HOUR);
  const eachSlot = Math.min(1, expected / MAX_PER_TICK);
  let count = (rng() < eachSlot ? 1 : 0) + (rng() < eachSlot ? 1 : 0);

  const open = (pool) => pool.filter(t => !used.has(t) || at - used.get(t).last > PHRASE_BLOCK_SEC);
  const scored = [];
  for (const cand of candidates) {
    if (cand.key && seen.has(`${cand.family}:${cand.key}`)) continue;
    const choices = open(cand.pool);
    if (!choices.length) continue;
    const age = finite(cand.eventAt) ? Math.max(0, at - cand.eventAt) : 0;
    const decay = cand.eventAt ? Math.max(0.2, 1 - age / EVIDENCE_WINDOW_SEC) : 1;
    const since = familyLast[cand.family] ? (at - familyLast[cand.family]) / MIN : Infinity;
    const cool = since < (COOLDOWN_MIN[cand.family] ?? 30) ? 0.25 : 1;
    const usedOften = choices.reduce((a, t) => a + (used.get(t)?.n ?? 0), 0) / choices.length;
    const novelty = 1 / (1 + usedOften * 0.5);
    scored.push({ ...cand, choices, score: cand.salience * decay * cool * novelty * (cand.urgency ?? 1) + rng() * 0.12 });
  }
  scored.sort((a, b) => b.score - a.score);
  // Something that really matters surfaces even in a tick that drew silence.
  if (count === 0 && scored[0]?.salience >= 0.72 && scored[0].score >= 0.5) count = 1;
  if (catchUp) count = Math.min(count, 1);
  count = Math.min(count, MAX_PER_TICK, room);
  if (!count) return [];

  const rows = [];
  const families = new Set();
  const activitySince = finite(s.activity?.startAt) ? s.activity.startAt : at - (c.tickSec ?? 900);
  const valence = s.vitals?.mood?.valence;
  const voiceState = { activity: ctx, mood: !finite(valence) ? 'ok' : valence >= 0.3 ? 'high' : valence <= -0.25 ? 'low' : 'ok', time: timeOfDay(hour) };
  for (let i = 0; rows.length < count && i < scored.length; i++) {
    const w = scored[i];
    // Two thoughts in a tick don't come from one family.
    if (families.has(w.family)) continue;
    families.add(w.family);
    // The least used of its open phrases, with a little chance.
    const ranked = [...w.choices].sort((a, b) => (used.get(a)?.n ?? 0) - (used.get(b)?.n ?? 0));
    const least = used.get(ranked[0])?.n ?? 0;
    const pool = ranked.filter(t => (used.get(t)?.n ?? 0) === least);
    const phrase = pool[Math.floor(rng() * pool.length)];
    used.set(phrase, { n: (used.get(phrase)?.n ?? 0) + 1, last: at });
    const span = catchUp ? 0 : (c.tickSec ?? 900);
    // What's about what he's doing starts with it; a body feeling or a wandering mind doesn't care, but he was awake.
    const tied = w.family !== 'wordless' && w.family !== 'body' ? activitySince : (finite(c.wokeAt) ? c.wokeAt : 0);
    const lastAt = Math.max(recent.at(-1)?.at ?? 0, rows.at(-1)?.at ?? 0);
    const earliest = Math.max(at - span, tied, finite(w.eventAt) ? w.eventAt : 0, lastAt ? lastAt + MIN_GAP_SEC : 0);
    if (earliest > at) continue;   // too soon after the last one: silence
    const when = Math.round(earliest + (at - earliest) * rng());
    // The English line stays the memory's key; a bank only says how he'd say it. A heavy stretch keeps the plain words.
    const said = heavy ? phrase : voiceLine('thought', phrase, voiceState, `${at}:${phrase}`);
    const bank = said !== phrase ? bankVersion() : null;
    rows.push({
      at: when, family: w.family, text: fill(said, w.vars), cause: w.cause ?? null,
      codes: { tick: at, ...(w.codes ?? {}), ...(bank ? { bank } : {}) }, originKind: w.origin?.kind ?? 'self', originJid: w.origin?.jid ?? null,
      evidence: w.evidence ?? [], asOf: c.asOf ?? null, phraseKey: phrase,
      dedupeKey: w.key ? `${w.family}:${w.key}` : `slot:${at}:${rows.length}`,
    });
  }
  return rows.sort((a, b) => a.at - b.at);
}

/** The kit's stream kind for a family. */
export function streamKind(family) {
  return family === 'body' ? 'body' : family === 'wordless' ? 'feeling' : 'thought';
}

