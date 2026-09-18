import { describe, expect, it, vi } from "vitest";
import type {
  LocalCatalogSnapshot,
  LocalWatch,
} from "../../../../packages/core/src/local-monitor-contracts.js";
import {
  createUnavailableMonitorController,
  dispatchMonitorCommand,
  projectCatalogForUi,
  type MonitorUiController,
  type MonitorUiSnapshot,
} from "../../src/ui/controller.js";
import { buildWatchFromDraft } from "../../src/ui/watch-draft.js";
import { openLocalMonitorTab } from "../../src/ui/popup-monitor.js";

const catalog: LocalCatalogSnapshot = {
  schemaVersion: 1,
  generatedAt: "2026-09-09T12:00:00.000Z",
  markets: [
    {
      code: "ca",
      name: "Canada",
      storefrontPath: "/ca",
      variants: [
        {
          sku: "MFY84VC/A",
          title: "iPhone 17 Pro Max 256GB Silver",
          familySlug: "iphone-17-pro-max",
        },
      ],
      stores: [
        {
          storeNumber: "R001",
          name: "Apple Test",
          city: "Toronto",
          region: "ON",
          pollLocation: "Toronto",
        },
      ],
    },
    {
      code: "us",
      name: "United States",
      storefrontPath: "/us",
      variants: [
        {
          sku: "MUS84LL/A",
          title: "iPhone 17 Pro Max 256GB Silver",
          familySlug: "iphone-17-pro-max",
        },
      ],
      stores: [
        {
          storeNumber: "R999",
          name: "Apple Other Market",
          city: "New York",
          region: "NY",
          pollLocation: "New York",
        },
      ],
    },
  ],
};

function fakeController(snapshot: MonitorUiSnapshot): MonitorUiController {
  const report = {
    kind: "completed" as const,
    attemptedBatches: 1,
    unsupportedWatchIds: [],
    queuedEvents: 0,
    expiredDeliveryEvents: 0,
    queueBackpressure: false,
  };
  return {
    capabilities: {
      monitor: true,
      catalog: true,
      storeLookup: true,
      personalTelegram: false,
      hostedRelay: false,
    },
    getSnapshot: vi.fn(async () => snapshot),
    getCatalog: vi.fn(async () => catalog),
    lookupStores: vi.fn(async () => ({
      kind: "matches" as const,
      stores: catalog.markets[0]!.stores.map(
        ({ pollLocation: _pollLocation, ...store }) => store,
      ),
    })),
    start: vi.fn(async () => report),
    wake: vi.fn(async () => report),
    checkNow: vi.fn(async () => report),
    openAvailableAtApple: vi.fn(async () => "unavailable" as const),
    addWatch: vi.fn(async () => true),
    replaceWatch: vi.fn(async () => true),
    setWatchEnabled: vi.fn(async () => true),
    deleteWatch: vi.fn(async () => true),
    reset: vi.fn(async () => undefined),
  };
}

describe("local monitor UI command boundary", () => {
  it("opens only the extension-owned full monitor from the popup", () => {
    const create = vi.fn();
    openLocalMonitorTab({
      runtime: {
        getURL: (path) => `moz-extension://inventory-signal/${path}`,
      },
      tabs: { create },
    });
    expect(create).toHaveBeenCalledWith({
      url: "moz-extension://inventory-signal/app.html",
    });
  });

  it("permits only explicit monitor commands and never exposes generic storage access", async () => {
    const controller = fakeController({
      version: 1,
      watches: [],
      items: [],
      history: [],
      pendingDelivery: [],
    });
    await expect(
      dispatchMonitorCommand(controller, {
        type: "check-now",
        watchIds: ["watch-1"],
      }),
    ).resolves.toMatchObject({ kind: "completed" });
    expect(controller.checkNow).toHaveBeenCalledWith(["watch-1"]);
    await expect(
      dispatchMonitorCommand(controller, { type: "read-storage" } as never),
    ).rejects.toThrow("Unknown local monitor command");
  });

  it("fails closed when app UI is not yet wired to the trusted background", async () => {
    const controller = createUnavailableMonitorController(
      "Background unavailable",
      catalog,
    );
    await expect(controller.getCatalog()).resolves.toEqual(
      projectCatalogForUi(catalog),
    );
    await expect(
      dispatchMonitorCommand(controller, { type: "start" }),
    ).rejects.toThrow("Background unavailable");
  });
});

describe("watch draft privacy and validation", () => {
  it("persists selected public stores only and rejects an arbitrary store id", () => {
    const built = buildWatchFromDraft(catalog, {
      id: "watch-one",
      selection: {
        market: "ca",
        model: "iphone-17-pro-max",
        storage: "256GB",
        color: "Silver",
        sku: "MFY84VC/A",
      },
      selectedStoreNumbers: ["R001"],
      pollAnchorStoreNumber: "R001",
      pollIntervalSec: 120,
      enabled: false,
      deliveryChannels: {
        desktop: true,
        personalTelegram: true,
        hostedRelay: true,
      },
      now: "2026-09-09T12:00:00.000Z",
    });
    expect(built.success && built.watch).toMatchObject({
      storeNumbers: ["R001"],
      pollAnchor: { storeNumber: "R001" },
      enabled: false,
      deliveryChannels: {
        desktop: true,
        personalTelegram: true,
        hostedRelay: true,
      },
    } satisfies Partial<LocalWatch>);
    expect(JSON.stringify(built)).not.toContain("M5V 2T6");
    expect(
      buildWatchFromDraft(catalog, {
        id: "watch-two",
        selection: {
          market: "ca",
          model: "iphone-17-pro-max",
          storage: "256GB",
          color: "Silver",
          sku: "MFY84VC/A",
        },
        selectedStoreNumbers: ["not-a-returned-store"],
        pollAnchorStoreNumber: "not-a-returned-store",
        pollIntervalSec: 60,
        enabled: true,
        deliveryChannels: {
          desktop: true,
          personalTelegram: false,
          hostedRelay: false,
        },
        now: "2026-09-09T12:00:00.000Z",
      }),
    ).toMatchObject({ success: false });
    expect(
      buildWatchFromDraft(catalog, {
        id: "watch-cross-market",
        selection: {
          market: "ca",
          model: "iphone-17-pro-max",
          storage: "256GB",
          color: "Silver",
          sku: "MFY84VC/A",
        },
        selectedStoreNumbers: ["R999"],
        pollAnchorStoreNumber: "R999",
        pollIntervalSec: 60,
        enabled: true,
        deliveryChannels: {
          desktop: true,
          personalTelegram: false,
          hostedRelay: false,
        },
        now: "2026-09-09T12:00:00.000Z",
      }),
    ).toMatchObject({
      success: false,
      message: "Choose stores included in the selected region's catalog.",
    });
  });
});
