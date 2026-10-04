import dotenv from "dotenv";
import { Pool, QueryResultRow } from "pg";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Database {
  query<T extends QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
  connect?(): Promise<DatabaseConnection>;
}

export interface DatabaseConnection { query: Database["query"]; release(): void }

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

const migrationFailureMessage = "Memory migration failed. Check DATABASE_URL and database permissions.";
const safeMigrationMessages = new Set([
  "permission denied for schema public",
  "relation does not exist",
  ...["memory_schema_migrations", "memory_kins", "memory_contexts", "memories"].flatMap(table => [
    `permission denied for table ${table}`,
    `must be owner of table ${table}`,
    `relation "${table}" does not exist`,
  ]),
]);

function logMigrationFailure(stage: string, error: unknown): void {
  const fields = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = typeof fields.code === "string" && (
    /^[0-9A-Z]{5}$/.test(fields.code) ||
    ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"].includes(fields.code)
  ) ? fields.code : "unknown";
  const message = typeof fields.message === "string" && safeMigrationMessages.has(fields.message)
    ? fields.message : migrationFailureMessage;
  // Temporary diagnostics: never pass the original error or connection details to the logger.
  console.error({ stage, code, message });
}

export async function migrateDatabase(pool: Pool): Promise<void> {
  let stage = "read-migration-file";
  try {
    const migrations = await Promise.all(["001_memory", "002_category_candidates", "003_memory_governance"].map(async id => ({
      id, sql: await readFile(join(__dirname, `../migrations/${id}.sql`), "utf8"),
    })));
    stage = "connect-database";
    const client = await pool.connect();
    try {
      stage = "begin-transaction";
      await client.query("BEGIN");
      stage = "acquire-migration-lock";
      await client.query("SELECT pg_advisory_xact_lock(618034251)");
      stage = "create-migration-tracker";
      await client.query("CREATE TABLE IF NOT EXISTS memory_schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      for (const migration of migrations) {
        stage = `check-migration-record:${migration.id}`;
        const existing = await client.query("SELECT id FROM memory_schema_migrations WHERE id = $1", [migration.id]);
        if (!existing.rowCount) {
          stage = `execute-memory-schema:${migration.id}`;
          await client.query(migration.sql);
          stage = `record-migration:${migration.id}`;
          await client.query("INSERT INTO memory_schema_migrations (id) VALUES ($1)", [migration.id]);
        }
      }
      stage = "commit-transaction";
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original error and failing stage if rollback also fails.
      }
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    logMigrationFailure(stage, error);
    throw error;
  }
}

if (require.main === module) {
  dotenv.config();
  const pool = createDatabase();
  migrateDatabase(pool).then(() => console.log("Memory migration complete."))
    .catch(() => { process.exitCode = 1; })
    .finally(() => pool.end());
}
