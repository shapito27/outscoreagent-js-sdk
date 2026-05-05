import { createCoreHandler, IncomingRequest } from "./handler";
import { HandlerConfig } from "./types";

/**
 * Next.js App Router adapter — works with any catch-all route handler.
 *
 * In `app/api/outscoreagent/[...path]/route.ts`:
 *
 *     import { createNextRouteHandlers } from "@outscoreagent/custom-api/nextjs";
 *     export const { GET, POST, PUT } = createNextRouteHandlers({ ... });
 *
 * The adapter reads the path from `params.path` (the catch-all segment),
 * normalizes headers, awaits `request.json()` for POST/PUT, and returns a
 * standard `Response`. No Next-specific imports needed at compile time.
 */
type NextRouteContext = { params: Promise<{ path?: string[] }> | { path?: string[] } };

export function createNextRouteHandlers(config: HandlerConfig) {
  const handle = createCoreHandler(config);

  async function dispatch(method: string, req: Request, ctx: NextRouteContext) {
    const params = await Promise.resolve(ctx.params);
    const segments = params.path ?? [];
    const path = segments.join("/");
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    let body: unknown;
    if (method === "POST" || method === "PUT") {
      try {
        const text = await req.text();
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
      }
    }
    const incoming: IncomingRequest = { method, path, headers, body };
    const out = await handle(incoming);
    if (out.headers["Content-Type"]?.startsWith("text/plain")) {
      return new Response(String(out.body), {
        status: out.status,
        headers: out.headers,
      });
    }
    return new Response(JSON.stringify(out.body), {
      status: out.status,
      headers: out.headers,
    });
  }

  return {
    GET: (req: Request, ctx: NextRouteContext) => dispatch("GET", req, ctx),
    POST: (req: Request, ctx: NextRouteContext) => dispatch("POST", req, ctx),
    PUT: (req: Request, ctx: NextRouteContext) => dispatch("PUT", req, ctx),
  };
}
