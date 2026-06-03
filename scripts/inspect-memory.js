import { getDb, runMigrations } from '../src/memory/db.js';

runMigrations();
const db = getDb();

const command = process.argv[2] || 'stats';

switch (command) {
  case 'stats': {
    const tables = ['messages', 'people', 'groups', 'nicknames', 'relationships', 'memories', 'slang', 'topics'];
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
      if (p.summary) console.log(`    └ ${p.summary}`);
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

  case 'decisions': {
    const logs = db.prepare('SELECT * FROM response_log ORDER BY created_at DESC LIMIT 20').all();
    console.log('\n🎲 Recent Decisions\n');
    for (const l of logs) {
      console.log(`  ${l.decided.padEnd(12)} score: ${l.score?.toFixed(3) || '?'} | ${l.group_jid?.slice(0, 15) || 'DM'}`);
    }
    break;
  }

  default:
    console.log('Usage: node scripts/inspect-memory.js [stats|people|groups|relationships|slang|memories|decisions]');
}

process.exit(0);
