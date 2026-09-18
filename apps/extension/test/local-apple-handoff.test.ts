import { describe, expect, it } from "vitest";

import {
  createLocalAppleHandoffEventFactory,
  type LocalAppleHandoffOptions,
} from "../src/handoff/local-apple-handoff";
import type {
  LocalCatalogSnapshot,
  LocalWatch,
} from "../../../packages/core/src/local-monitor-contracts";
import { parseLocalWatch } from "../../../packages/core/src/local-monitor-contracts";

const now = Date.parse("2026-09-09T12:00:00.000Z");
const observedAt = "2026-09-09T11:59:00.000Z";

const catalog: LocalCatalogSnapshot = {
  schemaVersion: 1,
  generatedAt: "2026-09-09T00:00:00.000Z",
  markets: [
    {
      code: "ca",
      name: "Canada",
      storefrontPath: "/ca",
      variants: [
        { sku: "TEST4VC/A", title: "Catalog iPhone 17 Pro Max 256GB Blue" },
      ],
      stores: [
        {
          storeNumber: "R123",
          name: "Catalog Apple Test",
          city: "Toronto",
          region: "Ontario",
          pollLocation: "Apple Test Toronto",
        },
      ],
    },
  ],
};

const parsedWatch = parseLocalWatch({
  id: "watch-1",
  market: "ca",
  skus: ["TEST4VC/A"],
  storeNumbers: ["R123"],
  pollAnchor: { storeNumber: "R123" },
  pollIntervalSec: 120,
  enabled: true,
  catalogSchemaVersion: 1,
  createdAt: "2026-09-09T11:00:00.000Z",
  updatedAt: "2026-09-09T11:00:00.000Z",
});

if (!parsedWatch.success) {
  throw new Error("local Apple handoff watch fixture must be valid");
}

const watch: LocalWatch = parsedWatch.data;

function factory(
  catalogValue: LocalCatalogSnapshot | null = catalog,
  currentNow = now,
) {
  const options: LocalAppleHandoffOptions = {
    getCatalog: () => catalogValue,
    now: () => currentNow,
  };
  return createLocalAppleHandoffEventFactory(options);
}

function availableInput(
  overrides: Partial<{
    watch: LocalWatch;
    sku: string;
    storeNumber: string;
    title: string;
    storeName: string;
    observedAt: string;
  }> = {},
) {
  return {
    watch,
    sku: "TEST4VC/A",
    storeNumber: "R123",
    title: "Forged upstream title must not be trusted",
    storeName: "Forged upstream store must not be trusted",
    observedAt,
    ...overrides,
  };
}

describe("local Apple manual handoff factory", () => {
  it("re-derives a canonical regional manual URL and catalog display data", () => {
    expect(factory().create(availableInput())).toEqual({
      watchId: "watch-1",
      market: "ca",
      sku: "TEST4VC/A",
      title: "Catalog iPhone 17 Pro Max 256GB Blue",
      storeNumber: "R123",
      storeName: "Catalog Apple Test",
      observedAt,
      purchaseUrl: "https://www.apple.com/ca/shop/buy-iphone?part=TEST4VC%2FA",
    });
  });

  it("uses a current catalog-selected device path instead of a generic chooser", () => {
    const withPath: LocalCatalogSnapshot = {
      ...catalog,
      markets: [
        {
          ...catalog.markets[0]!,
          variants: [
            {
              ...catalog.markets[0]!.variants[0]!,
              buyPath:
                "/ca/shop/buy-iphone/iphone-18-pro/6.3-inch-display-256gb-black",
            },
          ],
        },
      ],
    };
    expect(factory(withPath).create(availableInput())?.purchaseUrl).toBe(
      "https://www.apple.com/ca/shop/buy-iphone/iphone-18-pro/6.3-inch-display-256gb-black",
    );
  });

  it("uses the verified regular iPhone 17 selected-device path for an available event", () => {
    const regularIphone17: LocalCatalogSnapshot = {
      ...catalog,
      markets: [
        {
          ...catalog.markets[0]!,
          variants: [
            {
              sku: "MG6A4VC/A",
              title: "iPhone 17 256GB Lavender",
              familySlug: "iphone-17",
              buyPath:
                "/ca/shop/buy-iphone/iphone-17/6.3-inch-display-256gb-lavender",
            },
          ],
        },
      ],
    };
    const regularWatch = { ...watch, skus: ["MG6A4VC/A"] };
    expect(
      factory(regularIphone17).create(
        availableInput({ watch: regularWatch, sku: "MG6A4VC/A" }),
      )?.purchaseUrl,
    ).toBe(
      "https://www.apple.com/ca/shop/buy-iphone/iphone-17/6.3-inch-display-256gb-lavender",
    );
  });

  it("fails closed for retired/wrong-region SKU and store data", () => {
    expect(factory().create(availableInput({ sku: "OTHER4VC/A" }))).toBeNull();
    expect(
      factory().create(availableInput({ storeNumber: "R999" })),
    ).toBeNull();
    expect(
      factory().create(
        availableInput({
          watch: { ...watch, market: "uk" },
        }),
      ),
    ).toBeNull();
    expect(
      factory().create(
        availableInput({
          watch: { ...watch, skus: ["OTHER4VC/A"] },
        }),
      ),
    ).toBeNull();
  });

  it("rejects disabled, malformed, stale, and future observations", () => {
    expect(
      factory().create(availableInput({ watch: { ...watch, enabled: false } })),
    ).toBeNull();
    expect(
      factory().create(availableInput({ observedAt: "not-an-iso-date" })),
    ).toBeNull();
    expect(
      factory().create(
        availableInput({ observedAt: "2026-09-09T11:45:00.000Z" }),
      ),
    ).toBeNull();
    expect(
      factory().create(
        availableInput({ observedAt: "2026-09-09T12:02:00.000Z" }),
      ),
    ).toBeNull();
  });

  it("fails closed when the last-known-good catalog is absent or incompatible", () => {
    expect(factory(null).create(availableInput())).toBeNull();
    expect(
      factory({
        ...catalog,
        schemaVersion: 2,
      } as unknown as LocalCatalogSnapshot).create(availableInput()),
    ).toBeNull();
    expect(
      factory({ ...catalog, markets: [] } as LocalCatalogSnapshot).create(
        availableInput(),
      ),
    ).toBeNull();
  });

  it("fails closed if the catalog source is unavailable rather than inventing a handoff", () => {
    const sourceFailure = createLocalAppleHandoffEventFactory({
      getCatalog: () => {
        throw new Error("catalog storage unavailable");
      },
      now: () => now,
    });
    expect(sourceFailure.create(availableInput())).toBeNull();
  });

  it("documents the engine-owned availability boundary", () => {
    // The DI contract has no status field. The engine may call this only for
    // a parser-confirmed available observation; UI code must gate its own
    // handoff action before calling the factory.
    expect(factory().create(availableInput())).not.toBeNull();
  });
});
