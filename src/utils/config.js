import { config as loadEnv } from 'dotenv';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { PROVIDER_NAMES, PROVIDER_KEY_FIELD, EFFORT_LEVELS } from '../brain/providers.js';
import { ROLE_NAMES, METERED_LABELS, readRoleConfig, resolveRole, mutableKeys as roleMutableKeys } from '../brain/roles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

loadEnv({ path: path.join(PROJECT_ROOT, '.env') });

function required(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key, fallback) {
  return process.env[key] || fallback;
}

// ── 014 geo (.env-only) ───────────────────────────────────────────────────
// A geo host: https only; http only for a loopback host or with GEO_ALLOW_HTTP
// (a LAN / Tailscale / docker self-hosted service). Anything else → '' (that
// service is off; the client reports it unconfigured). Read with ?? so an
// explicitly empty value turns the service off. Trailing slashes stripped.
function geoUrl(key, fallback, allowHttp) {
  const v = String(process.env[key] ?? fallback).trim().replace(/\/+$/, '');
  if (!v) return '';
  let u;
  try { u = new URL(v); } catch { console.warn(`[config] ${key} is not a URL — that service is off`); return ''; }
  if (u.username || u.password || u.search || u.hash) { console.warn(`[config] ${key} must be a bare base URL — that service is off`); return ''; }
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);
  if (u.protocol === 'https:' || (u.protocol === 'http:' && (loopback || allowHttp))) return v;
  console.warn(`[config] ${key} must be https (http only for loopback or with GEO_ALLOW_HTTP=true) — that service is off`);
  return '';
}

function buildGeoConfig() {
  const allowHttp = String(process.env.GEO_ALLOW_HTTP ?? 'false').trim() === 'true';
  const contact = String(process.env.GEO_CONTACT_EMAIL ?? '').trim();
  const email = /^[^\s@<>()]{1,64}@[^\s@<>()]{1,190}$/.test(contact) ? contact : '';
  if (contact && !email) console.warn('[config] GEO_CONTACT_EMAIL is not an email address — Nominatim/Overpass stay unconfigured');
  let version = '0';
  try { version = String(JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || '0'); } catch { /* keep 0 */ }
  const ua = String(process.env.GEO_USER_AGENT ?? '').trim().replace(/[^\x20-\x7e]/g, '').slice(0, 160);
  return {
    enabled: String(process.env.GEO_ENABLED ?? 'true').trim() !== 'false',
    nominatimUrl: geoUrl('GEO_NOMINATIM_URL', 'https://nominatim.openstreetmap.org', allowHttp),
    overpassUrl: geoUrl('GEO_OVERPASS_URL', 'https://overpass-api.de/api/interpreter', allowHttp),
    osrmUrl: geoUrl('GEO_OSRM_URL', '', allowHttp),
    osrmFootUrl: geoUrl('GEO_OSRM_FOOT_URL', '', allowHttp),
    allowHttp,
    contactEmail: email,
    userAgent: ua || `karyasthan-life-sim/${version}${email ? ` (+${email})` : ''}`,
    timeoutMs: envNumber('GEO_TIMEOUT_MS', 8000, 1000, 60000, true),
    maxPerDay: envNumber('GEO_MAX_PER_DAY', 400, 1, 5000, true),
    switchRadiusKm: envNumber('GEO_SWITCH_RADIUS_KM', 2, 0.2, 5, false),
  };
}

// Bounded numeric .env reads (spec 008 config.mind): unset/blank/non-numeric → the
// default; out of range → clamped to the bound with a warning (a typo in .env should
// not stop the bot from booting, but it must never exceed the documented range).
function envNumber(key, fallback, min, max, integer) {
  const raw = process.env[key];
  if (raw == null || String(raw).trim() === '') return fallback;
  let n = Number(String(raw).trim());
  if (!Number.isFinite(n)) {
    console.warn(`[config] ${key} is not a number — using ${fallback}`);
    return fallback;
  }
  if (integer) n = Math.round(n);
  if (n < min || n > max) {
    const c = Math.min(max, Math.max(min, n));
    console.warn(`[config] ${key}=${n} is outside ${min}..${max} — using ${c}`);
    return c;
  }
  return n;
}
// '' (= the role's own effort) | low | medium | high. Never xhigh/max (plan review S2-08).
const MIND_EFFORTS = ['', 'low', 'medium', 'high'];
function envMindEffort(key) {
  const v = String(process.env[key] ?? '').trim();
  if (MIND_EFFORTS.includes(v)) return v;
  console.warn(`[config] ${key} accepts only low|medium|high or empty — got "${v}", using the role's effort`);
  return '';
}

// Mind settings (spec 008, plan "Configuration") — ONE table drives config.mind,
// the dashboard-mutable keys + their bounded types (MUTABLE_KEYS), the .env names
// for /api/config/persist (envWriter KEY_TO_ENV) and the defaults that keep an
// unset-but-default key out of /api/config/diff.
//   [dot path under config, .env name, type, default, mutable]
// type: 'bool' | 'int:min..max' | 'float:min..max' | 'enum:mindEffort'.
const MIND_SETTINGS = [
  ['mind.enabled', 'MIND_ENABLED', 'bool', false, false],   // boot default of the "mind" skill
  ['mind.glanceMinutes', 'MIND_GLANCE_MINUTES', 'int:15..180', 45, true],
  ['mind.glanceMaxPerDay', 'MIND_GLANCE_MAX_PER_DAY', 'int:0..40', 20, true],
  ['mind.thinkMaxPerDay', 'MIND_THINK_MAX_PER_DAY', 'int:0..8', 4, true],
  ['mind.thinkMinGapMinutes', 'MIND_THINK_MIN_GAP_MINUTES', 'int:30..720', 90, true],
  // '' = the mind role's own effort (roles.mind.effort); when set it wins for that caller only.
  ['mind.thinkEffort', 'MIND_THINK_EFFORT', 'enum:mindEffort', '', true],
  ['mind.sleepEffort', 'MIND_SLEEP_EFFORT', 'enum:mindEffort', '', true],
  ['mind.selfModelEveryNights', 'MIND_SELF_MODEL_EVERY_NIGHTS', 'int:1..14', 3, true],
  ['mind.clerkMaxPerDay', 'MIND_CLERK_MAX_PER_DAY', 'int:0..120', 60, true],
  ['mind.sleepReservePct', 'MIND_SLEEP_RESERVE_PCT', 'int:0..50', 20, true],
  ['mind.digestMaxChats', 'MIND_DIGEST_MAX_CHATS', 'int:1..12', 8, true],
  // .env-only hard caps / windows
  ['mind.digestMaxLines', 'MIND_DIGEST_MAX_LINES', 'int:20..400', 120, false],
  ['mind.selfModelMaxChars', 'MIND_SELF_MODEL_MAX_CHARS', 'int:200..1500', 1500, false],
  ['mind.selfStateMaxChars', 'MIND_SELF_STATE_MAX_CHARS', 'int:40..160', 160, false],
  ['mind.intentionTtlHours', 'MIND_INTENTION_TTL_HOURS', 'int:1..72', 24, false],
  ['mind.reviewDays', 'MIND_REVIEW_DAYS', 'int:1..90', 14, false],
  // proactive caps (0 disables that target kind)
  ['mind.proactive.dmEveryDays', 'MIND_PROACTIVE_DM_EVERY_DAYS', 'int:0..30', 3, true],
  ['mind.proactive.groupPerDay', 'MIND_PROACTIVE_GROUP_PER_DAY', 'int:0..4', 1, true],
  ['mind.proactive.maxPerDay', 'MIND_PROACTIVE_MAX_PER_DAY', 'int:0..12', 4, true],
  ['mind.proactive.dmBackoffDays', 'MIND_PROACTIVE_DM_BACKOFF_DAYS', 'int:0..60', 7, true],
  ['mind.proactive.groupBackoffDays', 'MIND_PROACTIVE_GROUP_BACKOFF_DAYS', 'int:0..60', 3, true],
  ['mind.proactive.draftsPerDay', 'MIND_PROACTIVE_DRAFTS_PER_DAY', 'int:0..12', 8, true],
  ['mind.proactiveMinScore', 'MIND_PROACTIVE_MIN_SCORE', 'float:0.3..0.9', 0.5, true],
  ['mind.proactiveTtlHours', 'MIND_PROACTIVE_TTL_HOURS', 'int:1..24', 6, false],
  ['mind.funAb', 'MIND_FUN_AB', 'bool', false, true],
];

function parseBoundedType(type) {
  const m = /^(int|float):(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)$/.exec(type);
  return m ? { integer: m[1] === 'int', min: Number(m[2]), max: Number(m[3]) } : null;
}

// Arcs settings (spec 010, plan "Configuration") — the same table shape as
// MIND_SETTINGS, driving config.arcs, MUTABLE_KEYS (dashboard-mutable rows), the
// envWriter KEY_TO_ENV entries and the diff defaults. The master on/off is the
// "arcs" skill (ARCS_ENABLED is only its boot default). Fate modes, sliders, pins,
// pause and the owner's reconciler mode are owner world events, never config, and
// nothing here is reachable by the mind (008's lever allow-list is unchanged).
// Extra types: 'enum:reconcilerMode' (auto|review|off; anything else → auto + a
// warning). ARCS_HEAVY_MIN_GAP_DAYS can only be raised: below 90 it is clamped up
// to 90 with a warning (envNumber). The .env-only hard caps can only be lowered.
const ARCS_SETTINGS = [
  ['arcs.enabled', 'ARCS_ENABLED', 'bool', false, false],   // boot default of the "arcs" skill
  ['arcs.reconcilerMode', 'ARCS_RECONCILER_MODE', 'enum:reconcilerMode', 'auto', false],   // boot default only
  ['arcs.extractMaxPerHour', 'ARCS_EXTRACT_MAX_PER_HOUR', 'int:0..20', 10, true],
  ['arcs.extractMaxPerDay', 'ARCS_EXTRACT_MAX_PER_DAY', 'int:0..120', 60, true],
  ['arcs.trayHours', 'ARCS_TRAY_HOURS', 'int:12..168', 72, true],
  // background arcs clerk calls only (life.claim.extract | life.journal); narration has its own caps
  ['arcs.clerkMaxPerDay', 'ARCS_CLERK_MAX_PER_DAY', 'int:0..200', 80, true],
  ['arcs.jevMaxPerDay', 'ARCS_JEV_MAX_PER_DAY', 'int:0..40', 20, true],
  ['arcs.mindBudgetUsd', 'ARCS_MIND_BUDGET_USD', 'float:0..3', 1, true],   // month-to-date cap over life.arcs.* callers (+ director.prompt + director.continuity for their own gates)
  // Director prompt (spec 011): calls per local day (0 = off) and its own month-to-date sub-cap
  ['arcs.promptMaxPerDay', 'ARCS_PROMPT_MAX_PER_DAY', 'int:0..60', 20, true],
  ['arcs.promptBudgetUsd', 'ARCS_PROMPT_BUDGET_USD', 'float:0..3', 0.5, true],
  // Continuity story read (spec 015 §P2.4): calls per local day (0 = off; the code checks always run) and its own sub-cap
  ['arcs.continuityMaxPerDay', 'ARCS_CONTINUITY_MAX_PER_DAY', 'int:0..100', 30, true],
  ['arcs.continuityBudgetUsd', 'ARCS_CONTINUITY_BUDGET_USD', 'float:0..3', 0.5, true],
  // Scene play-outs (spec 016 §1.6): model calls of both tiers per local day (0 = code one-liners only),
  // the mind-tier share, the chat-origin share (always clerk), the month-to-date $ cap over the life.scene.
  // callers (the mind tier stops at 60 % of it; never under life.arcs., so never the arcs budget), owner regenerations
  ['arcs.scenesEnabled', 'ARCS_SCENES_ENABLED', 'bool', true, true],
  ['arcs.sceneMaxPerDay', 'ARCS_SCENE_MAX_PER_DAY', 'int:0..30', 8, true],
  ['arcs.sceneMindMaxPerDay', 'ARCS_SCENE_MIND_MAX_PER_DAY', 'int:0..10', 3, true],
  ['arcs.sceneChatMaxPerDay', 'ARCS_SCENE_CHAT_MAX_PER_DAY', 'int:0..10', 2, true],
  ['arcs.sceneBudgetUsd', 'ARCS_SCENE_BUDGET_USD', 'float:0..5', 1, true],
  ['arcs.sceneRegenMaxPerDay', 'ARCS_SCENE_REGEN_MAX_PER_DAY', 'int:0..20', 6, true],
  ['arcs.scenePublic', 'ARCS_SCENE_PUBLIC', 'bool', true, true],
  // His phone (spec 019): texts with the fictional cast — message turns per local day (all writers), per member,
  // threads started on his own / by them (owner-told and replies aside), and the month-to-date $ cap over the
  // life.phone.* callers (never under life.arcs. or life.scene.)
  ['arcs.phoneEnabled', 'ARCS_PHONE_ENABLED', 'bool', true, true],
  // 019 (owner 2026-11-01: no limit on texts): the defaults are no practical limit; a number still caps, 0 = none.
  ['arcs.phoneMaxPerDay', 'ARCS_PHONE_MAX_PER_DAY', 'int:0..100000', 100000, true],
  ['arcs.phonePerCastDay', 'ARCS_PHONE_PER_CAST_DAY', 'int:0..100000', 100000, true],
  ['arcs.phoneOrganicPerDay', 'ARCS_PHONE_ORGANIC_PER_DAY', 'int:0..100000', 100000, true],
  ['arcs.phoneBudgetUsd', 'ARCS_PHONE_BUDGET_USD', 'float:0..10', 3, true],
  // 020 D2: how things stand with each fictional member. One clerk call per changed member at night, members per night, a month-to-date cap over `mind.standing`.
  ['arcs.standingEnabled', 'ARCS_STANDING_ENABLED', 'bool', true, true],
  ['arcs.standingMaxPerNight', 'ARCS_STANDING_MAX_PER_NIGHT', 'int:0..24', 4, true],
  ['arcs.standingBudgetUsd', 'ARCS_STANDING_BUDGET_USD', 'float:0..3', 0.3, true],
  // 020 G: dreams. Code but for a vivid dream's one small call a night, under its own month-to-date cap over `life.dream`.
  ['arcs.dreamsEnabled', 'ARCS_DREAMS_ENABLED', 'bool', true, true],
  ['arcs.dreamBudgetUsd', 'ARCS_DREAM_BUDGET_USD', 'float:0..3', 0.3, true],
  // 020 E3: the claim check. Shadow: stores verdicts, changes nothing, one small clerk call per output (`life.check.claims`) under
  // its own day cap and month-to-date $ cap. Enforce: a contradiction → one rewrite, then the writer's fallback (off until measured).
  ['arcs.claimCheckEnabled', 'ARCS_CLAIM_CHECK_ENABLED', 'bool', true, true],
  ['arcs.claimCheckEnforce', 'ARCS_CLAIM_CHECK_ENFORCE', 'bool', false, true],
  ['arcs.claimCheckMaxPerDay', 'ARCS_CLAIM_CHECK_MAX_PER_DAY', 'int:0..1000', 150, true],
  ['arcs.claimCheckBudgetUsd', 'ARCS_CLAIM_CHECK_BUDGET_USD', 'float:0..3', 0.5, true],
  // 020 F3: real thoughts. 3–6 a day at salient moments, one small mouth call each (caller life.thought.real); calls a day and a month-to-date $ cap.
  ['arcs.realThoughtsEnabled', 'ARCS_REAL_THOUGHTS_ENABLED', 'bool', false, true],   // ships off: the PM turns it on
  ['arcs.realThoughtMaxPerDay', 'ARCS_REAL_THOUGHT_MAX_PER_DAY', 'int:0..12', 8, true],
  ['arcs.realThoughtBudgetUsd', 'ARCS_REAL_THOUGHT_BUDGET_USD', 'float:0..3', 1, true],
  // '' = the mind role's own effort; unset → low
  ['arcs.weeklyEffort', 'ARCS_WEEKLY_EFFORT', 'enum:mindEffort', 'low', true],
  ['arcs.bigLeadHours', 'ARCS_BIG_LEAD_HOURS', 'int:24..168', 24, true],
  ['arcs.rewindDays', 'ARCS_REWIND_DAYS', 'int:1..30', 14, true],
  ['arcs.journalEnabled', 'ARCS_JOURNAL_ENABLED', 'bool', true, true],
  ['arcs.narrateMaxPerHour', 'ARCS_NARRATE_MAX_PER_HOUR', 'int:0..40', 20, true],
  ['arcs.narrateMaxPerDay', 'ARCS_NARRATE_MAX_PER_DAY', 'int:0..200', 100, true],
  // .env-only hard caps / floors
  ['arcs.bookmarksMax', 'ARCS_BOOKMARKS_MAX', 'int:1..30', 30, false],
  ['arcs.heavyMinGapDays', 'ARCS_HEAVY_MIN_GAP_DAYS', 'int:90..3650', 90, false],
  ['arcs.castMax', 'ARCS_CAST_MAX', 'int:0..24', 24, false],
  ['arcs.newCastPer90d', 'ARCS_NEW_CAST_PER_90D', 'int:0..2', 2, false],
  ['arcs.beatsPerWeek', 'ARCS_BEATS_PER_WEEK', 'int:0..8', 8, false],
  ['arcs.journalMaxChars', 'ARCS_JOURNAL_MAX_CHARS', 'int:200..1200', 1200, false],
  ['arcs.journalMaxCalls', 'ARCS_JOURNAL_MAX_CALLS', 'int:0..6', 6, false],
  // 016: a scene's narration cap (lower only) and the downtime age past which an outing gets the code one-liner
  ['arcs.sceneMaxChars', 'ARCS_SCENE_MAX_CHARS', 'int:400..1200', 1200, false],
  ['arcs.sceneMaxAgeHours', 'ARCS_SCENE_MAX_AGE_HOURS', 'int:6..72', 36, false],
];
const RECONCILER_MODES = ['auto', 'review', 'off'];

// Chats shape his life (spec 012, plan §1.4) — the same table shape. The master
// on/off is the "chat-influence" skill (CHAT_INFLUENCE_ENABLED is only its boot
// default); the area toggles and soft caps are dashboard-mutable and persistable,
// the hard caps .env-only (lower only). The mood caps themselves are code
// constants (src/life/influence/mood.js): moodScale can only soften them. Nothing
// here is reachable by the mind (008's lever allow-list is unchanged).
const CHAT_INFLUENCE_SETTINGS = [
  ['chatInfluence.enabled', 'CHAT_INFLUENCE_ENABLED', 'bool', false, false],   // boot default of the skill
  ['chatInfluence.mood', 'CHAT_INFLUENCE_MOOD', 'bool', true, true],
  ['chatInfluence.sleep', 'CHAT_INFLUENCE_SLEEP', 'bool', true, true],
  ['chatInfluence.work', 'CHAT_INFLUENCE_WORK', 'bool', true, true],
  ['chatInfluence.invites', 'CHAT_INFLUENCE_INVITES', 'bool', true, true],
  ['chatInfluence.advice', 'CHAT_INFLUENCE_ADVICE', 'bool', true, true],
  ['chatInfluence.tellBackOut', 'CHAT_INFLUENCE_TELL_BACKOUT', 'bool', true, true],   // 020: he tells a real person when he backs out
  ['chatInfluence.jevMaxPerDay', 'CHAT_INFLUENCE_JEV_MAX_PER_DAY', 'int:0..200', 80, true],
  ['chatInfluence.perSenderPerHour', 'CHAT_INFLUENCE_PER_SENDER_HOUR', 'int:1..20', 6, true],
  ['chatInfluence.perChatPerHour', 'CHAT_INFLUENCE_PER_CHAT_HOUR', 'int:1..60', 20, true],
  ['chatInfluence.clerkMaxPerDay', 'CHAT_INFLUENCE_CLERK_MAX_PER_DAY', 'int:0..60', 20, true],
  ['chatInfluence.invitesMaxPerDay', 'CHAT_INFLUENCE_INVITES_MAX_PER_DAY', 'int:0..10', 4, true],
  ['chatInfluence.inviteWaitMs', 'CHAT_INFLUENCE_INVITE_WAIT_MS', 'int:0..2000', 2000, true],
  ['chatInfluence.moodScale', 'CHAT_INFLUENCE_MOOD_SCALE', 'float:0..1', 1, true],
  ['chatInfluence.workMsgsPerHour', 'CHAT_INFLUENCE_WORK_MSGS_PER_HOUR', 'int:10..100', 25, true],
  // .env-only
  ['chatInfluence.jevTimeoutMs', 'CHAT_INFLUENCE_JEV_TIMEOUT_MS', 'int:500..5000', 1800, false],
  ['chatInfluence.sleepMaxMinutes', 'CHAT_INFLUENCE_SLEEP_MAX_MINUTES', 'int:0..120', 120, false],
  ['chatInfluence.adviceDays', 'CHAT_INFLUENCE_ADVICE_DAYS', 'int:1..14', 14, false],
  ['chatInfluence.advicePerCategory', 'CHAT_INFLUENCE_ADVICE_PER_CATEGORY', 'int:1..3', 3, false],
];

function readSetting(env, type, def) {
  if (type === 'bool') {
    const v = String(process.env[env] ?? '').trim();
    if (v === '') return def;
    if (v === 'true' || v === 'false') return v === 'true';
    console.warn(`[config] ${env} must be true or false — using ${def}`);
    return def;
  }
  // Unset → the table default ('' for the mind keys, so their behaviour is unchanged);
  // an explicitly empty value (KEY=) → '' = the role's own effort.
  if (type === 'enum:mindEffort') return process.env[env] === undefined ? def : envMindEffort(env);
  if (type === 'enum:reconcilerMode') {
    const v = String(process.env[env] ?? '').trim();
    if (v === '') return def;
    if (RECONCILER_MODES.includes(v)) return v;
    console.warn(`[config] ${env} accepts only ${RECONCILER_MODES.join('|')} — got "${v}", using ${def}`);
    return def;
  }
  const b = parseBoundedType(type);
  return envNumber(env, def, b.min, b.max, b.integer);
}

// Public site (specs/013): the exporter's knobs (.env only). The R2 / votes
// credentials are NOT config: src/public/r2.js and votes.js read them from
// process.env at use, so no config snapshot or dashboard route can carry them.
const PUBLIC_SITE_SETTINGS = [
  ['publicSite.enabled', 'PUBLIC_SITE_ENABLED', 'bool', false, false],   // boot default of the skill
  ['publicSite.intervalMinutes', 'PUBLIC_SITE_INTERVAL_MINUTES', 'int:2..60', 5, false],
  ['publicSite.days', 'PUBLIC_SITE_DAYS', 'int:1..30', 14, false],
];

function buildSettings(table) {
  const out = {};
  for (const [dot, env, type, def] of table) {
    const parts = dot.split('.').slice(1);
    let cur = out;
    for (const p of parts.slice(0, -1)) cur = (cur[p] ||= {});
    cur[parts[parts.length - 1]] = readSetting(env, type, def);
  }
  return out;
}
const settingsKeyToEnv = (table) => Object.fromEntries(table.filter(r => r[4]).map(([dot, env]) => [dot, env]));
const settingsDefault = (table, dot) => { const row = table.find(r => r[0] === dot); return row ? row[3] : undefined; };
const settingsMutableKeys = (table) => Object.fromEntries(table.filter(r => r[4]).map(([dot, , type]) => [dot, type]));

function buildArcsConfig() {
  return buildSettings(ARCS_SETTINGS);
}

function buildMindConfig() {
  const out = buildSettings(MIND_SETTINGS);
  // First-boot seed of the proactive mode only: off|shadow. `live` is a
  // dashboard-only switch (FR-024), so anything else falls back to shadow.
  const mode = String(process.env.MIND_PROACTIVE_MODE ?? '').trim();
  if (mode === 'off') out.proactiveMode = 'off';
  else {
    if (mode !== '' && mode !== 'shadow') {
      console.warn(`[config] MIND_PROACTIVE_MODE accepts only off|shadow (live is set on the dashboard) — got "${mode}", using shadow`);
    }
    out.proactiveMode = 'shadow';
  }
  return out;
}

/** dot path → .env name for every persistable (dashboard-mutable) mind key. */
export function mindKeyToEnv() {
  return settingsKeyToEnv(MIND_SETTINGS);
}

/** The built-in default of a mind dot path (undefined for any other key). */
export function mindDefaultForKey(dot) {
  return settingsDefault(MIND_SETTINGS, dot);
}

function mindMutableKeys() {
  return settingsMutableKeys(MIND_SETTINGS);
}

/** dot path → .env name for every persistable (dashboard-mutable) arcs key (spec 010). */
export function arcsKeyToEnv() {
  return settingsKeyToEnv(ARCS_SETTINGS);
}

/** The built-in default of an arcs dot path (undefined for any other key). */
export function arcsDefaultForKey(dot) {
  return settingsDefault(ARCS_SETTINGS, dot);
}

function arcsMutableKeys() {
  return settingsMutableKeys(ARCS_SETTINGS);
}

/** dot path → .env name for every persistable (dashboard-mutable) chat-influence key (spec 012). */
export function chatInfluenceKeyToEnv() {
  return settingsKeyToEnv(CHAT_INFLUENCE_SETTINGS);
}

/** The built-in default of a chat-influence dot path (undefined for any other key). */
export function chatInfluenceDefaultForKey(dot) {
  return settingsDefault(CHAT_INFLUENCE_SETTINGS, dot);
}

function chatInfluenceMutableKeys() {
  return settingsMutableKeys(CHAT_INFLUENCE_SETTINGS);
}

// ---------------------------------------------------------------------------
// Persona
//
// The bot's identity is split in two:
//   - persona.json       structured fields the *code* needs (name, aliases the
//                        bot answers to, WhatsApp display name, voice descriptor)
//   - identity.md        the free-form prose injected into the LLM system prompt
//
// Both live under src/personality/ and are gitignored — each install owns its
// own. `npm run setup` generates them. If persona.json is missing we fall back
// to the committed persona.example.json so a fresh checkout still boots.
// ---------------------------------------------------------------------------
const PERSONALITY_DIR = path.join(PROJECT_ROOT, 'src', 'personality');

function normalizePersona(p) {
  const name = String(p.name || 'Karyasthan').trim();
  const displayName = String(p.displayName || name).trim();
  const nameLower = name.toLowerCase();
  let aliases = Array.isArray(p.aliases)
    ? p.aliases.map((s) => String(s).toLowerCase().trim()).filter(Boolean)
    : [];
  // The bot must always answer to its own name.
  if (!aliases.includes(nameLower)) aliases = [nameLower, ...aliases];
  aliases = [...new Set(aliases)];
  return {
    name,
    displayName,
    aliases,
    age: p.age ?? null,
    region: String(p.region || '').trim(),
    language: String(p.language || 'English').trim(),
    voiceDescriptor: String(p.voiceDescriptor || 'a young adult speaking casually to friends').trim(),
    vibe: String(p.vibe || '').trim(),
  };
}

function loadPersona() {
  const primary = path.join(PERSONALITY_DIR, 'persona.json');
  const example = path.join(PERSONALITY_DIR, 'persona.example.json');
  let file = primary;
  if (!fs.existsSync(primary)) {
    file = example;
    console.warn(
      '[config] persona.json not found — falling back to persona.example.json. ' +
      'Run `npm run setup` to create your own persona.',
    );
  }
  try {
    return normalizePersona(JSON.parse(fs.readFileSync(file, 'utf-8')));
  } catch (err) {
    console.warn(`[config] could not load persona from ${file}: ${err.message}. Using built-in defaults.`);
    return normalizePersona({});
  }
}

export const persona = loadPersona();

/** The active persona (structured fields). See normalizePersona for the shape. */
export function getPersona() {
  return persona;
}

export const config = {
  projectRoot: PROJECT_ROOT,

  // Model roles (spec 007): raw per-role routing from the registry
  // (src/brain/roles.js). '' = inherit / disabled; resolveRole() computes the
  // effective routing at call time. Legacy paths (config.llm.provider, …) are
  // accessor aliases onto these — see defineAliases() below.
  roles: readRoleConfig(process.env),

  // LLM — provider keys and shared knobs. Routing lives in config.roles.
  llm: {
    // The OpenAI key ONLY (spec 007 R7). No other provider ever falls back to it.
    apiKey: process.env.LLM_API_KEY || '',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    // Endpoint for the 'local' provider — a local OpenAI-compatible server
    // (llama.cpp / LM Studio / vLLM). Applies ONLY when provider is 'local'; cloud
    // providers always use their own endpoint. .env-only routing surface —
    // deliberately not in MUTABLE_KEYS/getSafeConfig.
    baseUrl: optional('LLM_BASE_URL', ''),
    // Bearer token for the 'local' provider only (optional; most local servers ignore it).
    localApiKey: process.env.LLM_LOCAL_API_KEY || '',
    // Global monthly cap across every role and metered label (enforced by src/brain/usage.js).
    monthlyBudgetUsd: parseFloat(optional('LLM_MONTHLY_BUDGET_USD', '30')),
    glmApiKey: process.env.GLM_API_KEY || '',
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
    xaiApiKey: process.env.XAI_API_KEY || '',
    temperature: parseFloat(optional('LLM_TEMPERATURE', '0.7')),
  },

  // Jev "would he reply?" pre-filter (spec 007 R9). On/off is the jev-prefilter
  // skill (JEV_PREFILTER_ENABLED = its boot default); mode/skipBelow are tunable.
  prefilter: {
    enabled: optional('JEV_PREFILTER_ENABLED', 'true') === 'true',
    mode: optional('JEV_PREFILTER_MODE', 'shadow') === 'enforce' ? 'enforce' : 'shadow',
    skipBelow: (() => {
      const n = parseFloat(optional('JEV_PREFILTER_SKIP_BELOW', '0.25'));
      return Number.isFinite(n) ? n : 0.25;
    })(),
    shadowTarget: 300,
  },

  // Transcription
  transcriptionModel: optional('TRANSCRIPTION_MODEL', ''),

  // Behavior
  responseRate: parseFloat(optional('RESPONSE_RATE', '0.15')),
  sleepStartHour: parseInt(optional('SLEEP_START_HOUR', '0'), 10),
  sleepEndHour: parseInt(optional('SLEEP_END_HOUR', '7'), 10),
  timezone: optional('TIMEZONE', 'UTC'),

  // Rate limits
  maxPerGroupHour: parseInt(optional('MAX_PER_GROUP_HOUR', '8'), 10),
  maxGlobalHour: parseInt(optional('MAX_GLOBAL_HOUR', '20'), 10),
  // One catch-up reply per group after an hourly cap blocked a reply he'd have
  // sent (src/behavior/capCatchUp.js). Pending entries are in-memory and older
  // than maxAgeMinutes are dropped (he moved on).
  capCatchUp: {
    enabled: optional('CAP_CATCHUP_ENABLED', 'true') === 'true',
    maxAgeMinutes: (() => {
      const n = parseInt(optional('CAP_CATCHUP_MAX_AGE_MINUTES', '120'), 10);
      return Number.isFinite(n) && n > 0 ? n : 120;
    })(),
  },

  // Paths
  dbPath: path.resolve(PROJECT_ROOT, optional('DB_PATH', './data/karyasthan.db')),
  authPath: path.resolve(PROJECT_ROOT, optional('AUTH_PATH', './data/auth_info_baileys')),
  logLevel: optional('LOG_LEVEL', 'info'),

  // Warm-up
  warmupEnabled: optional('WARMUP_ENABLED', 'true') === 'true',

  // Dry run
  dryRun: optional('DRY_RUN', 'false') === 'true',

  // WhatsApp phone number (digits only, with country code, e.g. 15550100123)
  phoneNumber: process.env.WA_PHONE_NUMBER || '',

  // Bill Split
  billSplitModel: optional('BILL_SPLIT_MODEL', 'gemini-2.5-pro'),

  // Image Generation (uses GEMINI_API_KEY)
  imageGen: {
    enabled: optional('IMAGE_GEN_ENABLED', 'true') === 'true',
    model: optional('IMAGE_GEN_MODEL', 'imagen-4.0-generate-001'),
    editModel: optional('IMAGE_EDIT_MODEL', 'gemini-3-pro-image-preview'),
    maxPerHour: parseInt(optional('IMAGE_GEN_MAX_PER_HOUR', '5'), 10),
  },

  // Voice Notes (uses GEMINI_API_KEY for Gemini TTS). 3.8+ TTS models go through
  // the Interactions API; `*-preview` TTS models use the legacy generateContent path.
  // VOICE_NOTE_VOICE is a prebuilt name (Puck, Kore, …) or a per-project custom
  // voice id (voice_…) made with Voice Design in AI Studio / POST /v1beta/voices.
  voiceNote: {
    enabled: optional('VOICE_NOTE_ENABLED', 'true') === 'true',
    model: optional('VOICE_NOTE_MODEL', 'gemini-3.8-flash-tts'),
    voiceName: optional('VOICE_NOTE_VOICE', 'Puck'),
    fallbackModel: optional('VOICE_NOTE_FALLBACK_MODEL', 'gemini-3.1-flash-tts-preview'),
    fallbackVoice: optional('VOICE_NOTE_FALLBACK_VOICE', 'Puck'),
    // Voice-cloning (imitate voice) model — must support Voice Replication.
    cloneModel: optional('VOICE_CLONE_MODEL', 'gemini-3.8-flash-tts'),
    maxPerHour: parseInt(optional('VOICE_NOTE_MAX_PER_HOUR', '10'), 10),
  },

  // Phone calls. Cellular calls on the gateway phone's SIM reach Asterisk
  // (deploy/asterisk/) through the Android cellular<->SIP gateway; Asterisk hands each
  // call to the ARI app below, which bridges its audio to Gemini Live. The master
  // on/off is the "calls" skill; CALLS_ENABLED is only its boot default.
  // ARI_URL/ARI_USER/ARI_PASSWORD point at Asterisk's REST interface (localhost only).
  calls: {
    enabled: optional('CALLS_ENABLED', 'false') === 'true',
    ariUrl: optional('ARI_URL', 'http://127.0.0.1:8088').replace(/\/+$/, ''),
    ariUser: optional('ARI_USER', 'karyasthan'),
    ariPassword: process.env.ARI_PASSWORD || '',
    ariApp: optional('ARI_APP', 'karyasthan'),
    // PJSIP endpoint of the gateway phone; outbound dial string is PJSIP/<number>@<endpoint>.
    gatewayEndpoint: optional('CALL_GATEWAY_ENDPOINT', 'android-gw'),
    // Gemini Live model + prebuilt voice. Live ignores Voice Design voice_… ids (it
    // silently uses its default voice), so calls follow VOICE_NOTE_VOICE only when that
    // is a prebuilt name — keeping voice notes and calls in the same voice.
    liveModel: optional('CALL_LIVE_MODEL', 'gemini-3.8-live'),
    voiceName: optional('CALL_VOICE',
      /^voice_/.test(process.env.VOICE_NOTE_VOICE || '') ? 'Enceladus' : (process.env.VOICE_NOTE_VOICE || 'Enceladus')),
    // Gemini Live sessions are capped at 15 min; stay under it.
    maxMinutes: parseFloat(optional('CALL_MAX_MINUTES', '14')),
    ringTimeoutSec: parseInt(optional('CALL_RING_TIMEOUT_SEC', '45'), 10),
    // Outbound numbers must match (E.164).
    allowedNumberPattern: optional('CALL_ALLOWED_NUMBER_RE', '^$'),   // nothing until the owner names their numbers
    // Country code for a caller's number that arrives without one (digits, no +). Empty: not guessed, an unknown caller.
    defaultCountryCode: optional('CALL_DEFAULT_COUNTRY_CODE', '').replace(/\D/g, ''),
    // Local address Asterisk sends call RTP to (externalMedia).
    rtpHost: optional('CALL_RTP_HOST', '127.0.0.1'),
    // Expected spoken languages (BCP-47). Pins Gemini Live's speech recognition, which
    // otherwise auto-detects and misreads short phrases of a mixed language on a phone line.
    languageCodes: optional('CALL_LANGUAGE_CODES', 'en-US').split(',').map(s => s.trim()).filter(Boolean),
    // Save each call's audio (caller in, bot out) under data/calls-debug/ for troubleshooting.
    debugAudio: optional('CALL_DEBUG_AUDIO', 'false') === 'true',
  },

  // Instagram reels (specs/005). The real Instagram app on a dedicated phone, driven over
  // ADB by src/instagram/device.js — which may control ONLY com.instagram.android. The
  // master on/off is the "instagram-reels" skill; IG_ENABLED is only its boot default.
  // IG_DEVICE_SERIAL (hardware serial) + IG_DEVICE_MODEL pin every command to that phone
  // so the call-gateway phone, also on ADB, is never touched.
  instagram: {
    enabled: optional('IG_ENABLED', 'false') === 'true',
    adbPath: optional('IG_ADB_PATH', path.join(os.homedir(), '.local/opt/platform-tools/adb'))
      .replace(/^~(?=\/)/, os.homedir()),
    // scrcpy (record-only: --no-control) captures clips WITH audio; OxygenOS 12 ships no
    // screenrecord binary.
    scrcpyPath: optional('IG_SCRCPY_PATH', path.join(os.homedir(), '.local/opt/scrcpy/scrcpy'))
      .replace(/^~(?=\/)/, os.homedir()),
    deviceSerial: optional('IG_DEVICE_SERIAL', ''),
    deviceModel: optional('IG_DEVICE_MODEL', ''),
    groupName: optional('IG_GROUP_NAME', ''),
    // Home-screen packages Instagram may be launched over (nothing else is ever in front
    // when a session starts; any other app means the phone is in use → don't start).
    launcherPackages: optional('IG_LAUNCHER_PACKAGES', 'com.android.launcher').split(',').map(s => s.trim()).filter(Boolean),
    // Jev's model is the `jev` role (config.roles.jev; JEV_MODEL) — jevModel below is
    // an accessor alias onto it.
    // Gemini model that watches clips/frames and writes the English reel description.
    describeModel: optional('IG_DESCRIBE_MODEL', 'gemini-3.8-flash'),
    // How reels are watched: 'live' streams screen+audio to Gemini Live and reports after
    // ~3 s (swipe early like a person); 'clip' records a fixed clip per promising reel.
    watchMode: optional('IG_WATCH_MODE', 'live'),
    liveModel: optional('IG_LIVE_MODEL', 'gemini-3.8-live'),
    firstLookSeconds: parseFloat(optional('IG_FIRST_LOOK_SECONDS', '3')),
    fullLookSeconds: parseFloat(optional('IG_FULL_LOOK_SECONDS', '12')),
    // Explicit Jev key override only. Empty → getJevKey() uses the live
    // config.llm.openrouterApiKey at call time, so a dashboard-set key reaches Jev.
    // A secret: kept here, never in config.roles (which getSafeConfig exposes).
    jevApiKey: process.env.JEV_API_KEY || '',
    // ── Behaviour (dashboard-tunable; see MUTABLE_KEYS) ──
    // Automatic browsing sessions per day (random times outside sleep hours), each a
    // random length between min and max minutes.
    sessionsPerDay: parseInt(optional('IG_SESSIONS_PER_DAY', '4'), 10),
    sessionMinMinutes: parseFloat(optional('IG_SESSION_MIN_MINUTES', '5')),
    sessionMaxMinutes: parseFloat(optional('IG_SESSION_MAX_MINUTES', '12')),
    likesPerDay: parseInt(optional('IG_LIKES_PER_DAY', '25'), 10),
    sharesPerDay: parseInt(optional('IG_SHARES_PER_DAY', '3'), 10),
    // 'approve-each': nothing is sent to the group without a dashboard approval.
    // 'auto': the best queued reel goes out at each share slot.
    approvalMode: optional('IG_APPROVAL_MODE', 'approve-each'),
    // No automatic shares until the account has browsed for this many days.
    warmupDays: parseInt(optional('IG_WARMUP_DAYS', '10'), 10),
    clipSeconds: parseInt(optional('IG_CLIP_SECONDS', '15'), 10),
    // Group chat: read the group thread and reply/react on his own. The master on/off is
    // the "instagram-chat" skill; IG_CHAT_ENABLED is only its boot default.
    chatEnabled: optional('IG_CHAT_ENABLED', 'false') === 'true',
    chatPollMinutes: parseFloat(optional('IG_CHAT_POLL_MINUTES', '20')),
    chatMaxRepliesPerHour: parseInt(optional('IG_CHAT_MAX_REPLIES_PER_HOUR', '6'), 10),
    // Send 3 frames to Jev alongside the description (Jev image input is experimental).
    framesToJev: optional('IG_FRAMES_TO_JEV', 'false') === 'true',
    // Judge thresholds (src/instagram/judge.js).
    hazardThreshold: parseFloat(optional('IG_HAZARD_THRESHOLD', '0.25')),
    minConfidence: parseFloat(optional('IG_MIN_CONFIDENCE', '0.4')),
    likeHumour: parseFloat(optional('IG_LIKE_HUMOUR', '1.8')),
    likeFit: parseFloat(optional('IG_LIKE_FIT', '1.5')),
    queueHumour: parseFloat(optional('IG_QUEUE_HUMOUR', '2.2')),
    queueFit: parseFloat(optional('IG_QUEUE_FIT', '1.8')),
  },

  // Stickers + GIFs (GIPHY)
  media: {
    giphyApiKey: process.env.GIPHY_API_KEY || '',
    stickerMaxPerHour: parseInt(optional('STICKER_MAX_PER_HOUR', '8'), 10),
    gifMaxPerHour: parseInt(optional('GIF_MAX_PER_HOUR', '8'), 10),
  },

  // Web Search + Browsing.
  //   search  → self-hosted SearXNG JSON API (no API key)
  //   browse  → Playwright headless Chromium (renders JS)
  // The master on/off is the "web-search" skill (Skills tab); WEB_SEARCH_ENABLED is
  // only its BOOT DEFAULT (see src/skills/web-search.skill.js enabledByDefault).
  webSearch: {
    enabled: optional('WEB_SEARCH_ENABLED', 'true') === 'true',
    searxngUrl: optional('SEARXNG_URL', 'http://127.0.0.1:8888').replace(/\/+$/, ''),
    maxResults: parseInt(optional('WEB_SEARCH_MAX_RESULTS', '4'), 10),
    // One tool round (initial + 1 lookup). 2 enables search→browse-a-result but also
    // needs IN_FLIGHT_SAFETY_MS raised (events.js) — see plan/CLAUDE.md.
    maxHops: parseInt(optional('WEB_SEARCH_MAX_HOPS', '1'), 10),
    timeoutMs: parseInt(optional('WEB_SEARCH_TIMEOUT_MS', '5000'), 10),
    // Wall-clock budget for all web ops in one turn; once spent, force a no-tool answer.
    budgetMs: parseInt(optional('WEB_SEARCH_BUDGET_MS', '20000'), 10),
    searchMaxPerHour: parseInt(optional('WEB_SEARCH_MAX_PER_HOUR', '30'), 10),
    browse: {
      enabled: optional('WEB_BROWSE_ENABLED', 'true') === 'true',
      maxPerHour: parseInt(optional('WEB_BROWSE_MAX_PER_HOUR', '15'), 10),
      timeoutMs: parseInt(optional('WEB_BROWSE_TIMEOUT_MS', '8000'), 10),
      maxContentChars: parseInt(optional('WEB_BROWSE_MAX_CHARS', '4000'), 10),
      maxConcurrent: parseInt(optional('WEB_BROWSE_CONCURRENCY', '2'), 10),
      idleMs: parseInt(optional('WEB_BROWSE_IDLE_MS', '300000'), 10),
      // SSRF escape hatch — keep false in production. .env only (never dashboard-mutable).
      allowPrivate: optional('WEB_BROWSE_ALLOW_PRIVATE', 'false') === 'true',
    },
  },

  // Imitate Mode — per-group impersonation of a member's chat style.
  // The master on/off is the "imitate" skill (Skills tab); IMITATE_MODE_ENABLED is
  // only its BOOT DEFAULT (see src/skills/imitate.skill.js enabledByDefault).
  // Per-group targets live in the group_imitation table (dashboard-driven).
  imitate: {
    enabled: optional('IMITATE_MODE_ENABLED', 'false') === 'true',
    maxDurationMinutes: parseInt(optional('IMITATE_MAX_MINUTES', '360'), 10),
    minCorpus: parseInt(optional('IMITATE_MIN_MESSAGES', '40'), 10),
    disclose: optional('IMITATE_ANNOUNCE', 'false') === 'true',
    // Imitate VOICE — speak as the target in their own cloned voice. Needs the
    // person to have enrolled (DM "voice enroll" or dashboard upload, both with a
    // consent recording). Master switch = the "imitate-voice" skill; this is only
    // its boot default. Per-group opt-in is group_imitation.use_voice.
    voiceEnabled: optional('IMITATE_VOICE_ENABLED', 'false') === 'true',
    voiceMaxPerSession: parseInt(optional('IMITATE_VOICE_MAX_PER_SESSION', '3'), 10), // 0 = no per-session cap
  },

  // Life simulation (specs/009) — an event-sourced day (routine, travel, vitals,
  // timed decisions) that gates when he answers. The master on/off is the "life"
  // skill (Skills tab); LIFE_ENABLED is only its BOOT DEFAULT (see
  // src/skills/life.skill.js enabledByDefault). World constants come from the
  // per-install src/personality/world.json, never from here.
  life: {
    enabled: optional('LIFE_ENABLED', 'false') === 'true',
    tickMinutes: parseFloat(optional('LIFE_TICK_MINUTES', '15')),
    // Downtime longer than this is not replayed: the world re-anchors at "now".
    catchupHours: parseFloat(optional('LIFE_CATCHUP_HOURS', '72')),
    jevMaxPerDay: readSetting('LIFE_JEV_MAX_PER_DAY', 'int:0..200', 40),
    // Commit a timed decision early once Jev's lean reaches this probability.
    commitP: readSetting('LIFE_COMMIT_P', 'float:0.51..1', 0.8),
    // Plan 020 H2: thoughts, live lines and dream fragments in his own voice, from a bank written offline
    // (scripts/gen-phrases.js). Off: today's English, byte for byte.
    phraseBanks: readSetting('LIFE_PHRASE_BANKS', 'bool', false),
    // Deferred messages older than this are read but no longer answered.
    queueMaxAgeHours: readSetting('LIFE_QUEUE_MAX_AGE_HOURS', 'int:1..168', 18),
    claimsMaxPerHour: parseInt(optional('LIFE_CLAIMS_MAX_PER_HOUR', '10'), 10),
    // Replies per chat per 24 h that may talk about his own life before the
    // inner-state line drops to tone only.
    selfMentionBudget: readSetting('LIFE_SELF_MENTION_BUDGET', 'int:0..20', 3),
    embargoHours: parseFloat(optional('LIFE_EMBARGO_HOURS', '12')),
    // Map tiles for the dashboard Map page (.env only). Read with ?? rather than
    // optional(): an explicitly EMPTY value means "no tiles" (blank grid), and
    // optional() would turn '' back into the default. Anything but http(s) → no tiles.
    mapTileUrl: (() => {
      const v = (process.env.LIFE_MAP_TILE_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png').trim();
      return /^https?:\/\//i.test(v) ? v : '';
    })(),
  },

  // 014 real places (specs/014 plan §1.4) — OpenStreetMap lookups (Nominatim,
  // Overpass) and OSRM road routes, owner clicks only. Every key is .env-only
  // (none in MUTABLE_KEYS: the hosts are an SSRF surface). See buildGeoConfig.
  geo: buildGeoConfig(),

  // Mind (specs/008) — a slow loop over the chats: glances, thinks, a nightly sleep
  // (episodes, self-model proposals), bounded lever nudges and proactive openers
  // (shadow by default). The master on/off is the "mind" skill; MIND_ENABLED is only
  // its BOOT default (src/skills/mind.skill.js). Pause, proactive mode, review mode,
  // bands and exclusions are owner-only DB settings on the Mind page, never here.
  // Keys, .env names, bounds and defaults: MIND_SETTINGS (top of this file). Every
  // value is parsed with bounds (out-of-range .env values are clamped with a warning);
  // the dashboard-mutable ones are in MUTABLE_KEYS with the same ranges (out of range
  // → rejected there, never clamped). config.mind.proactiveMode is only the first-boot
  // seed of the Mind page's proactive mode (off|shadow).
  mind: buildMindConfig(),

  // Relationships, arcs & Director (specs/010) — the story layer over the life
  // simulation. The master on/off is the "arcs" skill (needs "life" on);
  // ARCS_ENABLED is only its BOOT default (src/skills/arcs.skill.js). Keys, .env
  // names, bounds and defaults: ARCS_SETTINGS (top of this file).
  arcs: buildArcsConfig(),

  // Chats shape his life (specs/012) — chat messages may nudge his mood, push his
  // sleep a little and add work pressure (P1). The master on/off is the
  // "chat-influence" skill (needs "life" on); CHAT_INFLUENCE_ENABLED is only its
  // BOOT default (src/skills/chat-influence.skill.js). Keys, .env names, bounds and
  // defaults: CHAT_INFLUENCE_SETTINGS (top of this file).
  chatInfluence: buildSettings(CHAT_INFLUENCE_SETTINGS),

  // Public site (specs/013) — a filtered snapshot of his life pushed to Cloudflare R2.
  // The master on/off is the "public-site" skill; PUBLIC_SITE_ENABLED is only its BOOT
  // default (src/skills/public-site.skill.js). Credentials live in process.env only.
  publicSite: buildSettings(PUBLIC_SITE_SETTINGS),

  // Owner identities (.env only, never dashboard-mutable — an identity/safety setting
  // like CALL_ALLOWED_NUMBER_RE). Raw forms (phone numbers or JIDs), trimmed; the mind
  // canonicalises them through resolvePerson at use time. Every form is a hard
  // exclusion for proactive openers, and live proactive mode is refused while empty.
  ownerJids: String(process.env.OWNER_JIDS || '').split(',').map(s => s.trim()).filter(Boolean),

  // Quality Gate
  qualityGate: {
    enabled: optional('QUALITY_GATE_ENABLED', 'true') === 'true',
    // provider/model/maxTokens/timeoutMs are the `gate` role (accessor aliases below).
    threshold: parseFloat(optional('QUALITY_GATE_THRESHOLD', '0.4')),
    mentionThreshold: parseFloat(optional('QUALITY_GATE_MENTION_THRESHOLD', '0.25')),
    temperature: parseFloat(optional('QUALITY_GATE_TEMPERATURE', '0.1')),
  },

  // Dashboard (read-only web UI)
  dashboard: {
    enabled: optional('DASHBOARD_ENABLED', 'false') === 'true',
    host: optional('DASHBOARD_HOST', '127.0.0.1'),
    port: parseInt(optional('DASHBOARD_PORT', '7070'), 10),
    user: optional('DASHBOARD_USER', ''),
    passHash: optional('DASHBOARD_PASS_HASH', ''),
    cookieSecret: optional('DASHBOARD_COOKIE_SECRET', ''),
    allowCidrs: optional('DASHBOARD_ALLOW_CIDRS', '127.0.0.1/32,::1/128')
      .split(',').map(s => s.trim()).filter(Boolean),
    readOnly: optional('DASHBOARD_READONLY', 'true') === 'true',
  },
};

// Legacy config paths → accessor aliases onto config.roles (spec 007 R2), so any
// unmigrated reader (or test) keeps working for one release. Both get and set
// write through: ESM is strict mode, a getter-only alias would throw on assignment.
function defineAliases(target, map) {
  for (const [prop, [role, field]] of Object.entries(map)) {
    Object.defineProperty(target, prop, {
      get: () => config.roles[role][field],
      set: (v) => { config.roles[role][field] = v; },
      enumerable: true,
      configurable: true,
    });
  }
}
defineAliases(config.llm, {
  provider: ['mouth', 'provider'],
  model: ['mouth', 'model'],
  maxTokens: ['mouth', 'maxTokens'],
  fallbackProvider: ['mouth', 'fallbackProvider'],
  fallbackModel: ['mouth', 'fallbackModel'],
});
defineAliases(config.qualityGate, {
  provider: ['gate', 'provider'],
  model: ['gate', 'model'],
  maxTokens: ['gate', 'maxTokens'],
  timeoutMs: ['gate', 'timeoutMs'],
});
defineAliases(config.instagram, {
  jevModel: ['jev', 'model'],
});

/**
 * A provider's OWN API key ('' when unset or keyless). Never another provider's:
 * an empty GEMINI_API_KEY no longer sends LLM_API_KEY to Google (spec 007 R7).
 */
export function getProviderKey(name) {
  const field = PROVIDER_KEY_FIELD[name];
  if (!field) return '';
  const key = config.llm[field] || '';
  // LLM_API_KEY=local is a leftover placeholder from the local-provider days (that
  // provider now reads LLM_LOCAL_API_KEY) — not an OpenAI key, so it counts as unset.
  if (name === 'openai' && key === 'local') return '';
  return key;
}

/** Jev's key, resolved per call: JEV_API_KEY override, else the current OpenRouter key. */
export function getJevKey() {
  return config.instagram.jevApiKey || getProviderKey('openrouter');
}

// LLM_API_KEY is the OpenAI key only now. Warn once (never the value) when it is set
// while mouth isn't OpenAI — it was probably meant for another provider (owner O1).
if (getProviderKey('openai') && config.roles.mouth.provider !== 'openai') {
  console.warn(
    '[config] LLM_API_KEY is set but LLM_PROVIDER is not "openai". LLM_API_KEY is now the OpenAI key only — ' +
    'move other providers\' keys to ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY / GLM_API_KEY / XAI_API_KEY.',
  );
}

// Gemini Live is the only call engine (the Eleven Realtime provider was removed). An old
// CALL_PROVIDER line is ignored with a warning, never an error.
if ((process.env.CALL_PROVIDER || '').trim() && process.env.CALL_PROVIDER.trim().toLowerCase() !== 'gemini') {
  console.warn('[config] CALL_PROVIDER is no longer supported — calls use Gemini Live. Remove CALL_PROVIDER / ELEVENLABS_API_KEY / CALL_ELEVEN_* from .env.');
}

// Fail-loud if 'local' is any role's primary/fallback provider but no base URL is set —
// that role's local calls would otherwise fail (or fall through to the fallback) every time.
if (!config.llm.baseUrl) {
  const localRoles = ROLE_NAMES.filter((name) => {
    const r = resolveRole(name, config);
    return r && (r.provider === 'local' || r.fallback?.provider === 'local');
  });
  if (localRoles.length) {
    console.error(`[config] LLM provider "local" selected (roles: ${localRoles.join(', ')}) but LLM_BASE_URL is empty — local calls will fail. Set LLM_BASE_URL.`);
  }
}

// Keys the dashboard is allowed to mutate in-memory, with their expected type.
// Typing here (not inferred from the live value) because Number.isInteger(0)
// is true, which would mis-type a float field that happens to currently hold 0.
const MUTABLE_KEYS = {
  'responseRate': 'float:0..1',
  'dryRun': 'bool',
  'warmupEnabled': 'bool',
  'maxPerGroupHour': 'int',
  'maxGlobalHour': 'int',
  'capCatchUp.enabled': 'bool',
  'capCatchUp.maxAgeMinutes': 'int:1..1440',
  'llm.temperature': 'float:0..2',
  'llm.monthlyBudgetUsd': 'float:0..100000', // global cap across all roles; 0 = no cap
  // LLM routing is per role: `roles.<role>.<field>` keys come from the registry
  // (src/brain/roles.js, merged below). llm.baseUrl is deliberately NOT mutable —
  // .env-only SSRF surface.
  'qualityGate.enabled': 'bool',
  'qualityGate.threshold': 'float:0..1',
  'qualityGate.mentionThreshold': 'float:0..1',
  'imageGen.enabled': 'bool',
  'imageGen.maxPerHour': 'int',
  'voiceNote.enabled': 'bool',
  'voiceNote.maxPerHour': 'int',
  'media.stickerMaxPerHour': 'int',
  'media.gifMaxPerHour': 'int',
  // Web search — master on/off lives in the Skills tab (not here). searxngUrl and
  // browse.allowPrivate are deliberately .env-only (SSRF surface).
  'webSearch.maxResults': 'int',
  'webSearch.maxHops': 'int',
  'webSearch.searchMaxPerHour': 'int',
  'webSearch.browse.enabled': 'bool',
  'webSearch.browse.maxPerHour': 'int',
  'webSearch.browse.maxConcurrent': 'int',
  // Instagram reels — master on/off is the "instagram-reels" skill. Device pinning,
  // group name and binaries are .env-only.
  'instagram.sessionsPerDay': 'int',
  'instagram.sessionMinMinutes': 'float',
  'instagram.sessionMaxMinutes': 'float',
  'instagram.likesPerDay': 'int',
  'instagram.sharesPerDay': 'int',
  'instagram.approvalMode': 'enum:approval',
  'instagram.warmupDays': 'int',
  'instagram.clipSeconds': 'int',
  'instagram.framesToJev': 'bool',
  'instagram.watchMode': 'enum:watch',
  'instagram.chatPollMinutes': 'float',
  'instagram.chatMaxRepliesPerHour': 'int',
  'instagram.firstLookSeconds': 'float',
  'instagram.fullLookSeconds': 'float',
  'instagram.hazardThreshold': 'float',
  'instagram.minConfidence': 'float',
  'instagram.likeHumour': 'float',
  'instagram.likeFit': 'float',
  'instagram.queueHumour': 'float',
  'instagram.queueFit': 'float',
  // Life simulation — master on/off is the "life" skill. The map tile URL and the
  // daily-plan switch are deliberately .env-only.
  // Bounded (2026-10-31 audit): out of range is rejected here and clamped from .env —
  // a 0 / negative queue age left deferred messages answered days later, a commitP
  // ≤ 0.5 or a negative cap was silently replaced by the default while shown as set.
  'life.jevMaxPerDay': 'int:0..200',
  'life.commitP': 'float:0.51..1',
  'life.phraseBanks': 'bool',
  'life.selfMentionBudget': 'int:0..20',
  'life.queueMaxAgeHours': 'int:1..168',
  // Jev pre-filter tuning (on/off is the jev-prefilter skill).
  'prefilter.mode': 'enum:prefilter',
  'prefilter.skipBelow': 'float:0..1',
  // Mind (spec 008) — owner caps. Bounded types: out of range → rejected, never
  // clamped. The master on/off is the "mind" skill; pause, proactive mode, review
  // mode, bands and exclusions are Mind-page settings; OWNER_JIDS is .env-only.
  // None of these is reachable by the mind itself (contracts/levers.md "forbidden").
  // (the table is MIND_SETTINGS at the top of this file)
  ...mindMutableKeys(),
  // Arcs (spec 010) — owner caps, same bounded types (out of range → rejected). The
  // master on/off is the "arcs" skill; ARCS_RECONCILER_MODE, ARCS_HEAVY_MIN_GAP_DAYS
  // and the hard caps are .env-only (the table is ARCS_SETTINGS at the top of this file).
  ...arcsMutableKeys(),
  // Chat influence (spec 012) — area toggles + soft caps (CHAT_INFLUENCE_SETTINGS).
  ...chatInfluenceMutableKeys(),
  ...roleMutableKeys(),
};

// A value that may be written to .env as one KEY=VALUE line must not hold CR/LF/NUL
// (it would add a line — a new variable). writeEnvVars refuses these whatever the caller.
export const ENV_UNSAFE = /[\r\n\0]/;

// The setters are stricter: no control character at all, and no ' #' (an inline
// comment on read). Checked on the raw value too, so a trailing newline is refused.
export const ENV_UNSAFE_RE = /[\x00-\x1f\x7f]|\s#/;
const envUnsafe = (v) => ENV_UNSAFE.test(v) || ENV_UNSAFE_RE.test(v.trim());

function coerce(type, incoming) {
  if (type === 'bool') {
    if (typeof incoming === 'boolean') return incoming;
    if (incoming === 'true') return true;
    if (incoming === 'false') return false;
    return null;
  }
  if (type === 'int' || type === 'float') {
    const n = Number(incoming);
    if (!Number.isFinite(n)) return null;
    return type === 'int' ? Math.round(n) : n;
  }
  // Bounded numbers (spec 008): `int:min..max` / `float:min..max`. Out of range →
  // rejected (null), never clamped. Booleans/blank strings are not numbers here.
  const bounded = parseBoundedType(type);
  if (bounded) {
    if (typeof incoming === 'boolean' || incoming == null) return null;
    if (typeof incoming === 'string' && !incoming.trim()) return null;
    let n = Number(incoming);
    if (!Number.isFinite(n)) return null;
    if (bounded.integer) n = Math.round(n);
    return n >= bounded.min && n <= bounded.max ? n : null;
  }
  // The mind's per-caller effort override: '' (= the role's effort) | low | medium | high.
  // Deliberately not enum:effort, which also allows xhigh|max (plan review S2-08).
  if (type === 'enum:mindEffort') {
    if (typeof incoming !== 'string') return null;
    const v = incoming.trim();
    return MIND_EFFORTS.includes(v) ? v : null;
  }
  // Strings can be persisted to .env as KEY=VALUE lines: an inner CR/LF/NUL would
  // smuggle extra lines (e.g. an .env-only SSRF switch) into the file — refused.
  if (type === 'string') {
    return typeof incoming === 'string' && incoming.trim() && !envUnsafe(incoming) ? incoming.trim() : null;
  }
  // Optional role fields: '' clears the value (→ inherit, or disabled for a role
  // without a parent). null/undefined are rejected, not treated as a clear.
  if (type === 'string?') {
    return typeof incoming === 'string' && !envUnsafe(incoming) ? incoming.trim() : null;
  }
  if (type === 'int?') {
    if (incoming === '') return '';
    const n = Number(incoming);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  }
  if (type === 'enum:effort') {
    if (typeof incoming !== 'string') return null;
    const v = incoming.trim();
    return EFFORT_LEVELS.includes(v) ? v : null;
  }
  if (type === 'enum:prefilter') {
    return incoming === 'shadow' || incoming === 'enforce' ? incoming : null;
  }
  if (type === 'enum:provider?' || type === 'enum:fallback') {
    if (typeof incoming !== 'string') return null;
    const v = incoming.trim();
    if (v === '') return '';
    if (type === 'enum:fallback' && v === 'none') return 'none';
    return PROVIDER_NAMES.includes(v) ? v : null;
  }
  if (type === 'enum:watch') {
    return incoming === 'live' || incoming === 'clip' ? incoming : null;
  }
  if (type === 'enum:approval') {
    return incoming === 'approve-each' || incoming === 'auto' ? incoming : null;
  }
  if (type === 'enum:provider') {
    if (typeof incoming !== 'string') return null;
    const v = incoming.trim();
    return PROVIDER_NAMES.includes(v) ? v : null;
  }
  return null;
}

/**
 * Apply an allow-listed patch to the running config singleton. Returns
 * { applied, rejected }. Nothing touches .env — changes revert on restart.
 */
export function updateConfig(patch) {
  const applied = {};
  const rejected = {};
  for (const [key, incoming] of Object.entries(patch || {})) {
    const type = MUTABLE_KEYS[key];
    if (!type) {
      rejected[key] = 'not allow-listed';
      continue;
    }
    const parts = key.split('.');
    let cursor = config;
    let missingParent = false;
    for (let i = 0; i < parts.length - 1; i++) {
      cursor = cursor[parts[i]];
      if (!cursor || typeof cursor !== 'object') { missingParent = true; break; }
    }
    if (missingParent) {
      rejected[key] = 'missing parent';
      continue;
    }
    const leaf = parts[parts.length - 1];
    const coerced = coerce(type, incoming);
    if (coerced === null) {
      // A number outside a bounded key's range says so (and the range), not "bad type".
      const bounded = parseBoundedType(type);
      const n = typeof incoming === 'boolean' || incoming == null || (typeof incoming === 'string' && !incoming.trim()) ? NaN : Number(incoming);
      rejected[key] = bounded && Number.isFinite(n)
        ? `out of range (allowed ${bounded.min}..${bounded.max}${bounded.integer ? ', whole numbers' : ''})`
        : typeof incoming === 'string' && envUnsafe(incoming)
          ? 'contains a line break, control character or " #"'
          : `bad type (expected ${type})`;
      continue;
    }
    // Provider-switch usability guard, scoped to enum:provider keys ONLY (every other
    // key's flow is unchanged): refuse a switch to a cloud provider whose API key isn't
    // configured — it would silently break responses (callLlm returns null on an
    // unkeyed provider) or force the fallback. ollama has no key field, so never rejected.
    // A provider is "keyed" only by its OWN key (getProviderKey) — no shared-key fallback.
    const isProviderType = type === 'enum:provider' || type === 'enum:provider?' || type === 'enum:fallback';
    if (isProviderType && PROVIDER_NAMES.includes(coerced)) {
      if (coerced === 'local' && !config.llm.baseUrl) {
        rejected[key] = 'local base URL not set (LLM_BASE_URL)';
        continue;
      }
      if (PROVIDER_KEY_FIELD[coerced] && !getProviderKey(coerced)) {
        rejected[key] = 'provider key not configured';
        continue;
      }
    }
    cursor[leaf] = coerced;
    applied[key] = coerced;
  }
  return { applied, rejected };
}

// LLM provider API-key fields settable from the dashboard (Tier 3). Kept separate
// from MUTABLE_KEYS so secrets never flow through the generic patch/diff path.
const LLM_KEY_FIELDS = new Set(['apiKey', 'anthropicApiKey', 'geminiApiKey', 'glmApiKey', 'openrouterApiKey', 'xaiApiKey']);

/**
 * In-memory setter for provider API keys. Returns applied FIELD NAMES only —
 * never key values. Callers (and audit) must not log the values. Changes revert
 * on restart unless persisted to .env via the route's writeEnvVars path.
 */
export function updateLlmKeys(patch) {
  const applied = [];
  const rejected = {};
  for (const [field, value] of Object.entries(patch || {})) {
    if (!LLM_KEY_FIELDS.has(field)) { rejected[field] = 'unknown key field'; continue; }
    if (typeof value !== 'string' || !value.trim()) { rejected[field] = 'must be a non-empty string'; continue; }
    if (envUnsafe(value)) { rejected[field] = 'contains a line break, control character or " #"'; continue; }
    config.llm[field] = value.trim();
    applied.push(field);
  }
  return { applied, rejected };
}

/**
 * Safe read-only snapshot with secrets redacted. For the dashboard settings
 * page — never expose API keys or the pass hash.
 */
export function getSafeConfig() {
  return {
    responseRate: config.responseRate,
    dryRun: config.dryRun,
    warmupEnabled: config.warmupEnabled,
    maxPerGroupHour: config.maxPerGroupHour,
    maxGlobalHour: config.maxGlobalHour,
    capCatchUp: {
      enabled: config.capCatchUp.enabled,
      maxAgeMinutes: config.capCatchUp.maxAgeMinutes,
    },
    sleepStartHour: config.sleepStartHour,
    sleepEndHour: config.sleepEndHour,
    timezone: config.timezone,
    llm: {
      provider: config.llm.provider,
      model: config.llm.model,
      temperature: config.llm.temperature,
      maxTokens: config.llm.maxTokens,
      fallbackProvider: config.llm.fallbackProvider,
      fallbackModel: config.llm.fallbackModel,
      monthlyBudgetUsd: config.llm.monthlyBudgetUsd,
      // Presence booleans only — never the key values (mirrors media.giphyConfigured).
      // Each provider is "configured" only by its own key (getProviderKey).
      apiKeyConfigured: !!getProviderKey('openai'),
      anthropicKeyConfigured: !!getProviderKey('anthropic'),
      geminiKeyConfigured: !!getProviderKey('gemini'),
      glmKeyConfigured: !!getProviderKey('glm'),
      openrouterKeyConfigured: !!getProviderKey('openrouter'),
      xaiKeyConfigured: !!getProviderKey('xai'),
      jevKeyConfigured: !!getJevKey(),
      baseUrlConfigured: !!config.llm.baseUrl,
    },
    // Per role/label: the raw values (what `roles.<role>.<field>` holds; '' = inherit)
    // plus `effective` (what a call would use right now). No secrets live in roles.
    roles: Object.fromEntries([...ROLE_NAMES, ...METERED_LABELS].map((name) => {
      const eff = resolveRole(name, config);
      return [name, {
        ...config.roles[name],
        effective: {
          provider: eff.provider, model: eff.model, effort: eff.effort, maxTokens: eff.maxTokens,
          timeoutMs: eff.timeoutMs, budgetUsd: eff.budgetUsd, fallback: eff.fallback,
          disabled: eff.disabled, shadowOnly: eff.shadowOnly,
        },
      }];
    })),
    prefilter: {
      enabled: config.prefilter.enabled,
      mode: config.prefilter.mode,
      skipBelow: config.prefilter.skipBelow,
      shadowTarget: config.prefilter.shadowTarget,
    },
    qualityGate: {
      enabled: config.qualityGate.enabled,
      provider: config.qualityGate.provider,
      model: config.qualityGate.model,
      threshold: config.qualityGate.threshold,
      mentionThreshold: config.qualityGate.mentionThreshold,
    },
    imageGen: {
      enabled: config.imageGen.enabled,
      model: config.imageGen.model,
      maxPerHour: config.imageGen.maxPerHour,
    },
    voiceNote: {
      enabled: config.voiceNote.enabled,
      model: config.voiceNote.model,
      voice: config.voiceNote.voiceName,
      maxPerHour: config.voiceNote.maxPerHour,
    },
    media: {
      stickerMaxPerHour: config.media.stickerMaxPerHour,
      gifMaxPerHour: config.media.gifMaxPerHour,
      giphyConfigured: !!config.media.giphyApiKey,
    },
    instagram: {
      deviceConfigured: !!(config.instagram.deviceSerial && config.instagram.deviceModel),
      groupName: config.instagram.groupName,
      jevModel: config.instagram.jevModel,
      describeModel: config.instagram.describeModel,
      sessionsPerDay: config.instagram.sessionsPerDay,
      sessionMinMinutes: config.instagram.sessionMinMinutes,
      sessionMaxMinutes: config.instagram.sessionMaxMinutes,
      likesPerDay: config.instagram.likesPerDay,
      sharesPerDay: config.instagram.sharesPerDay,
      approvalMode: config.instagram.approvalMode,
      warmupDays: config.instagram.warmupDays,
      clipSeconds: config.instagram.clipSeconds,
      framesToJev: config.instagram.framesToJev,
      watchMode: config.instagram.watchMode,
      chatPollMinutes: config.instagram.chatPollMinutes,
      chatMaxRepliesPerHour: config.instagram.chatMaxRepliesPerHour,
      liveModel: config.instagram.liveModel,
      firstLookSeconds: config.instagram.firstLookSeconds,
      fullLookSeconds: config.instagram.fullLookSeconds,
      hazardThreshold: config.instagram.hazardThreshold,
      minConfidence: config.instagram.minConfidence,
      likeHumour: config.instagram.likeHumour,
      likeFit: config.instagram.likeFit,
      queueHumour: config.instagram.queueHumour,
      queueFit: config.instagram.queueFit,
    },
    imitate: {
      enabled: config.imitate.enabled,
      maxDurationMinutes: config.imitate.maxDurationMinutes,
      minCorpus: config.imitate.minCorpus,
      disclose: config.imitate.disclose,
    },
    webSearch: {
      enabled: config.webSearch.enabled,
      searxngConfigured: !!config.webSearch.searxngUrl,
      maxResults: config.webSearch.maxResults,
      maxHops: config.webSearch.maxHops,
      searchMaxPerHour: config.webSearch.searchMaxPerHour,
      browse: {
        enabled: config.webSearch.browse.enabled,
        maxPerHour: config.webSearch.browse.maxPerHour,
        maxConcurrent: config.webSearch.browse.maxConcurrent,
        allowPrivate: config.webSearch.browse.allowPrivate,
      },
    },
    life: {
      enabled: config.life.enabled,
      tickMinutes: config.life.tickMinutes,
      catchupHours: config.life.catchupHours,
      jevMaxPerDay: config.life.jevMaxPerDay,
      commitP: config.life.commitP,
      phraseBanks: config.life.phraseBanks,
      queueMaxAgeHours: config.life.queueMaxAgeHours,
      claimsMaxPerHour: config.life.claimsMaxPerHour,
      selfMentionBudget: config.life.selfMentionBudget,
      embargoHours: config.life.embargoHours,
      mapTilesEnabled: !!config.life.mapTileUrl,
    },
    // Owner caps only. OWNER_JIDS is never exposed — presence boolean only.
    mind: {
      enabled: config.mind.enabled,
      glanceMinutes: config.mind.glanceMinutes,
      glanceMaxPerDay: config.mind.glanceMaxPerDay,
      thinkMaxPerDay: config.mind.thinkMaxPerDay,
      thinkMinGapMinutes: config.mind.thinkMinGapMinutes,
      thinkEffort: config.mind.thinkEffort,
      sleepEffort: config.mind.sleepEffort,
      selfModelEveryNights: config.mind.selfModelEveryNights,
      clerkMaxPerDay: config.mind.clerkMaxPerDay,
      sleepReservePct: config.mind.sleepReservePct,
      digestMaxChats: config.mind.digestMaxChats,
      digestMaxLines: config.mind.digestMaxLines,
      selfModelMaxChars: config.mind.selfModelMaxChars,
      selfStateMaxChars: config.mind.selfStateMaxChars,
      intentionTtlHours: config.mind.intentionTtlHours,
      reviewDays: config.mind.reviewDays,
      proactiveMode: config.mind.proactiveMode,
      proactive: { ...config.mind.proactive },
      proactiveMinScore: config.mind.proactiveMinScore,
      proactiveTtlHours: config.mind.proactiveTtlHours,
      funAb: config.mind.funAb,
      ownerJidsSet: config.ownerJids.length > 0,
    },
    // Arcs owner caps (spec 010). Fate, sliders, pins, pause and the owner's
    // reconciler mode are world events (Director page), not config.
    arcs: { ...config.arcs },
    chatInfluence: { ...config.chatInfluence },
    dashboard: {
      readOnly: config.dashboard.readOnly,
      host: config.dashboard.host,
      port: config.dashboard.port,
    },
  };
}

export const CONFIG_MUTABLE_KEYS = Object.keys(MUTABLE_KEYS);
export const CONFIG_KEY_TYPES = { ...MUTABLE_KEYS };
/** The choices of the simple enum types, for the Settings page's selects (provider enums come from PROVIDER_NAMES). */
export const CONFIG_ENUM_CHOICES = Object.freeze({
  'enum:mindEffort': MIND_EFFORTS,
  'enum:prefilter': ['shadow', 'enforce'],
  'enum:watch': ['live', 'clip'],
  'enum:approval': ['approve-each', 'auto'],
  'enum:reconcilerMode': RECONCILER_MODES,
});
