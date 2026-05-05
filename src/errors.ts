import { ErrorCode, ErrorCodes } from "./types";

/**
 * Base class for every error the SDK throws. Inherits from Error so
 * existing `instanceof Error` checks keep working, and exposes a stable
 * `code` discriminator so consumers can match on a string union without
 * tightly coupling to class names.
 *
 * Pattern:
 *
 *     try {
 *       await sendOutscoreWebhook(...)
 *     } catch (e) {
 *       if (e instanceof OutscoreAuthError) {
 *         // re-issue token
 *       } else if (e instanceof OutscoreNetworkError) {
 *         // queue for retry
 *       } else if (e instanceof OutscoreError) {
 *         // generic SDK error
 *       } else {
 *         throw e
 *       }
 *     }
 */
export class OutscoreError extends Error {
  /** Stable string code; survives bundling/minification (class names don't). */
  public readonly code: ErrorCode;
  /** HTTP status if the error came from a remote response. */
  public readonly httpStatus?: number;
  /** Underlying error, when one exists. */
  public readonly cause?: unknown;

  constructor(
    message: string,
    code: ErrorCode,
    opts: { httpStatus?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "OutscoreError";
    this.code = code;
    this.httpStatus = opts.httpStatus;
    this.cause = opts.cause;
  }
}

/** 401-class — wrong/missing token, signature mismatch, expired secret. */
export class OutscoreAuthError extends OutscoreError {
  constructor(
    message = "Authentication failed",
    opts: { httpStatus?: number; cause?: unknown } = {},
  ) {
    super(message, ErrorCodes.AUTH_FAILED, opts);
    this.name = "OutscoreAuthError";
  }
}

/**
 * 400-class — payload missing required fields, malformed body, etc.
 * Receivers can throw this from `store.createPost` / `updatePost` to surface
 * a clean 400 to the platform instead of a 500.
 */
export class OutscoreValidationError extends OutscoreError {
  constructor(
    message: string,
    opts: { httpStatus?: number; cause?: unknown } = {},
  ) {
    super(message, ErrorCodes.MISSING_FIELD, opts);
    this.name = "OutscoreValidationError";
  }
}

/**
 * 404-class — `store.updatePost` couldn't find the receiver-side post.
 * The handler maps this to HTTP 404 so the platform knows to retry as a
 * create instead of looping on update failures.
 */
export class OutscoreNotFoundError extends OutscoreError {
  constructor(
    message = "Post not found",
    opts: { httpStatus?: number; cause?: unknown } = {},
  ) {
    super(message, ErrorCodes.POST_NOT_FOUND, opts);
    this.name = "OutscoreNotFoundError";
  }
}

/** 429-class — rate limit hit. */
export class OutscoreRateLimitError extends OutscoreError {
  /** Seconds the caller should wait before retrying, when known. */
  public readonly retryAfterSec?: number;

  constructor(
    message = "Rate limit exceeded",
    opts: { httpStatus?: number; cause?: unknown; retryAfterSec?: number } = {},
  ) {
    super(message, ErrorCodes.RATE_LIMITED, opts);
    this.name = "OutscoreRateLimitError";
    this.retryAfterSec = opts.retryAfterSec;
  }
}

/**
 * Connectivity error — DNS failure, ECONNREFUSED, TLS handshake failure,
 * etc. Distinct from `OutscoreServerError` (which is a 5xx response from a
 * reachable server).
 */
export class OutscoreNetworkError extends OutscoreError {
  constructor(message: string, opts: { cause?: unknown } = {}) {
    super(message, ErrorCodes.INTERNAL_ERROR, opts);
    this.name = "OutscoreNetworkError";
  }
}

/** Request exceeded the configured timeout. */
export class OutscoreTimeoutError extends OutscoreError {
  constructor(
    message = "Request timed out",
    opts: { cause?: unknown } = {},
  ) {
    super(message, ErrorCodes.INTERNAL_ERROR, opts);
    this.name = "OutscoreTimeoutError";
  }
}

/** 5xx — remote responded but with a server error. */
export class OutscoreServerError extends OutscoreError {
  constructor(
    message: string,
    opts: { httpStatus?: number; cause?: unknown } = {},
  ) {
    super(message, ErrorCodes.INTERNAL_ERROR, opts);
    this.name = "OutscoreServerError";
  }
}
