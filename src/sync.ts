import * as crypto from "crypto";
import {
  ErrorCodes,
  OutscoreLogger,
  WebhookEventName,
  WebhookPayload,
} from "./types";
import {
  OutscoreAuthError,
  OutscoreError,
  OutscoreNetworkError,
  OutscoreRateLimitError,
  OutscoreServerError,
  OutscoreTimeoutError,
  OutscoreValidationError,
} from "./errors";
import { redactString } from "./redact";

/**
 * Outbound lifecycle webhook helper.
 *
 * The integrator calls `sendOutscoreWebhook(...)` whenever a managed article
 * changes state on the receiver side (admin updated the body, deleted the
 * post, etc.). The platform consumes these at:
 *
 *     POST {BACKEND_PUBLIC_URL}/api/webhooks/custom-api/<webhook_token>
 *
 * Reliability:
 * - Retries on network errors and 5xx / 429 responses.
 * - Default backoff matches the WP plugin: immediate, 5s, 30s, 120s.
 * - Backoff is fully overridable via `RetryPolicy`.
 *
 * Errors:
 * - Throws a typed `OutscoreError` subclass on terminal failure (after
 *   retries are exhausted, or on a non-retriable status). Consumers can
 *   `instanceof OutscoreAuthError` etc. to react precisely.
 */

const DEFAULT_RETRY_DELAYS_MS = [0, 5_000, 30_000, 120_000];
const DEFAULT_TIMEOUT_MS = 15_000;

/** Status codes that warrant a retry. Everything else is terminal. */
const RETRIABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export interface RetryPolicy {
  /**
   * Delays applied before each attempt, in milliseconds. The first entry
   * applies before the first attempt (use `0` for "send immediately").
   * Length determines the maximum number of attempts.
   *
   * Default: `[0, 5_000, 30_000, 120_000]` (4 attempts total).
   */
  delaysMs?: number[];

  /**
   * Per-attempt timeout in milliseconds. Default: 15_000.
   */
  timeoutMs?: number;
}

export interface SendWebhookOptions {
  /** Full callback URL from the OutscoreAgent dashboard. */
  callbackUrl: string;
  /** Bearer token shown in the dashboard alongside the callback URL. */
  callbackToken: string;

  // --- Payload --------------------------------------------------------------
  event: WebhookEventName;
  external_id: string;
  external_post_id: string | number;
  post_url?: string;
  post_status?: string;
  edit_url?: string;
  /**
   * ISO-8601 UTC timestamp. Stable across retries (the platform's
   * idempotency key includes this value). Defaults to `now`, but you SHOULD
   * pass a fixed value when retrying outside the SDK's built-in retry loop
   * — otherwise each retry produces a fresh `event_id` and the platform
   * processes them as independent events.
   */
  timestamp?: string;

  // --- Reliability ----------------------------------------------------------
  retry?: RetryPolicy;

  // --- Hooks ----------------------------------------------------------------
  /**
   * Optional HMAC-SHA256 signing secret. When set, the SDK adds
   * `X-Outscore-Signature: sha256=<hex>` over the canonicalized request
   * body. Defense-in-depth on top of the bearer token. Pair it with the
   * platform's `webhook_signing_secret` setting on the integration.
   */
  signingSecret?: string;

  /** Extra headers to merge into every attempt. */
  headers?: Record<string, string>;

  /**
   * Inject a custom fetch implementation — useful in serverless
   * environments without `globalThis.fetch`, or in tests. Defaults to
   * `globalThis.fetch`.
   */
  fetchImpl?: typeof fetch;

  /** Sleep override (test seam). */
  sleep?: (ms: number) => Promise<void>;

  logger?: OutscoreLogger;
}

export async function sendOutscoreWebhook(opts: SendWebhookOptions): Promise<void> {
  const {
    callbackUrl,
    callbackToken,
    event,
    external_id,
    external_post_id,
    post_url,
    post_status,
    edit_url,
    timestamp = new Date().toISOString(),
    retry,
    signingSecret,
    headers: extraHeaders,
    fetchImpl = resolveDefaultFetch(),
    sleep = defaultSleep,
    logger = {},
  } = opts;

  if (!isHttpsOrLocalhost(callbackUrl)) {
    throw new OutscoreValidationError(
      "callbackUrl must use HTTPS (HTTP is allowed for localhost only)",
    );
  }
  if (!callbackToken) {
    throw new OutscoreValidationError("callbackToken is required");
  }

  const delays = retry?.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const timeoutMs = retry?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (delays.length === 0) {
    throw new OutscoreValidationError("retry.delaysMs must contain at least one delay");
  }

  const payload: WebhookPayload = {
    event,
    external_id,
    external_post_id,
    post_url,
    post_status,
    edit_url,
    timestamp,
  };
  // Stringify ONCE — both the body and the optional signature must hash over
  // the exact same bytes. Re-serializing per attempt would be wasteful and
  // would also make signature mismatches hard to debug.
  const body = JSON.stringify(payload);
  const headers = buildHeaders(callbackToken, body, signingSecret, extraHeaders);

  let lastErr: unknown;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) await sleep(delays[attempt]);

    try {
      const response = await fetchWithTimeout(
        fetchImpl,
        callbackUrl,
        { method: "POST", headers, body },
        timeoutMs,
      );

      if (response.status >= 200 && response.status < 300) {
        logger.info?.("[outscoreagent] webhook sent", {
          event,
          external_id,
          status: response.status,
          attempt: attempt + 1,
        });
        return;
      }

      // Non-2xx: decide retry vs terminal based on status code.
      const isLast = attempt === delays.length - 1;
      const retriable = RETRIABLE_STATUSES.has(response.status);

      if (!retriable || isLast) {
        // Terminal — translate to a typed error with the right class.
        const text = await safeReadBody(response);
        throw httpStatusToError(response.status, text, response);
      }

      lastErr = new OutscoreServerError(
        `Webhook returned HTTP ${response.status}`,
        { httpStatus: response.status },
      );
      logger.warn?.("[outscoreagent] webhook non-2xx, will retry", {
        event,
        external_id,
        status: response.status,
        attempt: attempt + 1,
      });
    } catch (e) {
      // fetch threw — network error or aborted timeout.
      const wrapped = wrapFetchError(e);
      lastErr = wrapped;

      // Non-retriable typed errors (validation/auth/etc.) escape immediately
      // even if more delays remain — there's no point retrying a 401.
      if (
        wrapped instanceof OutscoreAuthError ||
        wrapped instanceof OutscoreValidationError
      ) {
        throw wrapped;
      }

      logger.warn?.("[outscoreagent] webhook attempt failed", {
        event,
        external_id,
        attempt: attempt + 1,
        message: (wrapped as Error).message,
      });

      if (attempt === delays.length - 1) throw wrapped;
    }
  }

  // Defensive — unreachable when delays.length >= 1.
  throw (lastErr as Error) ?? new OutscoreError(
    "Webhook delivery failed",
    ErrorCodes.INTERNAL_ERROR,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildHeaders(
  callbackToken: string,
  body: string,
  signingSecret: string | undefined,
  extra: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${callbackToken}`,
    ...(extra ?? {}),
  };
  if (signingSecret) {
    // Format mirrors GitHub / Stripe / LemonSqueezy: scheme prefix lets us
    // rotate the algorithm later (sha384, ed25519, …) without breaking
    // existing receivers — they parse the prefix.
    out["X-Outscore-Signature"] =
      "sha256=" + crypto.createHmac("sha256", signingSecret).update(body).digest("hex");
  }
  return out;
}

async function fetchWithTimeout(
  impl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await impl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function httpStatusToError(
  status: number,
  body: string,
  res: Response,
): OutscoreError {
  if (status === 401 || status === 403) {
    return new OutscoreAuthError(`Authentication failed (HTTP ${status})`, {
      httpStatus: status,
    });
  }
  if (status === 429) {
    const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
    return new OutscoreRateLimitError("Rate limit exceeded", {
      httpStatus: status,
      retryAfterSec: retryAfter,
    });
  }
  if (status >= 500) {
    return new OutscoreServerError(`Server error (HTTP ${status}): ${truncate(body)}`, {
      httpStatus: status,
    });
  }
  return new OutscoreError(`HTTP ${status}: ${truncate(body)}`, ErrorCodes.INTERNAL_ERROR, {
    httpStatus: status,
  });
}

function wrapFetchError(e: unknown): OutscoreError {
  if (e instanceof OutscoreError) return e;
  const err = e as Error & { name?: string; code?: string };
  if (err?.name === "AbortError") {
    return new OutscoreTimeoutError("Request timed out", { cause: e });
  }
  // Run the error message through `redactString` so the SDK honors its
  // own redaction promise. Node's fetch surfaces full URLs (incl. query
  // params) in error messages — if a consumer passes a callbackUrl with a
  // token in the query string and the request fails, the raw error text
  // would leak it into their logs without this scrub.
  const safe = redactString(err?.message ?? "Network error");
  return new OutscoreNetworkError(safe, { cause: e });
}

async function safeReadBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 1024);
  } catch {
    return "";
  }
}

function truncate(s: string, max = 200): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function isHttpsOrLocalhost(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === "https:") return true;
    if (
      u.protocol === "http:" &&
      /^(localhost|127\.0\.0\.1|::1)$/i.test(u.hostname)
    ) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function resolveDefaultFetch(): typeof fetch {
  if (typeof fetch !== "function") {
    throw new OutscoreError(
      "globalThis.fetch is not available. Pass `fetchImpl` explicitly " +
        "(e.g. node-fetch) or upgrade to Node 18+.",
      ErrorCodes.INTERNAL_ERROR,
    );
  }
  return fetch;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
