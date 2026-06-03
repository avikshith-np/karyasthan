import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../utils/config.js';
import { safePath } from '../utils/pathGuard.js';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db = null;

export function getDb() {
  if (db) return db;

  const dbPath = safePath(config.dbPath);
  const dbDir = path.dirname(dbPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  logger.info({ dbPath }, 'Database connected');
  return db;
}

export function runMigrations() {
  const database = getDb();
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');

  // Execute the entire schema at once — better-sqlite3's exec() handles multiple statements
  database.exec(schema);

  logger.info('Database migrations complete');
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
    logger.info('Database closed');
  }
}
