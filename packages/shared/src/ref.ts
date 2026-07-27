/**
 * Booking reference generator.
 * Format: BK-XXXXXX where X is [A-Z0-9] (6 characters, uppercase).
 * ~2.2 billion combinations — enough for a demo.
 */

const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export function generateRef(): string {
  let code = "";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 6; i++) {
    code += CHARSET[bytes[i]! % CHARSET.length];
  }
  return `BK-${code}`;
}
