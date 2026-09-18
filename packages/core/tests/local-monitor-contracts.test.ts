import { describe, expect, it } from "vitest";

import {
  APPLE_STOREFRONT_PATHS,
  capHistoryEvents,
  coalescePollBatches,
  compareCatalogFreshness,
  createEmptySnapshot,
  extractPersistableWatchStores,
  HISTORY_RETENTION_DAYS,
  isAllowedCatalogUrl,
  LOCAL_STORAGE_SCHEMA_VERSION,
  MAX_PENDING_DELIVERY_EVENTS,
  MAX_DELIVERY_COOLDOWN_MS,
  parseLocalCatalogSnapshot,
  parseLocalDeliveryDispatchResult,
  parseLocalMonitorSnapshot,
  parseLocalWatch,
  reconcileWatchWithCatalog,
  resolveWatchPollLocation,
  toCloudMarketCode,
  toObservedStatusFromError,
  type LocalCatalogSnapshot,
  type LocalWatch,
  type WatchHistoryEvent,
} from "../src/index.js";
import { evaluateAvailabilityTransition } from "../src/index.js";

const CREATED = "2026-09-09T12:00:00.000Z";
const NOW_MS = Date.parse("2026-09-09T12:00:00.000Z");

function validWatch(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "watch-1",
    market: "us",
    skus: ["MG464LL/A"],
    storeNumbers: ["R123"],
    pollAnchor: {
      storeNumber: "R123",
    },
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

function expectValidWatch(input: Record<string, unknown>): LocalWatch {
  const result = parseLocalWatch(input);
  expect(result.success).toBe(true);
  if (!result.success) throw new Error("expected valid watch");
  return result.data;
}

function expectInvalidWatch(input: Record<string, unknown>): void {
  expect(parseLocalWatch(input).success).toBe(false);
}

function catalogFixture(): LocalCatalogSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-01T00:00:00.000Z",
    markets: [
      {
        code: "us",
        name: "United States",
        storefrontPath: "",
        variants: [{ sku: "MG464LL/A", title: "iPhone 17 256GB Black" }],
        stores: [
          {
            storeNumber: "R123",
            name: "Fifth Avenue",
            city: "New York",
            region: "NY",
            pollLocation: "Apple Fifth Avenue",
          },
        ],
      },
    ],
  };
}

describe("local watch configuration", () => {
  it("accepts a valid watch with defaults applied", () => {
    const watch = expectValidWatch(validWatch());
    expect(watch.pollIntervalSec).toBe(120);
    expect(watch.enabled).toBe(true);
    expect(watch.deliveryChannels).toEqual({
      desktop: true,
      personalTelegram: false,
      hostedRelay: false,
    });
  });

  it("rejects malformed SKUs, duplicates, and empty stores", () => {
    expectInvalidWatch(validWatch({ skus: ["not-a-sku"] }));
    expectInvalidWatch(validWatch({ skus: ["MG464LL/A", "MG464LL/A"] }));
    expectInvalidWatch(validWatch({ storeNumbers: [] }));
    expectInvalidWatch(validWatch({ market: "jp" }));
  });

  it("rejects poll intervals outside 120-3600 seconds", () => {
    expectInvalidWatch(validWatch({ pollIntervalSec: 30 }));
    expectInvalidWatch(validWatch({ pollIntervalSec: 60 }));
    expectInvalidWatch(validWatch({ pollIntervalSec: 119 }));
    expectValidWatch(validWatch({ pollIntervalSec: 120 }));
    expectValidWatch(validWatch({ pollIntervalSec: 121 }));
    expectValidWatch(validWatch({ pollIntervalSec: 3600 }));
    expectInvalidWatch(validWatch({ pollIntervalSec: 3601 }));
  });

  it("rejects SKU lists above the Apple batch limit", () => {
    const skus = Array.from({ length: 13 }, (_, i) => `MG${i}LL/A`);
    expectInvalidWatch(validWatch({ skus }));
  });
});

describe("privacy boundary: postal input never persists", () => {
  it("extracts only public store numbers from a transient lookup", () => {
    const result = extractPersistableWatchStores(
      { market: "us", userPostalInput: "10001" },
      ["R123"],
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.storeNumbers).toEqual(["R123"]);
    expect(JSON.stringify(result)).not.toContain("10001");
  });

  it("refuses to persist when no public store was chosen", () => {
    const result = extractPersistableWatchStores(
      { market: "us", userPostalInput: "10001" },
      [],
    );
    expect(result.success).toBe(false);
  });

  it("requires a selected public store's validated polling anchor", () => {
    expectInvalidWatch(
      validWatch({
        pollAnchor: {
          storeNumber: "R999",
        },
      }),
    );
    expectValidWatch(validWatch());
  });

  it("persists no free-text location or label on the watch", () => {
    // The persisted watch carries only public store references; any
    // caller-supplied location text or display label is rejected.
    expectInvalidWatch(validWatch({ label: "Home near 10001" }));
    expectInvalidWatch(
      validWatch({
        pollAnchor: { storeNumber: "R123", validatedLocation: "10001" },
      }),
    );
    const watch = expectValidWatch(validWatch());
    expect(JSON.stringify(watch)).not.toContain("10001");
  });

  it("resolves poll locations from the validated catalog at request time", () => {
    const watch = expectValidWatch(validWatch());
    expect(resolveWatchPollLocation(watch, catalogFixture())).toBe(
      "Apple Fifth Avenue",
    );
    expect(
      resolveWatchPollLocation(watch, {
        ...catalogFixture(),
        markets: [],
      }),
    ).toBe(null);
    expect(
      resolveWatchPollLocation(
        { market: "us", pollAnchor: { storeNumber: "R999" } },
        catalogFixture(),
      ),
    ).toBe(null);
  });
});

describe("request coalescing within one installation", () => {
  it("merges watches with the same market and catalog-resolved anchor", () => {
    const batches = coalescePollBatches(
      [
        {
          id: "a",
          market: "us",
          skus: ["MG464LL/A"],
          pollAnchor: { storeNumber: "R123" },
          enabled: true,
        },
        {
          id: "b",
          market: "us",
          skus: ["MG494LL/A", "MG464LL/A"],
          pollAnchor: { storeNumber: "R123" },
          enabled: true,
        },
      ],
      catalogFixture(),
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]?.skuChunks).toEqual([["MG464LL/A", "MG494LL/A"]]);
    expect(batches[0]?.watchIds).toEqual(["a", "b"]);
    expect(batches[0]?.storefrontPath).toBe(APPLE_STOREFRONT_PATHS.us);
    expect(batches[0]?.anchorStoreNumber).toBe("R123");
    expect(batches[0]?.location).toBe("Apple Fifth Avenue");
  });

  it("keeps markets and public store anchors separate", () => {
    const catalog: LocalCatalogSnapshot = {
      schemaVersion: 1,
      generatedAt: "2026-09-01T00:00:00.000Z",
      markets: [
        {
          code: "us",
          name: "United States",
          storefrontPath: "",
          variants: [
            { sku: "MG464LL/A", title: "iPhone 17 256GB Black" },
            { sku: "MG494LL/A", title: "iPhone 17 256GB White" },
          ],
          stores: [
            {
              storeNumber: "R123",
              name: "Fifth Avenue",
              city: "New York",
              region: "NY",
              pollLocation: "Apple Fifth Avenue",
            },
            {
              storeNumber: "R456",
              name: "SoHo",
              city: "New York",
              region: "NY",
              pollLocation: "Apple SoHo",
            },
          ],
        },
        {
          code: "ca",
          name: "Canada",
          storefrontPath: "/ca",
          variants: [{ sku: "MG464LL/A", title: "iPhone 17 256GB Black" }],
          stores: [
            {
              storeNumber: "R123",
              name: "Eaton Centre",
              city: "Toronto",
              region: "ON",
              pollLocation: "Apple Eaton Centre",
            },
          ],
        },
      ],
    };
    const batches = coalescePollBatches(
      [
        {
          id: "a",
          market: "us",
          skus: ["MG464LL/A"],
          pollAnchor: { storeNumber: "R123" },
          enabled: true,
        },
        {
          id: "b",
          market: "ca",
          skus: ["MG464LL/A"],
          pollAnchor: { storeNumber: "R123" },
          enabled: true,
        },
        {
          id: "c",
          market: "us",
          skus: ["MG494LL/A"],
          pollAnchor: { storeNumber: "R123" },
          enabled: false,
        },
        {
          id: "d",
          market: "us",
          skus: ["MG494LL/A"],
          pollAnchor: { storeNumber: "R456" },
          enabled: true,
        },
      ],
      catalog,
    );
    expect(batches).toHaveLength(3);
    expect(batches.find((batch) => batch.market === "us")?.watchIds).toEqual([
      "a",
    ]);
    expect(
      batches.find((batch) => batch.anchorStoreNumber === "R456")?.watchIds,
    ).toEqual(["d"]);
    expect(batches.find((batch) => batch.market === "ca")?.location).toBe(
      "Apple Eaton Centre",
    );
  });

  it("excludes watches whose anchor cannot be resolved in the catalog", () => {
    const batches = coalescePollBatches(
      [
        {
          id: "a",
          market: "us",
          skus: ["MG464LL/A"],
          pollAnchor: { storeNumber: "R123" },
          enabled: true,
        },
        {
          id: "ghost",
          market: "us",
          skus: ["MG464LL/A"],
          pollAnchor: { storeNumber: "R999" },
          enabled: true,
        },
      ],
      catalogFixture(),
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]?.watchIds).toEqual(["a"]);
  });
});

describe("catalog trust and reconciliation", () => {
  const current = {
    schemaVersion: 1 as const,
    generatedAt: "2026-09-01T00:00:00.000Z",
  };

  it("accepts newer catalogs, rejects rollbacks and versions", () => {
    expect(
      compareCatalogFreshness(current, {
        schemaVersion: 1,
        generatedAt: "2026-09-09T00:00:00.000Z",
      }),
    ).toEqual({ kind: "newer_available" });
    expect(
      compareCatalogFreshness(current, {
        schemaVersion: 1,
        generatedAt: "2026-09-01T00:00:00.000Z",
      }),
    ).toEqual({ kind: "current" });
    expect(
      compareCatalogFreshness(current, {
        schemaVersion: 1,
        generatedAt: "2026-08-01T00:00:00.000Z",
      }).kind,
    ).toBe("rollback_rejected");
    expect(
      compareCatalogFreshness(current, {
        schemaVersion: 99,
        generatedAt: "2026-10-01T00:00:00.000Z",
      }).kind,
    ).toBe("unsupported_version");
  });

  it("restricts remote fetches to the fixed HTTPS origin", () => {
    const origin = "https://catalog.example.com";
    expect(
      isAllowedCatalogUrl("https://catalog.example.com/v1/iphone.json", origin),
    ).toBe(true);
    expect(
      isAllowedCatalogUrl("http://catalog.example.com/v1/iphone.json", origin),
    ).toBe(false);
    expect(
      isAllowedCatalogUrl("https://evil.example.com/v1.json", origin),
    ).toBe(false);
  });

  it("reports retired SKUs/stores without deleting the watch", () => {
    const issues = reconcileWatchWithCatalog(
      {
        market: "us",
        skus: ["MG464LL/A", "ZZ999LL/A"],
        storeNumbers: ["R123", "R999"],
        pollAnchor: { storeNumber: "R123" },
      },
      catalogFixture(),
    );
    expect(issues.map((issue) => issue.kind).sort()).toEqual([
      "unknown_sku",
      "unknown_store",
    ]);
  });

  it("flags title drift for revalidation", () => {
    const issues = reconcileWatchWithCatalog(
      {
        market: "us",
        skus: ["MG464LL/A"],
        storeNumbers: ["R123"],
        pollAnchor: { storeNumber: "R123" },
      },
      catalogFixture(),
      { "MG464LL/A": "Something Else Entirely" },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe("title_mismatch");
  });

  it("reports a poll anchor outside the selected stores", () => {
    const issues = reconcileWatchWithCatalog(
      {
        market: "us",
        skus: ["MG464LL/A"],
        storeNumbers: ["R123"],
        pollAnchor: { storeNumber: "R999" },
      },
      catalogFixture(),
    );
    expect(
      issues.some(
        (issue) =>
          issue.kind === "unknown_store" && issue.storeNumber === "R999",
      ),
    ).toBe(true);
  });

  it("rejects catalog snapshots with wrong schema versions", () => {
    expect(
      parseLocalCatalogSnapshot({
        ...catalogFixture(),
        schemaVersion: 99,
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate market codes", () => {
    const fixture = catalogFixture();
    expect(
      parseLocalCatalogSnapshot({
        ...fixture,
        markets: [fixture.markets[0]!, fixture.markets[0]!],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate variant SKUs within a market", () => {
    const fixture = catalogFixture();
    const market = fixture.markets[0]!;
    expect(
      parseLocalCatalogSnapshot({
        ...fixture,
        markets: [
          {
            ...market,
            variants: [market.variants[0]!, market.variants[0]!],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate store IDs within a market", () => {
    const fixture = catalogFixture();
    const market = fixture.markets[0]!;
    expect(
      parseLocalCatalogSnapshot({
        ...fixture,
        markets: [
          {
            ...market,
            stores: [market.stores[0]!, market.stores[0]!],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("never silently first-matches ambiguous catalog data", () => {
    const fixture = catalogFixture();
    const market = fixture.markets[0]!;
    const ambiguousSkuCatalog: LocalCatalogSnapshot = {
      ...fixture,
      markets: [
        {
          ...market,
          variants: [
            market.variants[0]!,
            { ...market.variants[0]!, title: "Conflicting Title" },
          ],
        },
      ],
    };
    const skuIssues = reconcileWatchWithCatalog(
      {
        market: "us",
        skus: ["MG464LL/A"],
        storeNumbers: ["R123"],
        pollAnchor: { storeNumber: "R123" },
      },
      ambiguousSkuCatalog,
    );
    expect(skuIssues.some((issue) => issue.kind === "ambiguous_catalog")).toBe(
      true,
    );
    const ambiguousStoreCatalog: LocalCatalogSnapshot = {
      ...fixture,
      markets: [
        {
          ...market,
          stores: [
            market.stores[0]!,
            { ...market.stores[0]!, pollLocation: "Somewhere Else" },
          ],
        },
      ],
    };
    const storeIssues = reconcileWatchWithCatalog(
      {
        market: "us",
        skus: ["MG464LL/A"],
        storeNumbers: ["R123"],
        pollAnchor: { storeNumber: "R123" },
      },
      ambiguousStoreCatalog,
    );
    expect(
      storeIssues.some((issue) => issue.kind === "ambiguous_catalog"),
    ).toBe(true);
    expect(
      resolveWatchPollLocation(
        { market: "us", pollAnchor: { storeNumber: "R123" } },
        ambiguousStoreCatalog,
      ),
    ).toBe(null);
  });
});

describe("persisted snapshot and failure model", () => {
  it("parses only explicit, credential-free provider delivery outcomes", () => {
    expect(parseLocalDeliveryDispatchResult(undefined)).toBeNull();
    expect(parseLocalDeliveryDispatchResult({ kind: "delivered" })).toEqual({
      kind: "delivered",
    });
    expect(
      parseLocalDeliveryDispatchResult({
        kind: "retry_not_before",
        retryNotBefore: CREATED,
      }),
    ).toEqual({ kind: "retry_not_before", retryNotBefore: CREATED });
    expect(
      parseLocalDeliveryDispatchResult({
        kind: "retry_not_before",
        retryNotBefore: CREATED,
        providerError: "429 body must not persist",
      }),
    ).toBeNull();
  });

  it("creates and round-trips an empty versioned snapshot", () => {
    const empty = createEmptySnapshot();
    expect(empty.version).toBe(LOCAL_STORAGE_SCHEMA_VERSION);
    expect(parseLocalMonitorSnapshot(empty).success).toBe(true);
  });

  it("migrates legacy v1 snapshots with safe opt-in delivery defaults", () => {
    const legacy = {
      version: LOCAL_STORAGE_SCHEMA_VERSION,
      watches: [validWatch()],
      items: [],
      delivery: [],
      history: [],
    };
    const parsed = parseLocalMonitorSnapshot(legacy);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.watches[0]?.deliveryChannels).toEqual({
      desktop: true,
      personalTelegram: false,
      hostedRelay: false,
    });
    expect(parsed.data.pendingDelivery).toEqual([]);
    expect(parsed.data.runtime).toEqual({
      nextEligibleAt: null,
      consecutiveFetchFailures: 0,
    });
  });

  it("rejects unsafe durable delivery payloads and duplicate delivery work", () => {
    const watch = expectValidWatch(validWatch());
    const event = {
      watchId: watch.id,
      market: watch.market,
      sku: "MG464LL/A",
      title: "iPhone 17 256GB Black",
      storeNumber: "R123",
      storeName: "Fifth Avenue",
      observedAt: CREATED,
      purchaseUrl: "https://www.apple.com/shop/buy-iphone",
    };
    const pending = {
      eventId: "event-1",
      watchUpdatedAt: watch.updatedAt,
      event,
      createdAt: CREATED,
      channels: [
        {
          channel: "desktop",
          state: "pending",
          attempts: 0,
          nextAttemptAt: CREATED,
          lastAttemptAt: null,
          completedAt: null,
        },
      ],
    };
    const valid = {
      ...createEmptySnapshot(),
      watches: [watch],
      pendingDelivery: [pending],
    };
    expect(parseLocalMonitorSnapshot(valid).success).toBe(true);
    expect(
      parseLocalMonitorSnapshot({
        ...valid,
        pendingDelivery: [pending, pending],
      }).success,
    ).toBe(false);
    expect(
      parseLocalMonitorSnapshot({
        ...valid,
        pendingDelivery: [
          {
            ...pending,
            event: {
              ...event,
              purchaseUrl: "https://user:pass@www.apple.com/shop",
            },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      parseLocalMonitorSnapshot({
        ...valid,
        pendingDelivery: Array.from(
          { length: MAX_PENDING_DELIVERY_EVENTS + 1 },
          (_, index) => ({
            ...pending,
            eventId: `event-${index}`,
          }),
        ),
      }).success,
    ).toBe(false);
  });

  it("rejects snapshots with wrong versions or oversized lists", () => {
    expect(
      parseLocalMonitorSnapshot({
        ...createEmptySnapshot(),
        version: 99,
      }).success,
    ).toBe(false);
    const tooMany = Array.from({ length: 21 }, (_, i) =>
      validWatch({ id: `watch-${i}` }),
    );
    expect(
      parseLocalMonitorSnapshot({
        ...createEmptySnapshot(),
        watches: tooMany,
      }).success,
    ).toBe(false);
  });

  it("isolates persisted state by watch and validates every watch reference", () => {
    const firstWatch = expectValidWatch(validWatch());
    const secondWatch = expectValidWatch(
      validWatch({
        id: "watch-2",
      }),
    );
    const item = {
      watchId: "watch-1",
      market: "us",
      sku: "MG464LL/A",
      storeNumber: "R123",
      status: "available",
      lastKnownStatus: "available",
      lastChangedAt: CREATED,
      lastCheckedAt: CREATED,
      lastSuccessfulAt: CREATED,
      consecutiveUnknowns: 0,
    } as const;
    const snapshot = {
      ...createEmptySnapshot(),
      watches: [firstWatch, secondWatch],
      items: [item, { ...item, watchId: "watch-2" }],
    };
    expect(parseLocalMonitorSnapshot(snapshot).success).toBe(true);
    expect(
      parseLocalMonitorSnapshot({
        ...snapshot,
        items: [{ ...item, watchId: "missing-watch" }],
      }).success,
    ).toBe(false);
    expect(
      parseLocalMonitorSnapshot({
        ...snapshot,
        items: [{ ...item, market: "ca" }],
      }).success,
    ).toBe(false);
    expect(
      parseLocalMonitorSnapshot({
        ...snapshot,
        items: [item, item],
      }).success,
    ).toBe(false);
  });

  it("rejects known observations with mismatched lastKnownStatus", () => {
    const watch = expectValidWatch(validWatch());
    expect(
      parseLocalMonitorSnapshot({
        ...createEmptySnapshot(),
        watches: [watch],
        items: [
          {
            watchId: watch.id,
            market: watch.market,
            sku: "MG464LL/A",
            storeNumber: "R123",
            status: "available",
            lastKnownStatus: "unavailable",
            lastChangedAt: CREATED,
            lastCheckedAt: CREATED,
            lastSuccessfulAt: CREATED,
            consecutiveUnknowns: 0,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects known observations with null lastSuccessfulAt", () => {
    const watch = expectValidWatch(validWatch());
    for (const status of ["available", "unavailable", "ineligible"] as const) {
      expect(
        parseLocalMonitorSnapshot({
          ...createEmptySnapshot(),
          watches: [watch],
          items: [
            {
              watchId: watch.id,
              market: watch.market,
              sku: "MG464LL/A",
              storeNumber: "R123",
              status,
              lastKnownStatus: status,
              lastChangedAt: CREATED,
              lastCheckedAt: CREATED,
              lastSuccessfulAt: null,
              consecutiveUnknowns: 0,
            },
          ],
        }).success,
      ).toBe(false);
    }
  });

  it("accepts unknown observations preserving the prior known state", () => {
    const watch = expectValidWatch(validWatch());
    // Recovery case: an outage preserves the actual prior known status.
    expect(
      parseLocalMonitorSnapshot({
        ...createEmptySnapshot(),
        watches: [watch],
        items: [
          {
            watchId: watch.id,
            market: watch.market,
            sku: "MG464LL/A",
            storeNumber: "R123",
            status: "unknown",
            lastKnownStatus: "available",
            lastChangedAt: CREATED,
            lastCheckedAt: CREATED,
            lastSuccessfulAt: CREATED,
            consecutiveUnknowns: 3,
          },
        ],
      }).success,
    ).toBe(true);
    // Never-succeeded case: no prior known state exists yet.
    expect(
      parseLocalMonitorSnapshot({
        ...createEmptySnapshot(),
        watches: [watch],
        items: [
          {
            watchId: watch.id,
            market: watch.market,
            sku: "MG464LL/A",
            storeNumber: "R123",
            status: "unknown",
            lastKnownStatus: null,
            lastChangedAt: null,
            lastCheckedAt: CREATED,
            lastSuccessfulAt: null,
            consecutiveUnknowns: 1,
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("bounds delivery cooldowns", () => {
    const watch = expectValidWatch(validWatch());
    expect(
      parseLocalMonitorSnapshot({
        ...createEmptySnapshot(),
        watches: [watch],
        delivery: [
          {
            watchId: watch.id,
            market: watch.market,
            sku: "MG464LL/A",
            storeNumber: "R123",
            lastAlertedAt: null,
            cooldownMs: MAX_DELIVERY_COOLDOWN_MS + 1,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("defaults and validates bounded per-scope deferred availability markers", () => {
    const watch = expectValidWatch(validWatch());
    const base = {
      ...createEmptySnapshot(),
      watches: [watch],
      delivery: [
        {
          watchId: watch.id,
          market: watch.market,
          sku: "MG464LL/A",
          storeNumber: "R123",
          lastAlertedAt: null,
          cooldownMs: 0,
        },
      ],
    };
    const parsed = parseLocalMonitorSnapshot(base);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.delivery[0]).toMatchObject({
      deferredAvailabilityAt: null,
      deferredWatchUpdatedAt: null,
      deferredAvailabilityState: "none",
    });
    expect(
      parseLocalMonitorSnapshot({
        ...base,
        delivery: [
          {
            ...base.delivery[0],
            deferredAvailabilityState: "pending",
            deferredAvailabilityAt: CREATED,
            deferredWatchUpdatedAt: null,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      parseLocalMonitorSnapshot({
        ...base,
        delivery: [
          {
            ...base.delivery[0],
            deferredAvailabilityState: "expired",
            deferredAvailabilityAt: CREATED,
            deferredWatchUpdatedAt: CREATED,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("caps history newest-first so adapters cannot grow unbounded queues", () => {
    const event = (at: string, watchId = "watch-1"): WatchHistoryEvent => ({
      watchId,
      market: "us",
      sku: "MG464LL/A",
      storeNumber: "R123",
      from: "unavailable",
      to: "available",
      at,
    });
    const newestFirst = Array.from({ length: 120 }, (_, i) =>
      event(new Date(NOW_MS - i * 60_000).toISOString()),
    );
    // Adapters may append oldest-first; the helper canonicalizes the order.
    const oldestFirst = [...newestFirst].reverse();
    const capped = capHistoryEvents(oldestFirst, 100, NOW_MS);
    expect(capped).toHaveLength(100);
    expect(capped[0]).toEqual(newestFirst[0]);
    expect(capped[99]).toEqual(newestFirst[99]);
    for (let i = 1; i < capped.length; i += 1) {
      expect(Date.parse(capped[i - 1]!.at)).toBeGreaterThanOrEqual(
        Date.parse(capped[i]!.at),
      );
    }
  });

  it("caps history independently for each watch", () => {
    const event = (at: string, watchId: string): WatchHistoryEvent => ({
      watchId,
      market: "us",
      sku: "MG464LL/A",
      storeNumber: "R123",
      from: "unavailable",
      to: "available",
      at,
    });
    const events: WatchHistoryEvent[] = [];
    for (let i = 0; i < 101; i += 1) {
      events.push(
        event(new Date(NOW_MS - i * 60_000).toISOString(), "watch-1"),
      );
    }
    for (let i = 0; i < 100; i += 1) {
      events.push(
        event(new Date(NOW_MS - i * 60_000).toISOString(), "watch-2"),
      );
    }
    const capped = capHistoryEvents(events, 100, NOW_MS);
    expect(capped.filter((event) => event.watchId === "watch-1")).toHaveLength(
      100,
    );
    expect(capped.filter((event) => event.watchId === "watch-2")).toHaveLength(
      100,
    );
  });

  it("discards history older than the retention window", () => {
    const freshAt = new Date(NOW_MS).toISOString();
    const expiredAt = new Date(
      NOW_MS - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1_000 - 1_000,
    ).toISOString();
    const make = (at: string): WatchHistoryEvent => ({
      watchId: "watch-1",
      market: "us",
      sku: "MG464LL/A",
      storeNumber: "R123",
      from: "unavailable",
      to: "available",
      at,
    });
    const capped = capHistoryEvents(
      [make(expiredAt), make(freshAt)],
      100,
      NOW_MS,
    );
    expect(capped).toHaveLength(1);
    expect(capped[0]?.at).toBe(freshAt);
  });

  it("sorts out-of-order history newest-first", () => {
    const make = (at: string): WatchHistoryEvent => ({
      watchId: "watch-1",
      market: "us",
      sku: "MG464LL/A",
      storeNumber: "R123",
      from: "unavailable",
      to: "available",
      at,
    });
    const oldest = make(new Date(NOW_MS - 3_600_000).toISOString());
    const middle = make(new Date(NOW_MS - 1_800_000).toISOString());
    const newest = make(new Date(NOW_MS).toISOString());
    expect(capHistoryEvents([oldest, newest, middle], 100, NOW_MS)).toEqual([
      newest,
      middle,
      oldest,
    ]);
  });

  it("aligns snapshot history budgets with the per-watch cap", () => {
    const watch = expectValidWatch(validWatch());
    const make = (offsetMs: number): WatchHistoryEvent => ({
      watchId: watch.id,
      market: "us",
      sku: "MG464LL/A",
      storeNumber: "R123",
      from: "unavailable",
      to: "available",
      at: new Date(NOW_MS - offsetMs).toISOString(),
    });
    const withinBudget = {
      ...createEmptySnapshot(),
      watches: [watch],
      history: Array.from({ length: 100 }, (_, i) => make(i * 1_000)),
    };
    expect(parseLocalMonitorSnapshot(withinBudget).success).toBe(true);
    expect(
      parseLocalMonitorSnapshot({
        ...withinBudget,
        history: [...withinBudget.history, make(101_000)],
      }).success,
    ).toBe(false);
  });

  it("maps every transport failure to unknown", () => {
    for (const code of [
      "http_error",
      "timeout",
      "offline",
      "blocked",
      "malformed",
      "denied_permission",
    ] as const) {
      expect(toObservedStatusFromError(code)).toBe("unknown");
    }
  });

  it("an unknown gap cannot fabricate a restock alert", () => {
    const decision = evaluateAvailabilityTransition({
      previousStatus: "unknown",
      lastKnownStatus: "available",
      currentStatus: "available",
      now: Date.parse(CREATED),
    });
    expect(decision.shouldAlert).toBe(false);
    expect(decision.reason).toBe("recovered_available_without_new_stock");
  });
});

describe("market code interop", () => {
  it("maps local codes to retained cloud codes without aliasing", () => {
    expect(toCloudMarketCode("us")).toBe("US");
    expect(toCloudMarketCode("ca")).toBe("CA");
    expect(toCloudMarketCode("uk")).toBe("UK");
  });
});
