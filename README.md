# @outscoreagent/custom-api

Reference SDK for receiving published articles from the [OutscoreAgent](https://outscoreagent.com) content platform on **any** Node.js backend. CMS-agnostic — bring your own storage.

> **Status**: `0.2.0`. The HTTP contract documented below is the source of truth — the Node SDK is one reference implementation. If you'd rather wire this up in PHP / Python / Go, follow the contract directly.

## When to use this

- ✅ You run a custom Node.js / Next.js / Fastify / NestJS backend.
- ✅ You run a headless CMS (Strapi, Payload, Keystone, Sanity, etc.).
- ✅ You publish articles to a static-site generator with a Node build step.
- ❌ You're on **WordPress** — install the [OutscoreAgent WordPress plugin](https://outscoreagent.com/downloads/outscoreagent.zip) instead.
- ❌ You want to *trigger* article generation from your code — that's a future *client* SDK; this is a *receiver* SDK only (the platform calls into your code).

## How it works

OutscoreAgent generates articles on its platform, then **pushes** each one to your backend over HTTP. The SDK is the receiver — there is no polling and no job queue.

```
                    POST /articles  (platform → you)
   ┌──────────────┐ ─────────────────────────────► ┌──────────────┐
   │ OutscoreAgent│                                │  Your Node   │
   │   platform   │ ◄───────────────────────────── │   backend    │
   └──────────────┘  200 { external_post_id, url } └──────────────┘
          ▲                                                │
          │            sendOutscoreWebhook(...)            │
          └────────────────────────────────────────────────┘
                    (optional, on your-side edits)
```

1. **Platform → SDK.** When an article is ready, the platform calls `POST /articles` (or `PUT /articles/:id` on edits) on your mounted endpoint, authenticated with the bearer token.
2. **SDK → your store.** The SDK validates the token, rate-limits, and dispatches to your `store.createPost` / `store.updatePost` callback. You persist the article however you want (Postgres, Sanity, MDX on disk, …) and return your internal post id + canonical URL.
3. **SDK → platform.** The SDK shapes your callback's return value into the HTTP response, so the dashboard knows where the article landed.
4. **Your backend → platform (optional).** When *you* edit, unpublish, or delete the article on your side, call `sendOutscoreWebhook(...)` to keep the dashboard in sync. This is the only outbound call the SDK ever makes.

All transport is synchronous request/response — no jobs, no polling, no background workers required on your side.

## Compatibility

| | |
|---|---|
| **Node.js** | 18+ (relies on global `fetch` and `AbortController`) |
| **Module formats** | ESM and CommonJS (dual-build, `package.json#exports` map) |
| **TypeScript** | 4.7+ for full type support; types ship with the package |
| **Adapters** | Express 4/5, Fastify 4/5, Next.js App Router |
| **Anything else** | Use the framework-agnostic `createCoreHandler` — see below |

## Install

```bash
npm install @outscoreagent/custom-api
# or
pnpm add @outscoreagent/custom-api
# or
yarn add @outscoreagent/custom-api
```

## Quick start (Express)

```ts
import express from "express";
import { createOutscoreExpressHandler } from "@outscoreagent/custom-api";

const app = express();
app.use(express.json({ limit: "1mb" })); // required for POST/PUT bodies

app.use(
  "/outscoreagent",
  createOutscoreExpressHandler({
    token: process.env.OUTSCORE_TOKEN!,        // copy from the dashboard
    app: { name: "My Site", url: "https://my-site.com" },
    store: {
      findByExternalId: async (externalId) => {
        const row = await db.posts.findUnique({ where: { externalId } });
        return row?.id ?? null;
      },
      createPost: async (article) => {
        const row = await db.posts.create({
          data: {
            externalId: article.external_id,
            title: article.title,
            html: article.content,
            slug: article.slug,
          },
        });
        return {
          success: true,
          external_post_id: row.id,
          post_url: `https://my-site.com/posts/${row.slug}`,
          post_status: article.post_status ?? "publish",
        };
      },
      updatePost: async (postId, article) => {
        const row = await db.posts.update({
          where: { id: String(postId) },
          data: { title: article.title, html: article.content, slug: article.slug },
        });
        return {
          success: true,
          external_post_id: row.id,
          post_url: `https://my-site.com/posts/${row.slug}`,
          post_status: article.post_status ?? "publish",
        };
      },
    },
  }),
);
```

In the OutscoreAgent dashboard → **Integrations** → **Custom API**, paste:

- **Endpoint URL**: `https://my-site.com/outscoreagent`
- **Token**: the value of `OUTSCORE_TOKEN`

…then click **Test Connection**.

## Other adapters

```ts
// Fastify
import Fastify from "fastify";
import { outscoreFastifyPlugin } from "@outscoreagent/custom-api";

const app = Fastify();
app.register(outscoreFastifyPlugin({ /* same config */ }), { prefix: "/outscoreagent" });
```

```ts
// Next.js (App Router) — app/api/outscoreagent/[...path]/route.ts
import { createNextRouteHandlers } from "@outscoreagent/custom-api";
export const { GET, POST, PUT } = createNextRouteHandlers({ /* same config */ });
```

```ts
// Anything else (Hono, Koa, raw http, etc.)
import { createCoreHandler } from "@outscoreagent/custom-api";

const handle = createCoreHandler({ /* same config */ });

// Then in your framework's request handler:
const out = await handle({
  method: req.method,
  path: req.path,           // path RELATIVE to the SDK mount point
  headers: req.headers,     // lowercase keys
  body: await req.json(),   // parsed JSON
});
res.status(out.status).set(out.headers).send(out.body);
```

Runnable examples: [`examples/express-minimal/`](examples/express-minimal/), [`examples/fastify-minimal/`](examples/fastify-minimal/), [`examples/nextjs-app-router/`](examples/nextjs-app-router/).

## HTTP contract (the source of truth)

All authenticated endpoints accept the token via either header. **Prefer the first one** — some hosts run JWT-auth plugins that hijack `Authorization: Bearer`.

```
X-OutscoreAgent-Token: <token>
Authorization:        Bearer <token>     # fallback
```

### `GET /status` (public)

Returns receiver metadata. Used by the dashboard to confirm the SDK is reachable before you've configured a token.

```json
{
  "success": true,
  "sdk_version": "0.2.0",
  "app_name": "My Site",
  "app_url": "https://my-site.com",
  "has_token": true,
  "categories": [{ "id": "1", "name": "Blog", "slug": "blog" }]
}
```

### `POST /test` (auth required)

Confirms the token round-trip.

```json
{
  "success": true,
  "message": "Connection verified",
  "app_name": "My Site",
  "app_url": "https://my-site.com"
}
```

### `POST /articles` (auth required)

Create a new article. The platform sends:

```json
{
  "external_id": "8d1b…",            // OutscoreAgent UUID — your idempotency key
  "title": "How to ...",
  "content": "<p>HTML body…</p>",    // sanitized HTML, includes inline images
  "excerpt": "...",
  "slug": "how-to-...",
  "meta_title": "...",
  "meta_description": "...",
  "featured_image_url": "https://img.outscoreagent.com/.../featured.webp",
  "featured_image_alt": "...",
  "featured_image_source": "unsplash",
  "featured_image_author_name": "Jane Doe",
  "featured_image_author_url": "https://unsplash.com/@janedoe?utm_source=outscoreagent&utm_medium=referral",
  "inline_images": [{ "url": "...", "alt": "...", "source": "pexels", "author_name": "...", "author_url": "..." }],
  "tags": ["topic-cluster-name"],
  "post_status": "publish"
}
```

You return:

```json
{
  "success": true,
  "external_post_id": "42",                         // your internal post id
  "post_url": "https://my-site.com/posts/how-to-...",
  "post_status": "publish",
  "edit_url": "https://my-site.com/admin/posts/42"  // optional
}
```

> **Attribution rules — legally mandatory.** When `featured_image_source` (or any `inline_images[*].source`) is `unsplash`, you **must** render visible credit linking the photographer's profile and Unsplash, with the `utm_source=outscoreagent&utm_medium=referral` query parameters preserved on both URLs. Pexels recommends but does not require credit. See the [Unsplash API Guidelines](https://help.unsplash.com/en/articles/2511245-unsplash-api-guidelines).

### `PUT /articles/:external_post_id` (auth required)

Update an existing article. Body is identical to `POST /articles`. Throw `OutscoreNotFoundError` (preferred) or any error containing the string `"not found"` to return 404.

### `POST /indexnow-key` (auth required)

The platform pushes its IndexNow key to your receiver after the integration is connected. Persist it in your `onIndexNowKey` callback; the SDK then serves it back at `GET /<key>.txt`.

```json
{ "key": "abcdef1234567890abcdef1234567890" }
```

### `GET /<key>.txt` (public)

Serves the IndexNow key as `text/plain`. Required for Bing/Yandex/Seznam/Naver `keyLocation` verification (per IndexNow spec §2.2).

> **Important — root-mount caveat.** The IndexNow spec expects `keyLocation` URLs at the **same origin and (typically) root path** as the indexed URLs. The SDK serves the key file under whatever path you mount it at (e.g. `https://my-site.com/outscoreagent/<key>.txt`). If your SDK mount path is non-root and your IndexNow `keyLocation` config points at the root, you'll need to add a separate root-level route serving the same key. See `onIndexNowKey` to grab the value and serve it yourself.

## Lifecycle webhooks (your → platform)

When an article changes state on **your** side (admin edits the published copy, deletes the post, etc.), notify the platform so its dashboard stays in sync:

```ts
import { sendOutscoreWebhook } from "@outscoreagent/custom-api";

await sendOutscoreWebhook({
  callbackUrl: "https://api.outscoreagent.com/api/webhooks/custom-api/<webhook_token>",
  callbackToken: "<webhook_token>",
  event: "post_published",
  external_id: article.externalId,
  external_post_id: article.id,
  post_url: `https://my-site.com/posts/${article.slug}`,
  post_status: "publish",
});
```

`callbackUrl` and `callbackToken` are shown in the dashboard after you click **Test Connection**. Events: `post_published`, `post_updated`, `post_trashed`, `post_status_changed`.

> **Idempotency.** The platform deduplicates events by `(event, external_id, timestamp)`. The SDK's built-in retry loop reuses one stable timestamp across attempts — if you write your own retry loop OUTSIDE `sendOutscoreWebhook`, **pass an explicit `timestamp` and reuse it across retries**, otherwise each attempt creates a new event.

### Configurable retry policy

Default backoff is `[0s, 5s, 30s, 120s]` with a 15s per-attempt timeout. Override per call:

```ts
await sendOutscoreWebhook({
  ...,
  retry: {
    delaysMs: [0, 1_000, 5_000, 30_000, 120_000], // 5 attempts
    timeoutMs: 30_000,
  },
});
```

Retries fire on network errors, 408, 429, and 5xx responses. 4xx (except 408 / 429) are terminal — no point retrying a 401.

### Optional HMAC body signature

Pass `signingSecret` to add a tamper-evident `X-Outscore-Signature: sha256=<hex>` header. The platform verifies the signature when the matching `webhook_signing_secret` is configured on the integration:

```ts
await sendOutscoreWebhook({
  ...,
  signingSecret: process.env.OUTSCORE_WEBHOOK_SIGNING_SECRET,
});
```

Defense-in-depth on top of the bearer token. Recommended when TLS is terminated by a proxy you don't fully trust, or when re-playing events from a log.

### Custom transport

Inject a custom fetch implementation (Cloudflare Workers, Vercel Edge, undici with a proxy, etc.) or extra headers:

```ts
await sendOutscoreWebhook({
  ...,
  fetchImpl: customFetch,
  headers: { "X-Tenant-Id": tenantId },
});
```

## Error handling

`sendOutscoreWebhook` throws a typed `OutscoreError` subclass on terminal failure:

```ts
import {
  sendOutscoreWebhook,
  OutscoreAuthError,
  OutscoreNetworkError,
  OutscoreRateLimitError,
  OutscoreServerError,
  OutscoreTimeoutError,
} from "@outscoreagent/custom-api";

try {
  await sendOutscoreWebhook(opts);
} catch (e) {
  if (e instanceof OutscoreAuthError) {
    // Your token is wrong — re-issue from the dashboard.
  } else if (e instanceof OutscoreRateLimitError) {
    setTimeout(retry, (e.retryAfterSec ?? 60) * 1000);
  } else if (e instanceof OutscoreNetworkError || e instanceof OutscoreTimeoutError) {
    // Transient — queue for later.
  } else if (e instanceof OutscoreServerError) {
    // Platform is unhealthy.
  } else {
    throw e;
  }
}
```

Every subclass extends `OutscoreError`, which carries `code` (stable string discriminator that survives bundling) and `httpStatus` (when applicable).

The same error classes can be **thrown** from your `store.createPost` / `store.updatePost` callbacks to map to the right HTTP status:

```ts
import {
  OutscoreNotFoundError,
  OutscoreValidationError,
} from "@outscoreagent/custom-api";

store: {
  createPost: async (article) => {
    if (!article.slug) throw new OutscoreValidationError("slug is required"); // → 400
    ...
  },
  updatePost: async (id, article) => {
    const row = await db.posts.findUnique({ where: { id } });
    if (!row) throw new OutscoreNotFoundError(`post ${id} does not exist`); // → 404
    ...
  },
}
```

Without these, every thrown error becomes an opaque 500 and the platform retries forever. **Note:** raw error messages thrown from your store callbacks are NOT echoed in HTTP response bodies (they're logged-only) — so you can include sensitive context in the message safely.

### All error classes

| Class | Code | When |
|---|---|---|
| `OutscoreError` | (parent) | Base — always check `instanceof OutscoreError` first if you only need to distinguish SDK errors from arbitrary throws. |
| `OutscoreAuthError` | `auth_failed` | 401/403 from the platform. Token wrong/revoked. |
| `OutscoreValidationError` | `missing_field` | 400-class — bad input. |
| `OutscoreNotFoundError` | `post_not_found` | 404 — the post doesn't exist on either side. |
| `OutscoreRateLimitError` | `rate_limited` | 429. Carries `retryAfterSec` when the response had a `Retry-After` header. |
| `OutscoreNetworkError` | `internal_error` | DNS / connect / TLS failure. Retriable. |
| `OutscoreTimeoutError` | `internal_error` | Per-attempt timeout exceeded. Retriable. |
| `OutscoreServerError` | `internal_error` | 5xx from the platform. Retriable. |

## Safe debug logging

`redact()` walks an object and replaces sensitive values (token, secret, password, pwd, passwd, authorization, api_key, private_key, bearer, cookie, webhook_token, signature) with `[REDACTED]`. `redactString()` does the same for free-form strings (Bearer tokens, query-string secrets, long opaque hex/base64 runs).

```ts
import { redact, redactString } from "@outscoreagent/custom-api";

logger.debug("webhook payload", redact(payload));
logger.error(redactString(err.stack));
```

`redact()` is cycle-safe (handles `obj.self = obj`), capped at depth 8, and never mutates the input. `redactString()`'s "long opaque" heuristic over-redacts UUIDs and long request IDs; this is intentional for SIEM-bound logs but worth knowing.

## Configuration reference

### `createOutscoreExpressHandler` / `outscoreFastifyPlugin` / `createNextRouteHandlers` / `createCoreHandler`

| Field | Type | Default | Notes |
|---|---|---|---|
| `token` | `string` | (required) | Min 32 chars. Generated by the dashboard. |
| `store.findByExternalId` | `(id: string) => string \| number \| null \| Promise<…>` | (required) | Returns your internal post id, or null. |
| `store.createPost` | `(article) => ArticleResponse \| Promise<…>` | (required) | Persist + return your internal id + canonical URL. |
| `store.updatePost` | `(postId, article) => ArticleResponse \| Promise<…>` | (required) | Throw `OutscoreNotFoundError` to return 404. |
| `app.name` | `string` | (required) | Shown in the dashboard's connection-test confirmation. |
| `app.url` | `string` | (required) | Canonical public origin. |
| `app.categories` | `Array<{id,name,slug}>` | `undefined` | Optional. Surfaced as the dashboard's category picker. |
| `indexNowKey` | `string \| null` | `null` | When set, served at `GET /<key>.txt`. |
| `onIndexNowKey` | `(key: string) => void \| Promise<void>` | `undefined` | Persist the platform-pushed key here. |
| `rateLimitPerMinute` | `number` | `30` | Per-token ceiling. The SDK adds a separate anonymous bucket at `4×` this for unauthenticated traffic. Set to `0` to disable both. |
| `logger` | `OutscoreLogger` | `undefined` | `{ debug?, info?, warn?, error? }`. |

### `sendOutscoreWebhook`

| Field | Type | Default | Notes |
|---|---|---|---|
| `callbackUrl` | `string` | (required) | HTTPS only (HTTP allowed for `localhost`). |
| `callbackToken` | `string` | (required) | Bearer token from the dashboard. |
| `event` | `WebhookEventName` | (required) | One of: `post_published`, `post_updated`, `post_trashed`, `post_status_changed`. |
| `external_id` | `string` | (required) | The OutscoreAgent article UUID. |
| `external_post_id` | `string \| number` | (required) | Your internal post id. |
| `post_url` | `string` | `undefined` | Public URL where the post is now reachable. |
| `post_status` | `string` | `undefined` | One of `draft`, `publish`, `pending`, `trash`. |
| `edit_url` | `string` | `undefined` | Optional admin-side edit URL. |
| `timestamp` | `string` (ISO-8601) | `new Date().toISOString()` | Stable across retries (idempotency key). |
| `retry.delaysMs` | `number[]` | `[0, 5000, 30000, 120000]` | Length = max attempts. First entry is the pre-attempt delay. |
| `retry.timeoutMs` | `number` | `15000` | Per-attempt timeout. |
| `signingSecret` | `string` | `undefined` | When set, adds `X-Outscore-Signature: sha256=<hex>` over the body. |
| `headers` | `Record<string,string>` | `undefined` | Extra headers merged into every attempt. |
| `fetchImpl` | `typeof fetch` | `globalThis.fetch` | Custom fetch implementation. |
| `logger` | `OutscoreLogger` | `undefined` | Same shape as the handler logger. |

## Security notes

- `crypto.timingSafeEqual` for token comparison — no string-equality timing leaks.
- IndexNow key route only matches `GET /<key>.txt` exactly. We deliberately do **not** register a query-var-based route, since that would leak a brute-force oracle on every front-end page.
- Pre-auth anonymous rate-limit bucket fires **before** token comparison — bounds brute-force attempts.
- HMAC body signature is opt-in; format mirrors GitHub / Stripe (`sha256=<hex>`) so we can rotate algorithms without breaking receivers.
- Rate limit is in-memory per process. If you run multiple replicas, front the SDK with a real rate limiter (nginx, an API gateway, or a distributed limiter) and pass `rateLimitPerMinute: 0`.
- Errors thrown from your `store.createPost` / `store.updatePost` callbacks are logged but **never** echoed in HTTP response bodies — safe to include sensitive context in messages.
- The shared secret never leaves your environment — the SDK does not phone home.
- DNS rebinding on the platform side is the only realistic SSRF vector against the platform; the SDK itself has no outbound calls except `sendOutscoreWebhook` (HTTPS-required).

## Packaging

- Dual ESM + CJS build via `package.json` `exports` map. `import` resolves to `dist/esm/`, `require` to `dist/cjs/`.
- TypeScript declarations ship next to the CJS output and apply to both consumers.
- No runtime dependencies. `express` and `fastify` are optional peer deps — only loaded if you import the matching adapter.
- Node 18+ (relies on global `fetch`).

## Versioning

Semver. Breaking changes to the public API surface (exports from `index.ts`) bump major; new features bump minor; bug fixes bump patch.

## Contributing

Issues and PRs welcome. Please:

1. Open an issue first for non-trivial changes.
2. Run `npm test` and `npm run lint` before submitting.
3. New public surface needs documentation here and a test.

## Roadmap

- PHP / Python reference ports
- TypeScript types published as a standalone package for non-Node integrators

## License

MIT — see [LICENSE](LICENSE).
