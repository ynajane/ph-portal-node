// Creates all tables from database/schema.sql. No psql needed:  npm run db
import 'dotenv/config';
import fs from 'node:fs';
import pg from 'pg';
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set in .env'); process.exit(1); }
const local = /localhost|127\.0\.0\.1/.test(url);
const db = new pg.Client({ connectionString: url, ssl: local ? undefined : { rejectUnauthorized: false } });
try {
  await db.connect();
  await db.query(fs.readFileSync(new URL('../database/schema.sql', import.meta.url), 'utf8'));
  const { rows } = await db.query(`select table_name from information_schema.tables where table_schema='public' order by 1`);
  console.log('Database ready. Tables:', rows.map((r) => r.table_name).join(', '));
} catch (e) { console.error('FAILED:', e.message); process.exitCode = 1; } finally { await db.end(); }
