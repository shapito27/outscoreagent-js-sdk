/**
 * @outscoreagent/custom-api
 *
 * Reference SDK for receiving published articles from the OutscoreAgent
 * platform on any Node.js backend. CMS-agnostic — bring your own storage.
 */

export * from "./types";
export {
  createCoreHandler,
  type IncomingRequest,
  type OutgoingResponse,
} from "./handler";
export { createOutscoreExpressHandler, createOutscoreExpressRouter } from "./express";
export { outscoreFastifyPlugin } from "./fastify";
export { createNextRouteHandlers } from "./nextjs";
export {
  sendOutscoreWebhook,
  type SendWebhookOptions,
  type RetryPolicy,
} from "./sync";
export { extractToken, safeCompareToken } from "./auth";
export {
  OutscoreError,
  OutscoreAuthError,
  OutscoreValidationError,
  OutscoreNotFoundError,
  OutscoreRateLimitError,
  OutscoreNetworkError,
  OutscoreTimeoutError,
  OutscoreServerError,
} from "./errors";
export { redact, redactString, type RedactOptions } from "./redact";
