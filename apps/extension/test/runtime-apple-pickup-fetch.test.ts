import { describe, expect, it } from "vitest";

import { createApplePickupFetchPort } from "../src/runtime/apple-pickup-fetch.js";

function bodyFrom(value: unknown): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function bodyBytes(value: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

const request = {
  market: "ca" as const,
  anchorStoreNumber: "R123",
  location: "qualified-public-anchor",
  skus: ["TEST4VC/A"],
};

describe("browser Apple pickup transport", () => {
  it("uses an exact credential-omitting Apple endpoint by default and returns parsed bounded JSON", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const diagnostics: unknown[] = [];
    const fetchPickup = createApplePickupFetchPort({
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      fetch: async (url, init) => {
        calls.push({ url, init });
        return {
          status: 200,
          url,
          redirected: false,
          headers: { get: () => null },
          body: bodyFrom({ body: { stores: [] } }),
        };
      },
    });

    await expect(fetchPickup.fetchPickup(request)).resolves.toEqual({
      httpStatus: 200,
      body: { body: { stores: [] } },
    });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(
      "https://www.apple.com/ca/shop/retail/pickup-message?fae=true&pl=true&mts.0=regular&parts.0=TEST4VC%2FA&location=qualified-public-anchor",
    );
    expect(call.init).toMatchObject({
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect(diagnostics).toEqual([
      {
        phase: "json_parsed",
        byteCount: new TextEncoder().encode(
          JSON.stringify({ body: { stores: [] } }),
        ).byteLength,
        httpStatus: 200,
      },
    ]);
  });

  it("defaults to omit and accepts only the explicit browser-managed credential mode", async () => {
    const observed: RequestCredentials[] = [];
    for (const credentials of [undefined, "include", "same-origin"] as const) {
      const port = createApplePickupFetchPort({
        ...(credentials === undefined
          ? {}
          : { credentials: credentials as never }),
        fetch: async (url, init) => {
          observed.push(init.credentials!);
          return {
            status: 200,
            url,
            redirected: false,
            headers: { get: () => null },
            body: bodyFrom({ body: { stores: [] } }),
          };
        },
      });
      await port.fetchPickup(request);
    }
    expect(observed).toEqual(["omit", "include", "omit"]);
  });

  it("treats redirects, wrong final URLs, non-JSON, and oversized responses as parser-neutral", async () => {
    const redirected = createApplePickupFetchPort({
      fetch: async (url) => ({
        status: 200,
        url,
        redirected: true,
        headers: { get: () => null },
        body: bodyFrom({ body: { stores: [] } }),
      }),
    });
    await expect(redirected.fetchPickup(request)).resolves.toEqual({
      httpStatus: 200,
      body: null,
    });

    const oversized = createApplePickupFetchPort({
      maxBodyBytes: 8,
      fetch: async (url) => ({
        status: 200,
        url,
        redirected: false,
        headers: { get: () => null },
        body: bodyFrom({ body: { stores: [] } }),
      }),
    });
    await expect(oversized.fetchPickup(request)).resolves.toEqual({
      httpStatus: 200,
      body: null,
    });
  });

  it("maps a bounded Retry-After hint without surfacing raw headers", async () => {
    const fetchPickup = createApplePickupFetchPort({
      fetch: async (url) => ({
        status: 429,
        url,
        redirected: false,
        headers: { get: (name) => (name === "retry-after" ? "30" : null) },
        body: null,
      }),
    });
    await expect(fetchPickup.fetchPickup(request)).resolves.toEqual({
      httpStatus: 429,
      body: null,
      retryAfterMs: 30_000,
    });
  });

  it("reports bounded body phases without changing parser-neutral fetch behavior", async () => {
    const diagnostics: unknown[] = [];
    const fetchPickup = createApplePickupFetchPort({
      maxBodyBytes: 8,
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
        throw new Error("diagnostic callbacks are observational only");
      },
      fetch: async (url) => ({
        status: 200,
        url,
        redirected: false,
        headers: { get: () => null },
        body: bodyFrom({ body: { stores: [] } }),
      }),
    });
    await expect(fetchPickup.fetchPickup(request)).resolves.toEqual({
      httpStatus: 200,
      body: null,
    });
    expect(diagnostics).toEqual([
      {
        phase: "body_too_large",
        byteCount: new TextEncoder().encode(
          JSON.stringify({ body: { stores: [] } }),
        ).byteLength,
        httpStatus: 200,
      },
    ]);
  });

  it("emits only allowlisted phase/status/byte diagnostics for parser-neutral branches", async () => {
    const cases: Array<{
      phase: string;
      request?: unknown;
      fetch?: (url: string) => Promise<unknown>;
    }> = [
      { phase: "request_invalid", request: { market: "nope" } },
      {
        phase: "network_failure",
        fetch: async () => {
          throw new Error("hidden");
        },
      },
      {
        phase: "http_rejected",
        fetch: async (url) => ({
          status: 503,
          url,
          redirected: false,
          headers: { get: () => null },
          body: null,
        }),
      },
      {
        phase: "url_mismatch",
        fetch: async () => ({
          status: 200,
          url: "https://invalid.example/",
          redirected: false,
          headers: { get: () => null },
          body: null,
        }),
      },
      {
        phase: "content_length_rejected",
        fetch: async (url) => ({
          status: 200,
          url,
          redirected: false,
          headers: {
            get: (name: string) =>
              name === "content-length" ? "524289" : null,
          },
          body: null,
        }),
      },
      {
        phase: "body_missing",
        fetch: async (url) => ({
          status: 200,
          url,
          redirected: false,
          headers: { get: () => null },
          body: null,
        }),
      },
      {
        phase: "invalid_json",
        fetch: async (url) => ({
          status: 200,
          url,
          redirected: false,
          headers: { get: () => null },
          body: bodyBytes("not-json"),
        }),
      },
    ];
    for (const entry of cases) {
      const diagnostics: unknown[] = [];
      const port = createApplePickupFetchPort({
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        ...(entry.fetch ? { fetch: entry.fetch as never } : {}),
      });
      await port.fetchPickup((entry.request ?? request) as never);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ phase: entry.phase });
      expect(Object.keys(diagnostics[0] as object).sort()).toEqual([
        "byteCount",
        "httpStatus",
        "phase",
      ]);
    }
  });
});
