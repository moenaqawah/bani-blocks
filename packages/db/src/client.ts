import postgres, { type Sql } from "postgres";

/**
 * Create a Postgres client.
 *
 * - prepare: false — required by Supabase's Supavisor transaction pooler
 *   (no prepared statements); harmless to leave off elsewhere too.
 * - max: 1 — one connection per Worker isolate / script run
 * - ssl: require by default. Pass { ssl: false } when connecting through
 *   Cloudflare Hyperdrive — Hyperdrive's local connection string already
 *   encodes its own sslmode and terminates SSL itself; forcing "require"
 *   on top of that breaks the Worker→Hyperdrive leg.
 * - onnotice: noop — suppress notices in production
 */
export function createDb(databaseUrl: string, opts?: { ssl?: false }): Sql {
  return postgres(databaseUrl, {
    prepare: false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    ...(opts?.ssl === false ? {} : { ssl: "require" }),
    onnotice: () => {},
  });
}
