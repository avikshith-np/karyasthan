import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { isSkillEnabled } from '../skills/skillRunner.js';
import { startSession, instagramState, startOfTodayUnix } from './session.js';
import { checkChat } from './chat.js';
import { isLifeOn, isAwakeAt as lifeIsAwakeAt, freeWindows as lifeFreeWindows, getState as getLifeState } from '../life/index.js';

// Automatic browsing sessions (specs/005): `sessionsPerDay` random start times per day,
// inside waking hours (outside SLEEP_START_HOUR..SLEEP_END_HOUR), at least 75 min apart.
// Only runs while the "instagram-reels" skill is on. Manual sessions (dashboard Browse
// button) don't consume a slot. The plan is in-memory and rebuilt each day/restart.
//
// Life (spec 009 §R16): while the life engine runs, "awake" is his simulated
// sleep (life.isAwakeAt), slots are drawn from the day's free windows, and the
// chat poll also waits while he is in a meeting or do-not-disturb. The sleep
// hours stay the fallback whenever life is off (or the day has no free window).
// The plan is rebuilt when life switches on or off.

const MIN_GAP_SEC = 75 * 60;
let plan = { day: null, slots: [] }; // slots: [{ at, done }]
let timer = null;

function localHour(unix) {
  return +new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, hourCycle: 'h23', hour: '2-digit' })
    .format(new Date(unix * 1000));
}

export function isAwake(unix = Math.floor(Date.now() / 1000)) {
  if (isLifeOn()) {
    try { return lifeIsAwakeAt(unix); } catch { /* fall back to sleep hours */ }
  }
  return isAwakeBySleepHours(unix);
}

function isAwakeBySleepHours(unix) {
  const h = localHour(unix);
  const { sleepStartHour: s, sleepEndHour: e } = config;
  if (s === e) return true;
  return s < e ? !(h >= s && h < e) : !(h >= s || h < e);
}

// Life on: 5-minute candidates inside the day's free windows, each with the room
// left before the window ends (the jitter stays inside it). [] → caller falls back.
function freeCandidates(dayStart, nowUnix) {
  let windows = [];
  try { windows = lifeFreeWindows(dayStart) || []; } catch { windows = []; }
  const out = [];
  for (const w of windows) {
    if (!Number.isFinite(w?.from) || !Number.isFinite(w?.to)) continue;
    for (let t = w.from; t + 60 <= w.to; t += 300) {
      if (t > nowUnix + 120) out.push({ t, room: Math.min(300, w.to - t) });
    }
  }
  return out;
}

export function planDay(dayStart, count, nowUnix = Math.floor(Date.now() / 1000)) {
  // Candidate minutes of the day that are awake (life: free) and still in the future.
  let awake = isLifeOn() ? freeCandidates(dayStart, nowUnix) : [];
  if (!awake.length) {
    awake = [];
    for (let m = 0; m < 24 * 60; m += 5) {
      const t = dayStart + m * 60;
      if (t > nowUnix + 120 && isAwake(t)) awake.push({ t, room: 300 });
    }
  }
  const slots = [];
  for (let tries = 0; slots.length < count && tries < 500 && awake.length; tries++) {
    const c = awake[Math.floor(Math.random() * awake.length)];
    const t = c.t + Math.floor(Math.random() * c.room);
    if (slots.every(s => Math.abs(s - t) >= MIN_GAP_SEC)) slots.push(t);
  }
  return slots.sort((a, b) => a - b).map(at => ({ at, done: false }));
}

function ensurePlan() {
  const day = startOfTodayUnix();
  const life = isLifeOn();
  if (plan.day !== day || plan.count !== config.instagram.sessionsPerDay || plan.life !== life) {
    // Only life switching on/off mid-day re-plans the rest of today around the
    // slots already used; a new day or a new count plans from scratch (as before).
    const lifeSwitch = plan.day === day && plan.count === config.instagram.sessionsPerDay && plan.life !== undefined;
    const done = lifeSwitch ? plan.slots.filter(s => s.done) : [];
    const fresh = planDay(day, Math.max(0, config.instagram.sessionsPerDay - done.length))
      .filter(f => done.every(d => Math.abs(d.at - f.at) >= MIN_GAP_SEC));
    plan = { day, count: config.instagram.sessionsPerDay, life, slots: [...done, ...fresh].sort((a, b) => a.at - b.at) };
    logger.info({ slots: plan.slots.map(s => new Date(s.at * 1000).toISOString()) }, 'Instagram sessions planned for today');
  }
}

let lastChatPoll = 0;

// Life on: asleep, in a meeting or on do-not-disturb he doesn't open Instagram
// (chat poll or an automatic session) — the projection's availability in force.
const IG_BLOCKED = new Set(['asleep', 'meeting', 'dnd']);

function lifeBlocksInstagram(nowUnix) {
  if (!isLifeOn()) return false;
  try {
    const v = getLifeState();
    if (v?.activity?.kind === 'sleep') return true;
    const a = v?.availability;
    const live = a && (!Number.isFinite(a.until) || a.until > nowUnix);
    return !!(live && IG_BLOCKED.has(a.state));
  } catch {
    return false;
  }
}

function chatTick() {
  if (!isSkillEnabled('instagram-chat') || !isAwake()) return;
  if (lifeBlocksInstagram(Math.floor(Date.now() / 1000))) return;
  if (Date.now() - lastChatPoll < config.instagram.chatPollMinutes * 60_000) return;
  const st = instagramState();
  if (st.busy || st.alert) return;
  lastChatPoll = Date.now();
  checkChat({ trigger: 'poll' }).catch(() => {}); // outcome is in chatState() / the dashboard
}

function tick() {
  try { chatTick(); } catch (err) { logger.warn({ err: err.message }, 'Instagram chat tick failed'); }
  try {
    ensurePlan();
    if (!isSkillEnabled('instagram-reels')) return;
    const now = Math.floor(Date.now() / 1000);
    const due = plan.slots.find(s => !s.done && s.at <= now);
    if (!due) return;
    const st = instagramState();
    if (st.busy || st.alert) return; // retry next tick; a stale slot is dropped below
    due.done = true;
    if (now - due.at > 45 * 60 || !isAwake(now)) return; // missed by a lot (restart, long share) — skip it
    if (lifeBlocksInstagram(now)) return; // life: the day changed under the slot (meeting, dnd) — skip it
    startSession({ trigger: 'auto' }); // phone offline → the session ends at once with that reason, logged on the dashboard
  } catch (err) {
    logger.warn({ err: err.message }, 'Instagram scheduler tick failed');
  }
}

export function startInstagramScheduler() {
  if (timer) return;
  ensurePlan();
  timer = setInterval(tick, 60_000);
  timer.unref?.();
}

export function stopInstagramScheduler() {
  clearInterval(timer);
  timer = null;
}

export function schedulePlan() {
  ensurePlan();
  return plan.slots.map(s => ({ at: s.at, done: s.done }));
}
