/**
 * Public type definitions for the OutscoreAgent Custom API integration.
 *
 * These types describe the over-the-wire contract between the OutscoreAgent
 * platform and a customer-hosted endpoint. The contract intentionally mirrors
 * the WordPress plugin's REST surface so the platform can target both with
 * the same publishing pipeline.
 */

/** Source of a stock photo, used to render mandatory attribution. */
export type ImageSource =
  | "branded_template"
  | "pexels"
  | "unsplash"
  | "ai"
  | string;

/** Inline photo inserted between major H2 sections by the platform. */
export interface InlineImage {
  url: string;
  alt?: string;
  position?: number;
  source?: ImageSource;
  author_name?: string;
  author_url?: string;
}

/**
 * Article payload sent by the platform on POST /articles and PUT /articles/:id.
 *
 * Field semantics:
 * - `external_id` is the OutscoreAgent article UUID. It is stable across
 *   updates and MUST be used as the idempotency key on the receiver side.
 *   Receivers should treat repeat POSTs of the same external_id as updates,
 *   not duplicates.
 * - `content` is sanitized HTML (already had inline images, anchor links,
 *   and heading IDs added).  It is NOT block markup — block conversion is
 *   only applied at the WordPress publish boundary.
 * - Featured + inline image attribution fields are mandatory for Unsplash
 *   compliance and MUST be rendered visibly wherever the image appears.
 */
export interface ArticlePayload {
  external_id: string;
  title: string;
  content: string;
  excerpt?: string;
  slug?: string;
  meta_title?: string;
  meta_description?: string;

  featured_image_url?: string;
  featured_image_alt?: string;
  featured_image_source?: ImageSource;
  featured_image_author_name?: string;
  featured_image_author_url?: string;

  inline_images?: InlineImage[];

  category_slug?: string;
  tags?: string[];

  /**
   * Suggested post status. Receivers may map this to their own state model;
   * `publish` should be treated as "make publicly visible immediately."
   */
  post_status?: "draft" | "publish" | "pending";

  cluster_id?: string;
}

/** Response shape for POST /articles and PUT /articles/:id. */
export interface ArticleResponse {
  success: true;
  /**
   * Receiver-assigned ID for the article (numeric or string — opaque to the
   * platform). Stored on the platform side as `cms_post_id`.
   */
  external_post_id: string;
  /** Public URL where the article is now (or will be) reachable. */
  post_url: string;
  /** Receiver's status for the article (`draft` | `publish` | etc.). */
  post_status: string;
  /** Optional admin/edit URL on the receiver's side. */
  edit_url?: string;
}

/** Response shape for GET /status (public, no auth). */
export interface StatusResponse {
  success: true;
  /** Semver of the receiver SDK or implementation. */
  sdk_version: string;
  /** Free-text identifier for the receiving application. */
  app_name: string;
  /** Canonical public origin where articles will be reachable. */
  app_url: string;
  /** Whether the receiver currently has a verified shared secret. */
  has_token: boolean;
  /** Optional hints for the platform's category/tag UI. */
  categories?: Array<{ id: string; name: string; slug: string }>;
}

/** Response shape for POST /test. */
export interface TestResponse {
  success: true;
  message: string;
  app_name: string;
  app_url: string;
}

/** Lifecycle event names mirrored from the WordPress webhook contract. */
export type WebhookEventName =
  | "post_published"
  | "post_updated"
  | "post_trashed"
  | "post_status_changed";

/**
 * Lifecycle event sent FROM the receiver TO the platform when an article's
 * state changes server-side (admin edits the published copy, deletes it, etc).
 * The platform exposes this at:
 *   POST {BACKEND_PUBLIC_URL}/api/webhooks/custom-api/<webhook_token>
 */
export interface WebhookPayload {
  event: WebhookEventName;
  external_id: string;
  external_post_id: string | number;
  post_url?: string;
  post_status?: string;
  edit_url?: string;
  /** ISO-8601 UTC string. */
  timestamp: string;
}

/** Article persistence callbacks supplied by the integrator. */
export interface ArticleStore {
  /**
   * Look up the receiver's internal post id by `external_id`.
   * Return `null` if the article has never been published before.
   */
  findByExternalId(
    externalId: string,
  ): Promise<string | number | null> | string | number | null;

  /**
   * Persist a new article. Return the receiver's internal id + canonical URL.
   */
  createPost(article: ArticlePayload): Promise<ArticleResponse> | ArticleResponse;

  /**
   * Update an existing article identified by the receiver's internal id.
   */
  updatePost(
    externalPostId: string | number,
    article: ArticlePayload,
  ): Promise<ArticleResponse> | ArticleResponse;
}

/** Optional tracing / logging hook surface. */
export interface OutscoreLogger {
  debug?: (msg: string, meta?: Record<string, unknown>) => void;
  info?: (msg: string, meta?: Record<string, unknown>) => void;
  warn?: (msg: string, meta?: Record<string, unknown>) => void;
  error?: (msg: string, meta?: Record<string, unknown>) => void;
}

/** Configuration for `createOutscoreHandler`. */
export interface HandlerConfig {
  /**
   * Shared secret issued by the OutscoreAgent dashboard.
   * Sent on every authenticated call as `X-OutscoreAgent-Token` (or
   * `Authorization: Bearer <token>` for backwards compatibility).
   */
  token: string;

  /**
   * Persistence callbacks. Pure functions — the SDK has no opinion about
   * your storage layer.
   */
  store: ArticleStore;

  /**
   * App identification surfaced on /status and /test for the dashboard's
   * connection-test UX.
   */
  app: {
    name: string;
    url: string;
    /** Optional category catalog hint. */
    categories?: StatusResponse["categories"];
  };

  /**
   * IndexNow key, when known. The SDK serves it at `GET /<key>.txt` with
   * `text/plain`. Optional — pass `null` to disable the route.
   */
  indexNowKey?: string | null;

  /**
   * Persistence hook for IndexNow keys pushed via POST /indexnow-key.
   * The platform calls this after the user connects the integration so
   * `keyLocation` verification works on Bing / Yandex.
   */
  onIndexNowKey?: (key: string) => Promise<void> | void;

  /**
   * Per-token requests-per-minute cap. Defaults to 30 to match the WP
   * plugin. Set to 0 to disable.
   */
  rateLimitPerMinute?: number;

  logger?: OutscoreLogger;
}

/** Error code surface for typed failure responses. */
export const ErrorCodes = {
  MISSING_FIELD: "missing_field",
  DUPLICATE_EXTERNAL_ID: "duplicate_external_id",
  POST_NOT_FOUND: "post_not_found",
  AUTH_FAILED: "auth_failed",
  RATE_LIMITED: "rate_limited",
  INTERNAL_ERROR: "internal_error",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface ErrorBody {
  success: false;
  code: ErrorCode;
  message: string;
}
