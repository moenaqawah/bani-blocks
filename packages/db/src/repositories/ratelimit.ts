import type { Sql } from "postgres";

/**
 * Consume one unit from a fixed-window rate limit bucket.
 * Returns the current count and whether the request is allowed.
 */
export async function consumeRateLimit(
  sql: Sql,
  bucketKey: string,
  limit: number,
): Promise<{ allowed: boolean; count: number }> {
  const rows = await sql<{ count: number }[]>`
    insert into rate_limit_windows (bucket_key, window_start, count)
    values (${bucketKey}, date_trunc('minute', now()), 1)
    on conflict (bucket_key, window_start)
    do update set count = rate_limit_windows.count + 1
    returning count
  `;
  const count = rows[0]?.count ?? 0;
  return { allowed: count <= limit, count };
}

/**
 * Release one unit from a rate limit window — used when a request
 * is denied and we don't want it to count against the limit.
 */
export async function releaseRateLimit(
  sql: Sql,
  bucketKey: string,
  windowStart: Date,
): Promise<void> {
  await sql`
    update rate_limit_windows
    set count = count - 1
    where bucket_key = ${bucketKey}
      and window_start = ${windowStart}
      and count > 0
  `;
}

/**
 * Garbage-collect rate limit windows older than one hour.
 * Called opportunistically (1 in 50 requests).
 */
export async function gcRateLimit(sql: Sql): Promise<void> {
  await sql`
    delete from rate_limit_windows
    where window_start < now() - interval '1 hour'
  `;
}
