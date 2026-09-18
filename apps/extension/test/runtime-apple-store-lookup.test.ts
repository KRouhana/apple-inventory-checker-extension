import { describe, expect, it } from "vitest";

import type { LocalCatalogSnapshot } from "../../../packages/core/src/local-monitor-contracts.js";
import { createAppleStoreLookupProvider } from "../src/runtime/apple-store-lookup.js";

const catalog: LocalCatalogSnapshot = {
  schemaVersion: 1,
  generatedAt: "2026-09-11T12:00:00.000Z",
  markets: [
    {
      code: "ca" as const,
      name: "Canada",
      storefrontPath: "/ca",
      variants: [
        {
          sku: "TEST4VC/A",
          title: "iPhone Test",
          familySlug: "iphone-test",
        },
      ],
      stores: [],
    },
  ],
};

function body(overrides: Record<string, unknown> = {}) {
  return {
    head: { status: "200" },
    body: {
      stores: [
        {
          storeNumber: "R701",
          storeName: "Apple Discovery",
          country: "CA",
          address: {
            postalCode: "M5V 2T6",
            countryCode: "CA",
            city: "Toronto",
            state: "ON",
          },
          partsAvailability: {
            "TEST4VC/A": {
              partNumber: "TEST4VC/A",
              storePickEligible: false,
              pickupDisplay: "Unavailable",
              messageTypes: {
                regular: { storePickupProductTitle: "iPhone Test" },
              },
            },
          },
          ...overrides,
        },
      ],
    },
  };
}

function provider(responseBody: unknown, status = 200) {
  const calls: unknown[] = [];
  return {
    calls,
    port: createAppleStoreLookupProvider({
      getCatalog: () => catalog,
      fetch: {
        fetchPickup: async (request) => {
          calls.push(request);
          return { httpStatus: status, body: responseBody };
        },
      },
    }),
  };
}

describe("Apple public store lookup", () => {
  it("uses one current catalog SKU and maps only provider postal/country fields", async () => {
    const lookup = provider(body());
    await expect(
      lookup.port.lookup(
        { market: "ca", userPostalInput: "M5V 2T6" },
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({
      kind: "matches",
      stores: [
        {
          storeNumber: "R701",
          name: "Apple Discovery",
          city: "Toronto",
          region: "ON",
          pollLocation: "M5V 2T6",
        },
      ],
    });
    expect(lookup.calls).toEqual([
      {
        market: "ca",
        anchorStoreNumber: "store-discovery",
        location: "M5V 2T6",
        skus: ["TEST4VC/A"],
      },
    ]);
  });

  it("accepts the documented retailStore address path but rejects missing, conflicting, or foreign public metadata", async () => {
    const retail = body({
      address: { postalCode: "M5V2T6" },
      retailStore: {
        address: {
          countryCode: "CA",
          city: "Toronto",
          state: "ON",
        },
      },
    });
    await expect(
      provider(retail).port.lookup(
        { market: "ca", userPostalInput: "M5V 2T6" },
        { signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({ kind: "matches" });

    for (const invalid of [
      body({ address: { postalCode: "M5V 2T6", countryCode: "US" } }),
      body({ country: undefined, address: { postalCode: "M5V 2T6" } }),
      body({
        address: { postalCode: "M5V 2T6", countryCode: "CA" },
        retailStore: { address: { postalCode: "H2X 1Y4", countryCode: "CA" } },
      }),
      body({ address: { postalCode: "not-a-postal", countryCode: "CA" } }),
    ]) {
      await expect(
        provider(invalid).port.lookup(
          { market: "ca", userPostalInput: "M5V 2T6" },
          { signal: new AbortController().signal },
        ),
      ).resolves.toEqual({ kind: "unknown", reason: "invalid_response" });
    }
  });

  it("treats throttling, current non-JSON/HTTP failures, aborts, and identity mismatches as non-empty non-success outcomes", async () => {
    await expect(
      provider(null, 429).port.lookup(
        { market: "ca", userPostalInput: "M5V 2T6" },
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ kind: "throttled" });
    await expect(
      provider("not json", 541).port.lookup(
        { market: "ca", userPostalInput: "M5V 2T6" },
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ kind: "unknown", reason: "apple_blocked" });
    await expect(
      provider(body({ partsAvailability: {} })).port.lookup(
        { market: "ca", userPostalInput: "M5V 2T6" },
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ kind: "unknown", reason: "invalid_response" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider(body()).port.lookup(
        { market: "ca", userPostalInput: "M5V 2T6" },
        { signal: controller.signal },
      ),
    ).resolves.toEqual({ kind: "unknown" });
    const malformedInput = provider(body());
    await expect(
      malformedInput.port.lookup(
        { market: "ca", userPostalInput: "not a postal code" },
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ kind: "unknown", reason: "invalid_postal_code" });
    expect(malformedInput.calls).toEqual([]);
  });

  it("reports a network failure without retaining provider details", async () => {
    await expect(
      provider(null, 599).port.lookup(
        { market: "ca", userPostalInput: "M5V 2T6" },
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ kind: "unknown", reason: "network_error" });
  });
});
