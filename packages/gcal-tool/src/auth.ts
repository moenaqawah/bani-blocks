/**
 * Google service-account JWT authentication via WebCrypto.
 * No `googleapis` dependency — we call the REST endpoints with fetch.
 */

interface TokenCache {
  accessToken: string;
  expiresAt: number; // epoch ms
}

let tokenCache: TokenCache | null = null;

function base64urlEncode(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  const b64 = btoa(binary);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signJwt(
  header: Record<string, string>,
  claims: Record<string, string | number>,
  privateKeyPem: string,
): Promise<string> {
  const headerB64 = base64urlEncode(
    new TextEncoder().encode(JSON.stringify(header)),
  );
  const claimsB64 = base64urlEncode(
    new TextEncoder().encode(JSON.stringify(claims)),
  );
  const toSign = `${headerB64}.${claimsB64}`;

  // Parse PEM to DER
  const pemBody = privateKeyPem
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN PRIVATE KEY-----\n?/, "")
    .replace(/\n?-----END PRIVATE KEY-----\n?/, "")
    .replace(/\n/g, "");
  const der = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    der.buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(toSign),
  );
  const sigB64 = base64urlEncode(signature);

  return `${toSign}.${sigB64}`;
}

export async function getAccessToken(cfg: {
  saEmail: string;
  saPrivateKeyPem: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const now = Date.now();

  // Return cached token if still valid (with 60s buffer)
  if (tokenCache && tokenCache.expiresAt > now + 60_000) {
    return tokenCache.accessToken;
  }

  const f = cfg.fetchImpl ?? fetch;

  const nowSeconds = Math.floor(now / 1000);
  const jwt = await signJwt(
    { alg: "RS256", typ: "JWT" },
    {
      iss: cfg.saEmail,
      // calendar.events alone is insufficient for freebusy.query — it 403s
      // with ACCESS_TOKEN_SCOPE_INSUFFICIENT (confirmed 2026-07-28).
      // calendar.freebusy covers the freeBusy check; calendar.events still
      // covers event insert/delete.
      scope:
        "https://www.googleapis.com/auth/calendar.events " +
        "https://www.googleapis.com/auth/calendar.freebusy",
      aud: "https://oauth2.googleapis.com/token",
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    },
    cfg.saPrivateKeyPem,
  );

  const response = await f("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to get access token: ${response.status} ${body}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };

  tokenCache = {
    accessToken: data.access_token,
    expiresAt: now + (data.expires_in ?? 3600) * 1000,
  };

  return tokenCache.accessToken;
}

/**
 * Discard the cached token — called after a 401 response.
 */
export function invalidateToken(): void {
  tokenCache = null;
}
