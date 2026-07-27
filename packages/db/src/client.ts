import postgres, { type Sql } from "postgres";

/**
 * Create a Postgres client configured for Supabase's Supavisor pooler
 * in transaction mode (port 6543).
 *
 * - prepare: false — required by the transaction pooler (no prepared statements)
 * - max: 1 — one connection per Worker isolate
 * - ssl: require
 * - onnotice: noop — suppress notices in production
 */
export function createDb(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    prepare: false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: "require",
    onnotice: () => {},
  });
}
