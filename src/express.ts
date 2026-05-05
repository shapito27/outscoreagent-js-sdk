import type { RequestHandler, Router } from "express";
import { createCoreHandler, IncomingRequest } from "./handler";
import { HandlerConfig } from "./types";

/**
 * Build an Express middleware that handles every OutscoreAgent route.
 *
 * Mount it at any path you choose:
 *
 *     import express from "express";
 *     import { createOutscoreExpressHandler } from "@outscoreagent/custom-api";
 *
 *     const app = express();
 *     app.use(express.json({ limit: "1mb" })); // required for POST/PUT bodies
 *     app.use("/outscoreagent", createOutscoreExpressHandler({ ... }));
 *
 * The middleware reads the request path RELATIVE to the mount point (uses
 * `req.path`, which is already stripped of the mount prefix), so the same
 * config works regardless of where it's mounted.
 */
export function createOutscoreExpressHandler(config: HandlerConfig): RequestHandler {
  const handle = createCoreHandler(config);

  return async function outscoreExpressHandler(req, res, next) {
    try {
      const incoming: IncomingRequest = {
        method: req.method,
        path: req.path,
        headers: lowerCaseHeaders(req.headers),
        body: req.body,
      };
      const out = await handle(incoming);
      res.status(out.status);
      for (const [k, v] of Object.entries(out.headers)) {
        res.setHeader(k, v);
      }
      // text/plain → send raw string; JSON → send JSON-encoded
      if (out.headers["Content-Type"]?.startsWith("text/plain")) {
        res.send(String(out.body));
      } else {
        res.json(out.body);
      }
    } catch (err) {
      next(err);
    }
  };
}

/** @deprecated use `createOutscoreExpressHandler` directly. Kept as a router alias. */
export function createOutscoreExpressRouter(
  config: HandlerConfig,
  // Lazily required so express stays an optional peer dependency.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expressLib: any,
): Router {
  const router: Router = expressLib.Router();
  router.use(createOutscoreExpressHandler(config));
  return router;
}

function lowerCaseHeaders(
  h: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(h)) {
    out[k.toLowerCase()] = v;
  }
  return out;
}
