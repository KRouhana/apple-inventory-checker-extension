import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  parseLocalCatalogSnapshot,
  parseLocalWatch,
  type LocalCatalogSnapshot,
  type LocalMonitorSnapshot,
} from "../../../packages/core/src/local-monitor-contracts.js";
import { createLocalAppleHandoffEventFactory } from "../src/handoff/local-apple-handoff.js";
import { LocalMonitorEngine } from "../src/monitor/local-monitor-engine.js";
import { createApplePickupFetchPort } from "../src/runtime/apple-pickup-fetch.js";
import { createAppleStoreLookupProvider } from "../src/runtime/apple-store-lookup.js";
import { openCurrentAvailableAtApple } from "../src/runtime/delivery.js";
import {
  dimensionsForVariant,
  normalizeWatchSelection,
  selectorOptions,
} from "../src/ui/catalog-presentation.js";

const parsedCatalog = parseLocalCatalogSnapshot(
  JSON.parse(
    readFileSync(
      new URL("../../../catalog/portable-catalog.json", import.meta.url),
      "utf8",
    ),
  ),
);
if (!parsedCatalog.success) throw new Error("Bundled catalog must parse");
const bundledCatalog = parsedCatalog.data;
const canada = bundledCatalog.markets.find((market) => market.code === "ca")!;
const duo = canada.variants.filter(
  (variant) => variant.familySlug === "iphone-duo",
);
const NOW = Date.parse("2026-10-01T12:00:00.000Z");

// Provider responses/store data are synthetic, not evidence of live stock.
// User postal input is deliberately different from the public store anchor.
const POSTAL_INPUT = "h0h0h0";
const STORE = {
  storeNumber: "R777",
  name: "Apple Synthetic Montréal",
  city: "Montréal",
  region: "QC",
  pollLocation: "H0H 0H1",
};

function harness() {
  let catalog: LocalCatalogSnapshot = bundledCatalog;
  let persisted: LocalMonitorSnapshot | null = null;
  let now = NOW;
  const response = {
    httpStatus: 200,
    status: "available",
    wrongTitle: false,
    missingSku: false,
  };
  const requests: URL[] = [];
  const transport = createApplePickupFetchPort({
    fetch: async (input) => {
      const url = new URL(input);
      requests.push(url);
      const skus = [...url.searchParams.entries()]
        .filter(([key]) => /^parts\.\d+$/.test(key))
        .map(([, sku]) => sku);
      const body = {
        head: { status: "200" },
        body: {
          stores: [
            {
              storeNumber: STORE.storeNumber,
              storeName: STORE.name,
              country: "CA",
              address: {
                postalCode: STORE.pollLocation,
                countryCode: "CA",
                city: STORE.city,
                state: STORE.region,
              },
              partsAvailability: Object.fromEntries(
                skus
                  .filter((_, index) => !response.missingSku || index !== 0)
                  .map((sku) => [
                    sku,
                    {
                      partNumber: sku,
                      storePickEligible: true,
                      pickupDisplay: response.status,
                      buyability: {
                        isBuyable: response.status === "available",
                      },
                      messageTypes: {
                        regular: {
                          storePickupProductTitle: response.wrongTitle
                            ? "iPhone 18 Pro 256GB Black"
                            : canada.variants.find(
                                (variant) => variant.sku === sku,
                              )!.title,
                        },
                      },
                    },
                  ]),
              ),
            },
          ],
        },
      };
      return {
        status: response.httpStatus,
        url: input,
        redirected: false,
        headers: { get: () => null },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
            controller.close();
          },
        }),
      };
    },
  });
  const catalogPort = { getCatalog: () => catalog };
  const eventFactory = createLocalAppleHandoffEventFactory({
    ...catalogPort,
    now: () => now,
  });
  const deliver = vi.fn(async () => undefined);
  const engine = new LocalMonitorEngine({
    clock: { now: () => now },
    storage: {
      load: async () => persisted,
      save: async (snapshot) => {
        persisted = structuredClone(snapshot);
      },
    },
    scheduler: {
      schedulePeriodic: () => undefined,
      scheduleOneShot: () => undefined,
      cancelAll: () => undefined,
    },
    catalog: catalogPort,
    fetch: transport,
    eventFactory,
    deliveryDispatcher: { deliver },
    jitterMs: () => 0,
  });
  const openApplePurchase = vi.fn(async () => undefined);
  return {
    engine,
    response,
    requests,
    deliver,
    openApplePurchase,
    advance: () => {
      now += 60 * 60_000;
    },
    async addDuoWatch() {
      const lookup = createAppleStoreLookupProvider({
        ...catalogPort,
        fetch: transport,
      });
      const result = await lookup.lookup(
        { market: "ca", userPostalInput: POSTAL_INPUT },
        { signal: new AbortController().signal },
      );
      expect(result).toEqual({ kind: "matches", stores: [STORE] });
      if (result.kind !== "matches") throw new Error("Store lookup failed");
      catalog = {
        ...bundledCatalog,
        markets: bundledCatalog.markets.map((market) =>
          market.code === "ca"
            ? { ...market, stores: [...result.stores] }
            : market,
        ),
      };
      const watch = parseLocalWatch({
        id: "canada-duo",
        market: "ca",
        skus: duo.map((variant) => variant.sku),
        storeNumbers: [STORE.storeNumber],
        pollAnchor: { storeNumber: STORE.storeNumber },
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      });
      if (!watch.success) throw new Error("Duo watch must parse");
      expect(await engine.addWatch(watch.data)).toBe(true);
    },
    open(sku = duo[0]!.sku) {
      return openCurrentAvailableAtApple({
        engine,
        catalog: catalogPort,
        eventFactory,
        platform: { tabs: { openApplePurchase } },
        input: { watchId: "canada-duo", sku, storeNumber: STORE.storeNumber },
        now: () => now,
      });
    },
  };
}

describe("Canada iPhone Duo integration (synthetic provider)", () => {
  it("selects all eight Duo combinations and replaces an old Pro SKU", () => {
    expect(duo).toHaveLength(8);
    const selection = {
      market: "ca" as const,
      model: "iphone-duo",
      storage: "",
      color: "",
      sku: canada.variants[0]!.sku,
    };
    const options = selectorOptions(bundledCatalog, selection);
    expect(options.storage).toEqual(["256GB", "512GB", "1TB", "2TB"]);
    expect(options.colors).toEqual(["Night Sky", "Star White"]);
    expect(normalizeWatchSelection(bundledCatalog, selection).sku).toBe("");
    for (const variant of duo) {
      const dimensions = dimensionsForVariant(variant);
      const resolved = normalizeWatchSelection(bundledCatalog, {
        ...selection,
        storage: dimensions.storage!,
        color: dimensions.color!,
      });
      expect(resolved.sku).toBe(variant.sku);
      expect(selectorOptions(bundledCatalog, resolved).variants).toEqual([
        variant,
      ]);
    }
  });

  it("discovers Canadian stores, polls all Duo SKUs, and opens exact matching handoffs", async () => {
    const test = harness();
    await test.addDuoWatch();
    expect(test.requests[0]!.pathname).toBe("/ca/shop/retail/pickup-message");
    expect(test.requests[0]!.searchParams.get("location")).toBe("H0H 0H0");
    const report = await test.engine.checkNewWatch("canada-duo");
    expect(report.attemptedBatches).toBe(1);
    expect(report.queuedEvents).toBe(8);
    expect(test.deliver).toHaveBeenCalledTimes(8);
    const poll = test.requests[1]!;
    expect(poll.pathname).toBe("/ca/shop/retail/pickup-message");
    expect(poll.searchParams.get("location")).toBe(STORE.pollLocation);
    expect(
      duo.map((_, index) => poll.searchParams.get(`parts.${index}`)).sort(),
    ).toEqual(duo.map((variant) => variant.sku).sort());
    const snapshot = await test.engine.getSnapshot();
    expect(snapshot.items).toHaveLength(8);
    expect(snapshot.items.every((item) => item.status === "available")).toBe(
      true,
    );
    expect(JSON.stringify(snapshot)).not.toMatch(/h0h ?0h0/i);
    for (const variant of duo) {
      await expect(test.open(variant.sku)).resolves.toBe("opened");
      expect(test.openApplePurchase).toHaveBeenLastCalledWith(
        `https://www.apple.com${variant.buyPath}`,
      );
    }
    test.advance();
    await test.engine.wake();
    expect(test.deliver).toHaveBeenCalledTimes(8);
  });

  it.each([
    { name: "Apple blocking", httpStatus: 541 },
    { name: "rate limiting", httpStatus: 429 },
    { name: "wrong product identity", wrongTitle: true },
    { name: "missing Duo SKU", missingSku: true },
  ])(
    "keeps $name unknown, preserves prior stock, and refuses a handoff",
    async (failure) => {
      const test = harness();
      await test.addDuoWatch();
      await test.engine.checkNewWatch("canada-duo");
      Object.assign(test.response, failure);
      test.advance();
      await test.engine.wake();
      const snapshot = await test.engine.getSnapshot();
      expect(snapshot.items).toHaveLength(8);
      for (const item of snapshot.items) {
        expect(item).toMatchObject({
          status: "unknown",
          lastKnownStatus: "available",
          lastSuccessfulAt: new Date(NOW).toISOString(),
        });
      }
      expect(test.deliver).toHaveBeenCalledTimes(8);
      await expect(test.open()).resolves.toBe("unavailable");
      expect(test.openApplePurchase).not.toHaveBeenCalled();
    },
  );

  it("treats a confirmed unavailable Duo as unavailable without an alert or handoff", async () => {
    const test = harness();
    await test.addDuoWatch();
    test.response.status = "unavailable";
    await test.engine.checkNewWatch("canada-duo");
    const snapshot = await test.engine.getSnapshot();
    expect(snapshot.items).toHaveLength(8);
    expect(snapshot.items.every((item) => item.status === "unavailable")).toBe(
      true,
    );
    expect(test.deliver).not.toHaveBeenCalled();
    await expect(test.open()).resolves.toBe("unavailable");
    expect(test.openApplePurchase).not.toHaveBeenCalled();
  });
});
