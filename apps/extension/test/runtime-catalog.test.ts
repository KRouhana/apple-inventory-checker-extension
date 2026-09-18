import { describe, expect, it, vi } from "vitest";

import type { ExtensionPlatform } from "../src/platform/adapters.js";
import {
  bindTrustedStoreLookup,
  LocalRuntimeCatalog,
} from "../src/runtime/catalog.js";

function catalogJson(withStore = false): string {
  return JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2026-09-09T12:00:00.000Z",
    markets: [
      {
        code: "ca",
        name: "Canada",
        storefrontPath: "/ca",
        variants: [
          {
            sku: "TEST4VC/A",
            title: "iPhone Test",
            familySlug: "iphone-test",
          },
        ],
        stores: withStore
          ? [
              {
                storeNumber: "R001",
                name: "Apple Test",
                city: "Toronto",
                region: "ON",
                pollLocation: "qualified-catalog-location",
              },
            ]
          : [],
      },
    ],
  });
}

function catalogBody(withStore = false): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(catalogJson(withStore));
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe("runtime catalog and lookup boundary", () => {
  const discoveredStore = {
    storeNumber: "R777",
    name: "Apple Discovery",
    city: "Toronto",
    region: "ON",
    pollLocation: "M5V 2T6",
  };

  it("loads a validated packaged catalog but never invents a store from transient location input", async () => {
    const catalog = new LocalRuntimeCatalog({
      platform: { storage: {} } as never,
      assetUrl: "chrome-extension://test/portable-catalog.json",
      fetch: async (url) => ({
        ok: true,
        status: 200,
        url,
        redirected: false,
        headers: { get: () => null },
        body: catalogBody(),
      }),
    });
    await expect(catalog.loadBundled()).resolves.toMatchObject({
      markets: [{ code: "ca", stores: [] }],
    });
    await expect(
      catalog.lookupStores({ market: "ca", userPostalInput: "M5V 2T6" }),
    ).resolves.toEqual({ kind: "unsupported" });
    expect(catalog.storeLookupAvailable()).toBe(false);
  });

  it("preserves successful zero matches while projecting only canonical catalog stores", async () => {
    const lookup = vi.fn(async () => ({
      kind: "matches" as const,
      stores: [],
    }));
    const catalog = new LocalRuntimeCatalog({
      platform: { storage: {} } as never,
      assetUrl: "chrome-extension://test/portable-catalog.json",
      fetch: async (url) => ({
        ok: true,
        status: 200,
        url,
        redirected: false,
        headers: { get: () => null },
        body: catalogBody(true),
      }),
      storeLookup: { lookup },
    });
    await catalog.loadBundled();
    await expect(
      catalog.lookupStores({ market: "ca", userPostalInput: "M5V 2T6" }),
    ).resolves.toEqual({ kind: "matches", stores: [] });
    expect(lookup).toHaveBeenCalledWith(
      { market: "ca", userPostalInput: "M5V 2T6" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("accepts new stores only from the trusted provider and commits cache before catalog success", async () => {
    let cache: unknown = null;
    const write = vi.fn(async (_key: string, value: unknown) => {
      cache = value;
    });
    const platform = {
      storage: {
        read: async <T>(_key: string): Promise<T | null> => cache as T | null,
        write,
        remove: async (_key: string): Promise<void> => undefined,
      },
    } satisfies Pick<ExtensionPlatform, "storage">;
    const catalog = new LocalRuntimeCatalog({
      platform,
      assetUrl: "chrome-extension://test/portable-catalog.json",
      fetch: async (url) => ({
        ok: true,
        status: 200,
        url,
        redirected: false,
        headers: { get: () => null },
        body: catalogBody(),
      }),
      storeLookup: bindTrustedStoreLookup({
        lookup: async () => ({ kind: "matches", stores: [discoveredStore] }),
      }),
    });
    await catalog.loadBundled();
    await expect(
      catalog.lookupStores({ market: "ca", userPostalInput: "M5V 2T6" }),
    ).resolves.toEqual({ kind: "matches", stores: [discoveredStore] });
    expect(write).toHaveBeenCalledOnce();
    expect(catalog.getCatalog()?.markets[0]?.stores).toEqual([discoveredStore]);

    const restarted = new LocalRuntimeCatalog({
      platform,
      assetUrl: "chrome-extension://test/portable-catalog.json",
      fetch: async (url) => ({
        ok: true,
        status: 200,
        url,
        redirected: false,
        headers: { get: () => null },
        body: catalogBody(),
      }),
    });
    await restarted.loadBundled();
    expect(restarted.getCatalog()?.markets[0]?.stores).toEqual([
      discoveredStore,
    ]);
  });

  it("does not let an untrusted port register stores and rolls back memory on a cache write failure", async () => {
    const untrusted = new LocalRuntimeCatalog({
      platform: { storage: {} } as never,
      assetUrl: "chrome-extension://test/portable-catalog.json",
      fetch: async (url) => ({
        ok: true,
        status: 200,
        url,
        redirected: false,
        headers: { get: () => null },
        body: catalogBody(),
      }),
      storeLookup: {
        lookup: async () => ({ kind: "matches", stores: [discoveredStore] }),
      },
    });
    await untrusted.loadBundled();
    await expect(
      untrusted.lookupStores({ market: "ca", userPostalInput: "M5V 2T6" }),
    ).resolves.toEqual({ kind: "unsupported" });
    expect(untrusted.getCatalog()?.markets[0]?.stores).toEqual([]);

    const writeFailure = new LocalRuntimeCatalog({
      platform: {
        storage: {
          read: async () => null,
          write: async () => {
            throw new Error("cache unavailable");
          },
        },
      } as never,
      assetUrl: "chrome-extension://test/portable-catalog.json",
      fetch: async (url) => ({
        ok: true,
        status: 200,
        url,
        redirected: false,
        headers: { get: () => null },
        body: catalogBody(),
      }),
      storeLookup: bindTrustedStoreLookup({
        lookup: async () => ({ kind: "matches", stores: [discoveredStore] }),
      }),
    });
    await writeFailure.loadBundled();
    await expect(
      writeFailure.lookupStores({ market: "ca", userPostalInput: "M5V 2T6" }),
    ).resolves.toEqual({ kind: "unknown", reason: "storage_error" });
    expect(writeFailure.getCatalog()?.markets[0]?.stores).toEqual([]);
  });

  it("rejects provider additions beyond the public 500-store market cap without evicting cached stores", async () => {
    const cachedStores = Array.from({ length: 500 }, (_, index) => ({
      ...discoveredStore,
      storeNumber: `R${index}`,
      name: `Apple Discovery ${index}`,
    }));
    const write = vi.fn(async () => undefined);
    const catalog = new LocalRuntimeCatalog({
      platform: {
        storage: {
          read: async () => ({
            version: 1,
            markets: { ca: cachedStores },
          }),
          write,
        },
      } as never,
      assetUrl: "chrome-extension://test/portable-catalog.json",
      fetch: async (url) => ({
        ok: true,
        status: 200,
        url,
        redirected: false,
        headers: { get: () => null },
        body: catalogBody(),
      }),
      storeLookup: bindTrustedStoreLookup({
        lookup: async () => ({ kind: "matches", stores: [discoveredStore] }),
      }),
    });
    await catalog.loadBundled();
    await expect(
      catalog.lookupStores({ market: "ca", userPostalInput: "M5V 2T6" }),
    ).resolves.toEqual({ kind: "unknown", reason: "invalid_response" });
    expect(write).not.toHaveBeenCalled();
    expect(catalog.getCatalog()?.markets[0]?.stores).toHaveLength(500);
  });

  it("does not publish a trusted discovery when its serialized cache write exceeds the lookup deadline", async () => {
    const catalog = new LocalRuntimeCatalog({
      platform: {
        storage: {
          read: async () => null,
          write: async () => new Promise<void>(() => undefined),
        },
      } as never,
      assetUrl: "chrome-extension://test/portable-catalog.json",
      lookupTimeoutMs: 10,
      fetch: async (url) => ({
        ok: true,
        status: 200,
        url,
        redirected: false,
        headers: { get: () => null },
        body: catalogBody(),
      }),
      storeLookup: bindTrustedStoreLookup({
        lookup: async () => ({ kind: "matches", stores: [discoveredStore] }),
      }),
    });
    await catalog.loadBundled();
    await expect(
      catalog.lookupStores({ market: "ca", userPostalInput: "M5V 2T6" }),
    ).resolves.toEqual({ kind: "unknown", reason: "timeout" });
    expect(catalog.getCatalog()?.markets[0]?.stores).toEqual([]);
  });

  it("keeps a timed-out physical write ahead of later cache writes until it settles", async () => {
    let resolveFirstWrite: (() => void) | undefined;
    let lookupCount = 0;
    let activeWrites = 0;
    let maximumConcurrentWrites = 0;
    const writes: string[] = [];
    const storeA = { ...discoveredStore, storeNumber: "R701" };
    const storeB = { ...discoveredStore, storeNumber: "R702" };
    const catalog = new LocalRuntimeCatalog({
      platform: {
        storage: {
          read: async () => null,
          write: async (_key: string, value: unknown) => {
            const storeNumber = (
              value as { markets: { ca: { storeNumber: string }[] } }
            ).markets.ca[0]!.storeNumber;
            writes.push(storeNumber);
            activeWrites += 1;
            maximumConcurrentWrites = Math.max(
              maximumConcurrentWrites,
              activeWrites,
            );
            if (writes.length === 1) {
              await new Promise<void>((resolve) => {
                resolveFirstWrite = () => {
                  activeWrites -= 1;
                  resolve();
                };
              });
              return;
            }
            activeWrites -= 1;
          },
        },
      } as never,
      assetUrl: "chrome-extension://test/portable-catalog.json",
      lookupTimeoutMs: 10,
      fetch: async (url) => ({
        ok: true,
        status: 200,
        url,
        redirected: false,
        headers: { get: () => null },
        body: catalogBody(),
      }),
      storeLookup: bindTrustedStoreLookup({
        lookup: async () => ({
          kind: "matches",
          stores: [lookupCount++ === 0 ? storeA : storeB],
        }),
      }),
    });
    await catalog.loadBundled();
    await expect(
      catalog.lookupStores({ market: "ca", userPostalInput: "M5V 2T6" }),
    ).resolves.toEqual({ kind: "unknown", reason: "timeout" });
    const second = catalog.lookupStores({
      market: "ca",
      userPostalInput: "M5V 2T6",
    });
    expect(writes).toEqual(["R701"]);
    resolveFirstWrite?.();
    await expect(second).resolves.toEqual({
      kind: "matches",
      stores: [storeB],
    });
    expect(writes).toEqual(["R701", "R702"]);
    expect(maximumConcurrentWrites).toBe(1);
  });

  it("recovers after a synchronous cache-write throw instead of wedging later discoveries", async () => {
    let attempts = 0;
    const catalog = new LocalRuntimeCatalog({
      platform: {
        storage: {
          read: async () => null,
          write: () => {
            attempts += 1;
            if (attempts === 1) throw new Error("storage unavailable");
            return Promise.resolve();
          },
        },
      } as never,
      assetUrl: "chrome-extension://test/portable-catalog.json",
      fetch: async (url) => ({
        ok: true,
        status: 200,
        url,
        redirected: false,
        headers: { get: () => null },
        body: catalogBody(),
      }),
      storeLookup: bindTrustedStoreLookup({
        lookup: async () => ({ kind: "matches", stores: [discoveredStore] }),
      }),
    });
    await catalog.loadBundled();
    await expect(
      catalog.lookupStores({ market: "ca", userPostalInput: "M5V 2T6" }),
    ).resolves.toEqual({ kind: "unknown", reason: "storage_error" });
    await expect(
      catalog.lookupStores({ market: "ca", userPostalInput: "M5V 2T6" }),
    ).resolves.toEqual({ kind: "matches", stores: [discoveredStore] });
    expect(attempts).toBe(2);
  });

  it("serializes successful discoveries so the later persisted cache contains both stores", async () => {
    let lookupCount = 0;
    const writeSnapshots: string[][] = [];
    const storeA = { ...discoveredStore, storeNumber: "R701" };
    const storeB = { ...discoveredStore, storeNumber: "R702" };
    const catalog = new LocalRuntimeCatalog({
      platform: {
        storage: {
          read: async () => null,
          write: async (_key: string, value: unknown) => {
            writeSnapshots.push(
              (
                value as { markets: { ca: { storeNumber: string }[] } }
              ).markets.ca.map((store) => store.storeNumber),
            );
          },
        },
      } as never,
      assetUrl: "chrome-extension://test/portable-catalog.json",
      fetch: async (url) => ({
        ok: true,
        status: 200,
        url,
        redirected: false,
        headers: { get: () => null },
        body: catalogBody(),
      }),
      storeLookup: bindTrustedStoreLookup({
        lookup: async () => ({
          kind: "matches",
          stores: [lookupCount++ === 0 ? storeA : storeB],
        }),
      }),
    });
    await catalog.loadBundled();
    await expect(
      Promise.all([
        catalog.lookupStores({ market: "ca", userPostalInput: "M5V 2T6" }),
        catalog.lookupStores({ market: "ca", userPostalInput: "M5V 2T6" }),
      ]),
    ).resolves.toEqual([
      { kind: "matches", stores: [storeA] },
      { kind: "matches", stores: [storeB] },
    ]);
    expect(writeSnapshots).toEqual([["R701"], ["R701", "R702"]]);
    expect(catalog.getCatalog()?.markets[0]?.stores).toEqual([storeA, storeB]);
  });

  it("retains explicit provider unknown and throttled outcomes without provider text", async () => {
    for (const result of [
      { kind: "unknown" },
      { kind: "throttled" },
    ] as const) {
      const catalog = new LocalRuntimeCatalog({
        platform: { storage: {} } as never,
        assetUrl: "chrome-extension://test/portable-catalog.json",
        fetch: async (url) => ({
          ok: true,
          status: 200,
          url,
          redirected: false,
          headers: { get: () => null },
          body: catalogBody(true),
        }),
        storeLookup: { lookup: async () => result },
      });
      await catalog.loadBundled();
      await expect(
        catalog.lookupStores({ market: "ca", userPostalInput: "M5V 2T6" }),
      ).resolves.toEqual(result);
    }
  });

  it("fails closed to unknown for malformed lookup output, foreign stores, and a deadline", async () => {
    const cases = [
      { kind: "matches", stores: [{ storeNumber: "R999" }] },
      { kind: "matches", stores: ["not-a-store"] },
      { kind: "provider_error", diagnostic: "location M5V 2T6" },
    ];
    for (const result of cases) {
      const catalog = new LocalRuntimeCatalog({
        platform: { storage: {} } as never,
        assetUrl: "chrome-extension://test/portable-catalog.json",
        fetch: async (url) => ({
          ok: true,
          status: 200,
          url,
          redirected: false,
          headers: { get: () => null },
          body: catalogBody(true),
        }),
        storeLookup: { lookup: async () => result as never },
      });
      await catalog.loadBundled();
      await expect(
        catalog.lookupStores({ market: "ca", userPostalInput: "M5V 2T6" }),
      ).resolves.toEqual({ kind: "unknown", reason: "invalid_response" });
    }

    let signal: AbortSignal | undefined;
    const timed = new LocalRuntimeCatalog({
      platform: { storage: {} } as never,
      assetUrl: "chrome-extension://test/portable-catalog.json",
      lookupTimeoutMs: 10,
      fetch: async (url) => ({
        ok: true,
        status: 200,
        url,
        redirected: false,
        headers: { get: () => null },
        body: catalogBody(true),
      }),
      storeLookup: {
        lookup: async (_input, options) => {
          signal = options.signal;
          return new Promise(() => undefined);
        },
      },
    });
    await timed.loadBundled();
    await expect(
      timed.lookupStores({ market: "ca", userPostalInput: "M5V 2T6" }),
    ).resolves.toEqual({ kind: "unknown", reason: "timeout" });
    expect(signal?.aborted).toBe(true);
  });

  it("does not let a synchronous abort callback turn a timed out lookup into empty matches", async () => {
    const timed = new LocalRuntimeCatalog({
      platform: { storage: {} } as never,
      assetUrl: "chrome-extension://test/portable-catalog.json",
      lookupTimeoutMs: 10,
      fetch: async (url) => ({
        ok: true,
        status: 200,
        url,
        redirected: false,
        headers: { get: () => null },
        body: catalogBody(true),
      }),
      storeLookup: {
        lookup: async (_input, options) =>
          new Promise((resolve) => {
            options.signal.addEventListener(
              "abort",
              () => resolve({ kind: "matches", stores: [] }),
              { once: true },
            );
          }),
      },
    });
    await timed.loadBundled();
    await expect(
      timed.lookupStores({ market: "ca", userPostalInput: "M5V 2T6" }),
    ).resolves.toEqual({ kind: "unknown", reason: "timeout" });
  });

  it("rejects redirected or non-canonical packaged catalog assets", async () => {
    const catalog = new LocalRuntimeCatalog({
      platform: { storage: {} } as never,
      assetUrl: "chrome-extension://test/portable-catalog.json",
      fetch: async () => ({
        ok: true,
        status: 200,
        url: "chrome-extension://test/other.json",
        redirected: true,
        headers: { get: () => null },
        body: catalogBody(),
      }),
    });
    await expect(catalog.loadBundled()).resolves.toBeNull();
    expect(catalog.getCatalog()).toBeNull();
  });

  it("times out a fetch that ignores abort and fails closed", async () => {
    const catalog = new LocalRuntimeCatalog({
      platform: { storage: {} } as never,
      assetUrl: "chrome-extension://test/portable-catalog.json",
      bootstrapTimeoutMs: 10,
      fetch: () => new Promise(() => undefined),
    });
    await expect(catalog.loadBundled()).resolves.toBeNull();
    expect(catalog.getCatalog()).toBeNull();
  });

  it("times out a body read that ignores abort and fails closed", async () => {
    const catalog = new LocalRuntimeCatalog({
      platform: { storage: {} } as never,
      assetUrl: "chrome-extension://test/portable-catalog.json",
      bootstrapTimeoutMs: 10,
      fetch: async (url) => ({
        ok: true,
        status: 200,
        url,
        redirected: false,
        headers: { get: () => null },
        body: new ReadableStream({
          pull: () => new Promise(() => undefined),
        }),
      }),
    });
    await expect(catalog.loadBundled()).resolves.toBeNull();
    expect(catalog.getCatalog()).toBeNull();
  });

  it("uses one total body deadline instead of extending it for each chunk", async () => {
    let pulls = 0;
    const catalog = new LocalRuntimeCatalog({
      platform: { storage: {} } as never,
      assetUrl: "chrome-extension://test/portable-catalog.json",
      bootstrapTimeoutMs: 15,
      fetch: async (url) => ({
        ok: true,
        status: 200,
        url,
        redirected: false,
        headers: { get: () => null },
        body: new ReadableStream({
          async pull(controller) {
            pulls += 1;
            if (pulls === 1) {
              controller.enqueue(new TextEncoder().encode("{"));
              return;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 60));
          },
        }),
      }),
    });
    await expect(catalog.loadBundled()).resolves.toBeNull();
    expect(pulls).toBeGreaterThanOrEqual(2);
  });

  it("keeps abort listener registration bounded for many tiny body chunks", async () => {
    let abortListeners = 0;
    const controller = new AbortController();
    const addEventListener = controller.signal.addEventListener.bind(
      controller.signal,
    );
    Object.defineProperty(controller.signal, "addEventListener", {
      configurable: true,
      value: (...args: Parameters<AbortSignal["addEventListener"]>) => {
        if (args[0] === "abort") abortListeners += 1;
        return addEventListener(...args);
      },
    });
    const bytes = new TextEncoder().encode(catalogJson());
    let index = 0;
    const catalog = new LocalRuntimeCatalog({
      platform: { storage: {} } as never,
      assetUrl: "chrome-extension://test/portable-catalog.json",
      createAbortController: () => controller,
      fetch: async (url) => ({
        ok: true,
        status: 200,
        url,
        redirected: false,
        headers: { get: () => null },
        body: new ReadableStream({
          pull(streamController) {
            if (index < bytes.length) {
              streamController.enqueue(bytes.subarray(index, index + 1));
              index += 1;
              return;
            }
            streamController.close();
          },
        }),
      }),
    });
    await expect(catalog.loadBundled()).resolves.toMatchObject({
      markets: [{ code: "ca", stores: [] }],
    });
    // One listener protects fetch and one protects the complete body, never
    // one per byte-sized chunk.
    expect(abortListeners).toBe(2);
  });
});
