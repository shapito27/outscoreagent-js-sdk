import * as crypto from "crypto";
import {
  ArticlePayload,
  ArticleResponse,
  ErrorBody,
  ErrorCodes,
  HandlerConfig,
  OutscoreLogger,
  StatusResponse,
  TestResponse,
} from "./types";
import { extractToken, safeCompareToken } from "./auth";
import { RateLimiter } from "./rate-limit";
import {
  OutscoreAuthError,
  OutscoreError,
  OutscoreNotFoundError,
  OutscoreRateLimitError,
  OutscoreValidationError,
} from "./errors";

/** Method/path-agnostic request shape the core handler operates on. */
export interface IncomingRequest {
  method: string;
  /** Path segments after the SDK mount point, e.g. `/articles/42` → `articles/42`. */
  path: string;
  headers: Record<string, string | string[] | undefined>;
  /** Decoded JSON body, or `undefined` for GET. */
  body?: unknown;
}

/** Normalized response — adapters serialize this to their framework type. */
export interface OutgoingResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

const JSON_HEADERS = { "Content-Type": "application/json" };
const TEXT_HEADERS = { "Content-Type": "text/plain; charset=utf-8" };

/**
 * Hard-coded once per release. Kept here (not read from `package.json`) so
 * bundlers that strip JSON imports don't break the `/status` response.
 * Update in lockstep with `package.json#version` at release time.
 */
const SDK_VERSION = "0.2.0";

/**
 * Build the framework-agnostic core handler.
 *
 * The returned function takes a normalized `IncomingRequest` and returns an
 * `OutgoingResponse`. Framework adapters (Express, Fastify, Next.js) are thin
 * wrappers around this — they do header normalization and body deserialization
 * only.
 */
export function createCoreHandler(config: HandlerConfig) {
  if (!config.token || config.token.length < 32) {
    throw new Error(
      "[outscoreagent/custom-api] `token` must be at least 32 characters. " +
        "Generate one in the OutscoreAgent dashboard under Integrations → Custom API, " +
        "or use crypto.randomBytes(32).toString('hex').",
    );
  }
  const perTokenLimit = config.rateLimitPerMinute ?? 30;
  const limiter = new RateLimiter(perTokenLimit);
  // Separate, more permissive bucket for unauthenticated requests so a
  // brute-force attacker can't bypass rate limiting by spamming with
  // garbage tokens (the per-token limiter only fires AFTER auth succeeds).
  // The bucket is shared across all anonymous traffic — sized for the
  // platform's `/status` polling (a few req/min) plus IndexNow probes,
  // not for legitimate per-tenant publishing throughput.
  const anonLimiter = new RateLimiter(perTokenLimit > 0 ? perTokenLimit * 4 : 0);
  const log = config.logger ?? {};

  return async function handle(req: IncomingRequest): Promise<OutgoingResponse> {
    const path = stripSlashes(req.path);
    const method = req.method.toUpperCase();

    // ------------------------------------------------------------------
    // GET /<key>.txt — IndexNow key route. Public, no auth.
    // ------------------------------------------------------------------
    if (
      method === "GET" &&
      config.indexNowKey &&
      path === `${config.indexNowKey}.txt`
    ) {
      return {
        status: 200,
        headers: TEXT_HEADERS,
        body: config.indexNowKey,
      };
    }

    // ------------------------------------------------------------------
    // GET /status — public
    // ------------------------------------------------------------------
    if (method === "GET" && path === "status") {
      const body: StatusResponse = {
        success: true,
        sdk_version: SDK_VERSION,
        app_name: config.app.name,
        app_url: config.app.url,
        has_token: Boolean(config.token),
        categories: config.app.categories,
      };
      return ok(body);
    }

    // Pre-auth anonymous rate limit. Closes the brute-force vector where
    // an attacker spams the endpoint with garbage tokens — the per-token
    // limiter below only fires AFTER a successful timingSafeEqual, so
    // without this guard a token-guess loop is unbounded.
    if (anonLimiter.exceeded("_anon")) {
      log.debug?.("[outscoreagent] anon rate limited");
      return err(429, ErrorCodes.RATE_LIMITED, "Too many requests");
    }

    // Everything below this point requires authentication.
    const provided = extractToken(req.headers);
    if (!safeCompareToken(provided, config.token)) {
      log.warn?.("[outscoreagent] auth failed", { path, method });
      return err(401, ErrorCodes.AUTH_FAILED, "Invalid or missing token");
    }

    // Rate-limit by the token bucket, not by IP — the platform may call
    // through CDN edges so source IP is not stable. Hash the token so we
    // never log raw tokens via the bucket key.
    const bucket = "tk_" + sha256(provided!).slice(0, 16);
    if (limiter.exceeded(bucket)) {
      log.debug?.("[outscoreagent] rate limited", { bucket });
      return err(429, ErrorCodes.RATE_LIMITED, "Too many requests");
    }

    // ------------------------------------------------------------------
    // POST /test — auth check
    // ------------------------------------------------------------------
    if (method === "POST" && path === "test") {
      const body: TestResponse = {
        success: true,
        message: "Connection verified",
        app_name: config.app.name,
        app_url: config.app.url,
      };
      return ok(body);
    }

    // ------------------------------------------------------------------
    // POST /indexnow-key — receive + persist the IndexNow key
    // ------------------------------------------------------------------
    if (method === "POST" && path === "indexnow-key") {
      const incoming = (req.body ?? {}) as { key?: unknown };
      const key = typeof incoming.key === "string" ? incoming.key.trim() : "";
      // Per IndexNow §2.1, the key is 8-128 alphanumeric + hyphen. The
      // platform's current generator emits hex, but loosening the regex
      // here insulates the SDK from a future generator rotation.
      if (!/^[a-zA-Z0-9-]{8,128}$/.test(key)) {
        return err(
          400,
          ErrorCodes.MISSING_FIELD,
          "key must be 8-128 alphanumeric or hyphen characters",
        );
      }
      try {
        await config.onIndexNowKey?.(key);
      } catch (e) {
        log.error?.("[outscoreagent] onIndexNowKey threw", {
          message: (e as Error).message,
        });
        return err(500, ErrorCodes.INTERNAL_ERROR, "Failed to persist IndexNow key");
      }
      return ok({ success: true });
    }

    // ------------------------------------------------------------------
    // POST /articles — create
    // ------------------------------------------------------------------
    if (method === "POST" && path === "articles") {
      const article = req.body as ArticlePayload | undefined;
      const missing = checkRequired(article, ["external_id", "title", "content"]);
      if (missing) {
        return err(400, ErrorCodes.MISSING_FIELD, missing);
      }

      const existing = await config.store.findByExternalId(article!.external_id);
      if (existing != null) {
        log.debug?.("[outscoreagent] duplicate external_id on create", {
          external_id: article!.external_id,
        });
        return err(
          409,
          ErrorCodes.DUPLICATE_EXTERNAL_ID,
          `external_id ${article!.external_id} already exists; use PUT /articles/${existing} to update`,
        );
      }

      try {
        const result = await config.store.createPost(article!);
        log.info?.("[outscoreagent] article created", {
          external_id: article!.external_id,
          external_post_id: result.external_post_id,
        });
        return ok(normalizeArticleResponse(result), 201);
      } catch (e) {
        // Map typed SDK errors to their corresponding HTTP status. Receivers
        // can `throw new OutscoreValidationError("missing slug")` from
        // `store.createPost` to surface a clean 400 to the platform; without
        // this branch every thrown error becomes an opaque 500 and the
        // platform retries forever.
        return mapStoreError(e, "createPost", article!.external_id, log);
      }
    }

    // ------------------------------------------------------------------
    // PUT /articles/:id — update
    // ------------------------------------------------------------------
    if (method === "PUT" && path.startsWith("articles/")) {
      const externalPostId = path.slice("articles/".length);
      if (!externalPostId) {
        return err(400, ErrorCodes.MISSING_FIELD, "post id is required");
      }
      const article = req.body as ArticlePayload | undefined;
      const missing = checkRequired(article, ["external_id", "title", "content"]);
      if (missing) {
        return err(400, ErrorCodes.MISSING_FIELD, missing);
      }

      try {
        const result = await config.store.updatePost(externalPostId, article!);
        log.info?.("[outscoreagent] article updated", {
          external_id: article!.external_id,
          external_post_id: result.external_post_id,
        });
        return ok(normalizeArticleResponse(result));
      } catch (e) {
        return mapStoreError(e, "updatePost", externalPostId, log);
      }
    }

    return err(404, ErrorCodes.MISSING_FIELD, `No route for ${method} /${path}`);
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(body: unknown, status = 200): OutgoingResponse {
  return { status, headers: JSON_HEADERS, body };
}

function err(status: number, code: ErrorBody["code"], message: string): OutgoingResponse {
  const body: ErrorBody = { success: false, code, message };
  return { status, headers: JSON_HEADERS, body };
}

function stripSlashes(p: string): string {
  return p.replace(/^\/+|\/+$/g, "");
}

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/**
 * Translate an error thrown from `store.createPost` / `store.updatePost`
 * into the right HTTP response. Receivers that throw typed SDK errors
 * (OutscoreNotFoundError, OutscoreValidationError, OutscoreAuthError,
 * OutscoreRateLimitError) get a precise status code; raw `Error` instances
 * fall back to 500 with a generic message, but we also keep the legacy
 * "message contains 'not found'" heuristic so existing receiver code
 * doesn't break when it migrates to typed errors at its own pace.
 */
function mapStoreError(
  e: unknown,
  op: "createPost" | "updatePost",
  externalIdOrPostId: string,
  log: OutscoreLogger,
): OutgoingResponse {
  if (e instanceof OutscoreNotFoundError) {
    return err(404, e.code, e.message);
  }
  if (e instanceof OutscoreValidationError) {
    return err(400, e.code, e.message);
  }
  if (e instanceof OutscoreAuthError) {
    return err(401, e.code, e.message);
  }
  if (e instanceof OutscoreRateLimitError) {
    return err(429, e.code, e.message);
  }
  if (e instanceof OutscoreError && e.httpStatus) {
    return err(e.httpStatus, e.code, e.message);
  }

  const msg = (e as Error).message ?? "";
  // Legacy heuristic — pre-error-classes receivers throw plain Errors with
  // "not found" in the message. Keep mapping the STATUS to 404 so upgrades
  // are backwards-compatible; new code should throw OutscoreNotFoundError.
  // The raw error message stays in the LOG, never in the response body —
  // a receiver that throws `new Error("ssh tunnel to internal not found
  // at 10.0.0.5:22")` would otherwise leak its infra details to the
  // platform on every 404.
  if (op === "updatePost" && /not.?found/i.test(msg)) {
    log.warn?.(`[outscoreagent] ${op} not-found`, {
      id: externalIdOrPostId,
      message: msg,
    });
    return err(404, ErrorCodes.POST_NOT_FOUND, "Post not found");
  }

  log.error?.(`[outscoreagent] ${op} threw`, {
    id: externalIdOrPostId,
    message: msg,
  });
  return err(
    500,
    ErrorCodes.INTERNAL_ERROR,
    op === "createPost" ? "Failed to create post" : "Failed to update post",
  );
}

function checkRequired(
  body: unknown,
  fields: string[],
): string | null {
  if (!body || typeof body !== "object") {
    return "Request body must be a JSON object";
  }
  for (const field of fields) {
    const v = (body as Record<string, unknown>)[field];
    if (v === undefined || v === null || v === "") {
      return `Required field "${field}" is missing or empty`;
    }
  }
  return null;
}

function normalizeArticleResponse(r: ArticleResponse): ArticleResponse {
  return {
    success: true,
    external_post_id: String(r.external_post_id),
    post_url: r.post_url,
    post_status: r.post_status,
    edit_url: r.edit_url,
  };
}
