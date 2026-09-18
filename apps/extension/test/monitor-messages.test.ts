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
  installLocalMonitorMessageHandler,
  LOCAL_MONITOR_PROTOCOL,
  parseLocalMonitorRuntimeCommand,
  type LocalMonitorRuntimeDependencies,
} from "../src/platform/monitor-messages.js";
import { createRuntimeMonitorController } from "../src/ui/runtime-controller.js";

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
          pollLocation: "qualified-internal-lookup",
        },
      ],
    },
  ],
};

const watch = {
  id: "watch-one",
  market: "ca" as const,
  skus: ["MFY84VC/A"],
  storeNumbers: ["R001"],
  pollAnchor: { storeNumber: "R001" },
  pollIntervalSec: 120,
  enabled: true,
  deliveryChannels: {
    desktop: true,
    personalTelegram: false,
    hostedRelay: false,
  },
  catalogSchemaVersion: 1,
  createdAt: "2026-09-09T12:00:00.000Z",
  updatedAt: "2026-09-09T12:00:00.000Z",
};

const at = "2026-09-09T12:00:00.000Z";

function createMaximumCanonicalSnapshot() {
  const snapshot = createEmptySnapshot();
  snapshot.watches = Array.from({ length: 20 }, (_, watchIndex) => {
    const skus = Array.from(
      { length: 12 },
      (_, skuIndex) => `M${watchIndex}${skuIndex}/A`,
    );
    const storeNumbers = Array.from(
      { length: 10 },
      (_, storeIndex) => `R${watchIndex}-${storeIndex}`,
    );
    return {
      id: `watch-${watchIndex}`,
      market: "ca" as const,
      skus,
      storeNumbers,
      pollAnchor: { storeNumber: storeNumbers[0]! },
      pollIntervalSec: 120,
      enabled: true,
      deliveryChannels: {
        desktop: true,
        personalTelegram: false,
        hostedRelay: false,
      },
      catalogSchemaVersion: 1,
      createdAt: at,
      updatedAt: at,
    };
  }) as never;
  const scopes = snapshot.watches.flatMap((currentWatch) =>
    currentWatch.skus.flatMap((sku) =>
      currentWatch.storeNumbers.map((storeNumber) => ({
        watch: currentWatch,
        sku,
        storeNumber,
      })),
    ),
  );
  snapshot.items = scopes.map(({ watch: currentWatch, sku, storeNumber }) => ({
    watchId: currentWatch.id,
    market: currentWatch.market,
    sku,
    storeNumber,
    status: "available",
    lastKnownStatus: "available",
    lastChangedAt: at,
    lastCheckedAt: at,
    lastSuccessfulAt: at,
    consecutiveUnknowns: 0,
  }));
  snapshot.delivery = scopes.map(
    ({ watch: currentWatch, sku, storeNumber }) => ({
      watchId: currentWatch.id,
      market: currentWatch.market,
      sku,
      storeNumber,
      lastAlertedAt: null,
      cooldownMs: 1_800_000,
      deferredAvailabilityAt: null,
      deferredWatchUpdatedAt: null,
      deferredAvailabilityState: "none" as const,
    }),
  );
  return snapshot;
}

function createRuntime() {
  const listeners: Array<
    (
      message: unknown,
      sender: ExtensionMessageSender,
      sendResponse: (response: unknown) => void,
    ) => boolean | void
  > = [];
  const runtime: ExtensionRuntime = {
    id: "test-extension",
    getURL: (path) => `chrome-extension://test-extension/${path}`,
    onMessage: { addListener: (listener) => listeners.push(listener) },
    sendMessage: (message, callback) => {
      const reply = new Promise<unknown>((resolve) => {
        for (const listener of listeners) {
          const handled = listener(
            message,
            {
              id: "test-extension",
              url: "chrome-extension://test-extension/app.html",
            },
            resolve,
          );
          if (handled) return;
        }
        resolve(undefined);
      });
      if (callback) {
        void reply.then(callback);
        return undefined;
      }
      return reply;
    },
  };
  const dispatch = (message: unknown, sender: ExtensionMessageSender) =>
    new Promise<unknown>((resolve) => {
      let responded = false;
      for (const listener of listeners) {
        const handled = listener(message, sender, (response) => {
          if (!responded) {
            responded = true;
            resolve(response);
          }
        });
        if (handled) return;
      }
      resolve(undefined);
    });
  return { runtime, dispatch };
}

function dependencies(): LocalMonitorRuntimeDependencies {
  const snapshot = createEmptySnapshot();
  const report = {
    kind: "completed" as const,
    attemptedBatches: 1,
    unsupportedWatchIds: [],
    queuedEvents: 0,
    expiredDeliveryEvents: 0,
    queueBackpressure: false,
  };
  return {
    engine: {
      start: vi.fn(async () => report),
      wake: vi.fn(async () => report),
      checkNow: vi.fn(async () => report),
      getSnapshot: vi.fn(async () => snapshot),
      addWatch: vi.fn(async () => true),
      replaceWatch: vi.fn(async () => true),
      setWatchEnabled: vi.fn(async () => true),
      deleteWatch: vi.fn(async () => true),
      reset: vi.fn(async () => undefined),
    },
    getCatalog: () => catalog,
    lookupStores: vi.fn(async () => ({
      kind: "matches" as const,
      stores: catalog.markets[0]!.stores,
    })),
    capabilities: () => ({
      monitor: true,
      catalog: true,
      storeLookup: true,
      personalTelegram: false,
      hostedRelay: false,
    }),
    openAvailableAtApple: vi.fn(async () => "unavailable" as const),
  };
}

describe("local monitor runtime protocol", () => {
  it("carries safe failure details through the background and UI decoder for a full snapshot", async () => {
    const fake = createRuntime();
    const deps = dependencies();
    const snapshot = createMaximumCanonicalSnapshot();
    snapshot.delivery = [];
    snapshot.items = snapshot.items.map((item) => ({
      ...item,
      status: "unknown",
      lastFailure: { reason: "http_error", httpStatus: 541 },
    }));
    deps.engine.getSnapshot = vi.fn(async () => snapshot);
    installLocalMonitorMessageHandler(fake.runtime, deps);
    const controller = await createRuntimeMonitorController(fake.runtime);
    const projected = await controller.getSnapshot();
    expect(projected.items).toHaveLength(2400);
    expect(projected.items[0]?.lastFailure).toEqual({
      reason: "http_error",
      httpStatus: 541,
    });
    (
      snapshot.items[0]!.lastFailure as unknown as Record<string, unknown>
    ).providerBody = "must not be sent";
    await expect(controller.getSnapshot()).rejects.toThrow();
  });

  it("serves only a bounded volatile pickup diagnostic to the trusted app sender", async () => {
    const fake = createRuntime();
    const deps = dependencies();
    deps.getPickupDiagnostic = () => ({
      phase: "body_read_failed",
      byteCount: 67_107,
      httpStatus: 200,
    });
    installLocalMonitorMessageHandler(fake.runtime, deps);
    const command = {
      protocol: LOCAL_MONITOR_PROTOCOL,
      type: "GET_PICKUP_DIAGNOSTIC",
    } as const;
    await expect(
      fake.dispatch(command, {
        id: "test-extension",
        url: "chrome-extension://test-extension/app.html",
      }),
    ).resolves.toEqual({
      protocol: LOCAL_MONITOR_PROTOCOL,
      type: "RESULT",
      request: "GET_PICKUP_DIAGNOSTIC",
      ok: true,
      result: { phase: "body_read_failed", byteCount: 67_107, httpStatus: 200 },
    });
    await expect(
      fake.dispatch(command, {
        id: "other",
        url: "chrome-extension://test-extension/app.html",
      }),
    ).resolves.toMatchObject({ ok: false, error: "unauthorized" });
    expect(
      parseLocalMonitorRuntimeCommand({ ...command, rawBody: "forbidden" }),
    ).toBeNull();
  });

  it("projects only exact public identity diagnostics to the trusted app sender", async () => {
    const fake = createRuntime();
    const deps = dependencies();
    const getPickupParseDiagnostic = vi.fn(() => ({
      outcome: "failure" as const,
      reason: "identity_validation_failed" as const,
      storeCount: 0,
      observationCount: 0,
      targetStatus: "not_parsed" as const,
      targetAvailability: null,
      identityMismatch: {
        kind: "public_product" as const,
        requestedSku: "MFY84VC/A",
        expectedTitle: "iPhone\u00a017 Pro Max 256GB Silver",
        observedTitle: "iPhone\u202f17 Pro Max 256GB Blue",
      },
    }));
    deps.getPickupParseDiagnostic = getPickupParseDiagnostic;
    installLocalMonitorMessageHandler(fake.runtime, deps);
    const command = {
      protocol: LOCAL_MONITOR_PROTOCOL,
      type: "GET_PICKUP_PARSE_DIAGNOSTIC",
    } as const;
    await expect(
      fake.dispatch(command, {
        id: "test-extension",
        url: "chrome-extension://test-extension/app.html",
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        identityMismatch: {
          kind: "public_product",
          requestedSku: "MFY84VC/A",
          expectedTitle: "iPhone\u00a017 Pro Max 256GB Silver",
          observedTitle: "iPhone\u202f17 Pro Max 256GB Blue",
        },
      },
    });
    expect(getPickupParseDiagnostic).toHaveBeenCalledTimes(1);

    getPickupParseDiagnostic.mockReturnValue({
      outcome: "failure",
      reason: "identity_validation_failed",
      storeCount: 0,
      observationCount: 0,
      targetStatus: "not_parsed",
      targetAvailability: null,
      identityMismatch: { kind: "redacted", rawBody: "forbidden" },
    } as never);
    await expect(
      fake.dispatch(command, {
        id: "test-extension",
        url: "chrome-extension://test-extension/app.html",
      }),
    ).resolves.toMatchObject({ ok: true, result: null });

    getPickupParseDiagnostic.mockReturnValue({
      outcome: "failure",
      reason: "invalid_json",
      storeCount: 0,
      observationCount: 0,
      targetStatus: "not_parsed",
      targetAvailability: null,
      identityMismatch: { kind: "redacted" },
    } as never);
    await expect(
      fake.dispatch(command, {
        id: "test-extension",
        url: "chrome-extension://test-extension/app.html",
      }),
    ).resolves.toMatchObject({ ok: true, result: null });

    await expect(
      fake.dispatch(command, {
        id: "other-extension",
        url: "chrome-extension://test-extension/app.html",
      }),
    ).resolves.toMatchObject({ ok: false, error: "unauthorized" });
    expect(getPickupParseDiagnostic).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["an overlong SKU", "M".repeat(31) + "/A", "iPhone 17 Pro Max"],
    ["an overlong title", "MFY84VC/A", "iPhone " + "A".repeat(194)],
    ["a control character", "MFY84VC/A", "iPhone 17\u0000 Pro Max"],
    ["HTML", "MFY84VC/A", "iPhone <b>17</b> Pro Max"],
    ["a URL", "MFY84VC/A", "iPhone www.example.com"],
  ])(
    "redacts malformed public identity diagnostic with %s",
    async (_case, requestedSku, title) => {
      const fake = createRuntime();
      const deps = dependencies();
      deps.getPickupParseDiagnostic = () => ({
        outcome: "failure",
        reason: "identity_validation_failed",
        storeCount: 0,
        observationCount: 0,
        targetStatus: "not_parsed",
        targetAvailability: null,
        identityMismatch: {
          kind: "public_product",
          requestedSku,
          expectedTitle: title,
          observedTitle: "iPhone 17 Pro Max",
        },
      });
      installLocalMonitorMessageHandler(fake.runtime, deps);
      await expect(
        fake.dispatch(
          {
            protocol: LOCAL_MONITOR_PROTOCOL,
            type: "GET_PICKUP_PARSE_DIAGNOSTIC",
          },
          {
            id: "test-extension",
            url: "chrome-extension://test-extension/app.html",
          },
        ),
      ).resolves.toMatchObject({ ok: true, result: null });
    },
  );

  it("projects only finite target availability flags and rejects malformed diagnostic nesting", async () => {
    const fake = createRuntime();
    const deps = dependencies();
    const getPickupParseDiagnostic = vi.fn(() => ({
      outcome: "success" as const,
      reason: null,
      storeCount: 12,
      observationCount: 12,
      targetStatus: "unknown" as const,
      targetAvailability: {
        pickupDisplay: "other" as const,
        pickupDisplayToken: "Pickup ready",
        storePickEligible: true,
        isBuyable: null,
      },
      identityMismatch: null,
    }));
    deps.getPickupParseDiagnostic = getPickupParseDiagnostic;
    installLocalMonitorMessageHandler(fake.runtime, deps);
    const command = {
      protocol: LOCAL_MONITOR_PROTOCOL,
      type: "GET_PICKUP_PARSE_DIAGNOSTIC",
    } as const;
    const sender = {
      id: "test-extension",
      url: "chrome-extension://test-extension/app.html",
    };

    await expect(fake.dispatch(command, sender)).resolves.toMatchObject({
      ok: true,
      result: {
        outcome: "success",
        targetAvailability: {
          pickupDisplay: "other",
          pickupDisplayToken: "Pickup ready",
          storePickEligible: true,
          isBuyable: null,
        },
      },
    });

    getPickupParseDiagnostic.mockReturnValue({
      outcome: "success",
      reason: null,
      storeCount: 12,
      observationCount: 12,
      targetStatus: "unknown",
      targetAvailability: {
        pickupDisplay: "other",
        pickupDisplayToken: null,
        storePickEligible: true,
        isBuyable: null,
      },
      identityMismatch: null,
    } as never);
    await expect(fake.dispatch(command, sender)).resolves.toMatchObject({
      ok: true,
      result: { targetAvailability: { pickupDisplayToken: null } },
    });

    getPickupParseDiagnostic.mockReturnValue({
      outcome: "success",
      reason: null,
      storeCount: 12,
      observationCount: 12,
      targetStatus: "ineligible",
      targetAvailability: {
        pickupDisplay: "ineligible",
        pickupDisplayToken: null,
        storePickEligible: false,
        isBuyable: false,
      },
      identityMismatch: null,
    } as never);
    await expect(fake.dispatch(command, sender)).resolves.toMatchObject({
      ok: true,
      result: {
        targetStatus: "ineligible",
        targetAvailability: {
          pickupDisplay: "ineligible",
          pickupDisplayToken: null,
        },
      },
    });

    getPickupParseDiagnostic.mockReturnValue({
      outcome: "success",
      reason: null,
      storeCount: 12,
      observationCount: 12,
      targetStatus: "unknown",
      targetAvailability: {
        pickupDisplay: "ineligible",
        pickupDisplayToken: null,
        storePickEligible: true,
        isBuyable: true,
      },
      identityMismatch: null,
    } as never);
    await expect(fake.dispatch(command, sender)).resolves.toMatchObject({
      ok: true,
      result: { targetStatus: "unknown" },
    });

    getPickupParseDiagnostic.mockReturnValue({
      outcome: "success",
      reason: null,
      storeCount: 12,
      observationCount: 12,
      targetStatus: "ineligible",
      targetAvailability: {
        pickupDisplay: "ineligible",
        pickupDisplayToken: "Ineligible",
        storePickEligible: false,
        isBuyable: false,
      },
      identityMismatch: null,
    } as never);
    await expect(fake.dispatch(command, sender)).resolves.toMatchObject({
      ok: true,
      result: null,
    });

    for (const targetAvailability of [
      {
        pickupDisplay: "other",
        pickupDisplayToken: "Pickup ready",
        storePickEligible: true,
        isBuyable: null,
        responseBody: "forbidden",
      },
      {
        pickupDisplay: "other",
        pickupDisplayToken: "https://provider.invalid",
        storePickEligible: true,
        isBuyable: null,
      },
      {
        pickupDisplay: "other",
        pickupDisplayToken: "Pickup\u0000ready",
        storePickEligible: true,
        isBuyable: 1,
      },
      ...["Pickup ready\n", "Pickup ready\r\n", "Pickup ready\u2028"].map(
        (pickupDisplayToken) => ({
          pickupDisplay: "other",
          pickupDisplayToken,
          storePickEligible: true,
          isBuyable: null,
        }),
      ),
    ]) {
      getPickupParseDiagnostic.mockReturnValue({
        outcome: "success",
        reason: null,
        storeCount: 12,
        observationCount: 12,
        targetStatus: "unknown",
        targetAvailability,
        identityMismatch: null,
      } as never);
      await expect(fake.dispatch(command, sender)).resolves.toMatchObject({
        ok: true,
        result: null,
      });
    }

    getPickupParseDiagnostic.mockReturnValue({
      outcome: "success",
      reason: null,
      storeCount: 2_001,
      observationCount: 12,
      targetStatus: "unknown",
      targetAvailability: {
        pickupDisplay: "other",
        pickupDisplayToken: "Pickup\u0000ready",
        storePickEligible: true,
        isBuyable: null,
      },
      identityMismatch: null,
    } as never);
    await expect(fake.dispatch(command, sender)).resolves.toMatchObject({
      ok: true,
      result: null,
    });

    getPickupParseDiagnostic.mockReturnValue({
      outcome: "success",
      reason: null,
      storeCount: 12,
      observationCount: 12,
      targetStatus: "available",
      targetAvailability: {
        pickupDisplay: "available",
        pickupDisplayToken: "Pickup ready",
        storePickEligible: true,
        isBuyable: true,
      },
      identityMismatch: null,
    } as never);
    await expect(fake.dispatch(command, sender)).resolves.toMatchObject({
      ok: true,
      result: null,
    });

    getPickupParseDiagnostic.mockReturnValue({
      outcome: "failure",
      reason: "invalid_json",
      storeCount: 0,
      observationCount: 0,
      targetStatus: "not_parsed",
      targetAvailability: {
        pickupDisplay: "available",
        pickupDisplayToken: null,
        storePickEligible: true,
        isBuyable: true,
      },
      identityMismatch: null,
    } as never);
    await expect(fake.dispatch(command, sender)).resolves.toMatchObject({
      ok: true,
      result: null,
    });
  });

  it("rejects extra fields, raw storage/fetch shapes, and oversized transient input", () => {
    expect(
      parseLocalMonitorRuntimeCommand({
        protocol: LOCAL_MONITOR_PROTOCOL,
        type: "ADD_WATCH",
        watch: { ...watch, pollIntervalSec: 60 },
      }),
    ).toBeNull();
    expect(
      parseLocalMonitorRuntimeCommand({
        protocol: LOCAL_MONITOR_PROTOCOL,
        type: "GET_SNAPSHOT",
        storageKey: "inventorySignal.localMonitor.v1",
      }),
    ).toBeNull();
    expect(
      parseLocalMonitorRuntimeCommand({
        protocol: LOCAL_MONITOR_PROTOCOL,
        type: "ADD_WATCH",
        watch: {
          id: "watch-one",
          market: "ca",
          skus: ["MFY84VC/A"],
          storeNumbers: ["R001"],
          pollAnchor: { storeNumber: "R001" },
          pollIntervalSec: 60,
          enabled: true,
          deliveryChannels: {
            desktop: true,
            personalTelegram: false,
            hostedRelay: false,
          },
          catalogSchemaVersion: 1,
          createdAt: "2026-02-30T12:00:00.000Z",
          updatedAt: "1995-12-17T03:24:00.000Z",
        },
      }),
    ).toBeNull();
    expect(
      parseLocalMonitorRuntimeCommand({
        protocol: LOCAL_MONITOR_PROTOCOL,
        type: "LOOKUP_STORES",
        input: { market: "ca", userPostalInput: "x".repeat(121) },
      }),
    ).toBeNull();
    expect(
      parseLocalMonitorRuntimeCommand({
        protocol: LOCAL_MONITOR_PROTOCOL,
        type: "LOOKUP_STORES",
        input: { market: "ca", userPostalInput: "M5V\u00002T6" },
      }),
    ).toBeNull();
    expect(
      parseLocalMonitorRuntimeCommand({
        protocol: LOCAL_MONITOR_PROTOCOL,
        type: "FETCH_ANY_URL",
        url: "https://example.test",
      }),
    ).toBeNull();
    expect(
      parseLocalMonitorRuntimeCommand({
        protocol: LOCAL_MONITOR_PROTOCOL,
        type: "CHECK_NOW",
        watchIds: [],
      }),
    ).toBeNull();
  });

  it("uses only a declared response request type for unknown monitor commands", async () => {
    const fake = createRuntime();
    installLocalMonitorMessageHandler(fake.runtime, dependencies());
    await expect(
      fake.dispatch(
        { protocol: LOCAL_MONITOR_PROTOCOL, type: "NOT_A_COMMAND" },
        {
          id: "test-extension",
          url: "chrome-extension://test-extension/app.html",
        },
      ),
    ).resolves.toMatchObject({ request: "UNKNOWN", error: "invalid_request" });
  });

  it("accepts the exact extension app tab but rejects web and other-protocol senders", async () => {
    const fake = createRuntime();
    const deps = dependencies();
    installLocalMonitorMessageHandler(fake.runtime, deps);
    await expect(
      fake.dispatch(
        { protocol: LOCAL_MONITOR_PROTOCOL, type: "GET_SNAPSHOT" },
        {
          id: "test-extension",
          url: "chrome-extension://test-extension/app.html",
          origin: "chrome-extension://test-extension",
          frameId: 0,
          tab: {
            id: 42,
            url: "chrome-extension://test-extension/app.html",
          },
        },
      ),
    ).resolves.toMatchObject({ ok: true, request: "GET_SNAPSHOT" });
    await expect(
      fake.dispatch(
        { protocol: "inventory-signal.checkout.v1", type: "OPEN_CHECKOUT" },
        {
          id: "test-extension",
          url: "chrome-extension://test-extension/app.html",
        },
      ),
    ).resolves.toBeUndefined();
    await expect(
      fake.dispatch(
        { protocol: LOCAL_MONITOR_PROTOCOL, type: "GET_SNAPSHOT" },
        {
          id: "test-extension",
          url: "https://www.apple.com/ca/shop/buy-iphone",
          origin: "https://www.apple.com",
          frameId: 0,
          tab: { id: 42, url: "https://www.apple.com/ca/shop/buy-iphone" },
        },
      ),
    ).resolves.toMatchObject({ ok: false, error: "unauthorized" });
    await expect(
      fake.dispatch(
        { protocol: LOCAL_MONITOR_PROTOCOL, type: "GET_SNAPSHOT" },
        {
          id: "test-extension",
          url: "chrome-extension://test-extension/app.html?x=1",
        },
      ),
    ).resolves.toMatchObject({ ok: false, error: "unauthorized" });
    expect(deps.engine.getSnapshot).toHaveBeenCalledTimes(1);
  });

  it("accepts only public item identifiers for an explicit Apple handoff", async () => {
    const fake = createRuntime();
    const deps = dependencies();
    deps.openAvailableAtApple = vi.fn(async () => "opened" as const);
    installLocalMonitorMessageHandler(fake.runtime, deps);
    const sender = {
      id: "test-extension",
      url: "chrome-extension://test-extension/app.html",
    };
    await expect(
      fake.dispatch(
        {
          protocol: LOCAL_MONITOR_PROTOCOL,
          type: "OPEN_AVAILABLE_AT_APPLE",
          watchId: "watch-one",
          sku: "MFY84VC/A",
          storeNumber: "R001",
        },
        sender,
      ),
    ).resolves.toMatchObject({
      ok: true,
      request: "OPEN_AVAILABLE_AT_APPLE",
      result: "opened",
    });
    expect(deps.openAvailableAtApple).toHaveBeenCalledWith({
      watchId: "watch-one",
      sku: "MFY84VC/A",
      storeNumber: "R001",
    });
    await expect(
      fake.dispatch(
        {
          protocol: LOCAL_MONITOR_PROTOCOL,
          type: "OPEN_AVAILABLE_AT_APPLE",
          watchId: "watch-one",
          sku: "MFY84VC/A",
          storeNumber: "R001",
          url: "https://evil.example/",
        },
        sender,
      ),
    ).resolves.toMatchObject({ ok: false, error: "invalid_request" });
    expect(deps.openAvailableAtApple).toHaveBeenCalledTimes(1);
  });

  it("projects catalog and lookup results without poll location, then drives the typed controller", async () => {
    const fake = createRuntime();
    const deps = dependencies();
    installLocalMonitorMessageHandler(fake.runtime, deps);
    const controller = await createRuntimeMonitorController(fake.runtime);
    const result = await controller.getCatalog();
    const lookup = await controller.lookupStores?.({
      market: "ca",
      userPostalInput: "M5V 2T6",
    });
    expect(result?.markets[0]?.stores[0]).toEqual({
      storeNumber: "R001",
      name: "Apple Test",
      city: "Toronto",
      region: "ON",
    });
    expect(lookup).toMatchObject({ kind: "matches" });
    expect(JSON.stringify(lookup)).not.toContain("M5V 2T6");
    expect(JSON.stringify(lookup)).not.toContain("qualified-internal-lookup");
    expect(lookup).toMatchObject({
      kind: "matches",
      stores: [
        {
          storeNumber: "R001",
          name: "Apple Test",
          city: "Toronto",
          region: "ON",
        },
      ],
    });
    expect(JSON.stringify(lookup)).not.toContain("pollLocation");
    await expect(controller.getSnapshot()).resolves.toMatchObject({
      version: 1,
    });
  });

  it("projects only finite lookup outcomes and never relabels provider uncertainty as an empty match", async () => {
    const sender = {
      id: "test-extension",
      url: "chrome-extension://test-extension/app.html",
    };
    for (const outcome of [
      { kind: "unsupported" },
      { kind: "unknown" },
      { kind: "unknown", reason: "apple_blocked" },
      { kind: "throttled" },
      { kind: "matches", stores: [] },
    ] as const) {
      const fake = createRuntime();
      const deps = dependencies();
      deps.lookupStores = vi.fn(async () => outcome);
      installLocalMonitorMessageHandler(fake.runtime, deps);
      await expect(
        fake.dispatch(
          {
            protocol: LOCAL_MONITOR_PROTOCOL,
            type: "LOOKUP_STORES",
            input: { market: "ca", userPostalInput: "M5V 2T6" },
          },
          sender,
        ),
      ).resolves.toEqual({
        protocol: LOCAL_MONITOR_PROTOCOL,
        type: "RESULT",
        request: "LOOKUP_STORES",
        ok: true,
        result: outcome,
      });
    }
  });

  it("rejects poisoned lookup reasons while retaining the legacy reason-less unknown", async () => {
    const fake = createRuntime();
    const deps = dependencies();
    deps.lookupStores = vi.fn(
      async () =>
        ({
          kind: "unknown",
          reason: "https://provider.invalid/token",
        }) as never,
    );
    installLocalMonitorMessageHandler(fake.runtime, deps);
    await expect(
      fake.dispatch(
        {
          protocol: LOCAL_MONITOR_PROTOCOL,
          type: "LOOKUP_STORES",
          input: { market: "ca", userPostalInput: "M5V 2T6" },
        },
        {
          id: "test-extension",
          url: "chrome-extension://test-extension/app.html",
        },
      ),
    ).resolves.toMatchObject({ ok: false, error: "operation_failed" });
  });

  it("carries a closed unknown reason through the typed runtime controller", async () => {
    const fake = createRuntime();
    const deps = dependencies();
    deps.lookupStores = vi.fn(async () => ({
      kind: "unknown" as const,
      reason: "timeout" as const,
    }));
    installLocalMonitorMessageHandler(fake.runtime, deps);
    const controller = await createRuntimeMonitorController(fake.runtime);
    await expect(
      controller.lookupStores?.({
        market: "ca",
        userPostalInput: "M5V 2T6",
      }),
    ).resolves.toEqual({ kind: "unknown", reason: "timeout" });
  });

  it("rejects malformed lookup commands before the port can receive transient location text", async () => {
    const fake = createRuntime();
    const deps = dependencies();
    installLocalMonitorMessageHandler(fake.runtime, deps);
    await expect(
      fake.dispatch(
        {
          protocol: LOCAL_MONITOR_PROTOCOL,
          type: "LOOKUP_STORES",
          input: {
            market: "ca",
            userPostalInput: "M5V 2T6",
            providerDiagnostic: "do not forward",
          },
        },
        {
          id: "test-extension",
          url: "chrome-extension://test-extension/app.html",
        },
      ),
    ).resolves.toMatchObject({ ok: false, error: "invalid_request" });
    expect(deps.lookupStores).not.toHaveBeenCalled();
  });

  it("keeps a legal 2,400-item snapshot within the trusted response bound", async () => {
    const fake = createRuntime();
    const deps = dependencies();
    const snapshot = createMaximumCanonicalSnapshot();
    snapshot.delivery = [];
    deps.engine.getSnapshot = vi.fn(async () => snapshot);
    installLocalMonitorMessageHandler(fake.runtime, deps);
    const controller = await createRuntimeMonitorController(fake.runtime);
    const result = await controller.getSnapshot();
    expect(result.items).toHaveLength(2_400);
    expect(result.items[0]).toMatchObject({ watchId: "watch-0" });
  });

  it("does not reject a full internal delivery ledger that is omitted from UI responses", async () => {
    const fake = createRuntime();
    const deps = dependencies();
    const snapshot = createMaximumCanonicalSnapshot();
    snapshot.items = [];
    deps.engine.getSnapshot = vi.fn(async () => snapshot);
    installLocalMonitorMessageHandler(fake.runtime, deps);
    const controller = await createRuntimeMonitorController(fake.runtime);
    await expect(controller.getSnapshot()).resolves.toMatchObject({
      version: 1,
      pendingDelivery: [],
    });
  });

  it("rejects oversized or wrong-version engine snapshots before sending a public result", async () => {
    const fake = createRuntime();
    const deps = dependencies();
    const snapshot = createEmptySnapshot();
    snapshot.watches = Array.from({ length: 21 }, () => watch) as never;
    deps.engine.getSnapshot = vi.fn(async () => snapshot);
    installLocalMonitorMessageHandler(fake.runtime, deps);
    await expect(
      fake.dispatch(
        { protocol: LOCAL_MONITOR_PROTOCOL, type: "GET_SNAPSHOT" },
        {
          id: "test-extension",
          url: "chrome-extension://test-extension/app.html",
        },
      ),
    ).resolves.toMatchObject({ ok: false, error: "operation_failed" });

    const wrongVersion = createEmptySnapshot() as { version: number };
    wrongVersion.version = 2;
    deps.engine.getSnapshot = vi.fn(async () => wrongVersion as never);
    await expect(
      fake.dispatch(
        { protocol: LOCAL_MONITOR_PROTOCOL, type: "GET_SNAPSHOT" },
        {
          id: "test-extension",
          url: "chrome-extension://test-extension/app.html",
        },
      ),
    ).resolves.toMatchObject({ ok: false, error: "operation_failed" });
  });

  it("requires canonical item, history, and pending-delivery watch references before projection", async () => {
    const fake = createRuntime();
    const deps = dependencies();
    installLocalMonitorMessageHandler(fake.runtime, deps);
    const sender = {
      id: "test-extension",
      url: "chrome-extension://test-extension/app.html",
    };
    const invalidSnapshots = [
      (() => {
        const snapshot = createEmptySnapshot();
        snapshot.watches = [watch];
        snapshot.items = [
          {
            watchId: watch.id,
            market: "us",
            sku: watch.skus[0]!,
            storeNumber: watch.storeNumbers[0]!,
            status: "available",
            lastKnownStatus: "available",
            lastChangedAt: at,
            lastCheckedAt: at,
            lastSuccessfulAt: at,
            consecutiveUnknowns: 0,
          },
        ] as never;
        return snapshot;
      })(),
      (() => {
        const snapshot = createEmptySnapshot();
        snapshot.watches = [watch];
        snapshot.history = [
          {
            watchId: watch.id,
            market: watch.market,
            sku: "MISSING/A",
            storeNumber: watch.storeNumbers[0]!,
            from: null,
            to: "available",
            at,
          },
        ] as never;
        return snapshot;
      })(),
      (() => {
        const snapshot = createEmptySnapshot();
        snapshot.watches = [watch];
        snapshot.pendingDelivery = [
          {
            eventId: "event-one",
            watchUpdatedAt: at,
            event: {
              watchId: watch.id,
              market: "us",
              sku: watch.skus[0]!,
              title: "iPhone",
              storeNumber: watch.storeNumbers[0]!,
              storeName: "Apple Test",
              observedAt: at,
              purchaseUrl: "https://www.apple.com/ca/shop/buy-iphone",
            },
            createdAt: at,
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
          },
        ] as never;
        return snapshot;
      })(),
      (() => {
        const snapshot = createEmptySnapshot();
        snapshot.watches = [watch];
        const item = {
          watchId: watch.id,
          market: watch.market,
          sku: watch.skus[0]!,
          storeNumber: watch.storeNumbers[0]!,
          status: "available",
          lastKnownStatus: "available",
          lastChangedAt: at,
          lastCheckedAt: at,
          lastSuccessfulAt: at,
          consecutiveUnknowns: 0,
        };
        snapshot.items = [item, item] as never;
        return snapshot;
      })(),
      (() => {
        const snapshot = createEmptySnapshot();
        snapshot.watches = [watch];
        snapshot.history = Array.from({ length: 101 }, () => ({
          watchId: watch.id,
          market: watch.market,
          sku: watch.skus[0]!,
          storeNumber: watch.storeNumbers[0]!,
          from: null,
          to: "available",
          at,
        })) as never;
        return snapshot;
      })(),
    ];
    for (const snapshot of invalidSnapshots) {
      deps.engine.getSnapshot = vi.fn(async () => snapshot);
      await expect(
        fake.dispatch(
          { protocol: LOCAL_MONITOR_PROTOCOL, type: "GET_SNAPSHOT" },
          sender,
        ),
      ).resolves.toMatchObject({ ok: false, error: "operation_failed" });
    }
  });

  it("rejects a non-boolean engine mutation reply before it reaches the page", async () => {
    const fake = createRuntime();
    const deps = dependencies();
    deps.engine.deleteWatch = vi.fn(
      async () => ({ secret: "not-public" }) as never,
    );
    installLocalMonitorMessageHandler(fake.runtime, deps);
    await expect(
      fake.dispatch(
        {
          protocol: LOCAL_MONITOR_PROTOCOL,
          type: "DELETE_WATCH",
          id: "watch-one",
        },
        {
          id: "test-extension",
          url: "chrome-extension://test-extension/app.html",
        },
      ),
    ).resolves.toEqual({
      protocol: LOCAL_MONITOR_PROTOCOL,
      type: "RESULT",
      request: "DELETE_WATCH",
      ok: false,
      error: "operation_failed",
    });
  });

  it("rejects an oversized catalog response even if a transport adapter regresses", async () => {
    const fake = createRuntime();
    const deps = dependencies();
    deps.getCatalog = () => ({
      ...catalog,
      markets: Array.from({ length: 4 }, () => catalog.markets[0]!),
    });
    installLocalMonitorMessageHandler(fake.runtime, deps);
    const controller = await createRuntimeMonitorController(fake.runtime);
    await expect(controller.getCatalog()).rejects.toMatchObject({
      code: "operation_failed",
    });
  });

  it("rejects invalid or over-wide catalog callbacks before a UI response", async () => {
    const fake = createRuntime();
    const deps = dependencies();
    installLocalMonitorMessageHandler(fake.runtime, deps);
    const sender = {
      id: "test-extension",
      url: "chrome-extension://test-extension/app.html",
    };
    deps.getCatalog = () => ({ ...catalog, schemaVersion: 2 }) as never;
    await expect(
      fake.dispatch(
        { protocol: LOCAL_MONITOR_PROTOCOL, type: "GET_CATALOG" },
        sender,
      ),
    ).resolves.toMatchObject({ ok: false, error: "operation_failed" });

    deps.getCatalog = () =>
      ({
        ...catalog,
        markets: [
          {
            ...catalog.markets[0]!,
            variants: Array.from({ length: 501 }, (_, index) => ({
              sku: `M${index}/A`,
              title: `iPhone ${index}`,
            })),
          },
        ],
      }) as never;
    await expect(
      fake.dispatch(
        { protocol: LOCAL_MONITOR_PROTOCOL, type: "GET_CATALOG" },
        sender,
      ),
    ).resolves.toMatchObject({ ok: false, error: "operation_failed" });
  });

  it("requires the current catalog version and unique public references in client results", async () => {
    const fake = createRuntime();
    let catalogResult: unknown = {
      schemaVersion: 2,
      generatedAt: at,
      markets: [],
    };
    fake.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const request = (message as { type?: unknown }).type;
      sendResponse({
        protocol: LOCAL_MONITOR_PROTOCOL,
        type: "RESULT",
        request,
        ok: true,
        result:
          request === "GET_CAPABILITIES"
            ? {
                monitor: true,
                catalog: true,
                storeLookup: true,
                personalTelegram: false,
                hostedRelay: false,
              }
            : catalogResult,
      });
      return true;
    });
    const controller = await createRuntimeMonitorController(fake.runtime);
    await expect(controller.getCatalog()).rejects.toMatchObject({
      code: "operation_failed",
    });

    catalogResult = {
      schemaVersion: 1,
      generatedAt: at,
      markets: [
        {
          code: "ca",
          name: "Canada",
          storefrontPath: "/ca",
          variants: [
            { sku: "MFY84VC/A", title: "iPhone" },
            { sku: "MFY84VC/A", title: "Duplicate iPhone" },
          ],
          stores: [],
        },
      ],
    };
    await expect(controller.getCatalog()).rejects.toMatchObject({
      code: "operation_failed",
    });
  });

  it("uses Firefox promise messaging without a callback", async () => {
    const fake = createRuntime();
    installLocalMonitorMessageHandler(fake.runtime, dependencies());
    const original = fake.runtime.sendMessage;
    fake.runtime.sendMessage = (message, callback) => {
      if (callback) throw new Error("Firefox should not receive a callback");
      return original(message);
    };
    vi.stubGlobal("browser", {});
    try {
      await expect(
        createRuntimeMonitorController(fake.runtime),
      ).resolves.toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("normalizes a browser runtime error without exposing its raw message", async () => {
    const fake = createRuntime();
    installLocalMonitorMessageHandler(fake.runtime, dependencies());
    fake.runtime.lastError = { message: "postal M5V 2T6 must stay private" };
    await expect(
      createRuntimeMonitorController(fake.runtime),
    ).rejects.toMatchObject({
      code: "operation_failed",
      message: "The local monitor request could not be completed.",
    });
  });
});
