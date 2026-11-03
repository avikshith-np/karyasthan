// Public site (spec 013): the public.json validator — contracts/public-json.md as
// code. Closed keys (an unknown key is an error), types, string/array caps, the
// coordinate grid, the size cap, and a final pass of every string through the
// scrubber. validate(doc, scrubber) → { ok, errors: [path codes] }. Pure.

export const SIZE_MAX = 512 * 1024;
export const GRID = 0.01;
export const FICTION = 'A fictional AI character living a simulated life.';

const ID = { m: /^m_[0-9a-f]{10}$/, w: /^w_[0-9a-f]{10}$/, p: /^p_[0-9a-f]{10}$/, c: /^c_[0-9a-f]{10}$/, a: /^a_[0-9a-f]{10}$/, d: /^d_[0-9a-f]{10}$/, f: /^f_[0-9a-f]{12}$/, s: /^s_[0-9a-f]{10}$/, t: /^t_[0-9a-f]{10}$/, dr: /^dr_[0-9a-f]{10}$/ };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK = /^\d{4}-W\d{2}$/;
const KIND = /^[a-z][a-z0-9:_-]{0,31}$/;
const SKY = ['sunny', 'fair', 'cloudy', 'grey', 'stormy'];

// ── tiny schema language ──
const nul = (t) => ({ ...t, nullable: true });
// An optional key (spec 016: additive keys the live site ignores): may be absent, never null unless nul() too.
const opt = (t) => ({ ...t, optional: true });
const S = {
  str: (max, extra = {}) => ({ t: 'str', max, ...extra }),
  re: (re, extra = {}) => ({ t: 'str', max: 64, re, ...extra }),
  // A fixed-shape token (salted hex id, date, week): no room for text, so not scrubbed.
  tok: (re) => ({ t: 'str', max: 24, re, token: true }),
  int: (min = -Infinity, max = Infinity) => ({ t: 'num', int: true, min, max }),
  num: (min = -Infinity, max = Infinity) => ({ t: 'num', min, max }),
  time: () => ({ t: 'num', int: true, min: 946684800, max: 4102444800 }),
  bool: () => ({ t: 'bool' }),
  arr: (item, max) => ({ t: 'arr', item, max }),
  obj: (shape) => ({ t: 'obj', shape }),
  one: (...alts) => ({ t: 'one', alts }),
  lit: (v) => ({ t: 'lit', v }),
};

const withRef = S.one(S.tok(ID.c), S.tok(ID.f), S.lit('friend'));
const ROW = S.obj({
  at: S.time(), end: nul(S.time()), kind: S.re(KIND), label: S.str(120),
  placeId: nul(S.tok(ID.p)), with: S.arr(withRef, 8),
  sceneId: opt(S.tok(ID.s)),   // 016: the row's scene (export-contract.md)
});
const BEAT = S.obj({ at: S.time(), text: S.str(200) });
// ── 016 scenes (specs/016-scene-playouts/export-contract.md) ──
export const SCENE_ENDINGS = Object.freeze(['nothing', 'swapped_numbers', 'plan_to_meet', 'stayed_late', 'left_early', 'parted_badly']);
export const SCENE_MAX = 30;
export const SCENE_PARAS_MAX = 9;
export const SCENE_TEXT_MAX = 2400;   // all paras together (a long outing; a short one is still written under 1200)
export const SCENE_SCHEMA_VERSION = 1;
export const SCENE = S.obj({
  id: S.tok(ID.s), at: S.time(), end: S.time(), placeId: nul(S.tok(ID.p)),
  with: S.arr(S.tok(ID.c), 8), firstMeet: S.arr(S.tok(ID.c), 8),
  kind: S.re(KIND), area: nul(S.str(60)),
  paras: S.arr(S.str(SCENE_TEXT_MAX), SCENE_PARAS_MAX),
  highlight: nul(S.str(160)), awkward: nul(S.str(160)), topics: S.arr(S.str(40), 5),
  impressions: nul(S.obj({ him: S.str(160), them: S.str(160) })),
  ending: S.one(...SCENE_ENDINGS.map((e) => S.lit(e))),
});
// ── 018 wallet (contracts/public-json.md "wallet"): optional, additive like 016's scenes ──
// Amounts are integers in the world's currency (the site formats them); labels are code
// words. Never a setback (heavy) or an owner "set" (no public category for either).
export const WALLET_SCHEMA_VERSION = 1;
export const WALLET_CATEGORIES = Object.freeze(['salary', 'income', 'rent', 'bills', 'groceries', 'food', 'outing', 'travel', 'other', 'out']);
export const WALLET_ITEMS_MAX = 400;
export const WALLET_DAYS_MAX = 31;
const MONTH = /^\d{4}-\d{2}$/;
const AMOUNT = () => S.int(0, 1e10);
export const WALLET_ITEM = S.obj({
  id: S.tok(ID.w), at: S.time(), dir: S.one(S.lit('in'), S.lit('out')), amount: S.int(1, 1e9),
  category: S.one(...WALLET_CATEGORIES.filter((c) => c !== 'out').map((c) => S.lit(c))),
  label: S.str(60), placeId: nul(S.tok(ID.p)),
});
// ── plan 020 (contracts/public-json.md): optional, additive, each with its own schema number ──
export const LIVE_SCHEMA_VERSION = 1;
export const LIVE_PHASES = Object.freeze(['arriving', 'settling', 'main', 'lull', 'winding', 'leaving']);
export const LIVE_BEATS_MAX = 6;
export const LIVE_WITH_MAX = 4;
export const LIVE_PRIVATE_LINE = 'out';
export const LIVE = S.obj({
  at: S.time(), startAt: nul(S.time()), until: nul(S.time()), placeId: nul(S.tok(ID.p)), with: S.arr(S.tok(ID.c), LIVE_WITH_MAX),
  phase: nul(S.one(...LIVE_PHASES.map((x) => S.lit(x)))), line: S.str(160), beats: S.arr(S.obj({ at: S.time(), text: S.str(120) }), LIVE_BEATS_MAX),
});
export const THOUGHTS_SCHEMA_VERSION = 1;
export const THOUGHTS_MAX = 40;
export const THOUGHT_TEXT_MAX = 80;
export const THOUGHT = S.obj({ id: S.tok(ID.t), at: S.time(), kind: S.lit('stream'), text: S.str(THOUGHT_TEXT_MAX) });
export const DREAMS_SCHEMA_VERSION = 1;
export const DREAMS_MAX = 14;
export const DREAM_VIVID_MAX = 600;
export const DREAM_FRAGMENT_MAX = 160;
export const DREAM_TONES = Object.freeze({ good: 'pleasant', flat: 'neutral', bad: 'anxious', nightmare: 'nightmare' });
export const DREAM = S.obj({
  id: S.tok(ID.dr), night: S.tok(DATE), at: S.time(), recall: S.one(S.lit('vivid'), S.lit('fragment')),
  tone: S.one(...Object.values(DREAM_TONES).map((x) => S.lit(x))), text: S.str(DREAM_VIVID_MAX), with: S.arr(S.tok(ID.c), 3), placeIds: S.arr(S.tok(ID.p), 3),
});
export const MIND_SCHEMA_VERSION = 1;
export const MIND_ROWS_MAX = 12;
const MIND_TREND = S.one(S.lit('up'), S.lit('down'), S.lit('steady'));
export const MIND = S.obj({
  interests: S.arr(S.obj({ topic: S.str(40), value: S.num(0, 1), trend: MIND_TREND, why: S.str(160), since: S.time() }), MIND_ROWS_MAX),
  opinions: S.arr(S.obj({ topic: S.str(40), stance: S.num(-1, 1), trend: MIND_TREND, why: S.str(160), since: S.time() }), MIND_ROWS_MAX),
});
// ── 019 phone (contracts/public-json.md "phone"): optional, additive like scenes / wallet ──
// His in-world texts with fictional cast members only; every text scrubbed like all prose.
export const PHONE_SCHEMA_VERSION = 1;
export const PHONE_THREADS_MAX = 30;
export const PHONE_THREAD_MESSAGES_MAX = 60;
export const PHONE_MESSAGES_MAX = 500;            // over all threads (the document stays well under SIZE_MAX)
export const PHONE_TEXT_MAX = 300;
export const PHONE_MESSAGE = S.obj({ id: S.tok(ID.m), at: S.time(), dir: S.one(S.lit('out'), S.lit('in')), text: S.str(PHONE_TEXT_MAX) });
export const PHONE = S.obj({
  threads: S.arr(S.obj({ id: S.tok(ID.c), name: S.str(60), lastAt: S.time(), messages: S.arr(PHONE_MESSAGE, PHONE_THREAD_MESSAGES_MAX) }), PHONE_THREADS_MAX),
});
export const WALLET = S.obj({
  month: S.tok(MONTH),
  balance: nul(S.int(-1e9, 1e9)),
  salary: nul(S.obj({ amount: S.int(0, 1e9), payday: S.int(1, 31), lastDate: nul(S.tok(DATE)), nextDate: nul(S.tok(DATE)) })),
  monthIn: AMOUNT(), monthOut: AMOUNT(),
  byCategory: S.obj(Object.fromEntries(WALLET_CATEGORIES.map((c) => [c, opt(AMOUNT())]))),
  days: S.arr(S.obj({ date: S.tok(DATE), in: AMOUNT(), out: AMOUNT(), outWithFriends: AMOUNT(), items: S.arr(WALLET_ITEM, WALLET_ITEMS_MAX) }), WALLET_DAYS_MAX),
});
const POINT = S.obj({ at: S.time(), closeness: nul(S.num(0, 1)), trust: nul(S.num(0, 1)), tension: nul(S.num(0, 1)) });

export const SCHEMA = S.obj({
  v: S.lit(1),
  generatedAt: S.time(),
  timezone: S.str(64),
  fiction: S.lit(FICTION),
  persona: S.obj({ name: S.str(40), age: nul(S.int(0, 120)), city: nul(S.str(60)) }),
  now: S.obj({
    at: S.time(),
    doing: nul(S.obj({ kind: S.re(KIND), label: S.str(120), since: nul(S.time()), until: nul(S.time()), with: S.arr(withRef, 8) })),
    where: S.obj({ placeId: nul(S.tok(ID.p)), name: nul(S.str(80)), home: S.bool() }),
    travel: nul(S.obj({ mode: nul(S.str(24)), toName: nul(S.str(80)), toHome: S.bool() })),
    mood: nul(S.obj({ sky: S.one(...SKY.map(S.lit)), valence: S.num(-1, 1), arousal: S.num(0, 1) })),
    energy: nul(S.int(0, 100)),
    vitals: S.obj({
      energy: nul(S.int(0, 100)), stress: nul(S.int(0, 100)), hunger: nul(S.int(0, 100)), social: nul(S.int(0, 100)),
      workPressure: nul(S.int(0, 100)), sleepDebtHours: nul(S.num(0, 20)),
      mood: nul(S.int(-100, 100)), arousal: nul(S.int(0, 100)), money: nul(S.int(-1e9, 1e9)),
    }),
    weather: nul(S.obj({ condition: nul(S.str(24)), tempC: nul(S.int(-30, 60)), rain: S.bool() })),
    awake: S.bool(),
    hardStretch: S.bool(),
  }),
  today: S.obj({ date: S.tok(DATE), rows: S.arr(ROW, 200) }),
  next: S.arr(ROW, 13),
  days: S.arr(S.obj({ date: S.tok(DATE), rows: S.arr(ROW, 200) }), 30),
  story: S.obj({
    chapters: S.arr(S.obj({
      id: S.tok(ID.a), kind: S.re(KIND), title: S.str(80), stage: nul(S.str(40)), status: nul(S.str(16)),
      startedAt: nul(S.time()), endedAt: nul(S.time()), with: S.arr(withRef, 4), beats: S.arr(BEAT, 10),
    }), 30),
    recaps: S.arr(S.obj({ week: S.tok(WEEK), from: S.time(), to: S.time(), lines: S.arr(S.str(160), 8) }), 8),
    hardStretchLine: nul(S.str(80)),
  }),
  people: S.obj({
    cast: S.arr(S.obj({
      id: S.tok(ID.c), name: S.str(60), relation: nul(S.str(40)), job: nul(S.str(80)), status: nul(S.str(160)),
      closeness: nul(S.num(0, 1)), trust: nul(S.num(0, 1)), tension: nul(S.num(0, 1)),
      series: S.arr(POINT, 61), beats: S.arr(BEAT, 10),
    }), 40),
    friends: S.arr(S.obj({ id: S.tok(ID.f), name: S.str(40) }), 100),
  }),
  city: S.obj({
    places: S.arr(S.obj({ id: S.tok(ID.p), name: S.str(80), kind: nul(S.re(KIND)), lat: nul({ t: 'num', grid: true, min: -90, max: 90 }), lon: nul({ t: 'num', grid: true, min: -180, max: 180 }) }), 200),
    visits: S.arr(S.obj({ placeId: S.tok(ID.p), count: S.int(0, 100000) }), 200),
  }),
  stats: S.obj({
    since: S.tok(DATE), days: S.int(0, 100000),
    sleep: S.arr(S.obj({ date: S.tok(DATE), hours: S.num(0, 24) }), 60),
    meals: S.int(0, 1e6), cafeVisits: S.int(0, 1e6), rainyDays: S.int(0, 1e6), soaked: S.int(0, 1e6),
    plans: S.obj({ kept: S.int(0, 1e6), bailed: S.int(0, 1e6) }),
    outings: S.int(0, 1e6),
  }),
  journal: S.arr(S.obj({ night: S.tok(DATE), text: S.str(1200), publishedAt: S.time() }), 60),
  votes: S.arr(S.obj({
    id: S.tok(ID.d), question: S.str(140), closesAt: S.time(),
    options: S.arr(S.obj({ id: S.re(/^[a-z][a-z0-9_-]{0,23}$/), label: S.str(100) }), 4),
  }), 5),
  // 016: optional, additive (v stays 1; the live site gates on v === 1 and ignores unknown keys).
  scenes: opt(S.arr(SCENE, SCENE_MAX)),
  scenesSchema: opt(S.lit(SCENE_SCHEMA_VERSION)),
  // 018: optional, additive the same way (v stays 1: the live site refuses any other v).
  wallet: opt(WALLET),
  walletSchema: opt(S.lit(WALLET_SCHEMA_VERSION)),
  // 019: optional, additive the same way.
  phone: opt(PHONE),
  phoneSchema: opt(S.lit(PHONE_SCHEMA_VERSION)),
  // plan 020: optional, additive the same way.
  live: opt(nul(LIVE)),
  liveSchema: opt(S.lit(LIVE_SCHEMA_VERSION)),
  thoughts: opt(S.arr(THOUGHT, THOUGHTS_MAX)),
  thoughtsSchema: opt(S.lit(THOUGHTS_SCHEMA_VERSION)),
  dreams: opt(S.arr(DREAM, DREAMS_MAX)),
  dreamsSchema: opt(S.lit(DREAMS_SCHEMA_VERSION)),
  mind: opt(MIND),
  mindSchema: opt(S.lit(MIND_SCHEMA_VERSION)),
});

/**
 * Plan 020's keys, what the schema language can't say. Every person is a cast member of this document and every place a place of it,
 * never home; a private session's live line is the bare word and nothing beside it; times in order; ids unique; a fragment stays short.
 */
function feedRules(doc, errs) {
  for (const k of ['live', 'thoughts', 'dreams', 'mind']) if (`${k}Schema` in doc !== k in doc) errs.push(`$.${k}Schema:without_${k}`);
  const castIds = new Set((doc.people?.cast ?? []).map((c) => c?.id));
  const placeIds = new Set((doc.city?.places ?? []).map((p) => p?.id));
  const live = doc.live;
  if (live && typeof live === 'object') {
    const bare = live.line === LIVE_PRIVATE_LINE;
    if (bare) {
      if (live.placeId !== null || live.startAt !== null || live.until !== null || live.phase !== null || live.with?.length || live.beats?.length) errs.push('$.live:private_has_more');
    } else {
      if (!Array.isArray(live.with) || !live.with.length) errs.push('$.live.with:empty');
      (live.with ?? []).forEach((c, i) => { if (!castIds.has(c)) errs.push(`$.live.with[${i}]:not_cast`); });
      if (live.placeId !== null && !placeIds.has(live.placeId)) errs.push('$.live.placeId:not_place');
      if (typeof live.phase !== 'string') errs.push('$.live.phase:missing');
      if (typeof live.startAt !== 'number') errs.push('$.live.startAt:missing');
    }
    const ats = (live.beats ?? []).map((b) => b?.at);
    if (ats.some((a, j) => j > 0 && !(a >= ats[j - 1]))) errs.push('$.live.beats:order');
  }
  const newestFirst = (list, path) => {
    const seen = new Set();
    list.forEach((x, i) => {
      if (seen.has(x?.id)) errs.push(`${path}[${i}].id:duplicate`);
      seen.add(x?.id);
      if (i > 0 && !(x?.at <= list[i - 1]?.at)) errs.push(`${path}:order`);
    });
  };
  if (Array.isArray(doc.thoughts)) newestFirst(doc.thoughts, '$.thoughts');
  if (Array.isArray(doc.dreams)) {
    newestFirst(doc.dreams, '$.dreams');
    doc.dreams.forEach((d, i) => {
      if (d?.recall === 'fragment' && typeof d.text === 'string' && d.text.length > DREAM_FRAGMENT_MAX) errs.push(`$.dreams[${i}].text:fragment_too_long`);
      (d?.with ?? []).forEach((c, j) => { if (!castIds.has(c)) errs.push(`$.dreams[${i}].with[${j}]:not_cast`); });
      (d?.placeIds ?? []).forEach((p, j) => { if (!placeIds.has(p)) errs.push(`$.dreams[${i}].placeIds[${j}]:not_place`); });
    });
  }
}

function onGrid(v) {
  // A cell centre: k·GRID + GRID/2, kept to 3 decimals.
  const k = (v - GRID / 2) / GRID;
  return Math.abs(k - Math.round(k)) < 1e-6 && Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6;
}

function check(spec, v, path, errs, strings) {
  if (v === null && spec.nullable) return;
  switch (spec.t) {
    case 'lit': if (v !== spec.v) errs.push(`${path}:literal`); return;
    case 'bool': if (typeof v !== 'boolean') errs.push(`${path}:bool`); return;
    case 'num':
      if (typeof v !== 'number' || !Number.isFinite(v)) { errs.push(`${path}:num`); return; }
      if (spec.int && !Number.isInteger(v)) errs.push(`${path}:int`);
      if (v < spec.min || v > spec.max) errs.push(`${path}:range`);
      if (spec.grid && !onGrid(v)) errs.push(`${path}:grid`);
      return;
    case 'str':
      if (typeof v !== 'string' || !v.trim()) { errs.push(`${path}:str`); return; }
      if (v.length > spec.max) errs.push(`${path}:long`);
      if (spec.re && !spec.re.test(v)) errs.push(`${path}:pattern`);
      if (!spec.token) strings.push([path, v]);
      return;
    case 'arr':
      if (!Array.isArray(v)) { errs.push(`${path}:arr`); return; }
      if (v.length > spec.max) errs.push(`${path}:too_many`);
      v.forEach((x, i) => check(spec.item, x, `${path}[${i}]`, errs, strings));
      return;
    case 'obj': {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) { errs.push(`${path}:obj`); return; }
      for (const k of Object.keys(v)) if (!(k in spec.shape)) errs.push(`${path}.${k}:unknown_key`);
      for (const [k, s] of Object.entries(spec.shape)) {
        if (!(k in v)) { if (!s.optional) errs.push(`${path}.${k}:missing`); continue; }
        check(s, v[k], `${path}.${k}`, errs, strings);
      }
      return;
    }
    case 'one': {
      for (const a of spec.alts) { const e = []; check(a, v, path, e, []); if (!e.length) { if (typeof v === 'string' && !(a.token || a.t === 'lit')) strings.push([path, v]); return; } }
      errs.push(`${path}:none_of`);
      return;
    }
    default: errs.push(`${path}:schema`);
  }
}

/** Cross-field rules the schema language can't say — 016: paras ≤ 2400 chars together, firstMeet ⊆ with, scenesSchema only beside scenes; 018: walletSchema ⇔ wallet, ≤ 400 wallet items; 019: phoneSchema ⇔ phone, threads of this doc's cast. */
export function sceneRules(doc) {
  const errs = [];
  if (!doc || typeof doc !== 'object') return errs;
  if ('scenesSchema' in doc && !('scenes' in doc)) errs.push('$.scenesSchema:without_scenes');
  // 018: walletSchema only beside wallet; ≤ WALLET_ITEMS_MAX items over all days.
  if ('walletSchema' in doc !== 'wallet' in doc) errs.push('$.walletSchema:without_wallet');
  if (doc.wallet && Array.isArray(doc.wallet.days)) {
    const n = doc.wallet.days.reduce((a, d) => a + (Array.isArray(d?.items) ? d.items.length : 0), 0);
    if (n > WALLET_ITEMS_MAX) errs.push('$.wallet.days:too_many_items');
  }
  // 019: phoneSchema only beside phone; every thread a cast member of this document, not empty,
  // its lastAt its newest message, messages oldest → newest, ids unique, ≤ PHONE_MESSAGES_MAX in all.
  if ('phoneSchema' in doc !== 'phone' in doc) errs.push('$.phoneSchema:without_phone');
  if (doc.phone && Array.isArray(doc.phone.threads)) {
    const castIds = new Set(Array.isArray(doc.people?.cast) ? doc.people.cast.map((c) => c?.id) : []);
    const seen = new Set();
    let n = 0;
    doc.phone.threads.forEach((t, i) => {
      if (!t || typeof t !== 'object' || !Array.isArray(t.messages)) return;
      if (!castIds.has(t.id)) errs.push(`$.phone.threads[${i}].id:not_cast`);
      if (seen.has(t.id)) errs.push(`$.phone.threads[${i}].id:duplicate`);
      seen.add(t.id);
      if (!t.messages.length) errs.push(`$.phone.threads[${i}].messages:empty`);
      n += t.messages.length;
      const ats = t.messages.map((m) => m?.at);
      if (ats.some((a, j) => j > 0 && !(a >= ats[j - 1]))) errs.push(`$.phone.threads[${i}].messages:order`);
      if (t.messages.length && t.lastAt !== ats[ats.length - 1]) errs.push(`$.phone.threads[${i}].lastAt:mismatch`);
      for (const m of t.messages) { if (seen.has(m?.id)) errs.push(`$.phone.threads[${i}].messages:duplicate_id`); seen.add(m?.id); }
    });
    if (n > PHONE_MESSAGES_MAX) errs.push('$.phone.threads:too_many_messages');
  }
  feedRules(doc, errs);
  if (!Array.isArray(doc.scenes)) return errs;
  doc.scenes.forEach((sc, i) => {
    if (!sc || typeof sc !== 'object') return;
    if (Array.isArray(sc.paras) && sc.paras.reduce((a, p) => a + (typeof p === 'string' ? p.length : 0), 0) > SCENE_TEXT_MAX) errs.push(`$.scenes[${i}].paras:long`);
    if (Array.isArray(sc.paras) && !sc.paras.length) errs.push(`$.scenes[${i}].paras:empty`);
    if (Array.isArray(sc.firstMeet) && Array.isArray(sc.with) && sc.firstMeet.some((c) => !sc.with.includes(c))) errs.push(`$.scenes[${i}].firstMeet:not_in_with`);
    if (Array.isArray(sc.with) && !sc.with.length) errs.push(`$.scenes[${i}].with:empty`);
    if (sc.impressions && Array.isArray(sc.firstMeet) && !sc.firstMeet.length) errs.push(`$.scenes[${i}].impressions:not_first_meet`);
  });
  return errs;
}

/** One scene against the schema + rules (the builder drops a failing scene before the document is validated). → [errors] */
export function validateScene(sc, scrubber) {
  const errors = [];
  const strings = [];
  check(SCENE, sc, '$', errors, strings);
  errors.push(...sceneRules({ scenes: [sc] }).map((e) => e.replace('$.scenes[0]', '$')));
  if (scrubber) for (const [path, s] of strings) { const why = scrubber.check(s); if (why) errors.push(`${path}:${why}`); }
  return errors;
}

/** → { ok, errors, size } — errors are path:code strings (no values). */
export function validate(doc, scrubber) {
  const errors = [];
  const strings = [];
  check(SCHEMA, doc, '$', errors, strings);
  errors.push(...sceneRules(doc));
  const soft = [];
  if (scrubber) {
    for (const [path, s] of strings) {
      const why = scrubber.check(s);
      // A real name's lone word (not its first name, not the whole name) is soft here: the builder's
      // clean() already dropped every free text holding one; what reaches here is code-built words.
      if (why === 'real_name_token') soft.push(`${path}:${why}`);
      else if (why) errors.push(`${path}:${why}`);
    }
  } else {
    errors.push('$:no_scrubber');
  }
  let size = 0;
  try { size = Buffer.byteLength(JSON.stringify(doc), 'utf8'); } catch { errors.push('$:serialize'); }
  if (size > SIZE_MAX) errors.push('$:too_large');
  return { ok: errors.length === 0, errors: errors.slice(0, 50), soft: soft.slice(0, 50), size };
}

// ── the kill switch's document ──
const OFFLINE = S.obj({ v: S.lit(1), offline: S.lit(true), generatedAt: S.time(), fiction: S.lit(FICTION) });

export function offlineDoc(at) {
  return { v: 1, offline: true, generatedAt: at, fiction: FICTION };
}

export function validateOffline(doc) {
  const errors = [];
  check(OFFLINE, doc, '$', errors, []);
  return { ok: errors.length === 0, errors };
}
