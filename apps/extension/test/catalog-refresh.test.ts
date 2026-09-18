import { describe, expect, it, vi } from "vitest";
import {
  refreshPortableCatalog,
  type CatalogFetchResponse,
  type CatalogRefreshDeps,
} from "../src/catalog/catalogRefresh";
import type { PortableCatalogSnapshot } from "../src/catalog/portableCatalog";

const ORIGIN = "https://catalog.example.com";
const CATALOG_URL = "https://catalog.example.com/v1/portable-catalog.json";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function baselineFixture(): PortableCatalogSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-01T00:00:00.000Z",
    markets: [
      {
        code: "us",
        name: "United States",
        storefrontPath: "",
        variants: [{ sku: "MG464LL/A", title: "iPhone 17 256GB Black" }],
        stores: [],
      },
    ],
  };
}

function newerFixture(): PortableCatalogSnapshot {
  const base = baselineFixture();
  return {
    ...base,
    generatedAt: "2026-09-09T00:00:00.000Z",
    markets: [
      {
        ...base.markets[0]!,
        variants: [
          ...base.markets[0]!.variants,
          { sku: "MG494LL/A", title: "iPhone 17 256GB Lavender" },
        ],
      },
    ],
  };
}

function byteStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function textResponse(
  text: string,
  overrides: Partial<CatalogFetchResponse> = {},
): CatalogFetchResponse {
  const bytes = new TextEncoder().encode(text);
  return {
    url: CATALOG_URL,
    redirected: false,
    httpStatus: 200,
    contentLength: bytes.byteLength,
    body: byteStream([bytes]),
    ...overrides,
  };
}

interface Harness {
  deps: CatalogRefreshDeps;
  fetchCalls: string[];
  savedSnapshots: PortableCatalogSnapshot[];
}

function makeHarness(
  response: CatalogFetchResponse | Error,
  options: {
    stored?: unknown;
    bundledFallback?: unknown;
    sha256Hex?: CatalogRefreshDeps["sha256Hex"];
  } = {},
): Harness {
  const fetchCalls: string[] = [];
  const savedSnapshots: PortableCatalogSnapshot[] = [];
  const deps: CatalogRefreshDeps = {
    fetchPort: {
      fetchCatalog: async (url: string) => {
        fetchCalls.push(url);
        if (response instanceof Error) throw response;
        return response;
      },
    },
    storagePort: {
      loadLastGood: async () => options.stored ?? null,
      saveLastGood: async (snapshot: PortableCatalogSnapshot) => {
        savedSnapshots.push(snapshot);
      },
    },
    sha256Hex: options.sha256Hex ?? (async () => HASH_A),
    bundledFallback: options.bundledFallback ?? baselineFixture(),
  };
  return { deps, fetchCalls, savedSnapshots };
}

const ENABLED = {
  remoteUpdatesEnabled: true,
  trustedOrigin: ORIGIN,
  catalogUrl: CATALOG_URL,
  timeoutMs: 1000,
};

describe("catalog refresh: disabled by default", () => {
  it("performs no network access and keeps the validated bundled fallback", async () => {
    const harness = makeHarness(new Error("network must stay untouched"));
    const result = await refreshPortableCatalog(harness.deps, {
      remoteUpdatesEnabled: false,
      trustedOrigin: "",
      catalogUrl: "",
    });
    expect(result.status).toBe("disabled");
    expect(harness.fetchCalls).toEqual([]);
    if (result.status !== "disabled") return;
    expect(result.catalog.generatedAt).toBe("2026-09-01T00:00:00.000Z");
  });

  it("does not return a corrupt stored catalog and reports absent valid state", async () => {
    const corrupt = {
      schemaVersion: 1,
      generatedAt: "not-a-date",
      markets: [],
    };
    const fallback = makeHarness(new Error("offline"), { stored: corrupt });
    const fallbackResult = await refreshPortableCatalog(fallback.deps, {
      remoteUpdatesEnabled: false,
      trustedOrigin: "",
      catalogUrl: "",
    });
    expect(fallbackResult.status).toBe("disabled");
    if (fallbackResult.status !== "disabled") return;
    expect(fallbackResult.catalog).toEqual(baselineFixture());

    const corruptActive = await refreshPortableCatalog(
      fallback.deps,
      {
        remoteUpdatesEnabled: false,
        trustedOrigin: "",
        catalogUrl: "",
      },
      corrupt,
    );
    expect(corruptActive.status).toBe("disabled");
    if (corruptActive.status !== "disabled") return;
    expect(corruptActive.catalog).toEqual(baselineFixture());

    const futureStored = makeHarness(new Error("offline"), {
      stored: { ...baselineFixture(), generatedAt: "2099-01-01T00:00:00.000Z" },
    });
    const futureStoredResult = await refreshPortableCatalog(
      {
        ...futureStored.deps,
        nowMs: () => Date.parse("2026-09-09T00:00:00.000Z"),
      },
      {
        remoteUpdatesEnabled: false,
        trustedOrigin: "",
        catalogUrl: "",
      },
      undefined,
    );
    expect(futureStoredResult.status).toBe("disabled");
    if (futureStoredResult.status !== "disabled") return;
    expect(futureStoredResult.catalog).toEqual(baselineFixture());

    const unavailable = makeHarness(new Error("offline"), {
      stored: corrupt,
      bundledFallback: corrupt,
    });
    expect(
      (
        await refreshPortableCatalog(unavailable.deps, {
          remoteUpdatesEnabled: false,
          trustedOrigin: "",
          catalogUrl: "",
        })
      ).status,
    ).toBe("unavailable");
  });
});

describe("catalog refresh: origin and bounds guards", () => {
  it("rejects an untrusted URL without fetching", async () => {
    const harness = makeHarness(textResponse("{}"));
    const result = await refreshPortableCatalog(harness.deps, {
      ...ENABLED,
      catalogUrl: "https://evil.example.com/catalog.json",
    });
    expect(result.status).toBe("rejected");
    expect(harness.fetchCalls).toEqual([]);
  });

  it("rejects redirects and origin changes", async () => {
    const redirected = makeHarness(
      textResponse(JSON.stringify(newerFixture()), { redirected: true }),
    );
    expect(
      (await refreshPortableCatalog(redirected.deps, ENABLED)).status,
    ).toBe("rejected");

    const moved = makeHarness(
      textResponse(JSON.stringify(newerFixture()), {
        url: "https://evil.example.com/v1/portable-catalog.json",
      }),
    );
    expect((await refreshPortableCatalog(moved.deps, ENABLED)).status).toBe(
      "rejected",
    );
  });

  it("enforces streamed bytes even when Content-Length is missing or false", async () => {
    const huge = new Uint8Array(256);
    const stream = textResponse("{}", {
      contentLength: null,
      body: byteStream([huge]),
    });
    const harness = makeHarness(stream);
    const result = await refreshPortableCatalog(harness.deps, {
      ...ENABLED,
      maxBytes: 128,
    });
    expect(result.status).toBe("rejected");
    expect(harness.savedSnapshots).toEqual([]);
  });

  it("rejects invalid or unbounded runtime configuration", async () => {
    const harness = makeHarness(textResponse("{}"));
    expect(
      (
        await refreshPortableCatalog(harness.deps, {
          ...ENABLED,
          maxBytes: Infinity,
        })
      ).status,
    ).toBe("rejected");
    expect(
      (
        await refreshPortableCatalog(makeHarness(textResponse("{}")).deps, {
          ...ENABLED,
          timeoutMs: 30_001,
        })
      ).status,
    ).toBe("rejected");
  });

  it("returns after timeout when a stream read never settles", async () => {
    vi.useFakeTimers();
    try {
      const never = new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
      });
      const harness = makeHarness(
        textResponse("{}", { contentLength: null, body: never }),
      );
      const pending = refreshPortableCatalog(harness.deps, ENABLED);
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await pending;
      expect(result.status).toBe("failed");
      if (result.status !== "failed") return;
      expect(result.catalog).toEqual(baselineFixture());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("catalog refresh: failure retention", () => {
  it("keeps a validated baseline on transport and schema failures", async () => {
    const offline = makeHarness(new Error("offline"));
    expect((await refreshPortableCatalog(offline.deps, ENABLED)).status).toBe(
      "failed",
    );

    const invalid = makeHarness(
      textResponse(JSON.stringify({ schemaVersion: 1 })),
    );
    expect((await refreshPortableCatalog(invalid.deps, ENABLED)).status).toBe(
      "rejected",
    );
  });

  it("rejects rollbacks and unsupported versions monotonically", async () => {
    const older = {
      ...newerFixture(),
      generatedAt: "2026-08-01T00:00:00.000Z",
    };
    const rollback = makeHarness(textResponse(JSON.stringify(older)));
    const rollbackResult = await refreshPortableCatalog(
      rollback.deps,
      ENABLED,
      newerFixture(),
    );
    expect(rollbackResult.status).toBe("rejected");
    if (rollbackResult.status !== "rejected") return;
    expect(rollbackResult.catalog.generatedAt).toBe("2026-09-09T00:00:00.000Z");

    const future = { ...newerFixture(), schemaVersion: 99 };
    const versioned = makeHarness(textResponse(JSON.stringify(future)));
    expect((await refreshPortableCatalog(versioned.deps, ENABLED)).status).toBe(
      "rejected",
    );
  });

  it("rejects a remote catalog too far ahead of the trusted clock", async () => {
    const future = makeHarness(
      textResponse(
        JSON.stringify({
          ...newerFixture(),
          generatedAt: "2099-01-01T00:00:00.000Z",
        }),
      ),
    );
    const result = await refreshPortableCatalog(
      { ...future.deps, nowMs: () => Date.parse("2026-09-09T00:00:00.000Z") },
      ENABLED,
    );
    expect(result.status).toBe("rejected");
  });

  it("catches malformed and throwing hash implementations", async () => {
    const body = JSON.stringify(newerFixture());
    const malformed = makeHarness(textResponse(body), {
      sha256Hex: async () => "not-a-hash",
    });
    expect((await refreshPortableCatalog(malformed.deps, ENABLED)).status).toBe(
      "failed",
    );
    const throwing = makeHarness(textResponse(body), {
      sha256Hex: async () => {
        throw new Error("crypto unavailable");
      },
    });
    expect((await refreshPortableCatalog(throwing.deps, ENABLED)).status).toBe(
      "failed",
    );
  });
});

describe("catalog refresh: success path", () => {
  it("enforces a well-formed pinned hash", async () => {
    const body = JSON.stringify(newerFixture());
    const mismatched = makeHarness(textResponse(body));
    expect(
      (
        await refreshPortableCatalog(mismatched.deps, {
          ...ENABLED,
          expectedSha256: HASH_B,
        })
      ).status,
    ).toBe("rejected");
    const matched = makeHarness(textResponse(body));
    expect(
      (
        await refreshPortableCatalog(matched.deps, {
          ...ENABLED,
          expectedSha256: HASH_A,
        })
      ).status,
    ).toBe("updated");
  });

  it("stores a newer catalog and reports current without mutation", async () => {
    const harness = makeHarness(textResponse(JSON.stringify(newerFixture())));
    const updated = await refreshPortableCatalog(harness.deps, ENABLED);
    expect(updated.status).toBe("updated");
    if (updated.status !== "updated") return;
    expect(updated.previousGeneratedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(harness.savedSnapshots).toHaveLength(1);

    const frozen = Object.freeze(baselineFixture());
    const same = makeHarness(textResponse(JSON.stringify(frozen)));
    const current = await refreshPortableCatalog(same.deps, ENABLED, frozen);
    expect(current.status).toBe("current");
    expect(frozen.markets).toHaveLength(1);
  });
});
