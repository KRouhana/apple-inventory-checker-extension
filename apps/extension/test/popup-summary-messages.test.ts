import { describe, expect, it, vi } from "vitest";
import {
  createEmptySnapshot,
  type LocalCatalogSnapshot,
} from "../../../packages/core/src/local-monitor-contracts.js";
import type {
  ExtensionMessageSender,
  ExtensionRuntime,
} from "../src/platform/api.js";
import {
  installPopupMonitorSummaryMessageHandler,
  projectPopupMonitorSummary,
  POPUP_MONITOR_SUMMARY_PROTOCOL,
} from "../src/platform/popup-summary-messages.js";
import { createLocalAppleHandoffEventFactory } from "../src/handoff/local-apple-handoff.js";
import { openCurrentAvailableAtApple } from "../src/runtime/delivery.js";
const at = "2026-09-18T12:00:00.000Z";
const now = Date.parse(at);
const catalog: LocalCatalogSnapshot = {
  schemaVersion: 1,
  generatedAt: at,
  markets: [
    {
      code: "ca",
      name: "Canada",
      storefrontPath: "/ca",
      variants: [
        {
          sku: "TEST4VC/A",
          title: "iPhone 18 Pro Max 512GB Burgundy",
          familySlug: "iphone-18-pro-max",
          buyPath:
            "/ca/shop/buy-iphone/iphone-18-pro/6.9-inch-display-512gb-burgundy",
        },
      ],
      stores: [
        {
          storeNumber: "R123",
          name: "Apple Test",
          city: "Toronto",
          region: "ON",
          pollLocation: "public-anchor",
        },
      ],
    },
  ],
};
function fixture() {
  const s = createEmptySnapshot();
  s.watches = [
    {
      id: "watch-one",
      market: "ca",
      skus: ["TEST4VC/A"],
      storeNumbers: ["R123"],
      pollAnchor: { storeNumber: "R123" },
      pollIntervalSec: 120,
      enabled: true,
      deliveryChannels: {
        desktop: true,
        personalTelegram: true,
        hostedRelay: false,
      },
      catalogSchemaVersion: 1,
      createdAt: at,
      updatedAt: at,
    },
  ];
  s.items = [
    {
      watchId: "watch-one",
      market: "ca",
      sku: "TEST4VC/A",
      storeNumber: "R123",
      status: "available",
      lastKnownStatus: "available",
      lastChangedAt: at,
      lastCheckedAt: at,
      lastSuccessfulAt: at,
      consecutiveUnknowns: 0,
    },
  ];
  return s;
}
function runtime() {
  const listeners: Array<
    (
      input: unknown,
      sender: ExtensionMessageSender,
      respond: (response: unknown) => void,
    ) => boolean | void
  > = [];
  const api: ExtensionRuntime = {
    id: "test-extension",
    getURL: (path) => `chrome-extension://test-extension/${path}`,
    onMessage: { addListener: (l) => listeners.push(l) },
    sendMessage: () => undefined,
  };
  return {
    api,
    dispatch: (input: unknown, sender: ExtensionMessageSender = trusted) =>
      new Promise<unknown>((resolve) => {
        for (const l of listeners) if (l(input, sender, resolve)) return;
      }),
  };
}
const trusted = {
  id: "test-extension",
  url: "chrome-extension://test-extension/popup.html",
};
const command = {
  protocol: POPUP_MONITOR_SUMMARY_PROTOCOL,
  type: "OPEN_AVAILABLE",
  watchId: "watch-one",
  sku: "TEST4VC/A",
  storeNumber: "R123",
};
describe("watch popup protocol", () => {
  it("projects every phone/store with public names and no secrets or location inputs", () => {
    const result = projectPopupMonitorSummary(fixture(), catalog, now)!;
    expect(result.watches[0]).toMatchObject({
      title: "iPhone 18 Pro Max 512GB Burgundy",
      items: [{ storeName: "Apple Test", status: "available" }],
    });
    expect(JSON.stringify(result)).not.toContain("public-anchor");
    expect(JSON.stringify(result)).not.toContain("deliveryChannels");
    expect(JSON.stringify(result)).not.toContain("buyPath");
  });
  it("distinguishes unavailable, unknown, ineligible, missing, stale, paused and retired", () => {
    for (const status of [
      "available",
      "unavailable",
      "ineligible",
      "unknown",
    ] as const) {
      const s = fixture();
      s.items[0]!.status = status;
      s.items[0]!.lastKnownStatus = status === "unknown" ? "available" : status;
      expect(
        projectPopupMonitorSummary(s, catalog, now)?.watches[0]?.items[0]
          ?.status,
      ).toBe(status);
    }
    const missing = fixture();
    missing.items = [];
    expect(
      projectPopupMonitorSummary(missing, catalog, now)?.watches[0]?.items[0]
        ?.status,
    ).toBe("waiting");
    expect(
      projectPopupMonitorSummary(fixture(), catalog, now + 600001)?.watches[0]
        ?.items[0]?.status,
    ).toBe("stale");
    const paused = fixture();
    paused.watches[0]!.enabled = false;
    expect(
      projectPopupMonitorSummary(paused, catalog, now)?.watches[0]?.items[0]
        ?.status,
    ).toBe("paused");
    const retired = structuredClone(catalog);
    retired.markets[0]!.variants[0]!.sku = "DIFF4VC/A";
    expect(
      projectPopupMonitorSummary(fixture(), retired, now)?.watches[0]?.items[0]
        ?.status,
    ).toBe("retired");
    expect(projectPopupMonitorSummary({}, catalog, now)).toBeNull();
  });
  it("only the exact popup can read watches or request a handoff; URLs and extra fields are rejected", async () => {
    const fake = runtime();
    const open = vi.fn(async () => "opened" as const);
    const getSnapshot = vi.fn(async () => fixture());
    installPopupMonitorSummaryMessageHandler(fake.api, {
      getSnapshot,
      getCatalog: async () => catalog,
      openAvailableAtApple: open,
      now: () => now,
    });
    for (const sender of [
      { id: "foreign", url: trusted.url },
      { ...trusted, url: "https://www.apple.com/" },
      { ...trusted, url: "chrome-extension://test-extension/app.html" },
      { ...trusted, frameId: 1 },
    ]) {
      expect(await fake.dispatch(command, sender)).toMatchObject({
        ok: false,
        error: "unauthorized",
      });
    }
    expect(
      await fake.dispatch({ ...command, url: "https://example.invalid" }),
    ).toMatchObject({ ok: false, error: "invalid_request" });
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(
      await fake.dispatch({
        protocol: POPUP_MONITOR_SUMMARY_PROTOCOL,
        type: "GET_SUMMARY",
      }),
    ).toMatchObject({ ok: true, result: { watches: [{ id: "watch-one" }] } });
  });
  it("opens the selected official product from a fresh user click and rejects state changes", async () => {
    const fake = runtime();
    const s = fixture();
    const openApplePurchase = vi.fn(async () => undefined);
    const engine = { getSnapshot: async () => s };
    const catalogPort = { getCatalog: () => catalog };
    const open = vi.fn((input) =>
      openCurrentAvailableAtApple({
        engine,
        catalog: catalogPort,
        eventFactory: createLocalAppleHandoffEventFactory({
          getCatalog: () => catalog,
          now: () => now,
        }),
        platform: { tabs: { openApplePurchase } },
        input,
        now: () => now,
      }),
    );
    installPopupMonitorSummaryMessageHandler(fake.api, {
      getSnapshot: engine.getSnapshot,
      getCatalog: async () => catalog,
      openAvailableAtApple: open,
      now: () => now,
    });
    expect(await fake.dispatch(command)).toMatchObject({
      ok: true,
      result: "opened",
    });
    expect(openApplePurchase).toHaveBeenCalledWith(
      "https://www.apple.com/ca/shop/buy-iphone/iphone-18-pro/6.9-inch-display-512gb-burgundy",
    );
    s.items[0]!.status = "unknown";
    expect(await fake.dispatch(command)).toMatchObject({
      ok: true,
      result: "unavailable",
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(
      await fake.dispatch({ ...command, storeNumber: "R999" }),
    ).toMatchObject({ ok: true, result: "unavailable" });
  });
});
