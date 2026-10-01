import dotenv from "dotenv";
import { Pool, QueryResultRow } from "pg";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Database {
  query<T extends QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

export function createDatabase(): Pool {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 3,
    connectionTimeoutMillis: 2000,
    statement_timeout: 2000,
    query_timeout: 3000,
    idleTimeoutMillis: 30000,
  });
  // Do not log database errors verbatim: they can contain SQL values or credentials.
  pool.on("error", () => console.warn("Memory database connection failed; recent context remains available."));
  return pool;
}

export async function migrateDatabase(pool: Pool): Promise<void> {
  const sql = await readFile(join(__dirname, "../migrations/001_memory.sql"), "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(618034251)");
    await client.query("CREATE TABLE IF NOT EXISTS memory_schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const existing = await client.query("SELECT id FROM memory_schema_migrations WHERE id = $1", ["001_memory"]);
    if (!existing.rowCount) {
      await client.query(sql);
      await client.query("INSERT INTO memory_schema_migrations (id) VALUES ($1)", ["001_memory"]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  dotenv.config();
  const pool = createDatabase();
  migrateDatabase(pool).then(() => console.log("Memory migration complete."))
    .catch(() => { console.error("Memory migration failed. Check DATABASE_URL and database permissions."); process.exitCode = 1; })
    .finally(() => pool.end());
}
