/**
 * In-memory sliding-window rate limiter, keyed by an arbitrary bucket id.
 *
 * Intentionally minimal: a fresh process starts with empty state, and there
 * is no cross-instance coordination. This matches the WP plugin's per-token
 * transient-backed limiter — defense in depth, not a security boundary.
 *
 * For multi-instance deployments where you genuinely need shared state,
 * front the SDK with a real rate limiter (nginx, an API gateway, or a
 * distributed limiter) and pass `rateLimitPerMinute: 0` to disable this.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly limitPerMinute: number) {}

  /** Returns true when the request should be rejected. */
  exceeded(key: string): boolean {
    if (this.limitPerMinute <= 0) return false;
    const now = Date.now();
    const entry = this.buckets.get(key);
    if (!entry || entry.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + 60_000 });
      return false;
    }
    entry.count += 1;
    return entry.count > this.limitPerMinute;
  }

  /** Test-only — drop all buckets. */
  reset(): void {
    this.buckets.clear();
  }
}
