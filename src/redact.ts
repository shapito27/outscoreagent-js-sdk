/**
 * Replace sensitive values in a freeform object so it's safe to log.
 *
 * Walks the input recursively. Any key matching the redaction regex (case-
 * insensitive) has its value replaced with `[REDACTED]`. Non-object inputs
 * pass through unchanged so this can be used safely as a logger formatter.
 *
 * Tradeoffs:
 * - Pure value-only redaction. Won't scrub a token that's been embedded
 *   inside a longer string (e.g. a stack trace or URL); for that, also
 *   apply `redactString` below.
 * - Returns a clone — never mutates the input.
 * - Cycle-safe via WeakSet.
 */

const DEFAULT_KEY_PATTERN =
  /(token|secret|password|pwd|passwd|authorization|api[_-]?key|private[_-]?key|bearer|cookie|webhook_token|signature)/i;

const REDACTED = "[REDACTED]";

export interface RedactOptions {
  /** Override the key matcher. Pass a fully custom regex. */
  keyPattern?: RegExp;
  /** Maximum depth before bailing out (defense against pathological inputs). */
  maxDepth?: number;
}

export function redact(value: unknown, opts: RedactOptions = {}): unknown {
  const pattern = opts.keyPattern ?? DEFAULT_KEY_PATTERN;
  const maxDepth = opts.maxDepth ?? 8;
  const seen = new WeakSet<object>();

  function walk(v: unknown, depth: number): unknown {
    if (depth > maxDepth) return "[TRUNCATED]";
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) return "[CIRCULAR]";
    seen.add(v as object);

    if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1));

    const out: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (pattern.test(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = walk(child, depth + 1);
      }
    }
    return out;
  }

  return walk(value, 0);
}

/**
 * Replace any token-shaped substring in a string with `[REDACTED]`.
 *
 * Targets:
 * - `Bearer <token>` headers
 * - `?token=...` / `?api_key=...` query params
 * - Hex-or-base64-shaped runs of >=24 chars (catches platform-issued tokens
 *   that are usually hex; also catches base64-ish secrets without false-
 *   positiving on prose)
 *
 * Useful for scrubbing error messages and stack traces before they reach a
 * SIEM.
 */
export function redactString(s: string): string {
  return s
    .replace(/(Bearer\s+)\S+/gi, `$1${REDACTED}`)
    .replace(/((?:token|api[_-]?key|secret|password)=)[^&\s]+/gi, `$1${REDACTED}`)
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, REDACTED);
}
