// Web Crypto helpers. Convex's default runtime exposes the WebCrypto API, so
// these run inside queries/mutations/actions and HTTP actions unchanged from
// the original Cloudflare Worker implementation.

export async function hashString(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function generateToken(length: number = 32): string {
  const chars =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const maxValid = 248; // largest multiple of 62 below 256 — avoids modulo bias
  const result: string[] = [];
  while (result.length < length) {
    const bytes = crypto.getRandomValues(
      new Uint8Array(length - result.length + 8),
    );
    for (const b of bytes) {
      const ch = chars[b % chars.length];
      if (b < maxValid && ch) result.push(ch);
      if (result.length === length) break;
    }
  }
  return result.join("");
}

function toBase64Url(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface JwtPayload {
  sub: string;
  iat: number;
  exp: number;
}

export async function createAdminJWT(secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const header = toBase64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = toBase64Url(
    JSON.stringify({ sub: "admin", iat: now, exp: now + 86400 }),
  );

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${header}.${payload}`),
  );
  const sig = toBase64Url(String.fromCharCode(...new Uint8Array(signature)));
  return `${header}.${payload}.${sig}`;
}

/** Verify an admin HS256 JWT. Returns the payload or null when invalid. */
export async function verifyAdminJWT(
  token: string,
  secret: string,
): Promise<JwtPayload | null> {
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );

    const parts = token.split(".");
    const headerB64 = parts[0];
    const payloadB64 = parts[1];
    const signatureB64 = parts[2];
    if (!headerB64 || !payloadB64 || !signatureB64) return null;

    const data = encoder.encode(`${headerB64}.${payloadB64}`);
    const signature = Uint8Array.from(
      atob(signatureB64.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0),
    );

    const valid = await crypto.subtle.verify("HMAC", key, signature, data);
    if (!valid) return null;

    const payload: JwtPayload = JSON.parse(
      atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")),
    );
    if (payload.exp && payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

export function adminSecret(): string {
  return process.env.ADMIN_JWT_SECRET ?? "change-me-in-secrets";
}

export function latestClientVersion(): string {
  return process.env.LATEST_CLIENT_VERSION ?? "";
}
