/**
 * Error taxonomy for the entire application.
 * Every error thrown by app code is an AppError with a typed `kind`.
 */
export type ErrorKind =
  | "CONFIG"        // missing/invalid env — fail fast at startup
  | "SIGNATURE"     // webhook signature mismatch — 403, no processing
  | "DB"            // Postgres unreachable or query failed
  | "LLM_RATE"      // provider rate limit (429)
  | "LLM"           // any other provider failure
  | "CALENDAR"      // Google API failure
  | "WHATSAPP"      // Meta send failure
  | "VALIDATION";   // bad tool input

export class AppError extends Error {
  constructor(
    public kind: ErrorKind,
    message: string,
    public override cause?: unknown,
    public retryable = false,
  ) {
    super(message);
    this.name = "AppError";
  }
}
