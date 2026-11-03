import Database from 'better-sqlite3';
import { config } from '../src/utils/config.js';
import { safePath } from '../src/utils/pathGuard.js';

// Inspection only: open the DB read-only and never migrate (this usually points
// at the live bot's DB). fileMustExist stops it creating an empty DB on a typo.
const db = new Database(safePath(config.dbPath), { readonly: true, fileMustExist: true });

const command = process.argv[2] || 'stats';
const tableExists = (name) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);

switch (command) {
  case 'stats': {
    const tables = ['messages', 'people', 'groups', 'nicknames', 'relationships', 'memories', 'slang'];
    console.log('\n📊 Database Stats\n');
    for (const table of tables) {
      try {
        const { count } = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get();
        console.log(`  ${table.padEnd(15)} ${count}`);
      } catch {
        console.log(`  ${table.padEnd(15)} (error)`);
      }
    }
    break;
  }

  case 'people': {
    const people = db.prepare('SELECT * FROM people ORDER BY message_count DESC LIMIT 20').all();
    console.log('\n👥 People\n');
    for (const p of people) {
      const nicks = db.prepare('SELECT nickname FROM nicknames WHERE person_jid = ? ORDER BY confidence DESC LIMIT 3').all(p.jid);
      const nickStr = nicks.length ? ` (${nicks.map(n => n.nickname).join(', ')})` : '';
      console.log(`  ${(p.push_name || p.phone || 'Unknown').padEnd(20)} msgs: ${p.message_count}${nickStr}`);
      // Profile text lives per origin in person_facets (spec 006); show the owner one.
      const owner = tableExists('person_facets')
        ? db.prepare(`SELECT summary FROM person_facets WHERE person_jid = ? AND origin_kind = 'owner'`).get(p.jid)
        : null;
      if (owner?.summary) console.log(`    └ ${owner.summary}`);
    }
    break;
  }

  case 'groups': {
    const groups = db.prepare('SELECT * FROM groups ORDER BY last_active DESC').all();
    console.log('\n💬 Groups\n');
    for (const g of groups) {
      console.log(`  ${(g.name || g.jid).padEnd(30)} lang: ${g.language || '?'}`);
      if (g.vibe) console.log(`    └ ${g.vibe}`);
    }
    break;
  }

  case 'relationships': {
    const rels = db.prepare(`SELECT r.*, pa.push_name as a_name, pb.push_name as b_name
      FROM relationships r
      JOIN people pa ON pa.jid = r.person_a_jid
      JOIN people pb ON pb.jid = r.person_b_jid
      ORDER BY r.strength DESC`).all();
    console.log('\n🤝 Relationships\n');
    for (const r of rels) {
      console.log(`  ${r.a_name || '?'} ↔ ${r.b_name || '?'}: ${r.relationship || '?'} (${r.strength})`);
      if (r.dynamic) console.log(`    └ ${r.dynamic}`);
    }
    break;
  }

  case 'slang': {
    const slang = db.prepare('SELECT * FROM slang ORDER BY use_count DESC LIMIT 30').all();
    console.log('\n🗣️ Learned Slang\n');
    for (const s of slang) {
      console.log(`  ${s.term.padEnd(20)} (${s.use_count}x) ${s.meaning || '?'}`);
    }
    break;
  }

  case 'memories': {
    const mems = db.prepare('SELECT * FROM memories ORDER BY importance DESC, created_at DESC LIMIT 20').all();
    console.log('\n🧠 Memories\n');
    for (const m of mems) {
      console.log(`  [${m.category}] ${m.content} (importance: ${m.importance})`);
    }
    break;
  }

  // Spec 006: where remembered things came from. Counts only — no content.
  case 'provenance': {
    const scalar = (sql, ...a) => { try { return db.prepare(sql).pluck().get(...a); } catch { return '(n/a)'; } };
    const rows = (sql) => { try { return db.prepare(sql).all(); } catch { return []; } };
    console.log(`\n🧭 Provenance (schema v${db.pragma('user_version', { simple: true })})\n`);
    console.log('  memories (current / superseded / expired) by origin_kind:');
    for (const r of rows(`SELECT COALESCE(origin_kind, '(none)') AS k,
        SUM(superseded_by IS NULL AND (expires_at IS NULL OR expires_at > unixepoch())) AS cur,
        SUM(superseded_by IS NOT NULL) AS sup,
        SUM(expires_at IS NOT NULL AND expires_at <= unixepoch()) AS exp
      FROM memories GROUP BY k ORDER BY cur DESC`)) {
      console.log(`    ${r.k.padEnd(10)} ${String(r.cur).padStart(6)} / ${String(r.sup).padStart(5)} / ${String(r.exp).padStart(5)}`);
    }
    console.log(`    without learned_at: ${scalar('SELECT COUNT(*) FROM memories WHERE learned_at IS NULL')}, `
      + `derived (item_origins): ${scalar(`SELECT COUNT(DISTINCT item_id) FROM item_origins WHERE item_type = 'memory'`)}, `
      + `with evidence: ${scalar(`SELECT COUNT(DISTINCT item_id) FROM item_evidence WHERE item_type = 'memory'`)}`);
    console.log('\n  top memory origins (current):');
    for (const r of rows(`SELECT origin_kind AS k, origin_jid AS j, COUNT(*) AS n FROM memories
        WHERE superseded_by IS NULL GROUP BY origin_kind, origin_jid ORDER BY n DESC LIMIT 12`)) {
      console.log(`    ${String(r.k).padEnd(6)} ${String(r.j).slice(0, 40).padEnd(40)} ${r.n}`);
    }
    for (const t of ['person_facets', 'nicknames', 'relationships', 'slang']) {
      const byKind = rows(`SELECT origin_kind AS k, COUNT(*) AS n FROM ${t} GROUP BY origin_kind ORDER BY n DESC`);
      console.log(`\n  ${t}: ${byKind.map(r => `${r.k}=${r.n}`).join(', ') || '(none)'}`);
    }
    console.log(`    slang global: ${scalar('SELECT COUNT(*) FROM slang WHERE is_global = 1')}`);
    console.log(`\n  identities: ${scalar('SELECT COUNT(*) FROM person_identities')}, `
      + `merge queue pending: ${scalar('SELECT COUNT(*) FROM identity_merge_queue WHERE decided_at IS NULL')}, `
      + `forget tombstones: ${scalar('SELECT COUNT(*) FROM learning_exclusions')}, `
      + `no_learn messages: ${scalar('SELECT COUNT(*) FROM messages WHERE no_learn = 1')}`);
    console.log('\n  group membership (members / synced):');
    for (const g of rows(`SELECT g.jid, g.name, g.members_synced_at AS synced,
        (SELECT COUNT(*) FROM group_members gm WHERE gm.group_jid = g.jid) AS n
      FROM groups g WHERE g.jid LIKE '%@g.us' ORDER BY n DESC`)) {
      const ago = g.synced ? `${Math.round((Date.now() / 1000 - g.synced) / 3600)} h ago` : 'never';
      console.log(`    ${(g.name || g.jid).slice(0, 30).padEnd(30)} ${String(g.n).padStart(4)}  ${ago}`);
    }
    const ig = scalar('SELECT members_synced_at FROM ig_sync_state WHERE id = 1');
    console.log(`    Instagram group: synced ${Number.isFinite(ig) ? `${Math.round((Date.now() / 1000 - ig) / 3600)} h ago` : 'never'}`);
    break;
  }

  case 'decisions': {
    const logs = db.prepare('SELECT * FROM response_log ORDER BY created_at DESC LIMIT 20').all();
    console.log('\n🎲 Recent Decisions\n');
    for (const l of logs) {
      console.log(`  ${l.decided.padEnd(12)} score: ${l.score?.toFixed(3) || '?'} | ${l.group_jid?.slice(0, 15) || 'DM'}`);
    }
    break;
  }

  default:
    console.log('Usage: node scripts/inspect-memory.js [stats|people|groups|relationships|slang|memories|provenance|decisions]');
}

db.close();
process.exit(0);
