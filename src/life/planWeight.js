// One being, one priority order (plan 020 §A, owner 2026-11-02). A committed plan is a plan wherever
// it was made; how much it holds depends on who it was made with. Pure, imports nothing, so the
// projector's readers, the pulse, the decisions and the pure planEdits can all share it.
//
//   owner    the owner set it (a Director pick or scene): only the owner changes it
//   promise  made with someone or for a purpose: an accepted invitation (`reply`), an adopted claim,
//            a plan agreed in texts, a soft goal, a job interview. He may rethink one (not a goal:
//            that is the owner's), but it takes a strong lean, and breaking it costs with that person
//   wish     his own lean or a draw: he may change his mind as usual
export const WEIGHT = Object.freeze({ owner: 3, promise: 2, wish: 1 });

/** A job interview's length (career counts it over at this; its block in his day runs this long). */
export const INTERVIEW_MIN = 60;

/** A lean this sure breaks a promise (a plain wish reverses at decisions.REVERSE_P). */
export const PROMISE_REVERSE_P = 0.9;

let oneBeing = true;
/** Test seam: false = the pre-020 engine (the 012 goldens replay its bytes). */
export function __setOneBeingForTest(on) { oneBeing = on !== false; }
export function oneBeingOn() { return oneBeing; }

export function planWeight(d) {
  const by = d?.committed?.by;
  if (by === 'owner') return WEIGHT.owner;
  if (by === 'goal' || by === 'text' || d?.adopted === true) return WEIGHT.promise;
  if (oneBeing && (by === 'reply' || d?.kind === 'career:interview')) return WEIGHT.promise;
  return WEIGHT.wish;
}

/** Fitted into his day as soon as its day's plan is in force, and wins over a lighter plan. */
export function isLockedOuting(d) {
  return d?.status === 'committed' && d.committed?.optionId === 'go' && planWeight(d) >= WEIGHT.promise;
}

/** Does a lean never touch it? The owner's plans and a soft goal's outing (the owner set that goal too). */
export function neverRethought(d) {
  const by = d?.committed?.by;
  if (by === 'owner' || by === 'goal') return true;
  return !oneBeing && (by === 'text' || d?.adopted === true);
}

/** A committed plan he is going to: go, or late. */
export function goingTo(d) {
  return d?.status === 'committed' && (d.committed?.optionId === 'go' || d.committed?.optionId === 'late');
}

/** A promise he still means to keep: only a commitment to go or late is one (never a decline). */
export function holdsPromise(d) {
  return oneBeing && goingTo(d) && planWeight(d) === WEIGHT.promise;
}

/** A plan a schedule edit keeps by default: an owner's plan or a promise, on time (go) or late alike. */
export function heldPlan(d) {
  return goingTo(d) && planWeight(d) >= WEIGHT.promise && (oneBeing || d.committed.optionId === 'go');
}

/**
 * Was this plan made in a chat (not merely nudged by one)? An adopted claim, an invitation or his
 * reply's commit, a real person as its subject, or a decision.opened that itself carried a chat
 * origin (projector `chatOpened`). A routine plan a chat only nudged (a lean caused by a chat.trigger:
 * `origins`) is his own here; its chat origin still gates every prompt (innerState).
 */
export function chatMadeDecision(d) {
  return d?.adopted === true || (Number.isSafeInteger(d?.claimId) && d.claimId > 0) || typeof d?.subjectJid === 'string'
    || d?.invite === true || d?.committed?.by === 'reply' || d?.chatOpened === true;
}

/** Does `x` hold its time against `d`: heavier, or as heavy and committed first? */
export function outranks(x, d) {
  const wx = planWeight(x);
  const wd = planWeight(d);
  if (wx !== wd) return wx > wd;
  const ax = x?.committed?.at;
  const ad = d?.committed?.at;
  return Number.isFinite(ax) && Number.isFinite(ad) ? (ax !== ad ? ax < ad : x.id < d.id) : false;
}
