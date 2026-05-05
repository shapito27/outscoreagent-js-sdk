import * as crypto from "crypto";
import { sendOutscoreWebhook } from "../src/sync";
import {
  OutscoreAuthError,
  OutscoreNetworkError,
  OutscoreRateLimitError,
  OutscoreServerError,
  OutscoreTimeoutError,
  OutscoreValidationError,
} from "../src/errors";

function fakeFetch(
  responses: Array<{ status: number; body?: string; headers?: Record<string, string> }>,
) {
  let i = 0;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(r.body ?? "", {
      status: r.status,
      headers: r.headers,
    });
  }) as unknown as typeof fetch;
  return Object.assign(fn, { calls });
}

const baseOpts = {
  callbackUrl: "https://api.outscoreagent.com/api/webhooks/custom-api/abc",
  callbackToken: "callback-token-1234567890",
  event: "post_published" as const,
  external_id: "uuid-1",
  external_post_id: "42",
  timestamp: "2026-05-04T10:00:00Z",
  // Skip the real backoff in tests.
  sleep: jest.fn().mockResolvedValue(undefined),
};

describe("sendOutscoreWebhook", () => {
  it("succeeds on the first 2xx response", async () => {
    const f = fakeFetch([{ status: 200 }]);
    await expect(
      sendOutscoreWebhook({ ...baseOpts, fetchImpl: f }),
    ).resolves.toBeUndefined();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].init.headers).toMatchObject({
      Authorization: "Bearer callback-token-1234567890",
      "Content-Type": "application/json",
    });
  });

  it("throws OutscoreAuthError on 401 (no retry)", async () => {
    const f = fakeFetch([{ status: 401 }, { status: 200 }]);
    await expect(
      sendOutscoreWebhook({ ...baseOpts, fetchImpl: f }),
    ).rejects.toBeInstanceOf(OutscoreAuthError);
    // No retry on auth failures — fetch called exactly once.
    expect(f.calls).toHaveLength(1);
  });

  it("retries on 503 then succeeds", async () => {
    const f = fakeFetch([{ status: 503 }, { status: 200 }]);
    await expect(
      sendOutscoreWebhook({ ...baseOpts, fetchImpl: f }),
    ).resolves.toBeUndefined();
    expect(f.calls).toHaveLength(2);
  });

  it("throws OutscoreServerError when retries exhausted", async () => {
    const f = fakeFetch([
      { status: 502 },
      { status: 502 },
      { status: 502 },
    ]);
    const err = await sendOutscoreWebhook({
      ...baseOpts,
      retry: { delaysMs: [0, 0, 0] },
      fetchImpl: f,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(OutscoreServerError);
    expect((err as OutscoreServerError).httpStatus).toBe(502);
    expect(f.calls).toHaveLength(3);
  });

  it("throws OutscoreRateLimitError with retryAfterSec on terminal 429", async () => {
    const f = fakeFetch([
      { status: 429, headers: { "retry-after": "30" } },
    ]);
    const err = await sendOutscoreWebhook({
      ...baseOpts,
      retry: { delaysMs: [0] },
      fetchImpl: f,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(OutscoreRateLimitError);
    expect((err as OutscoreRateLimitError).retryAfterSec).toBe(30);
  });

  it("wraps AbortError as OutscoreTimeoutError", async () => {
    const f = (async () => {
      const e: any = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }) as unknown as typeof fetch;
    await expect(
      sendOutscoreWebhook({
        ...baseOpts,
        retry: { delaysMs: [0] },
        fetchImpl: f,
      }),
    ).rejects.toBeInstanceOf(OutscoreTimeoutError);
  });

  it("wraps generic fetch errors as OutscoreNetworkError", async () => {
    const f = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(
      sendOutscoreWebhook({
        ...baseOpts,
        retry: { delaysMs: [0] },
        fetchImpl: f,
      }),
    ).rejects.toBeInstanceOf(OutscoreNetworkError);
  });

  it("rejects http:// callback URLs (production safety)", async () => {
    await expect(
      sendOutscoreWebhook({ ...baseOpts, callbackUrl: "http://api.example.com/" }),
    ).rejects.toBeInstanceOf(OutscoreValidationError);
  });

  it("allows http://localhost for local dev", async () => {
    const f = fakeFetch([{ status: 200 }]);
    await expect(
      sendOutscoreWebhook({
        ...baseOpts,
        callbackUrl: "http://localhost:4000/webhooks/x",
        fetchImpl: f,
      }),
    ).resolves.toBeUndefined();
  });

  it("merges custom headers and adds X-Outscore-Signature when signingSecret is set", async () => {
    const f = fakeFetch([{ status: 200 }]);
    await sendOutscoreWebhook({
      ...baseOpts,
      headers: { "X-Tenant": "acme" },
      signingSecret: "secret-123",
      fetchImpl: f,
    });

    const headers = f.calls[0].init.headers as Record<string, string>;
    expect(headers["X-Tenant"]).toBe("acme");

    // Signature should be sha256=<hex> over the JSON body.
    const body = String(f.calls[0].init.body);
    const expected =
      "sha256=" + crypto.createHmac("sha256", "secret-123").update(body).digest("hex");
    expect(headers["X-Outscore-Signature"]).toBe(expected);
  });

  it("respects custom retry policy delaysMs", async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const f = fakeFetch([{ status: 503 }, { status: 200 }]);
    await sendOutscoreWebhook({
      ...baseOpts,
      retry: { delaysMs: [0, 1234] },
      sleep,
      fetchImpl: f,
    });
    // The first attempt skips the `delay > 0 ? sleep : skip` guard (no
    // sleep call). The second attempt waits 1234ms before firing — proving
    // the configured delay is honored over the default of 5s.
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1234);
  });
});
