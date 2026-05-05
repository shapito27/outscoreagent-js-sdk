import { createCoreHandler, IncomingRequest } from "./handler";
import { HandlerConfig } from "./types";

/**
 * Fastify plugin factory. Usage:
 *
 *     import Fastify from "fastify";
 *     import { outscoreFastifyPlugin } from "@outscoreagent/custom-api";
 *
 *     const app = Fastify();
 *     app.register(outscoreFastifyPlugin({ ... }), { prefix: "/outscoreagent" });
 *
 * The plugin attaches a single catch-all handler under the registered prefix —
 * routing logic lives in the SDK core, not in Fastify's router. This keeps the
 * SDK's contract identical across frameworks.
 */
// We don't import fastify types directly so the package can be installed
// without fastify in the dep tree.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FastifyInstance = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FastifyPluginAsync = (instance: FastifyInstance, opts: unknown) => Promise<void>;

export function outscoreFastifyPlugin(config: HandlerConfig): FastifyPluginAsync {
  const handle = createCoreHandler(config);

  return async function plugin(fastify: FastifyInstance) {
    // Register one wildcard route per method. Fastify validates the `*` param
    // up-front so we never have to parse the URL ourselves.
    const wildcard = "/*";
    for (const method of ["GET", "POST", "PUT"] as const) {
      fastify.route({
        method,
        url: wildcard,
        handler: async (req: any, reply: any) => {
          const path = ((req.params as { "*"?: string })["*"] ?? "").toString();
          const incoming: IncomingRequest = {
            method,
            path,
            headers: req.headers,
            body: req.body,
          };
          const out = await handle(incoming);
          reply.status(out.status);
          for (const [k, v] of Object.entries(out.headers)) {
            reply.header(k, v);
          }
          if (out.headers["Content-Type"]?.startsWith("text/plain")) {
            return String(out.body);
          }
          return out.body;
        },
      });
    }
  };
}
