/**
 * Minimal Fastify integration. The store is the same shape as the Express
 * example — it's the only piece you need to swap for your DB.
 */

import Fastify from "fastify";
import {
  outscoreFastifyPlugin,
  ArticlePayload,
  ArticleResponse,
} from "@outscoreagent/custom-api";

const articles = new Map<string, ArticlePayload & { internalId: string }>();
let nextId = 1;
const APP_URL = process.env.APP_URL ?? "http://localhost:3000";

const app = Fastify({ logger: true });

app.register(
  outscoreFastifyPlugin({
    token: requireEnv("OUTSCORE_TOKEN"),
    app: { name: "Demo Site", url: APP_URL },
    store: {
      findByExternalId: (externalId) =>
        articles.get(externalId)?.internalId ?? null,
      createPost: (article): ArticleResponse => {
        const internalId = String(nextId++);
        articles.set(article.external_id, { ...article, internalId });
        return {
          success: true,
          external_post_id: internalId,
          post_url: `${APP_URL}/posts/${article.slug ?? internalId}`,
          post_status: article.post_status ?? "publish",
        };
      },
      updatePost: (externalPostId, article): ArticleResponse => {
        const existing = articles.get(article.external_id);
        if (!existing) throw new Error("post not found");
        articles.set(article.external_id, { ...article, internalId: existing.internalId });
        return {
          success: true,
          external_post_id: String(externalPostId),
          post_url: `${APP_URL}/posts/${article.slug ?? existing.internalId}`,
          post_status: article.post_status ?? "publish",
        };
      },
    },
  }),
  { prefix: "/outscoreagent" },
);

app.listen({ port: Number(process.env.PORT ?? 3000) });

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}
