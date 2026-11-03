import { askJev, noul, score, choice, imagePart } from '../brain/jev.js';
import { config } from '../utils/config.js';
import { listMembers } from '../memory/igStore.js';
import { recallFacets } from '../memory/recall.js';
import { resolvePerson, bareJid } from '../memory/identity.js';

// Reel judgments (specs/005). Jev answers narrow, literal questions about one reel;
// the decision itself is made here in code from those answers. Everything in `state`
// is English: Gemini's description already translates Malayalam dialogue.
// Fails closed: any hazard over its threshold or a low-confidence humour/fit read → skip.

const HAZARDS = {
  politics: 'The reel is about politics, a political party, a politician, an election or a government policy.',
  religion: 'The reel is about religion or religious communities, or could cause religious or communal offence.',
  nsfw: 'The reel shows nudity or explicit sexual activity. Sexual jokes, innuendo, double meanings and adult humour do NOT count.',
  violence: 'The reel shows real violence, injury, gore, an accident with people hurt, or a dead body.',
  scam: 'The reel promotes betting, gambling, crypto, a money-making scheme, a giveaway or asks viewers to send money or personal details.',
  cruelty: 'The reel shows a real person being bullied, physically hurt or seriously distressed, or an animal suffering. Harmless bloopers, awkward moments and people laughing at themselves do not count.',
  tragedy: 'The reel is about a death, disaster or other tragic news.',
};

// Thresholds live in config.instagram (dashboard-tunable); the quick-pass bar is fixed.
const QUICK_WORTH_WATCHING = 0.35;
const t = () => config.instagram;

const HUMOUR_LEVELS = [
  'Not funny or not trying to be funny',
  'Mildly amusing, a smile at most',
  'Funny, would make a friend laugh',
  'Very funny, the kind you forward to friends immediately',
];
const FIT_LEVELS = [
  'Nothing in `taste_card` is reflected in the reel',
  'Loosely related to `taste_card`',
  'Clearly matches `taste_card.likes` or `taste_card.humour`',
  'Exactly what `taste_card` describes',
];

/**
 * `group_members` for judgeFull: the Instagram group's in-group members by name,
 * with interests read through recallFacets for the Instagram audience (spec 006
 * R16) — never a raw profile. Jev is an external processor of these inputs, so a
 * member only carries interests this audience may see; an unknown sender in the
 * thread makes the audience outsider and recall then returns nothing cross-chat.
 */
export function membersForJudge(audience) {
  const rows = listMembers().filter(m => !m.is_self && m.in_group);
  const facets = recallFacets(audience, rows.map(m => m.person_jid).filter(Boolean));
  return rows.map(m => {
    const key = m.person_jid ? (resolvePerson(m.person_jid) || bareJid(m.person_jid)) : null;
    return { name: m.display_name || m.username, interests: (key && facets.get(key)?.interests || []).slice(0, 6) };
  });
}

function hazardQuestions() {
  return Object.fromEntries(Object.entries(HAZARDS).map(([k, v]) => [`hazard_${k}`, noul(v)]));
}

function reelState(reel, taste, members = [], frames = []) {
  return {
    taste_card: taste,
    reel: {
      account: reel.account || null,
      caption: reel.caption || null,
      audio: reel.audio || null,
      description: reel.description || null,
      ...(reel.comments?.length ? { top_comments: reel.comments } : {}),
      // JPEG frames (256–1568 px per side) — Jev reads image parts nested in state.
      ...(frames.length ? { frames: frames.map(f => imagePart(f, 'image/jpeg')) } : {}),
    },
    ...(members.length ? { group_members: members } : {}),
  };
}

function hazardHits(answers) {
  return Object.entries(answers)
    .filter(([k, a]) => k.startsWith('hazard_') && (a.noul ?? 0) >= t().hazardThreshold)
    .map(([k, a]) => ({ hazard: k.slice(7), p: a.noul }));
}

/** Cheap pass on caption + one-line description: is this worth watching properly? */
export async function judgeQuick(reel, taste) {
  const res = await askJev({
    caller: 'ig.judge.quick',
    state: reelState(reel, taste),
    questions: {
      worth_watching: noul('Based on `reel`, it is likely to be funny or interesting to someone with `taste_card`, and is not an ad.'),
      ...hazardQuestions(),
    },
  });
  const hazards = hazardHits(res.answers);
  const p = res.answers.worth_watching?.noul ?? 0;
  return {
    watch: hazards.length === 0 && p >= QUICK_WORTH_WATCHING,
    hazards, worthWatching: p, answers: res.answers, model: res.model, cost: res.usage.cost ?? null,
  };
}

/** Full judgment after Gemini has described the clip. */
export async function judgeFull(reel, taste, members = [], { frames = [] } = {}) {
  const memberNames = members.map(m => m.name).filter(Boolean);
  const questions = {
    humour: score('How funny is `reel` for a group of young friends?', HUMOUR_LEVELS),
    fit: score('How well does `reel` match `taste_card`?', FIT_LEVELS),
    is_ad: noul('`reel` is an advertisement, sponsored post or brand promotion.'),
    ...hazardQuestions(),
  };
  if (memberNames.length) {
    questions.for_whom = choice(
      'Which person in `group_members` would enjoy `reel` most, based on their interests? Choose nobody if no one clearly fits.',
      Object.fromEntries([...memberNames.map(n => [n, null]), ['nobody', null]]),
    );
  }
  const res = await askJev({ state: reelState(reel, taste, members, frames), questions, caller: 'ig.judge' });
  return { ...decide(res.answers), answers: res.answers, model: res.model, cost: res.usage.cost ?? null };
}

/** Combine Jev's answers into an action, in code. */
export function decide(answers) {
  const hazards = hazardHits(answers);
  const humour = answers.humour?.score ?? 0;
  const fit = answers.fit?.score ?? 0;
  const conf = Math.min(answers.humour?.confidence ?? 0, answers.fit?.confidence ?? 0);
  const ad = (answers.is_ad?.noul ?? 0) >= 0.5;
  const forWhom = answers.for_whom?.choice && answers.for_whom.choice !== 'nobody' ? answers.for_whom.choice : null;

  let action = 'skip';
  let reason;
  if (hazards.length) reason = `hazard: ${hazards.map(h => h.hazard).join(', ')}`;
  else if (ad) reason = 'ad';
  else if (conf < t().minConfidence) reason = `low confidence (${conf.toFixed(2)})`;
  else if (humour >= t().queueHumour && fit >= t().queueFit) { action = 'like_and_queue'; reason = 'strong'; }
  else if (humour >= t().likeHumour || fit >= t().likeFit) { action = 'like'; reason = 'good'; }
  else reason = 'not for him';

  // The Jev model is recorded by the caller from the response (judgeFull: res.model).
  return { action, reason, humour, fit, confidence: conf, hazards, forWhom };
}
