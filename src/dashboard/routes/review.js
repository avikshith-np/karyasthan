// The weekly review (plan 020 E4): the queue, a mark, the results, the failures as stubs. Marks are
// behind the dashboard's write gates (read-only, CSRF), audited with ids and codes, never words.
import { logger } from '../../utils/logger.js';
import { auditWrite } from '../audit.js';
import { actorOf } from '../auth.js';
import * as life from '../../life/index.js';
import * as store from '../../memory/reviewStore.js';

const limit = (max) => ({ rateLimit: { max, timeWindow: '1 minute', allowList: [] } });
const SAMPLE_EVERY_MS = 3_600_000;
const FIRST_SAMPLE_MS = 30_000;

const STATUS = { not_found: 404, gone: 409, already_marked: 409, bad_verdict: 400, bad_note: 400 };
const idOf = (req) => { const n = Number(req.params.id); return Number.isSafeInteger(n) && n > 0 ? n : null; };

/** Their name, also after they left his life; never the raw id. */
export function castNameFrom(state, id) {
  return state?.cast?.get?.(id)?.name || state?.story?.departed?.[id]?.name || 'someone';
}

function castName(id) {
  try { return castNameFrom(life.getState(), id); } catch { return 'someone'; }
}

function sampleQuietly() {
  try {
    const added = store.ensureWeeks();
    if (added) logger.info({ evt: 'review.sampled', added }, 'weekly review sampled');
  } catch (err) {
    logger.warn({ evt: 'issue', code: 'review_sample', err: err?.code || err?.name }, 'weekly review: sampling failed');
  }
}

export default async function reviewRoutes(app) {
  const first = setTimeout(sampleQuietly, FIRST_SAMPLE_MS);
  const every = setInterval(sampleQuietly, SAMPLE_EVERY_MS);
  first.unref?.();
  every.unref?.();
  app.addHook('onClose', async () => { clearTimeout(first); clearInterval(every); });

  app.get('/api/review/queue', async (req) => {
    const n = Math.min(30, Math.max(1, Number(req.query?.limit) || 12));
    const exclude = String(req.query?.exclude ?? '').split(',').map(Number).filter((x) => Number.isSafeInteger(x) && x > 0).slice(0, 500);
    return { ...store.queue({ limit: n, exclude, castName }), notes: store.NOTE_CODES };
  });

  app.get('/api/review/stats', async () => store.stats());

  // One output's words, on a tap: the only way to a private card's text.
  app.get('/api/review/items/:id/text', { config: limit(60) }, async (req, reply) => {
    const id = idOf(req);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    const out = store.textOf(id);
    if (out.error) return reply.code(STATUS[out.error] ?? 400).send({ error: out.error });
    return out;
  });

  app.post('/api/review/items/:id/mark', { config: limit(120) }, async (req, reply) => {
    const id = idOf(req);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    const { verdict, note = null } = req.body ?? {};
    const out = store.mark(id, { verdict, note });
    if (out.error) return reply.code(STATUS[out.error] ?? 400).send(out);
    if (!out.already) auditWrite(actorOf(req), 'review.mark', String(id), { surface: out.surface, verdict, note });
    return out;
  });

  app.post('/api/review/items/:id/unmark', { config: limit(120) }, async (req, reply) => {
    const id = idOf(req);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    const out = store.unmark(id);
    if (out.error) return reply.code(STATUS[out.error] ?? 400).send(out);
    if (out.was) auditWrite(actorOf(req), 'review.unmark', String(id), { surface: out.surface, was: out.was });
    return out;
  });

  app.post('/api/review/sample', { config: limit(6) }, async (req) => {
    const out = store.sampleCurrentWeek();
    auditWrite(actorOf(req), 'review.sample', out.week, { added: out.added });
    return out;
  });

  app.get('/api/review/failures.json', { config: limit(10) }, async (req, reply) => {
    reply.header('Content-Disposition', 'attachment; filename="review-failures.json"');
    return store.failureStubs();
  });
}
