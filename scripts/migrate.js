import { runMigrations, closeDb } from '../src/memory/db.js';

console.log('Running migrations...');
runMigrations();
closeDb();
console.log('Done.');
