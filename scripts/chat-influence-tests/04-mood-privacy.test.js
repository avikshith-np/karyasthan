// 012 mood privacy (plan §P1.2, owner decision "feeling yes, reason no"): the
// reason phrase shows only in the chat the blip came from — also with 006's real
// canUseIn plugged in, and never in a member's DM; the feeling itself (the mood
// value) moves everywhere; the dashboard sees all; a forgotten message loses its
// reason line at once, before any revert lands.
import { setupScratchDb, bootInfluence, say, section, check, eq, report } from './_helpers.js';

await setupScratchDb();
const t = await bootInfluence({
  jev: (await import('./_helpers.js')).perceiveJev((req) => {
    const m = String(req?.state?.message ?? '');
    if (/argue/.test(m)) return { kind: 'affect', target: 'him', affect: 'argument', intensity: 'high' };
    return { kind: 'affect', target: 'him', affect: 'bad_news', intensity: 'high' };
  }),
});
const { resolveAudience, canUseIn } = await import('../../src/memory/recall.js');
const { setCanUseIn, fallbackCanUseIn } = await import('../../src/life/innerState.js');
const aud = (jid) => resolveAudience({ chatJid: jid });
const line = (a) => t.life.innerStateLine(a);
const BOT = '10000000000@s.whatsapp.net';
const ARGUE = 'still a bit annoyed after that argument';

const quietG = line(aud(t.GROUP));
const quietO = line(aud(t.OTHER));
check('before: a good mood everywhere', /feeling pretty good/.test(quietO), quietO);

section('one argument in group G');
await say(t, { chat: t.GROUP, sender: t.A, text: 'no, you argue like a child', id: 'P1', mentioned: [BOT] });
check('G: the reason phrase', line(aud(t.GROUP)).includes(ARGUE), line(aud(t.GROUP)));
check('H (another group with A): no reason', !line(aud(t.OTHER)).includes(ARGUE));
check('A\'s DM (a member of G): no reason', !line(aud(t.A)).includes(ARGUE));
check('A\'s DM by the PN form: no reason', !line(aud('15550007201@s.whatsapp.net')).includes(ARGUE));
check('the dashboard sees it', line({ kind: 'dashboard' }).includes(ARGUE));
for (const [name, rule] of [['006 canUseIn', canUseIn], ['the same-chat fallback', fallbackCanUseIn]]) {
  setCanUseIn(rule);
  check(`with ${name}: still only G`, line(aud(t.GROUP)).includes(ARGUE) && !line(aud(t.OTHER)).includes(ARGUE) && !line(aud(t.A)).includes(ARGUE));
}
setCanUseIn(null);

section('the feeling moves everywhere');
await say(t, { chat: t.GROUP, sender: t.B, text: 'you argue badly, mate', id: 'P2', mentioned: [BOT] });
await say(t, { chat: t.A, sender: t.A, text: 'bad news, the trip is off', id: 'P3' });
const o = line(aud(t.OTHER));
check('H feels it (no longer "pretty good"), without any reason', !/feeling pretty good/.test(o) && !o.includes(ARGUE) && !/news/.test(o), o);
check('A\'s DM: its own reason (the news came from there), not G\'s', line(aud(t.A)).includes('a bit down about the news here')
  && !line(aud(t.A)).includes(ARGUE), line(aud(t.A)));
check('G keeps its own', line(aud(t.GROUP)).includes(ARGUE));
void quietG;

section('forgotten evidence → no reason line, before any revert');
t.db.prepare(`UPDATE messages SET no_learn = 1 WHERE id IN ('P1', 'P2')`).run();
const g = line(aud(t.GROUP));
check('G: the argument reason is gone at once', !g.includes(ARGUE), g);
t.db.prepare(`UPDATE messages SET content = 'edited away' WHERE id = 'P3'`).run();
check('an edited message (hash changed) loses its reason too', !line(aud(t.A)).includes('news'), line(aud(t.A)));

section('subject rule');
const { subjectVisible } = await import('../../src/life/innerState.js');
check('the fragment honours the subject rule (a blip about A is not explained where A is not)',
  subjectVisible(t.A, aud(t.GROUP)) && !subjectVisible(t.A, { chatJid: t.GROUP, sameChat: [t.GROUP], members: new Set([t.B]) }));

report();
