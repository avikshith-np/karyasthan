// The migration ladder (spec 006, R12). schema.sql is the frozen v0 baseline;
// every later schema change is a step here, applied in order by runMigrations()
// in ../db.js and recorded in PRAGMA user_version. Append only — never edit a
// step that has shipped. A step: { version, name, up(db), rebuild?: [tables] }
// (rebuild → runs with foreign_keys OFF and a foreign_key_check before COMMIT).

import provenance from './001-provenance.js';
import newTables from './002-new-tables.js';
import rebuildScoped from './003-rebuild-scoped.js';
import ftsTriggers from './004-fts-triggers.js';
import backfill from './005-backfill.js';
import forgetContentKey from './006-forget-content-key.js';
import llmUsage from './007-llm-usage.js';
import worldEvents from './008-world-events.js';
import lifeOps from './009-life-ops.js';
import mind from './010-mind.js';
import arcs from './011-arcs.js';
import chatInfluence from './012-chat-influence.js';
import publicSite from './013-public-site.js';
import scenes from './014-scenes.js';
import phone from './015-phone.js';
import thoughts from './016-thoughts.js';
import stance from './017-stance.js';
import dreams from './018-dreams.js';
import standing from './019-standing.js';
import claimCheck from './020-claim-check.js';
import weeklyReview from './021-weekly-review.js';

export const MIGRATIONS = [provenance, newTables, rebuildScoped, ftsTriggers, backfill, forgetContentKey, llmUsage,
  worldEvents, lifeOps, mind, arcs, chatInfluence, publicSite, scenes, phone, thoughts, stance, dreams, standing, claimCheck, weeklyReview];
