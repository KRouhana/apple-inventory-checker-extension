import { describe, expect, it } from "vitest";

import {
  createEmptySnapshot,
  LocalDeliveryDispatchResultSchema,
  LocalAvailabilityEventSchema,
  PendingDeliveryEventSchema,
  parseLocalCatalogSnapshot,
  parseLocalDeliveryDispatchResult,
  parseLocalMonitorSnapshot,
  parseLocalWatch,
} from "../src/local-monitor-contracts.js";

/**
 * Golden normalization captured from the pre-migration Zod Classic contract
 * at commit 3858abc. It intentionally compares accepted data exactly, while
 * normalizing rejected results to their observable error paths: Zod Mini and
 * Classic format built-in English diagnostic prose differently, but must keep
 * the same reject/accept boundary and offending fields. Custom contract
 * refinement messages remain covered by the existing contract suite.
 */
const BASELINE_COMMIT = "3858abc";
const AT = "2026-09-09T12:00:00.000Z";

function watch(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "watch-1",
    market: "us",
    skus: ["MG464LL/A"],
    storeNumbers: ["R123"],
    pollAnchor: { storeNumber: "R123" },
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function catalog(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    generatedAt: AT,
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
    ...overrides,
  };
}

function availabilityEvent(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    watchId: "watch-1",
    market: "us",
    sku: "MG464LL/A",
    title: "iPhone 17 256GB Black",
    storeNumber: "R123",
    storeName: "Fifth Avenue",
    observedAt: AT,
    purchaseUrl: "https://www.apple.com/shop/buy-iphone/iphone-17",
    ...overrides,
  };
}

function pendingDelivery(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    eventId: "event-1",
    watchUpdatedAt: AT,
    event: availabilityEvent(),
    createdAt: AT,
    channels: [
      {
        channel: "desktop",
        state: "pending",
        attempts: 0,
        nextAttemptAt: null,
        lastAttemptAt: null,
        completedAt: null,
      },
    ],
    ...overrides,
  };
}

type Normalized =
  | { success: true; data: unknown }
  | { success: false; paths: readonly string[] }
  | null;

function normalizePath(path: readonly unknown[] | string): string {
  return typeof path === "string" ? path : path.map(String).join(".");
}

function normalize(result: unknown): Normalized {
  if (result === null) return null;
  const parsed = result as {
    success?: unknown;
    data?: unknown;
    issues?: readonly { path: readonly unknown[] | string }[];
    error?: { issues?: readonly { path: readonly unknown[] | string }[] };
  };
  if (parsed.success === true) return { success: true, data: parsed.data };
  const issues = parsed.issues ?? parsed.error?.issues;
  if (!issues) throw new Error("Expected a schema parse result");
  return {
    success: false,
    paths: issues.map((issue) => normalizePath(issue.path)),
  };
}

const emptySnapshot = createEmptySnapshot();

const corpus: readonly {
  label: string;
  run(): unknown;
  baseline: Normalized;
}[] = [
  {
    label: "watch defaults",
    run: () => parseLocalWatch(watch()),
    baseline: {
      success: true,
      data: {
        ...watch(),
        pollIntervalSec: 120,
        enabled: true,
        deliveryChannels: {
          desktop: true,
          personalTelegram: false,
          hostedRelay: false,
        },
        catalogSchemaVersion: 1,
      },
    },
  },
  {
    label: "watch rejects unknown persisted keys",
    run: () => parseLocalWatch(watch({ label: "Home" })),
    baseline: { success: false, paths: [""] },
  },
  {
    label: "watch rejects duplicate SKUs",
    run: () => parseLocalWatch(watch({ skus: ["MG464LL/A", "MG464LL/A"] })),
    baseline: { success: false, paths: ["skus"] },
  },
  {
    label: "watch rejects Apple batch overflow",
    run: () =>
      parseLocalWatch(
        watch({
          skus: Array.from({ length: 13 }, (_, index) => `MG${index}LL/A`),
        }),
      ),
    baseline: { success: false, paths: ["skus"] },
  },
  {
    label: "watch rejects an anchor outside selected stores",
    run: () => parseLocalWatch(watch({ pollAnchor: { storeNumber: "R999" } })),
    baseline: { success: false, paths: ["pollAnchor.storeNumber"] },
  },
  {
    label: "watch rejects malformed timestamps",
    run: () => parseLocalWatch(watch({ createdAt: "not-a-date" })),
    baseline: { success: false, paths: ["createdAt"] },
  },
  {
    label: "watch applies nested delivery defaults",
    run: () => parseLocalWatch(watch({ deliveryChannels: {} })),
    baseline: {
      success: true,
      data: {
        ...watch(),
        pollIntervalSec: 120,
        enabled: true,
        deliveryChannels: {
          desktop: true,
          personalTelegram: false,
          hostedRelay: false,
        },
        catalogSchemaVersion: 1,
      },
    },
  },
  {
    label: "watch rejects non-finite integer input",
    run: () =>
      parseLocalWatch(watch({ pollIntervalSec: Number.POSITIVE_INFINITY })),
    baseline: { success: false, paths: ["pollIntervalSec"] },
  },
  {
    label: "watch accepts an offset datetime",
    run: () =>
      parseLocalWatch(
        watch({
          createdAt: "2026-09-09T08:00:00.000-04:00",
          updatedAt: "2026-09-09T08:00:00.000-04:00",
        }),
      ),
    baseline: {
      success: true,
      data: {
        ...watch({
          createdAt: "2026-09-09T08:00:00.000-04:00",
          updatedAt: "2026-09-09T08:00:00.000-04:00",
        }),
        pollIntervalSec: 120,
        enabled: true,
        deliveryChannels: {
          desktop: true,
          personalTelegram: false,
          hostedRelay: false,
        },
        catalogSchemaVersion: 1,
      },
    },
  },
  {
    label: "watch rejects impossible calendar dates",
    run: () => parseLocalWatch(watch({ createdAt: "2026-02-30T00:00:00Z" })),
    baseline: { success: false, paths: ["createdAt"] },
  },
  {
    label: "catalog accepts a curated public-store record",
    run: () => parseLocalCatalogSnapshot(catalog()),
    baseline: { success: true, data: catalog() },
  },
  {
    label: "catalog rejects unknown executable fields",
    run: () => parseLocalCatalogSnapshot(catalog({ extra: true })),
    baseline: { success: false, paths: [""] },
  },
  {
    label: "catalog rejects duplicate markets",
    run: () => {
      const value = catalog();
      return parseLocalCatalogSnapshot({
        ...value,
        markets: [
          ...(value.markets as unknown[]),
          ...(value.markets as unknown[]),
        ],
      });
    },
    baseline: { success: false, paths: ["markets.1.code"] },
  },
  {
    label: "catalog rejects blank polling anchors",
    run: () =>
      parseLocalCatalogSnapshot(
        catalog({
          markets: [
            {
              ...(catalog().markets as Record<string, unknown>[])[0],
              stores: [
                {
                  ...(
                    (catalog().markets as Record<string, unknown>[])[0]
                      ?.stores as Record<string, unknown>[]
                  )[0],
                  pollLocation: "  ",
                },
              ],
            },
          ],
        }),
      ),
    baseline: { success: false, paths: ["markets.0.stores.0.pollLocation"] },
  },
  {
    label: "catalog trims canonical display and polling fields",
    run: () =>
      parseLocalCatalogSnapshot(
        catalog({
          markets: [
            {
              ...(catalog().markets as Record<string, unknown>[])[0],
              variants: [
                { sku: "MG464LL/A", title: " iPhone 17 256GB Black " },
              ],
              stores: [
                {
                  ...(
                    (catalog().markets as Record<string, unknown>[])[0]
                      ?.stores as Record<string, unknown>[]
                  )[0],
                  name: " Fifth Avenue ",
                  pollLocation: " Apple Fifth Avenue ",
                },
              ],
            },
          ],
        }),
      ),
    baseline: {
      success: true,
      data: {
        ...catalog(),
        markets: [
          {
            ...(catalog().markets as Record<string, unknown>[])[0],
            variants: [{ sku: "MG464LL/A", title: "iPhone 17 256GB Black" }],
            stores: [
              {
                ...(
                  (catalog().markets as Record<string, unknown>[])[0]
                    ?.stores as Record<string, unknown>[]
                )[0],
                name: "Fifth Avenue",
                pollLocation: "Apple Fifth Avenue",
              },
            ],
          },
        ],
      },
    },
  },
  {
    label: "catalog rejects prototype-shaped JSON keys",
    run: () => parseLocalCatalogSnapshot(JSON.parse('{"__proto__": {}}')),
    baseline: {
      success: false,
      paths: ["schemaVersion", "generatedAt", "markets", ""],
    },
  },
  {
    label: "empty snapshot retains every safe default",
    run: () => parseLocalMonitorSnapshot(emptySnapshot),
    baseline: { success: true, data: emptySnapshot },
  },
  {
    label: "snapshot rejects private free-text fields",
    run: () =>
      parseLocalMonitorSnapshot({ ...emptySnapshot, privateInput: "10001" }),
    baseline: { success: false, paths: [""] },
  },
  {
    label: "snapshot rejects watch capacity overflow",
    run: () =>
      parseLocalMonitorSnapshot({
        ...emptySnapshot,
        watches: Array.from({ length: 21 }, (_, index) =>
          watch({ id: `watch-${index}` }),
        ),
      }),
    baseline: { success: false, paths: ["watches"] },
  },
  {
    label: "legacy snapshot receives runtime and delivery defaults",
    run: () =>
      parseLocalMonitorSnapshot({
        version: 1,
        watches: [],
        items: [],
        delivery: [],
        history: [],
      }),
    baseline: { success: true, data: emptySnapshot },
  },
  {
    label: "snapshot rejects duplicate SKU/store state",
    run: () => {
      const item = {
        watchId: "watch-1",
        market: "us",
        sku: "MG464LL/A",
        storeNumber: "R123",
        status: "available",
        lastKnownStatus: "available",
        lastChangedAt: AT,
        lastCheckedAt: AT,
        lastSuccessfulAt: AT,
        consecutiveUnknowns: 0,
      };
      return parseLocalMonitorSnapshot({
        ...emptySnapshot,
        watches: [watch()],
        items: [item, item],
      });
    },
    baseline: { success: false, paths: ["items.1"] },
  },
  {
    label: "availability event rejects non-Apple purchase URLs",
    run: () =>
      LocalAvailabilityEventSchema.safeParse({
        id: "evt-1",
        watchId: "watch-1",
        market: "us",
        sku: "MG464LL/A",
        storeNumber: "R123",
        title: "iPhone",
        storeName: "Fifth Avenue",
        observedAt: AT,
        purchaseUrl: "https://example.com",
      }),
    baseline: { success: false, paths: ["purchaseUrl", ""] },
  },
  {
    label: "availability event accepts canonical Apple HTTPS URLs",
    run: () => LocalAvailabilityEventSchema.safeParse(availabilityEvent()),
    baseline: { success: true, data: availabilityEvent() },
  },
  {
    label: "availability event rejects credentials in Apple URLs",
    run: () =>
      LocalAvailabilityEventSchema.safeParse(
        availabilityEvent({
          purchaseUrl: "https://person:secret@www.apple.com/shop/buy-iphone",
        }),
      ),
    baseline: { success: false, paths: ["purchaseUrl"] },
  },
  {
    label: "delivery union accepts only known discriminators",
    run: () =>
      LocalDeliveryDispatchResultSchema.safeParse({ kind: "not-a-result" }),
    baseline: { success: false, paths: ["kind"] },
  },
  {
    label: "delivery results reject invalid retry timestamps",
    run: () =>
      parseLocalDeliveryDispatchResult({
        kind: "retry_not_before",
        retryNotBefore: "yesterday",
      }),
    baseline: null,
  },
  {
    label: "pending delivery rejects pre-observation creation",
    run: () =>
      PendingDeliveryEventSchema.safeParse(
        pendingDelivery({ createdAt: "2026-09-09T11:59:59.000Z" }),
      ),
    baseline: { success: false, paths: ["createdAt"] },
  },
  {
    label: "pending delivery rejects channel completion contradictions",
    run: () =>
      PendingDeliveryEventSchema.safeParse(
        pendingDelivery({
          channels: [
            {
              channel: "desktop",
              state: "pending",
              attempts: 0,
              nextAttemptAt: null,
              lastAttemptAt: null,
              completedAt: AT,
            },
          ],
        }),
      ),
    baseline: { success: false, paths: ["channels.0.completedAt"] },
  },
];

describe("Zod Mini local-monitor parity", () => {
  it(`matches the ${BASELINE_COMMIT} Classic corpus`, () => {
    for (const entry of corpus) {
      expect(normalize(entry.run()), entry.label).toEqual(entry.baseline);
    }
  });
});
