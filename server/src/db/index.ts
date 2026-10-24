import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export { schema };
/** both drivers share the pg-core query builder; typed as node-postgres for one surface */
export type DB = NodePgDatabase<typeof schema>;
export interface Database { db: DB; kind: 'postgres' | 'pglite'; close(): Promise<void> }

const here = dirname(fileURLToPath(import.meta.url));
// src/db (tsx) → ../../drizzle ; dist (bundle) → ../drizzle
const candidates = [resolve(here, '../../drizzle'), resolve(here, '../drizzle'), resolve(process.cwd(), 'drizzle')];
export const MIGRATIONS_DIR = candidates.find((p) => existsSync(resolve(p, 'meta', '_journal.json'))) ?? candidates[0];

/**
 * DATABASE_URL=postgres://… → node-postgres pool.
 * empty → embedded PGlite (Postgres in WASM) in `pgliteDir` ("memory://" for tests).
 */
export async function openDatabase(url: string, pgliteDir: string): Promise<Database> {
  if (url) {
    const { default: pg } = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');
    // under a spike a request waits at most 5 s for a connection and a query runs at most 10 s, instead of queueing forever
    const pool = new pg.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 5_000, statement_timeout: 10_000 });
    const db = drizzle(pool, { schema });
    return { db, kind: 'postgres', close: () => pool.end() };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  if (!pgliteDir.startsWith('memory://')) mkdirSync(pgliteDir, { recursive: true });
  const client = new PGlite(pgliteDir);
  await client.waitReady;
  const db = drizzle(client, { schema }) as unknown as DB;
  return { db, kind: 'pglite', close: () => client.close() };
}

export async function migrateDatabase(d: Database): Promise<void> {
  if (d.kind === 'postgres') {
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await migrate(d.db, { migrationsFolder: MIGRATIONS_DIR });
  } else {
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await migrate(d.db as any, { migrationsFolder: MIGRATIONS_DIR });
  }
}
