/**
 * WhatsApp webhook verification:
 * - GET handshake for Meta's webhook config
 * - POST X-Hub-Signature-256 verification
 */

/**
 * Constant-time string comparison to prevent timing attacks on secrets.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Verify the GET webhook handshake from Meta.
 * Returns the challenge string on success, null on failure.
 */
export function verifyWebhookGet(
  mode: string | null,
  verifyToken: string | null,
  expectedToken: string,
): string | null {
  if (mode === "subscribe" && verifyToken !== null) {
    if (timingSafeEqual(verifyToken, expectedToken)) {
      return verifyToken; // Returns the challenge — caller must have saved it
    }
  }
  return null;
}

/**
 * Verify the X-Hub-Signature-256 header on a POST webhook.
 * Computes HMAC-SHA256 of the raw body and compares.
 */
export async function verifyWebhookPost(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string,
): Promise<boolean> {
  if (!signatureHeader) return false;

  const prefix = "sha256=";
  if (!signatureHeader.startsWith(prefix)) return false;

  const expectedHex = signatureHeader.slice(prefix.length);

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(rawBody),
  );

  const actualHex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return timingSafeEqual(actualHex, expectedHex);
}
