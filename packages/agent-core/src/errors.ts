/** Provider-agnostic detection of "you are sending too many requests". */
export function isRateLimitError(err: unknown): boolean {
  const e = err as { statusCode?: number; errors?: unknown[] } | undefined;
  if (e?.statusCode === 429) return true;
  if (Array.isArray(e?.errors)) {
    return e.errors.some((inner) => (inner as { statusCode?: number })?.statusCode === 429);
  }
  return false;
}
