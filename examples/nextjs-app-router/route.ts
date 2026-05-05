/**
 * Next.js App Router example.
 *
 * Drop this file at `app/api/outscoreagent/[...path]/route.ts` and wire your
 * own `store` callbacks (Prisma / Drizzle / Mongoose / etc.).
 *
 * The `[...path]` catch-all segment is what makes this work — the SDK
 * matches the remainder of the path internally.
 */

import {
  createNextRouteHandlers,
  ArticleResponse,
} from "@outscoreagent/custom-api";

const APP_URL = process.env.APP_URL ?? "https://example.com";

export const { GET, POST, PUT } = createNextRouteHandlers({
  token: process.env.OUTSCORE_TOKEN!,
  app: { name: "My Next.js Site", url: APP_URL },
  store: {
    findByExternalId: async (externalId) => {
      // const row = await db.posts.findUnique({ where: { externalId } });
      // return row?.id ?? null;
      return null;
    },
    createPost: async (article): Promise<ArticleResponse> => {
      // const row = await db.posts.create({ data: { ...article, externalId: article.external_id } });
      return {
        success: true,
        external_post_id: "todo-replace-me",
        post_url: `${APP_URL}/posts/${article.slug}`,
        post_status: article.post_status ?? "publish",
      };
    },
    updatePost: async (externalPostId, article): Promise<ArticleResponse> => {
      // await db.posts.update({ where: { id: String(externalPostId) }, data: { ...article } });
      return {
        success: true,
        external_post_id: String(externalPostId),
        post_url: `${APP_URL}/posts/${article.slug}`,
        post_status: article.post_status ?? "publish",
      };
    },
  },
});
