/**
 * JSON structured logger.
 * Every log line is a single JSON object.
 * Phone numbers are NEVER logged in clear text — use sha256 slice.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LogEntry {
  ts: string;
  level: LogLevel;
  kind?: string;
  msg: string;
  waPhoneHash?: string;
  conversationId?: string;
  bookingRef?: string;
  durationMs?: number;
  [key: string]: unknown;
}

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/**
 * Hash a phone number for logging. Returns first 12 hex chars of SHA-256.
 * If the input is empty or not a phone, returns a masked sentinel.
 */
export async function hashPhone(phone: string): Promise<string> {
  if (!phone) return "no-phone";
  const data = new TextEncoder().encode(phone);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 12);
}

export function log(
  level: LogLevel,
  msg: string,
  extra?: Partial<LogEntry>,
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;

  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...extra,
  };

  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug(msg: string, extra?: Partial<LogEntry>) { log("debug", msg, extra); },
  info(msg: string, extra?: Partial<LogEntry>) { log("info", msg, extra); },
  warn(msg: string, extra?: Partial<LogEntry>) { log("warn", msg, extra); },
  error(msg: string, extra?: Partial<LogEntry>) { log("error", msg, extra); },
};
