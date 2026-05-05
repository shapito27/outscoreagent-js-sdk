/**
 * Minimal Express integration — receives OutscoreAgent articles into an
 * in-memory store. Replace the store with a real DB call (Postgres, Mongo,
 * Prisma, etc.) — the SDK is intentionally agnostic about persistence.
 *
 * Run:
 *   OUTSCORE_TOKEN=...  npm run dev
 */

import express from "express";
import {
  createOutscoreExpressHandler,
  ArticlePayload,
  ArticleResponse,
} from "@outscoreagent/custom-api";

const app = express();
app.use(express.json({ limit: "1mb" }));

// Toy in-memory store. external_id → record.
const articles = new Map<
  string,
  ArticlePayload & { internalId: string; postUrl: string }
>();

let nextId = 1;
const APP_URL = process.env.APP_URL ?? "http://localhost:3000";

app.use(
  "/outscoreagent",
  createOutscoreExpressHandler({
    token: requireEnv("OUTSCORE_TOKEN"),
    app: { name: "Demo Site", url: APP_URL },
    indexNowKey: process.env.INDEXNOW_KEY ?? null,
    onIndexNowKey: async (key) => {
      // Persist this somewhere durable — your SDK call to the dashboard
      // verifies it via GET /<key>.txt before accepting submissions.
      console.log("Received IndexNow key:", key);
    },
    store: {
      findByExternalId: (externalId) =>
        articles.get(externalId)?.internalId ?? null,

      createPost: (article): ArticleResponse => {
        const internalId = String(nextId++);
        const slug = article.slug ?? slugify(article.title);
        const postUrl = `${APP_URL}/posts/${slug}`;
        articles.set(article.external_id, { ...article, internalId, postUrl });
        return {
          success: true,
          external_post_id: internalId,
          post_url: postUrl,
          post_status: article.post_status ?? "publish",
        };
      },

      updatePost: (externalPostId, article): ArticleResponse => {
        const existing = articles.get(article.external_id);
        if (!existing || existing.internalId !== String(externalPostId)) {
          throw new Error("post not found");
        }
        const slug = article.slug ?? slugify(article.title);
        const postUrl = `${APP_URL}/posts/${slug}`;
        articles.set(article.external_id, { ...article, internalId: existing.internalId, postUrl });
        return {
          success: true,
          external_post_id: existing.internalId,
          post_url: postUrl,
          post_status: article.post_status ?? "publish",
        };
      },
    },
  }),
);

app.get("/posts/:slug", (req, res) => {
  const found = [...articles.values()].find((a) =>
    (a.slug ?? slugify(a.title)) === req.params.slug,
  );
  if (!found) return res.status(404).send("Not found");
  res.send(`<h1>${found.title}</h1>${found.content}`);
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Listening on ${port}`));

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}
