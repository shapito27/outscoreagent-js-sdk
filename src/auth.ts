import * as crypto from "crypto";

/**
 * Constant-time token comparison.
 *
 * Naive `===` leaks timing information on the byte where the strings diverge —
 * an attacker that controls the token string can binary-search the secret one
 * byte at a time. `crypto.timingSafeEqual` is required, but it throws when
 * inputs differ in length, so we pad to a common length before comparing and
 * fold the length mismatch into the boolean result.
 */
export function safeCompareToken(
  provided: string | undefined | null,
  expected: string | undefined | null,
): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided), "utf8");
  const b = Buffer.from(String(expected), "utf8");
  // Pad shorter to longer so timingSafeEqual doesn't throw. ALWAYS run the
  // compare even on length mismatch — short-circuiting on `length !== length`
  // would otherwise leak whether the candidate hit the right length faster
  // than it leaks a single byte. Bitwise-AND folds the length check into the
  // result without short-circuit semantics.
  const max = Math.max(a.length, b.length);
  const aPad = Buffer.alloc(max);
  const bPad = Buffer.alloc(max);
  a.copy(aPad);
  b.copy(bPad);
  const eq = crypto.timingSafeEqual(aPad, bPad) ? 1 : 0;
  const lenEq = a.length === b.length ? 1 : 0;
  return (eq & lenEq) === 1;
}

/**
 * Extract the platform's auth token from request headers.
 *
 * Accepts:
 * - `X-OutscoreAgent-Token: <token>`  (preferred — sidesteps JWT-auth-plugin
 *   conflicts on hosts that intercept Authorization Bearer)
 * - `Authorization: Bearer <token>`   (fallback)
 */
export function extractToken(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const direct = headers["x-outscoreagent-token"];
  if (typeof direct === "string" && direct.length > 0) return direct;
  if (Array.isArray(direct) && direct[0]) return direct[0];

  const auth = headers["authorization"];
  const value = Array.isArray(auth) ? auth[0] : auth;
  if (typeof value === "string" && value.toLowerCase().startsWith("bearer ")) {
    return value.slice(7).trim() || null;
  }

  return null;
}
