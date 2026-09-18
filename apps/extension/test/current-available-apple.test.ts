import { describe, expect, it, vi } from "vitest";

import {
  createEmptySnapshot,
  type LocalCatalogSnapshot,
} from "../../../packages/core/src/local-monitor-contracts.js";
import { createLocalAppleHandoffEventFactory } from "../src/handoff/local-apple-handoff.js";
import { openCurrentAvailableAtApple } from "../src/runtime/delivery.js";

const NOW = Date.parse("2026-09-11T12:00:00.000Z");
const AT = new Date(NOW).toISOString();
const catalog: LocalCatalogSnapshot = {
  schemaVersion: 1,
  generatedAt: AT,
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
          buyPath:
            "/ca/shop/buy-iphone/iphone-18-pro/6.3-inch-display-256gb-black",
        },
      ],
      stores: [
        {
          storeNumber: "R123",
          name: "Apple Test",
          city: "Toronto",
          region: "ON",
          pollLocation: "qualified-public-anchor",
        },
      ],
    },
  ],
};

function availableSnapshot() {
  const snapshot = createEmptySnapshot();
  snapshot.watches = [
    {
      id: "watch-one",
      market: "ca",
      skus: ["TEST4VC/A"],
      storeNumbers: ["R123"],
      pollAnchor: { storeNumber: "R123" },
      pollIntervalSec: 120,
      enabled: true,
      deliveryChannels: {
        desktop: false,
        personalTelegram: false,
        hostedRelay: false,
      },
      catalogSchemaVersion: 1,
      createdAt: AT,
      updatedAt: AT,
    },
  ];
  snapshot.items = [
    {
      watchId: "watch-one",
      market: "ca",
      sku: "TEST4VC/A",
      storeNumber: "R123",
      status: "available",
      lastKnownStatus: "available",
      lastChangedAt: AT,
      lastCheckedAt: AT,
      lastSuccessfulAt: AT,
      consecutiveUnknowns: 0,
    },
  ];
  return snapshot;
}

function invoke(
  snapshot = availableSnapshot(),
  eventFactory = createLocalAppleHandoffEventFactory({
    getCatalog: () => catalog,
    now: () => NOW,
  }),
) {
  const openApplePurchase = vi.fn(async () => undefined);
  return {
    openApplePurchase,
    result: openCurrentAvailableAtApple({
      engine: { getSnapshot: async () => snapshot },
      catalog: { getCatalog: () => catalog },
      eventFactory,
      platform: { tabs: { openApplePurchase } },
      input: { watchId: "watch-one", sku: "TEST4VC/A", storeNumber: "R123" },
      now: () => NOW,
    }),
  };
}

describe("current available Apple handoff", () => {
  it("opens only the exact regional SKU product page from a fresh stored available observation", async () => {
    const call = invoke();
    await expect(call.result).resolves.toBe("opened");
    expect(call.openApplePurchase).toHaveBeenCalledOnce();
    expect(call.openApplePurchase).toHaveBeenCalledWith(
      "https://www.apple.com/ca/shop/buy-iphone/iphone-18-pro/6.3-inch-display-256gb-black",
    );
  });

  it("fails closed for stale or unknown observations without opening a tab", async () => {
    const stale = availableSnapshot();
    stale.items[0] = {
      ...stale.items[0]!,
      lastCheckedAt: new Date(NOW - 10 * 60_000 - 1).toISOString(),
      lastSuccessfulAt: new Date(NOW - 10 * 60_000 - 1).toISOString(),
    };
    const staleCall = invoke(stale);
    await expect(staleCall.result).resolves.toBe("unavailable");
    expect(staleCall.openApplePurchase).not.toHaveBeenCalled();

    const unknown = availableSnapshot();
    unknown.items[0] = { ...unknown.items[0]!, status: "unknown" };
    const unknownCall = invoke(unknown);
    await expect(unknownCall.result).resolves.toBe("unavailable");
    expect(unknownCall.openApplePurchase).not.toHaveBeenCalled();
  });

  it("rejects a forged event URL before navigation", async () => {
    const factory = {
      create: () => ({ purchaseUrl: "https://example.test/" }),
    } as never;
    const call = invoke(availableSnapshot(), factory);
    await expect(call.result).resolves.toBe("unavailable");
    expect(call.openApplePurchase).not.toHaveBeenCalled();

    const sameOriginForgery = {
      create: () => ({
        purchaseUrl:
          "https://www.apple.com/ca/shop/buy-iphone/iphone-18-pro/6.9-inch-display-256gb-black",
      }),
    } as never;
    const sameOriginCall = invoke(availableSnapshot(), sameOriginForgery);
    await expect(sameOriginCall.result).resolves.toBe("unavailable");
    expect(sameOriginCall.openApplePurchase).not.toHaveBeenCalled();
  });
});
