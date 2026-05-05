import { createCoreHandler } from "../src/handler";
import { ArticlePayload, ArticleResponse, HandlerConfig } from "../src/types";
import {
  OutscoreNotFoundError,
  OutscoreValidationError,
  OutscoreAuthError,
  OutscoreRateLimitError,
} from "../src/errors";

function buildConfig(overrides: Partial<HandlerConfig> = {}): HandlerConfig {
  const articles = new Map<string, string>();
  let nextId = 1;

  return {
    token: "tok_abcdef0123456789abcdef0123456789ab",
    app: { name: "Test App", url: "https://test.example.com" },
    store: {
      findByExternalId: (id) => articles.get(id) ?? null,
      createPost: (a: ArticlePayload): ArticleResponse => {
        const internal = String(nextId++);
        articles.set(a.external_id, internal);
        return {
          success: true,
          external_post_id: internal,
          post_url: `https://test.example.com/p/${internal}`,
          post_status: a.post_status ?? "publish",
        };
      },
      updatePost: (postId, a: ArticlePayload): ArticleResponse => ({
        success: true,
        external_post_id: String(postId),
        post_url: `https://test.example.com/p/${postId}`,
        post_status: a.post_status ?? "publish",
      }),
    },
    rateLimitPerMinute: 0,
    ...overrides,
  };
}

const tokenHeader = (t: string) => ({ "x-outscoreagent-token": t });

describe("createCoreHandler", () => {
  it("rejects under-length tokens at construction", () => {
    expect(() =>
      createCoreHandler({
        token: "too-short-but-only-30-chars-aa",
        app: { name: "x", url: "https://x" },
        store: { findByExternalId: () => null, createPost: () => ({} as any), updatePost: () => ({} as any) },
      }),
    ).toThrow(/at least 32 characters/);
  });

  it("serves /status without auth", async () => {
    const handle = createCoreHandler(buildConfig());
    const res = await handle({ method: "GET", path: "status", headers: {} });
    expect(res.status).toBe(200);
    expect((res.body as any).success).toBe(true);
    expect((res.body as any).app_name).toBe("Test App");
  });

  it("rejects /test without a token", async () => {
    const handle = createCoreHandler(buildConfig());
    const res = await handle({ method: "POST", path: "test", headers: {}, body: {} });
    expect(res.status).toBe(401);
  });

  it("rejects /test with the wrong token", async () => {
    const handle = createCoreHandler(buildConfig());
    const res = await handle({
      method: "POST",
      path: "test",
      headers: tokenHeader("wrong-token-1234"),
      body: {},
    });
    expect(res.status).toBe(401);
  });

  it("accepts /test with the correct token via Authorization Bearer too", async () => {
    const handle = createCoreHandler(buildConfig());
    const res = await handle({
      method: "POST",
      path: "test",
      headers: { authorization: "Bearer tok_abcdef0123456789abcdef0123456789ab" },
      body: {},
    });
    expect(res.status).toBe(200);
  });

  it("creates a new article", async () => {
    const handle = createCoreHandler(buildConfig());
    const res = await handle({
      method: "POST",
      path: "articles",
      headers: tokenHeader("tok_abcdef0123456789abcdef0123456789ab"),
      body: {
        external_id: "uuid-1",
        title: "Hello",
        content: "<p>Hi</p>",
      },
    });
    expect(res.status).toBe(201);
    expect((res.body as any).success).toBe(true);
    expect((res.body as any).external_post_id).toBe("1");
  });

  it("returns 409 when external_id already exists", async () => {
    const cfg = buildConfig();
    const handle = createCoreHandler(cfg);
    const body = { external_id: "uuid-2", title: "T", content: "<p>X</p>" };
    await handle({
      method: "POST",
      path: "articles",
      headers: tokenHeader("tok_abcdef0123456789abcdef0123456789ab"),
      body,
    });
    const dup = await handle({
      method: "POST",
      path: "articles",
      headers: tokenHeader("tok_abcdef0123456789abcdef0123456789ab"),
      body,
    });
    expect(dup.status).toBe(409);
    expect((dup.body as any).code).toBe("duplicate_external_id");
  });

  it("validates required fields", async () => {
    const handle = createCoreHandler(buildConfig());
    const res = await handle({
      method: "POST",
      path: "articles",
      headers: tokenHeader("tok_abcdef0123456789abcdef0123456789ab"),
      body: { external_id: "u", title: "" },
    });
    expect(res.status).toBe(400);
    expect((res.body as any).code).toBe("missing_field");
  });

  it("updates an existing article via PUT /articles/:id", async () => {
    const handle = createCoreHandler(buildConfig());
    const res = await handle({
      method: "PUT",
      path: "articles/42",
      headers: tokenHeader("tok_abcdef0123456789abcdef0123456789ab"),
      body: {
        external_id: "uuid-3",
        title: "Updated",
        content: "<p>Updated</p>",
      },
    });
    expect(res.status).toBe(200);
    expect((res.body as any).external_post_id).toBe("42");
  });

  it("serves the IndexNow key file", async () => {
    const key = "abcdef1234567890abcdef1234567890";
    const handle = createCoreHandler(buildConfig({ indexNowKey: key }));
    const res = await handle({
      method: "GET",
      path: `${key}.txt`,
      headers: {},
    });
    expect(res.status).toBe(200);
    expect(res.headers["Content-Type"]).toMatch(/text\/plain/);
    expect(res.body).toBe(key);
  });

  it("persists pushed IndexNow keys", async () => {
    const onIndexNowKey = jest.fn();
    const handle = createCoreHandler(buildConfig({ onIndexNowKey }));
    const key = "abcdef1234567890abcdef1234567890";
    const res = await handle({
      method: "POST",
      path: "indexnow-key",
      headers: tokenHeader("tok_abcdef0123456789abcdef0123456789ab"),
      body: { key },
    });
    expect(res.status).toBe(200);
    expect(onIndexNowKey).toHaveBeenCalledWith(key);
  });

  it("rejects malformed IndexNow keys", async () => {
    const handle = createCoreHandler(buildConfig());
    const res = await handle({
      method: "POST",
      path: "indexnow-key",
      headers: tokenHeader("tok_abcdef0123456789abcdef0123456789ab"),
      body: { key: "not-hex!" },
    });
    expect(res.status).toBe(400);
  });

  it("enforces rate limits", async () => {
    const handle = createCoreHandler(buildConfig({ rateLimitPerMinute: 2 }));
    const headers = tokenHeader("tok_abcdef0123456789abcdef0123456789ab");
    await handle({ method: "POST", path: "test", headers, body: {} });
    await handle({ method: "POST", path: "test", headers, body: {} });
    const limited = await handle({ method: "POST", path: "test", headers, body: {} });
    expect(limited.status).toBe(429);
  });

  // The mapStoreError contract: receivers can throw typed SDK errors from
  // their store callbacks and the handler maps each one to the right HTTP
  // status. Without this mapping, every thrown error becomes a 500 and the
  // platform retries forever on what should be a 404 / 400.
  describe("mapStoreError — typed errors thrown from store callbacks", () => {
    function buildHandler(throwInCreate: () => Error) {
      return createCoreHandler(
        buildConfig({
          store: {
            findByExternalId: () => null,
            createPost: () => {
              throw throwInCreate();
            },
            updatePost: (postId, a): ArticleResponse => ({
              success: true,
              external_post_id: String(postId),
              post_url: `https://x/${postId}`,
              post_status: a.post_status ?? "publish",
            }),
          },
        }),
      );
    }

    const create = (handle: any) =>
      handle({
        method: "POST",
        path: "articles",
        headers: tokenHeader("tok_abcdef0123456789abcdef0123456789ab"),
        body: { external_id: "u", title: "t", content: "<p>x</p>" },
      });

    it("OutscoreNotFoundError → 404", async () => {
      const r = await create(buildHandler(() => new OutscoreNotFoundError("gone")));
      expect(r.status).toBe(404);
      expect((r.body as any).code).toBe("post_not_found");
    });

    it("OutscoreValidationError → 400", async () => {
      const r = await create(
        buildHandler(() => new OutscoreValidationError("bad slug")),
      );
      expect(r.status).toBe(400);
      expect((r.body as any).message).toBe("bad slug");
    });

    it("OutscoreAuthError → 401", async () => {
      const r = await create(buildHandler(() => new OutscoreAuthError("nope")));
      expect(r.status).toBe(401);
    });

    it("OutscoreRateLimitError → 429", async () => {
      const r = await create(
        buildHandler(() => new OutscoreRateLimitError("slow down")),
      );
      expect(r.status).toBe(429);
    });

    it("plain Error with 'not found' in updatePost → 404 (legacy heuristic)", async () => {
      const handle = createCoreHandler(
        buildConfig({
          store: {
            findByExternalId: () => "1",
            createPost: () => ({} as any),
            updatePost: () => {
              throw new Error("post not found in db");
            },
          },
        }),
      );
      const r = await handle({
        method: "PUT",
        path: "articles/42",
        headers: tokenHeader("tok_abcdef0123456789abcdef0123456789ab"),
        body: { external_id: "u", title: "t", content: "<p>x</p>" },
      });
      expect(r.status).toBe(404);
    });

    it("plain Error → 500 (no leak of internals)", async () => {
      const r = await create(
        buildHandler(() => new Error("DB connection lost: pwd=hunter2")),
      );
      expect(r.status).toBe(500);
      // Generic message — actual internals stay in the logger only.
      expect((r.body as any).message).toBe("Failed to create post");
    });
  });
});
