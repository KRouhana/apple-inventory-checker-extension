import { describe, expect, it } from "vitest";

import {
  createEmptySnapshot,
  type ApplePickupFetchResponse,
  parseLocalWatch,
  type ApplePickupFetchRequest,
  type LocalAvailabilityEvent,
  type LocalCatalogSnapshot,
  type LocalDeliveryChannel,
  type LocalDeliveryDispatchResult,
  type LocalMonitorSnapshot,
  type LocalWatch,
} from "../../../../packages/core/src/local-monitor-contracts.js";
import { LocalMonitorEngine } from "../../src/monitor/local-monitor-engine.js";

const START = Date.parse("2026-09-09T12:00:00.000Z");
const SKU = "MG464LL/A";
const STORE = "R123";
const SECOND_STORE = "R456";

class FakeClock {
  public constructor(private current = START) {}

  public now(): number {
    return this.current;
  }

  public advance(ms: number): void {
    this.current += ms;
  }
}

class FakeStorage {
  public saves: LocalMonitorSnapshot[] = [];

  public constructor(public snapshot: LocalMonitorSnapshot | null = null) {}

  public async load(): Promise<LocalMonitorSnapshot | null> {
    return this.snapshot === null ? null : structuredClone(this.snapshot);
  }

  public async save(snapshot: LocalMonitorSnapshot): Promise<void> {
    this.snapshot = structuredClone(snapshot);
    this.saves.push(structuredClone(snapshot));
  }
}

class FailingStorage extends FakeStorage {
  public override async save(_snapshot: LocalMonitorSnapshot): Promise<void> {
    throw new Error("synthetic storage fault");
  }
}

class FakeScheduler {
  public periodic: number[] = [];
  public oneShot: number[] = [];
  public cancels = 0;

  public schedulePeriodic(intervalSec: number): void {
    this.periodic.push(intervalSec);
  }

  public scheduleOneShot(delayMs: number): void {
    this.oneShot.push(delayMs);
  }

  public cancelAll(): void {
    this.cancels += 1;
  }
}

function watch(overrides: Partial<LocalWatch> = {}): LocalWatch {
  const parsed = parseLocalWatch({
    id: "watch-1",
    market: "us",
    skus: [SKU],
    storeNumbers: [STORE],
    pollAnchor: { storeNumber: STORE },
    createdAt: new Date(START).toISOString(),
    updatedAt: new Date(START).toISOString(),
    ...overrides,
  });
  if (!parsed.success) throw new Error("test watch should parse");
  return parsed.data;
}

const catalog: LocalCatalogSnapshot = {
  schemaVersion: 1,
  generatedAt: "2026-09-09T00:00:00.000Z",
  markets: [
    {
      code: "us",
      name: "United States",
      storefrontPath: "",
      variants: [{ sku: SKU, title: "iPhone 17 256GB Black" }],
      stores: [
        {
          storeNumber: STORE,
          name: "Fifth Avenue",
          city: "New York",
          region: "NY",
          pollLocation: "Apple Fifth Avenue",
        },
      ],
    },
  ],
};

function catalogWithRetiredSku(): LocalCatalogSnapshot {
  return {
    ...catalog,
    generatedAt: "2026-09-11T00:00:00.000Z",
    markets: [
      {
        ...catalog.markets[0]!,
        variants: [
          {
            sku: "MG999LL/A",
            title: "iPhone 18 Pro 256GB Silver",
          },
        ],
      },
    ],
  };
}

function pickupResponse(
  request: ApplePickupFetchRequest,
  status: "available" | "unavailable" = "available",
  options: {
    storeNumbers?: readonly string[];
    partNumber?: string;
    title?: string;
    pickupDisplay?: string;
    storePickEligible?: boolean;
    isBuyable?: boolean | null;
  } = {},
) {
  return {
    httpStatus: 200,
    body: {
      body: {
        stores: (options.storeNumbers ?? [STORE]).map((storeNumber) => ({
          storeNumber,
          storeName: storeNumber === STORE ? "Fifth Avenue" : "SoHo, New York",
          partsAvailability: Object.fromEntries(
            request.skus.map((sku) => [
              sku,
              {
                partNumber: options.partNumber ?? sku,
                storePickEligible: options.storePickEligible ?? true,
                pickupDisplay: options.pickupDisplay ?? status,
                messageTypes: {
                  regular: {
                    storePickupProductTitle:
                      options.title ?? "iPhone 17 256GB Black",
                  },
                },
                ...(options.isBuyable === null
                  ? {}
                  : {
                      buyability: {
                        isBuyable: options.isBuyable ?? status === "available",
                      },
                    }),
              },
            ]),
          ),
        })),
      },
    },
  };
}

function catalogForStores(
  storeNumbers: readonly string[],
): LocalCatalogSnapshot {
  const market = catalog.markets[0]!;
  return {
    ...catalog,
    markets: [
      {
        ...market,
        stores: storeNumbers.map((storeNumber) => ({
          storeNumber,
          name: storeNumber === STORE ? "Fifth Avenue" : "SoHo, New York",
          city: "New York",
          region: "NY",
          pollLocation:
            storeNumber === STORE ? "Apple Fifth Avenue" : "Apple SoHo",
        })),
      },
    ],
  };
}

function eventFor(input: {
  watch: LocalWatch;
  sku: string;
  storeNumber: string;
  title: string;
  storeName: string;
  observedAt: string;
}): LocalAvailabilityEvent {
  return {
    watchId: input.watch.id,
    market: input.watch.market,
    sku: input.sku as LocalAvailabilityEvent["sku"],
    title: input.title,
    storeNumber: input.storeNumber as LocalAvailabilityEvent["storeNumber"],
    storeName: input.storeName,
    observedAt: input.observedAt,
    purchaseUrl: "https://www.apple.com/shop/buy-iphone",
  };
}

function makeEngine(options: {
  clock?: FakeClock;
  storage?: FakeStorage;
  fetch?: (
    request: ApplePickupFetchRequest,
  ) => Promise<ApplePickupFetchResponse>;
  deliver?: (
    channel: LocalDeliveryChannel,
    event: LocalAvailabilityEvent,
    options?: { signal?: AbortSignal },
  ) => Promise<void | LocalDeliveryDispatchResult>;
  catalog?: LocalCatalogSnapshot;
  getCatalog?: () => LocalCatalogSnapshot | null;
  fetchTimeoutMs?: number;
  deliveryTimeoutMs?: number;
  onPickupParseDiagnostic?: (diagnostic: unknown) => void;
}) {
  const clock = options.clock ?? new FakeClock();
  const storage = options.storage ?? new FakeStorage();
  const scheduler = new FakeScheduler();
  let fetchCalls = 0;
  const engine = new LocalMonitorEngine({
    clock,
    storage,
    scheduler,
    catalog: {
      getCatalog: () => options.getCatalog?.() ?? options.catalog ?? catalog,
    },
    fetch: {
      fetchPickup: async (request) => {
        fetchCalls += 1;
        return options.fetch ? options.fetch(request) : pickupResponse(request);
      },
    },
    eventFactory: { create: eventFor },
    deliveryDispatcher: options.deliver
      ? {
          deliver: async (channel, event, deliveryOptions) =>
            options.deliver!(channel, event, deliveryOptions),
        }
      : undefined,
    fetchTimeoutMs: options.fetchTimeoutMs,
    deliveryTimeoutMs: options.deliveryTimeoutMs,
    jitterMs: () => 0,
    onPickupParseDiagnostic: options.onPickupParseDiagnostic as never,
  });
  return { clock, storage, scheduler, engine, fetchCalls: () => fetchCalls };
}

function pendingEntry(
  currentWatch: LocalWatch,
  overrides: Partial<LocalMonitorSnapshot["pendingDelivery"][number]> = {},
): LocalMonitorSnapshot["pendingDelivery"][number] {
  return {
    eventId: "event-1",
    watchUpdatedAt: currentWatch.updatedAt,
    createdAt: new Date(START).toISOString(),
    event: eventFor({
      watch: currentWatch,
      sku: SKU,
      storeNumber: STORE,
      title: "iPhone 17 256GB Black",
      storeName: "Fifth Avenue",
      observedAt: new Date(START).toISOString(),
    }),
    channels: [
      {
        channel: "desktop",
        state: "pending",
        attempts: 0,
        nextAttemptAt: new Date(START).toISOString(),
        lastAttemptAt: null,
        completedAt: null,
      },
    ],
    ...overrides,
  };
}

describe("LocalMonitorEngine", () => {
  it.each([
    {
      response: (_request: ApplePickupFetchRequest) => ({
        httpStatus: 541,
        body: "private provider body",
      }),
      failure: { reason: "http_error", httpStatus: 541 },
    },
    {
      response: (_request: ApplePickupFetchRequest) => ({
        httpStatus: 599,
        body: null,
      }),
      failure: { reason: "request_failed" },
    },
    {
      response: (_request: ApplePickupFetchRequest) => ({
        httpStatus: 200,
        body: "private provider body",
      }),
      failure: { reason: "invalid_response" },
    },
    {
      response: (request: ApplePickupFetchRequest) =>
        pickupResponse(request, "available", { title: "Different phone" }),
      failure: { reason: "identity_mismatch" },
    },
    {
      response: (request: ApplePickupFetchRequest) =>
        pickupResponse(request, "available", { storeNumbers: [SECOND_STORE] }),
      failure: { reason: "missing_result" },
    },
    {
      response: (request: ApplePickupFetchRequest) =>
        pickupResponse(request, "available", { pickupDisplay: "unexpected" }),
      failure: { reason: "unrecognized_availability" },
    },
  ])(
    "persists safe $failure.reason diagnostics and clears them on recovery",
    async ({ response, failure }) => {
      let fail = true;
      const { engine, clock, storage } = makeEngine({
        fetch: async (request) =>
          fail ? response(request) : pickupResponse(request),
      });
      await engine.addWatch(
        watch({
          deliveryChannels: {
            desktop: false,
            personalTelegram: false,
            hostedRelay: false,
          },
        }),
      );
      await engine.wake();
      const first = await engine.getSnapshot();
      expect(first.items[0]).toMatchObject({
        status: "unknown",
        lastKnownStatus: null,
        lastSuccessfulAt: null,
        lastFailure: failure,
      });
      expect(first.pendingDelivery).toHaveLength(0);
      expect(JSON.stringify(storage.snapshot)).not.toContain(
        "private provider body",
      );
      const restarted = makeEngine({ storage });
      expect(
        (await restarted.engine.getSnapshot()).items[0]?.lastFailure,
      ).toEqual(failure);
      fail = false;
      clock.advance(60 * 60 * 1000);
      await engine.wake();
      const recovered = (await engine.getSnapshot()).items[0]!;
      expect(recovered.status).toBe("available");
      expect(recovered.lastFailure).toBeUndefined();
      expect(recovered.lastSuccessfulAt).not.toBeNull();
    },
  );

  it("persists an initial-availability event before any channel dispatch", async () => {
    const { engine, storage, fetchCalls } = makeEngine({});
    await engine.addWatch(watch());

    const report = await engine.wake();

    expect(fetchCalls()).toBe(1);
    expect(report.queuedEvents).toBe(1);
    expect(
      storage.saves.some((snapshot) =>
        snapshot.pendingDelivery.some(
          (pending) => pending.channels[0]?.state === "pending",
        ),
      ),
    ).toBe(true);
    const snapshot = await engine.getSnapshot();
    expect(snapshot.items[0]).toMatchObject({
      status: "available",
      lastKnownStatus: "available",
    });
    expect(snapshot.history[0]).toMatchObject({ from: null, to: "available" });
  });

  it("delivers one canonical available event for a product title with non-breaking spaces", async () => {
    const delivered: Array<{
      channel: LocalDeliveryChannel;
      event: LocalAvailabilityEvent;
    }> = [];
    const { clock, engine } = makeEngine({
      fetch: async (request) =>
        pickupResponse(request, "available", {
          title: "iPhone\u00a017\u202f256GB Black",
        }),
      deliver: async (channel, event) => {
        delivered.push({ channel, event });
      },
    });
    await engine.addWatch(
      watch({
        deliveryChannels: {
          desktop: true,
          personalTelegram: true,
          hostedRelay: false,
        },
      }),
    );

    const initial = await engine.wake();

    expect(initial).toMatchObject({ attemptedBatches: 1, queuedEvents: 1 });
    expect(delivered).toEqual([
      {
        channel: "desktop",
        event: expect.objectContaining({
          watchId: "watch-1",
          market: "us",
          sku: SKU,
          storeNumber: STORE,
          title: "iPhone 17 256GB Black",
          storeName: "Fifth Avenue",
          observedAt: new Date(START).toISOString(),
        }),
      },
      {
        channel: "personalTelegram",
        event: expect.objectContaining({
          watchId: "watch-1",
          market: "us",
          sku: SKU,
          storeNumber: STORE,
          title: "iPhone 17 256GB Black",
          storeName: "Fifth Avenue",
          observedAt: new Date(START).toISOString(),
        }),
      },
    ]);

    clock.advance(120_000);
    const unchanged = await engine.wake();

    expect(unchanged).toMatchObject({ attemptedBatches: 1, queuedEvents: 0 });
    expect(delivered).toHaveLength(2);
  });

  it("recovers durable delivery after a worker restart", async () => {
    const initial = makeEngine({});
    await initial.engine.addWatch(watch());
    await initial.engine.wake();
    const storage = new FakeStorage(await initial.engine.getSnapshot());
    const delivered: LocalDeliveryChannel[] = [];
    const resumed = makeEngine({
      storage,
      deliver: async (channel) => {
        delivered.push(channel);
      },
    });

    await resumed.engine.wake();

    expect(delivered).toEqual(["desktop"]);
    expect(
      (await resumed.engine.getSnapshot()).pendingDelivery[0]?.channels[0],
    ).toMatchObject({ state: "delivered", attempts: 1 });
  });

  it("keeps last known stock through malformed upstream data and applies backoff", async () => {
    const responses = [
      async (request: ApplePickupFetchRequest) => pickupResponse(request),
      async () => ({ httpStatus: 200, body: "<html>blocked</html>" }),
    ];
    let index = 0;
    const { clock, engine } = makeEngine({
      fetch: async (request) => responses[index++]!(request),
    });
    await engine.addWatch(watch());
    await engine.wake();
    clock.advance(120_000);

    await engine.wake();

    const snapshot = await engine.getSnapshot();
    expect(snapshot.items[0]).toMatchObject({
      status: "unknown",
      lastKnownStatus: "available",
      consecutiveUnknowns: 1,
    });
    expect(snapshot.runtime.consecutiveFetchFailures).toBe(1);
    expect(snapshot.runtime.nextEligibleAt).not.toBeNull();
  });

  it("emits the core parser's finite failure reason without changing unknown handling", async () => {
    const diagnostics: unknown[] = [];
    const { engine } = makeEngine({
      fetch: async () => ({ httpStatus: 200, body: "<html>blocked</html>" }),
      onPickupParseDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await engine.addWatch(watch());
    await engine.wake();
    expect(diagnostics).toEqual([
      {
        outcome: "failure",
        reason: "invalid_json",
        storeCount: 0,
        observationCount: 0,
        targetStatus: "not_parsed",
        targetAvailability: null,
        identityMismatch: null,
      },
    ]);
    expect((await engine.getSnapshot()).items[0]?.status).toBe("unknown");
  });

  it.each([
    [
      "available",
      "available",
      true,
      true,
      "available",
      {
        pickupDisplay: "available",
        pickupDisplayToken: null,
        storePickEligible: true,
        isBuyable: true,
      },
    ],
    [
      "unknown",
      "PickupReady",
      true,
      null,
      "unknown",
      {
        pickupDisplay: "other",
        pickupDisplayToken: "PickupReady",
        storePickEligible: true,
        isBuyable: null,
      },
    ],
    [
      "unknown",
      "Pickup ready",
      true,
      null,
      "unknown",
      {
        pickupDisplay: "other",
        pickupDisplayToken: "Pickup ready",
        storePickEligible: true,
        isBuyable: null,
      },
    ],
    [
      "unknown",
      "https://provider.invalid",
      true,
      null,
      "unknown",
      {
        pickupDisplay: "other",
        pickupDisplayToken: null,
        storePickEligible: true,
        isBuyable: null,
      },
    ],
    [
      "unknown",
      "Pickup\u0000ready",
      true,
      null,
      "unknown",
      {
        pickupDisplay: "other",
        pickupDisplayToken: null,
        storePickEligible: true,
        isBuyable: null,
      },
    ],
    [
      "unknown",
      "Pickup ready\n",
      true,
      null,
      "unknown",
      {
        pickupDisplay: "other",
        pickupDisplayToken: null,
        storePickEligible: true,
        isBuyable: null,
      },
    ],
    [
      "unknown",
      "Pickup ready\r\n",
      true,
      null,
      "unknown",
      {
        pickupDisplay: "other",
        pickupDisplayToken: null,
        storePickEligible: true,
        isBuyable: null,
      },
    ],
    [
      "unknown",
      "Pickup ready\u2028",
      true,
      null,
      "unknown",
      {
        pickupDisplay: "other",
        pickupDisplayToken: null,
        storePickEligible: true,
        isBuyable: null,
      },
    ],
    [
      "ineligible",
      "ineligible",
      true,
      null,
      "ineligible",
      {
        pickupDisplay: "ineligible",
        pickupDisplayToken: null,
        storePickEligible: true,
        isBuyable: null,
      },
    ],
    [
      "ineligible",
      "ineligible",
      false,
      false,
      "ineligible",
      {
        pickupDisplay: "ineligible",
        pickupDisplayToken: null,
        storePickEligible: false,
        isBuyable: false,
      },
    ],
    [
      "unknown",
      "ineligible",
      true,
      true,
      "unknown",
      {
        pickupDisplay: "ineligible",
        pickupDisplayToken: null,
        storePickEligible: true,
        isBuyable: true,
      },
    ],
  ])(
    "projects finite target availability flags for a single anchor %s observation",
    async (
      expectedStatus,
      pickupDisplay,
      storePickEligible,
      isBuyable,
      targetStatus,
      targetAvailability,
    ) => {
      const diagnostics: unknown[] = [];
      const { engine } = makeEngine({
        fetch: async (request) =>
          pickupResponse(request, "available", {
            pickupDisplay,
            storePickEligible,
            isBuyable,
          }),
        onPickupParseDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });
      await engine.addWatch(watch());

      await engine.wake();

      expect(diagnostics).toEqual([
        expect.objectContaining({
          outcome: "success",
          targetStatus,
          targetAvailability,
        }),
      ]);
      expect((await engine.getSnapshot()).items[0]?.status).toBe(
        expectedStatus,
      );
    },
  );

  it("records an initial ineligible observation as known without alerting, then alerts once when available", async () => {
    const delivered: LocalDeliveryChannel[] = [];
    const responses = [
      (request: ApplePickupFetchRequest) =>
        pickupResponse(request, "unavailable", {
          pickupDisplay: "ineligible",
          storePickEligible: true,
          isBuyable: null,
        }),
      (request: ApplePickupFetchRequest) => pickupResponse(request),
      (request: ApplePickupFetchRequest) => pickupResponse(request),
    ];
    let responseIndex = 0;
    const { clock, engine } = makeEngine({
      fetch: async (request) => responses[responseIndex++]!(request),
      deliver: async (channel) => {
        delivered.push(channel);
      },
    });
    await engine.addWatch(watch());

    const initial = await engine.wake();
    expect(initial).toMatchObject({ queuedEvents: 0 });
    expect((await engine.getSnapshot()).items[0]).toMatchObject({
      status: "ineligible",
      lastKnownStatus: "ineligible",
      lastSuccessfulAt: new Date(START).toISOString(),
    });
    expect(delivered).toEqual([]);

    clock.advance(120_000);
    const available = await engine.wake();
    expect(available).toMatchObject({ queuedEvents: 1 });
    expect(delivered).toEqual(["desktop"]);

    clock.advance(120_000);
    const unchanged = await engine.wake();
    expect(unchanged).toMatchObject({ queuedEvents: 0 });
    expect(delivered).toEqual(["desktop"]);
  });

  it("withholds target availability when multiple anchor observations disagree", async () => {
    const diagnostics: unknown[] = [];
    const { engine } = makeEngine({
      fetch: async (request) => {
        const response = pickupResponse(request);
        const duplicate = structuredClone(response.body.body.stores[0]!);
        duplicate.partsAvailability[SKU]!.pickupDisplay = "unavailable";
        duplicate.partsAvailability[SKU]!.buyability = { isBuyable: false };
        response.body.body.stores.push(duplicate);
        return response;
      },
      onPickupParseDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await engine.addWatch(watch());

    await engine.wake();

    expect(diagnostics).toEqual([
      expect.objectContaining({
        outcome: "success",
        targetStatus: "mixed",
        targetAvailability: null,
      }),
    ]);
    // The pre-existing transition continues to consume its first observation.
    expect((await engine.getSnapshot()).items[0]?.status).toBe("available");
  });

  it("projects only the first safe public identity mismatch, including printable non-breaking typography", async () => {
    const diagnostics: unknown[] = [];
    const expectedTitle = "iPhone 17 256GB Black";
    const observedTitle = "iPhone\u202f17 256GB Blue";
    const { engine } = makeEngine({
      catalog: {
        ...catalog,
        markets: [
          {
            ...catalog.markets[0]!,
            variants: [{ sku: SKU, title: expectedTitle }],
          },
        ],
      },
      fetch: async (request) =>
        pickupResponse(request, "available", { title: observedTitle }),
      onPickupParseDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await engine.addWatch(watch());

    await engine.wake();

    expect(diagnostics).toEqual([
      {
        outcome: "failure",
        reason: "identity_validation_failed",
        storeCount: 0,
        observationCount: 0,
        targetStatus: "not_parsed",
        targetAvailability: null,
        identityMismatch: {
          kind: "public_product",
          requestedSku: SKU,
          expectedTitle,
          observedTitle: "iPhone 17 256GB Blue",
        },
      },
    ]);
    expect((await engine.getSnapshot()).items[0]?.status).toBe("unknown");
  });

  it.each([
    ["an overlong SKU", "M".repeat(31) + "/A", "iPhone 17 256GB Blue"],
    ["an overlong title", SKU, "iPhone " + "A".repeat(194)],
    ["a control character in a title", SKU, "iPhone 17\u0000 Black"],
    ["HTML in a title", SKU, "iPhone <b>17</b> Black"],
    ["a URL in a title", SKU, "iPhone www.example.com"],
  ])(
    "redacts %s from the identity mismatch diagnostic",
    async (_case, sku, title) => {
      const diagnostics: unknown[] = [];
      const { engine } = makeEngine({
        catalog: {
          ...catalog,
          markets: [
            {
              ...catalog.markets[0]!,
              variants: [{ sku, title: "iPhone 17 256GB Black" }],
            },
          ],
        },
        fetch: async (request) =>
          pickupResponse(request, "available", { title }),
        onPickupParseDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });
      await engine.addWatch(watch({ skus: [sku] }));

      await engine.wake();

      expect(diagnostics).toEqual([
        expect.objectContaining({
          outcome: "failure",
          reason: "identity_validation_failed",
          identityMismatch: { kind: "redacted" },
        }),
      ]);
    },
  );

  it("contains diagnostic callback failures without changing identity mismatch handling", async () => {
    const { engine } = makeEngine({
      fetch: async (request) =>
        pickupResponse(request, "available", { title: "iPhone 17 256GB Blue" }),
      onPickupParseDiagnostic: () => {
        throw new Error("diagnostic callback failed");
      },
    });
    await engine.addWatch(watch());

    await expect(engine.wake()).resolves.toMatchObject({ kind: "completed" });
    expect((await engine.getSnapshot()).items[0]?.status).toBe("unknown");
  });

  it("keeps a retired saved watch inert without fetching or delivering it", async () => {
    const currentWatch = watch();
    const seed = createEmptySnapshot();
    seed.watches = [currentWatch];
    seed.items = [
      {
        watchId: currentWatch.id,
        market: currentWatch.market,
        sku: SKU,
        storeNumber: STORE,
        status: "available",
        lastKnownStatus: "available",
        lastChangedAt: new Date(START).toISOString(),
        lastCheckedAt: new Date(START - 60_000).toISOString(),
        lastSuccessfulAt: new Date(START).toISOString(),
        consecutiveUnknowns: 0,
      },
    ];
    seed.pendingDelivery = [pendingEntry(currentWatch)];
    const delivered: LocalDeliveryChannel[] = [];
    const { engine, fetchCalls } = makeEngine({
      storage: new FakeStorage(seed),
      catalog: catalogWithRetiredSku(),
      deliver: async (channel) => {
        delivered.push(channel);
      },
    });

    const report = await engine.wake();
    const recovered = await engine.getSnapshot();

    expect(report).toMatchObject({
      attemptedBatches: 0,
      unsupportedWatchIds: [currentWatch.id],
      queuedEvents: 0,
    });
    expect(fetchCalls()).toBe(0);
    expect(delivered).toEqual([]);
    // The watch and durable ledger remain visible for recovery; neither is
    // quietly deleted just because the active catalog retired its SKU.
    expect(recovered.watches).toEqual([currentWatch]);
    expect(recovered.items[0]).toMatchObject({
      status: "unknown",
      lastKnownStatus: "available",
    });
    expect(recovered.pendingDelivery[0]?.channels[0]).toMatchObject({
      state: "superseded",
      attempts: 0,
      nextAttemptAt: null,
    });
  });

  it("does not deliver a retired saved watch while Apple polling is backed off", async () => {
    const currentWatch = watch();
    const seed = createEmptySnapshot();
    seed.watches = [currentWatch];
    seed.items = [
      {
        watchId: currentWatch.id,
        market: currentWatch.market,
        sku: SKU,
        storeNumber: STORE,
        status: "available",
        lastKnownStatus: "available",
        lastChangedAt: new Date(START).toISOString(),
        lastCheckedAt: new Date(START - 30_000).toISOString(),
        lastSuccessfulAt: new Date(START).toISOString(),
        consecutiveUnknowns: 0,
      },
    ];
    seed.pendingDelivery = [pendingEntry(currentWatch)];
    seed.runtime.nextEligibleAt = new Date(START + 60_000).toISOString();
    const delivered: LocalDeliveryChannel[] = [];
    const { engine, fetchCalls } = makeEngine({
      storage: new FakeStorage(seed),
      catalog: catalogWithRetiredSku(),
      deliver: async (channel) => {
        delivered.push(channel);
      },
    });

    const report = await engine.wake();
    const recovered = await engine.getSnapshot();

    expect(report.kind).toBe("host_backoff");
    expect(fetchCalls()).toBe(0);
    expect(delivered).toEqual([]);
    expect(recovered.watches).toEqual([currentWatch]);
    expect(recovered.items[0]).toMatchObject({
      status: "unknown",
      lastKnownStatus: "available",
      // Catalog retirement is not an Apple request; timing remains historical.
      lastCheckedAt: new Date(START - 30_000).toISOString(),
      lastSuccessfulAt: new Date(START).toISOString(),
    });
    expect(recovered.pendingDelivery[0]?.channels[0]).toMatchObject({
      state: "superseded",
      attempts: 0,
      nextAttemptAt: null,
    });
  });

  it("projects a retired available item as unknown without mutating a snapshot read", async () => {
    const currentWatch = watch();
    const seed = createEmptySnapshot();
    seed.watches = [currentWatch];
    seed.items = [
      {
        watchId: currentWatch.id,
        market: currentWatch.market,
        sku: SKU,
        storeNumber: STORE,
        status: "available",
        lastKnownStatus: "available",
        lastChangedAt: new Date(START).toISOString(),
        lastCheckedAt: new Date(START).toISOString(),
        lastSuccessfulAt: new Date(START).toISOString(),
        consecutiveUnknowns: 0,
      },
    ];
    const storage = new FakeStorage(seed);
    let activeCatalog: LocalCatalogSnapshot = catalogWithRetiredSku();
    const { engine, fetchCalls } = makeEngine({
      storage,
      getCatalog: () => activeCatalog,
    });

    const projected = await engine.getSnapshot();

    expect(fetchCalls()).toBe(0);
    expect(storage.saves).toEqual([]);
    expect(storage.snapshot?.items[0]).toMatchObject({ status: "available" });
    expect(projected.watches).toEqual([currentWatch]);
    expect(projected.items[0]).toMatchObject({
      status: "unknown",
      lastKnownStatus: "available",
      lastCheckedAt: new Date(START).toISOString(),
      lastSuccessfulAt: new Date(START).toISOString(),
    });
    expect(projected.history).toEqual([]);

    // Changing the catalog back proves the engine's in-memory snapshot was
    // not changed by the read-only projection.
    activeCatalog = catalog;
    expect((await engine.getSnapshot()).items[0]).toMatchObject({
      status: "available",
      lastKnownStatus: "available",
    });

    // A later durable cycle owns the actual retirement reconciliation.
    activeCatalog = catalogWithRetiredSku();
    await engine.wake();
    expect(storage.snapshot?.items[0]).toMatchObject({
      status: "unknown",
      lastKnownStatus: "available",
    });
  });

  it("retires stale state for both not-due and paused watches without polling", async () => {
    const notDue = watch({ id: "watch-not-due" });
    const paused = watch({ id: "watch-paused", enabled: false });
    const seed = createEmptySnapshot();
    seed.watches = [notDue, paused];
    seed.items = [notDue, paused].map((currentWatch) => ({
      watchId: currentWatch.id,
      market: currentWatch.market,
      sku: SKU,
      storeNumber: STORE,
      status: "available" as const,
      lastKnownStatus: "available" as const,
      lastChangedAt: new Date(START).toISOString(),
      lastCheckedAt: new Date(START).toISOString(),
      lastSuccessfulAt: new Date(START).toISOString(),
      consecutiveUnknowns: 0,
    }));
    const { engine, fetchCalls } = makeEngine({
      storage: new FakeStorage(seed),
      catalog: catalogWithRetiredSku(),
    });

    const report = await engine.wake();
    const snapshot = await engine.getSnapshot();

    expect(report).toMatchObject({
      attemptedBatches: 0,
      unsupportedWatchIds: [notDue.id, paused.id],
    });
    expect(fetchCalls()).toBe(0);
    expect(snapshot.watches).toEqual([notDue, paused]);
    expect(snapshot.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          watchId: notDue.id,
          status: "unknown",
          lastCheckedAt: new Date(START).toISOString(),
        }),
        expect.objectContaining({
          watchId: paused.id,
          status: "unknown",
          lastCheckedAt: new Date(START).toISOString(),
        }),
      ]),
    );
  });

  it("marks an omitted selected store unknown without manufacturing an alert", async () => {
    const multiStoreCatalog = catalogForStores([STORE, SECOND_STORE]);
    const currentWatch = watch({
      storeNumbers: [STORE, SECOND_STORE],
      pollAnchor: { storeNumber: STORE },
    });
    const clock = new FakeClock();
    const initial = makeEngine({
      clock,
      catalog: multiStoreCatalog,
      fetch: async (request) =>
        pickupResponse(request, "available", {
          storeNumbers: [STORE, SECOND_STORE],
        }),
    });
    await initial.engine.addWatch(currentWatch);
    await initial.engine.wake();
    const seeded = await initial.engine.getSnapshot();
    seeded.history = [];
    seeded.pendingDelivery = [];

    clock.advance(120_000);
    const revalidated = makeEngine({
      clock,
      storage: new FakeStorage(seeded),
      catalog: multiStoreCatalog,
      fetch: async (request) =>
        pickupResponse(request, "available", { storeNumbers: [STORE] }),
    });

    const report = await revalidated.engine.wake();
    const snapshot = await revalidated.engine.getSnapshot();
    const itemsByStore = Object.fromEntries(
      snapshot.items.map((item) => [item.storeNumber, item]),
    );

    expect(report).toMatchObject({ attemptedBatches: 1, queuedEvents: 0 });
    expect(snapshot.pendingDelivery).toEqual([]);
    expect(itemsByStore[STORE]).toMatchObject({
      status: "available",
      lastKnownStatus: "available",
      lastSuccessfulAt: new Date(START + 120_000).toISOString(),
    });
    expect(itemsByStore[SECOND_STORE]).toMatchObject({
      status: "unknown",
      lastKnownStatus: "available",
      lastSuccessfulAt: new Date(START).toISOString(),
      consecutiveUnknowns: 1,
    });
  });

  it("marks every selected store unknown when a valid response has no stores", async () => {
    const multiStoreCatalog = catalogForStores([STORE, SECOND_STORE]);
    const { engine } = makeEngine({
      catalog: multiStoreCatalog,
      fetch: async (request) =>
        pickupResponse(request, "available", { storeNumbers: [] }),
    });
    await engine.addWatch(
      watch({
        storeNumbers: [STORE, SECOND_STORE],
        pollAnchor: { storeNumber: STORE },
      }),
    );

    const report = await engine.wake();
    const snapshot = await engine.getSnapshot();

    expect(report).toMatchObject({ attemptedBatches: 1, queuedEvents: 0 });
    expect(snapshot.pendingDelivery).toEqual([]);
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          storeNumber: STORE,
          status: "unknown",
          lastKnownStatus: null,
          lastSuccessfulAt: null,
        }),
        expect.objectContaining({
          storeNumber: SECOND_STORE,
          status: "unknown",
          lastKnownStatus: null,
          lastSuccessfulAt: null,
        }),
      ]),
    );
  });

  it.each([
    {
      name: "an HTTP error",
      response: (_request: ApplePickupFetchRequest) => ({
        httpStatus: 541,
        body: null,
      }),
    },
    {
      name: "a returned SKU mismatch",
      response: (request: ApplePickupFetchRequest) =>
        pickupResponse(request, "available", { partNumber: "OTHER-SKU" }),
    },
    {
      name: "a returned title mismatch",
      response: (request: ApplePickupFetchRequest) =>
        pickupResponse(request, "available", { title: "Different product" }),
    },
  ])(
    "preserves prior known state and queues no alert after $name",
    async ({ response }) => {
      const { clock, engine } = makeEngine({
        fetch: async (request) => pickupResponse(request),
      });
      await engine.addWatch(watch());
      await engine.wake();
      const seeded = await engine.getSnapshot();
      seeded.history = [];
      seeded.pendingDelivery = [];
      clock.advance(120_000);

      const revalidated = makeEngine({
        clock,
        storage: new FakeStorage(seeded),
        fetch: async (request) => response(request),
      });
      const report = await revalidated.engine.wake();
      const snapshot = await revalidated.engine.getSnapshot();

      expect(report).toMatchObject({ attemptedBatches: 1, queuedEvents: 0 });
      expect(snapshot.pendingDelivery).toEqual([]);
      expect(snapshot.items[0]).toMatchObject({
        status: "unknown",
        lastKnownStatus: "available",
        lastSuccessfulAt: new Date(START).toISOString(),
        consecutiveUnknowns: 1,
      });
      expect(snapshot.runtime.consecutiveFetchFailures).toBe(1);
    },
  );

  it("serializes duplicate alarms into one fetch cycle", async () => {
    let resolveFetch:
      | ((value: ReturnType<typeof pickupResponse>) => void)
      | null = null;
    const gate = new Promise<ReturnType<typeof pickupResponse>>((resolve) => {
      resolveFetch = resolve;
    });
    const { engine, fetchCalls } = makeEngine({ fetch: async () => gate });
    await engine.addWatch(watch());
    const first = engine.wake();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const duplicate = await engine.wake();
    expect(duplicate.kind).toBe("busy");
    expect(fetchCalls()).toBe(1);
    resolveFetch!(
      pickupResponse({
        market: "us",
        anchorStoreNumber: STORE,
        location: "Apple Fifth Avenue",
        skus: [SKU],
      }),
    );
    expect((await first).kind).toBe("completed");
  });

  it("invalidates a deleted watch while its request is in flight", async () => {
    let resolveFetch:
      | ((value: ReturnType<typeof pickupResponse>) => void)
      | null = null;
    const gate = new Promise<ReturnType<typeof pickupResponse>>((resolve) => {
      resolveFetch = resolve;
    });
    const { engine } = makeEngine({ fetch: async () => gate });
    await engine.addWatch(watch());
    const running = engine.wake();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await engine.deleteWatch("watch-1")).toBe(true);
    resolveFetch!(
      pickupResponse({
        market: "us",
        anchorStoreNumber: STORE,
        location: "Apple Fifth Avenue",
        skus: [SKU],
      }),
    );
    await running;

    const snapshot = await engine.getSnapshot();
    expect(snapshot).toEqual(createEmptySnapshot());
  });

  it("isolates channel failures and retries their durable work", async () => {
    const delivered: LocalDeliveryChannel[] = [];
    let telegramAttempts = 0;
    const { clock, engine } = makeEngine({
      deliver: async (channel) => {
        if (channel === "personalTelegram" && telegramAttempts++ === 0) {
          throw new Error("synthetic channel failure");
        }
        delivered.push(channel);
      },
    });
    await engine.addWatch(
      watch({
        deliveryChannels: {
          desktop: true,
          personalTelegram: true,
          hostedRelay: false,
        },
      }),
    );
    await engine.wake();
    let snapshot = await engine.getSnapshot();
    expect(delivered).toEqual(["desktop"]);
    expect(snapshot.pendingDelivery[0]?.channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: "desktop", state: "delivered" }),
        expect.objectContaining({
          channel: "personalTelegram",
          state: "pending",
          attempts: 1,
        }),
      ]),
    );

    clock.advance(1_000);
    await engine.wake();
    snapshot = await engine.getSnapshot();
    expect(delivered).toEqual(["desktop", "personalTelegram"]);
    expect(snapshot.pendingDelivery[0]?.channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "personalTelegram",
          state: "delivered",
          attempts: 2,
        }),
      ]),
    );
  });

  it("expires stale pending delivery instead of replaying it after wake", async () => {
    const delivered: LocalDeliveryChannel[] = [];
    const { clock, engine } = makeEngine({
      deliver: async (channel) => {
        delivered.push(channel);
      },
    });
    await engine.addWatch(watch());
    // First queue while no dispatcher can run, then rehydrate a worker that has one.
    const initial = makeEngine({});
    await initial.engine.addWatch(watch());
    await initial.engine.wake();
    const storage = new FakeStorage(await initial.engine.getSnapshot());
    const resumed = makeEngine({
      clock,
      storage,
      deliver: async (channel) => {
        delivered.push(channel);
      },
    });
    clock.advance(10 * 60_000 + 1);
    await resumed.engine.wake();
    const snapshot = await resumed.engine.getSnapshot();
    expect(delivered).toEqual([]);
    expect(snapshot.pendingDelivery[0]?.channels[0]).toMatchObject({
      state: "expired",
    });
  });

  it("reports storage faults without claiming a completed cycle", async () => {
    const snapshot = createEmptySnapshot();
    snapshot.watches = [watch()];
    const storage = new FailingStorage(snapshot);
    const { engine } = makeEngine({ storage });

    const report = await engine.wake();

    expect(report.kind).toBe("storage_error");
  });

  it("does not let check-now bypass a persisted Retry-After backoff", async () => {
    const { engine, fetchCalls } = makeEngine({
      fetch: async () => ({
        httpStatus: 429,
        body: "blocked",
        retryAfterMs: 10 * 60_000,
      }),
    });
    await engine.addWatch(watch());
    await engine.wake();

    const report = await engine.checkNow(["watch-1"]);

    expect(fetchCalls()).toBe(1);
    expect(report.kind).toBe("host_backoff");
  });

  it("bounds a fetch adapter that ignores AbortSignal and releases the worker", async () => {
    const { engine } = makeEngine({
      fetch: async () => new Promise<ApplePickupFetchResponse>(() => {}),
      fetchTimeoutMs: 5,
    });
    await engine.addWatch(watch());

    const report = await Promise.race([
      engine.wake(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("fetch timeout was not bounded")),
          100,
        ),
      ),
    ]);

    expect(report.kind).toBe("completed");
    expect((await engine.getSnapshot()).items[0]?.status).toBe("unknown");
    expect((await engine.wake()).kind).not.toBe("busy");
  });

  it("rechecks deletion after the pre-delivery write before dispatching", async () => {
    const seeded = makeEngine({});
    await seeded.engine.addWatch(watch());
    await seeded.engine.wake();
    let release: (() => void) | undefined;
    let saves = 0;
    class GateStorage extends FakeStorage {
      public override async save(
        snapshot: LocalMonitorSnapshot,
      ): Promise<void> {
        saves += 1;
        if (saves === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        await super.save(snapshot);
      }
    }
    const storage = new GateStorage(await seeded.engine.getSnapshot());
    let delivered = 0;
    const run = makeEngine({
      storage,
      deliver: async () => {
        delivered += 1;
      },
    });
    const cycle = run.engine.wake();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const deletion = run.engine.deleteWatch("watch-1");
    release?.();
    await deletion;
    await cycle;

    expect(delivered).toBe(0);
  });

  it("revokes active permission-gated delivery before pause, channel-off, delete, or reset", async () => {
    const seeded = makeEngine({});
    await seeded.engine.addWatch(watch());
    await seeded.engine.wake();
    const baseSnapshot = await seeded.engine.getSnapshot();

    const mutations: Array<{
      name: string;
      run: (engine: LocalMonitorEngine) => Promise<unknown>;
    }> = [
      {
        name: "pause",
        run: (engine) => engine.setWatchEnabled("watch-1", false),
      },
      {
        name: "channel-off",
        run: async (engine) => {
          const current = (await engine.getSnapshot()).watches[0]!;
          return engine.replaceWatch({
            ...current,
            deliveryChannels: { ...current.deliveryChannels, desktop: false },
          });
        },
      },
      {
        name: "delete",
        run: (engine) => engine.deleteWatch("watch-1"),
      },
      { name: "reset", run: (engine) => engine.reset() },
    ];

    for (const mutation of mutations) {
      let releasePermission: (() => void) | undefined;
      let markStarted: (() => void) | undefined;
      const permissionRequested = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const permissionGranted = new Promise<void>((resolve) => {
        releasePermission = resolve;
      });
      let notifications = 0;
      const { engine } = makeEngine({
        storage: new FakeStorage(structuredClone(baseSnapshot)),
        deliver: async (_channel, _event, options) => {
          markStarted?.();
          await permissionGranted;
          // Mirrors the DesktopAlert adapter boundary: the engine owns
          // cancellation, while the platform checks it before the irreversible
          // notification call.
          if (!options?.signal?.aborted) notifications += 1;
        },
      });

      const cycle = engine.wake();
      await permissionRequested;
      await mutation.run(engine);
      releasePermission?.();
      await Promise.race([
        cycle,
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () => reject(new Error(`${mutation.name} did not abort delivery`)),
            100,
          ),
        ),
      ]);

      expect(notifications, mutation.name).toBe(0);
      expect(
        (await engine.getSnapshot()).pendingDelivery.flatMap((pending) =>
          pending.channels.map((channel) => channel.state),
        ),
        mutation.name,
      ).not.toContain("pending");
    }
  });

  it("settles a revoked delivery even when an adapter ignores AbortSignal", async () => {
    const seeded = makeEngine({});
    await seeded.engine.addWatch(watch());
    await seeded.engine.wake();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const { engine } = makeEngine({
      storage: new FakeStorage(await seeded.engine.getSnapshot()),
      deliver: async () => {
        markStarted?.();
        return new Promise<void>(() => {});
      },
    });

    const cycle = engine.wake();
    await started;
    await engine.deleteWatch("watch-1");
    await Promise.race([
      cycle,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("mutation did not settle delivery")),
          100,
        ),
      ),
    ]);
    expect((await engine.getSnapshot()).pendingDelivery).toEqual([]);
  });

  it("recovers from valid but implausibly future persisted timestamps", async () => {
    const snapshot = createEmptySnapshot();
    snapshot.watches = [watch()];
    snapshot.items = [
      {
        watchId: "watch-1",
        market: "us",
        sku: SKU,
        storeNumber: STORE,
        status: "available",
        lastKnownStatus: "available",
        lastChangedAt: "2099-01-01T00:00:00.000Z",
        lastCheckedAt: "2099-01-01T00:00:00.000Z",
        lastSuccessfulAt: "2099-01-01T00:00:00.000Z",
        consecutiveUnknowns: 0,
      },
    ];
    snapshot.runtime.nextEligibleAt = "2099-01-01T00:00:00.000Z";
    const { engine, fetchCalls } = makeEngine({
      storage: new FakeStorage(snapshot),
    });

    await engine.wake();

    expect(fetchCalls()).toBe(1);
  });

  it("recovers future queued-delivery timestamps without violating event ordering", async () => {
    const future = "2099-01-01T00:00:00.000Z";
    const snapshot = createEmptySnapshot();
    const currentWatch = watch();
    snapshot.watches = [currentWatch];
    snapshot.items = [
      {
        watchId: currentWatch.id,
        market: currentWatch.market,
        sku: SKU,
        storeNumber: STORE,
        status: "available",
        lastKnownStatus: "available",
        lastChangedAt: new Date(START).toISOString(),
        lastCheckedAt: new Date(START).toISOString(),
        lastSuccessfulAt: new Date(START).toISOString(),
        consecutiveUnknowns: 0,
      },
    ];
    snapshot.pendingDelivery = [
      {
        ...pendingEntry(currentWatch),
        createdAt: future,
        event: {
          ...eventFor({
            watch: currentWatch,
            sku: SKU,
            storeNumber: STORE,
            title: "iPhone 17 256GB Black",
            storeName: "Fifth Avenue",
            observedAt: future,
          }),
        },
        channels: [
          {
            channel: "desktop",
            state: "pending",
            attempts: 0,
            nextAttemptAt: future,
            lastAttemptAt: future,
            completedAt: null,
          },
        ],
      },
    ];
    const delivered: LocalDeliveryChannel[] = [];
    const { engine } = makeEngine({
      storage: new FakeStorage(snapshot),
      deliver: async (channel) => {
        delivered.push(channel);
      },
    });

    await engine.wake();

    const recovered = await engine.getSnapshot();
    expect(delivered).toEqual(["desktop"]);
    expect(recovered.pendingDelivery[0]).toMatchObject({
      createdAt: new Date(START).toISOString(),
      event: { observedAt: new Date(START).toISOString() },
    });
    expect(
      Date.parse(recovered.pendingDelivery[0]!.createdAt),
    ).toBeGreaterThanOrEqual(
      Date.parse(recovered.pendingDelivery[0]!.event.observedAt),
    );
  });

  it("preserves a bounded provider retry deadline and arms it as a one-shot", async () => {
    const futureObservedAt = new Date(START + 11 * 60_000).toISOString();
    const providerDeadline = new Date(
      START + 11 * 60_000 + 31_000,
    ).toISOString();
    const snapshot = createEmptySnapshot();
    const currentWatch = watch();
    snapshot.watches = [currentWatch];
    snapshot.items = [
      {
        watchId: currentWatch.id,
        market: currentWatch.market,
        sku: SKU,
        storeNumber: STORE,
        status: "available",
        lastKnownStatus: "available",
        lastChangedAt: new Date(START).toISOString(),
        lastCheckedAt: new Date(START).toISOString(),
        lastSuccessfulAt: new Date(START).toISOString(),
        consecutiveUnknowns: 0,
      },
    ];
    snapshot.pendingDelivery = [
      {
        ...pendingEntry(currentWatch),
        createdAt: futureObservedAt,
        event: eventFor({
          watch: currentWatch,
          sku: SKU,
          storeNumber: STORE,
          title: "iPhone 17 256GB Black",
          storeName: "Fifth Avenue",
          observedAt: futureObservedAt,
        }),
        channels: [
          {
            channel: "desktop",
            state: "pending",
            attempts: 1,
            nextAttemptAt: providerDeadline,
            lastAttemptAt: futureObservedAt,
            completedAt: null,
          },
        ],
      },
    ];
    const { engine, scheduler } = makeEngine({
      storage: new FakeStorage(snapshot),
    });

    expect(
      (await engine.getSnapshot()).pendingDelivery[0]?.channels[0]
        ?.nextAttemptAt,
    ).toBe(providerDeadline);

    await engine.wake();
    expect(scheduler.oneShot).toContain(11 * 60_000 + 31_000);
  });

  it("persists provider deferral exactly across restart without early re-send", async () => {
    const snapshot = createEmptySnapshot();
    const currentWatch = watch();
    snapshot.watches = [currentWatch];
    snapshot.items = [
      {
        watchId: currentWatch.id,
        market: currentWatch.market,
        sku: SKU,
        storeNumber: STORE,
        status: "available",
        lastKnownStatus: "available",
        lastChangedAt: new Date(START).toISOString(),
        lastCheckedAt: new Date(START).toISOString(),
        lastSuccessfulAt: new Date(START).toISOString(),
        consecutiveUnknowns: 0,
      },
    ];
    snapshot.pendingDelivery = [pendingEntry(currentWatch)];
    const storage = new FakeStorage(snapshot);
    const clock = new FakeClock();
    let sends = 0;
    const deliver = async (): Promise<void | LocalDeliveryDispatchResult> => {
      sends += 1;
      return sends === 1
        ? {
            kind: "retry_not_before",
            retryNotBefore: new Date(START + 31_000).toISOString(),
          }
        : undefined;
    };
    const initial = makeEngine({ clock, storage, deliver });

    await initial.engine.wake();
    expect(sends).toBe(1);
    expect(
      (await initial.engine.getSnapshot()).pendingDelivery[0]?.channels[0],
    ).toMatchObject({
      state: "pending",
      attempts: 1,
      nextAttemptAt: new Date(START + 31_000).toISOString(),
    });

    clock.advance(1_000);
    const restarted = makeEngine({ clock, storage, deliver });
    await restarted.engine.wake();
    clock.advance(9_000);
    await restarted.engine.wake();
    expect(sends).toBe(1);

    clock.advance(21_000);
    await restarted.engine.wake();
    expect(sends).toBe(2);
  });

  it("accepts prompt 15-second provider deferral but terminalizes malformed, past, and expired delays", async () => {
    const makeSnapshot = () => {
      const snapshot = createEmptySnapshot();
      const currentWatch = watch();
      snapshot.watches = [currentWatch];
      snapshot.items = [
        {
          watchId: currentWatch.id,
          market: currentWatch.market,
          sku: SKU,
          storeNumber: STORE,
          status: "available",
          lastKnownStatus: "available",
          lastChangedAt: new Date(START).toISOString(),
          lastCheckedAt: new Date(START).toISOString(),
          lastSuccessfulAt: new Date(START).toISOString(),
          consecutiveUnknowns: 0,
        },
      ];
      snapshot.pendingDelivery = [pendingEntry(currentWatch)];
      return snapshot;
    };
    const clock = new FakeClock();
    let sends = 0;
    const accepted = makeEngine({
      clock,
      storage: new FakeStorage(makeSnapshot()),
      deliver: async () => {
        sends += 1;
        return {
          kind: "retry_not_before" as const,
          retryNotBefore: new Date(START + 15_000).toISOString(),
        };
      },
    });
    await accepted.engine.wake();
    clock.advance(10_000);
    await accepted.engine.wake();
    expect(sends).toBe(1);

    for (const [result, expectedState] of [
      [
        {
          kind: "retry_not_before",
          retryNotBefore: "not-an-iso-timestamp",
        },
        "failed",
      ],
      [
        {
          kind: "retry_not_before",
          retryNotBefore: new Date(START - 1).toISOString(),
        },
        "failed",
      ],
      [
        {
          kind: "retry_not_before",
          retryNotBefore: new Date(START + 10 * 60_000 + 1).toISOString(),
        },
        "expired",
      ],
    ] as const) {
      const invalid = makeEngine({
        storage: new FakeStorage(makeSnapshot()),
        // A platform adapter is untrusted at this boundary; malformed runtime
        // values must fail terminally without persisting provider details.
        deliver: async () => result as LocalDeliveryDispatchResult,
      });
      await invalid.engine.wake();
      expect(
        (await invalid.engine.getSnapshot()).pendingDelivery[0]?.channels[0],
      ).toMatchObject({ state: expectedState });
    }
  });

  it("durably defers a full dispatch ledger and promotes the event after capacity frees", async () => {
    const seed = createEmptySnapshot();
    const currentWatch = watch();
    seed.watches = [currentWatch];
    seed.items = [
      {
        watchId: "watch-1",
        market: "us",
        sku: SKU,
        storeNumber: STORE,
        status: "unknown",
        lastKnownStatus: "unavailable",
        lastChangedAt: new Date(START).toISOString(),
        lastCheckedAt: new Date(START - 120_000).toISOString(),
        lastSuccessfulAt: new Date(START - 60_000).toISOString(),
        consecutiveUnknowns: 1,
      },
    ];
    seed.pendingDelivery = Array.from({ length: 200 }, (_, index) => ({
      ...pendingEntry(currentWatch),
      eventId: `event_${index}`,
      channels: [
        {
          channel: "desktop" as const,
          state: "pending" as const,
          attempts: 0,
          nextAttemptAt: new Date(START + 9 * 60_000).toISOString(),
          lastAttemptAt: null,
          completedAt: null,
        },
      ],
    }));
    const first = makeEngine({ storage: new FakeStorage(seed) });
    expect((await first.engine.wake()).queueBackpressure).toBe(true);
    const full = await first.engine.getSnapshot();
    expect(full.delivery[0]).toMatchObject({
      deferredAvailabilityState: "pending",
    });
    // A subsequent unknown gap must preserve the bounded marker. When the
    // next known available result arrives after capacity frees, direct enqueue
    // clears that marker instead of allowing a second promotion.
    full.items[0] = {
      ...full.items[0]!,
      status: "unknown",
      lastKnownStatus: "available",
      lastCheckedAt: new Date(START).toISOString(),
      lastSuccessfulAt: new Date(START).toISOString(),
      consecutiveUnknowns: 1,
    };
    full.pendingDelivery.pop();
    const clock = new FakeClock(START + 120_000);
    const resumed = makeEngine({ clock, storage: new FakeStorage(full) });

    const report = await resumed.engine.wake();
    const promoted = await resumed.engine.getSnapshot();

    expect(report.queuedEvents).toBe(1);
    expect(promoted.pendingDelivery).toHaveLength(200);
    expect(promoted.delivery[0]).toMatchObject({
      deferredAvailabilityState: "none",
      deferredAvailabilityAt: null,
    });
  });

  it("terminalizes an already-maxed durable attempt without creating attempt nine", async () => {
    const seed = createEmptySnapshot();
    const currentWatch = watch();
    seed.watches = [currentWatch];
    seed.pendingDelivery = [
      pendingEntry(currentWatch, {
        channels: [
          {
            channel: "desktop",
            state: "pending",
            attempts: 8,
            nextAttemptAt: new Date(START).toISOString(),
            lastAttemptAt: new Date(START).toISOString(),
            completedAt: null,
          },
        ],
      }),
    ];
    const { engine } = makeEngine({
      storage: new FakeStorage(seed),
      deliver: async () => {},
    });

    await engine.wake();

    const snapshot = await engine.getSnapshot();
    expect(snapshot.pendingDelivery[0]?.channels[0]).toMatchObject({
      state: "failed",
      attempts: 8,
    });
  });

  it("bounds a never-settling delivery channel without holding later cycles busy", async () => {
    const seeded = makeEngine({});
    await seeded.engine.addWatch(watch());
    await seeded.engine.wake();
    const run = makeEngine({
      storage: new FakeStorage(await seeded.engine.getSnapshot()),
      deliveryTimeoutMs: 5,
      deliver: async () => new Promise<void>(() => {}),
    });

    const report = await Promise.race([
      run.engine.wake(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("delivery timeout was not bounded")),
          100,
        ),
      ),
    ]);

    expect(report.kind).toBe("completed");
    expect((await run.engine.wake()).kind).not.toBe("busy");
  });

  it("single-flights concurrent first load so an add cannot be overwritten", async () => {
    const resolvers: Array<(value: LocalMonitorSnapshot | null) => void> = [];
    const storage = {
      load: async () =>
        new Promise<LocalMonitorSnapshot | null>((resolve) =>
          resolvers.push(resolve),
        ),
      save: async () => {},
    };
    const engine = new LocalMonitorEngine({
      clock: new FakeClock(),
      storage,
      scheduler: new FakeScheduler(),
      catalog: { getCatalog: () => catalog },
      fetch: { fetchPickup: async (request) => pickupResponse(request) },
    });
    const add = engine.addWatch(watch());
    const read = engine.getSnapshot();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolvers).toHaveLength(1);
    resolvers[0]!(createEmptySnapshot());
    await add;

    expect((await read).watches.map((entry) => entry.id)).toEqual(["watch-1"]);
  });
});

describe("new watch first check", () => {
  it("checks immediately and waits two minutes from the response before checking again", async () => {
    const clock = new FakeClock();
    const subject = makeEngine({
      clock,
      fetch: async (request) => {
        clock.advance(10_000);
        return pickupResponse(request);
      },
    });
    await subject.engine.addWatch(watch());
    expect(subject.fetchCalls()).toBe(0);
    await subject.engine.checkNewWatch("watch-1");
    expect(subject.fetchCalls()).toBe(1);
    expect((await subject.engine.getSnapshot()).items[0]?.lastCheckedAt).toBe(
      new Date(START + 10_000).toISOString(),
    );
    expect(subject.scheduler.periodic.at(-1)).toBe(120);
    clock.advance(119_999);
    await subject.engine.wake();
    expect(subject.fetchCalls()).toBe(1);
    clock.advance(1);
    await subject.engine.wake();
    expect(subject.fetchCalls()).toBe(2);
  });

  it("queues behind an active check without overlapping requests or rechecking other watches", async () => {
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const subject = makeEngine({
      fetch: async (request) => {
        started();
        await blocked;
        return pickupResponse(request);
      },
    });
    await subject.engine.addWatch(watch());
    const first = subject.engine.checkNow(["watch-1"]);
    await startedPromise;
    await subject.engine.addWatch(watch({ id: "watch-2" }));
    const next = subject.engine.checkNewWatch("watch-2");
    expect(subject.fetchCalls()).toBe(1);
    release();
    await Promise.all([first, next]);
    expect(subject.fetchCalls()).toBe(2);
    expect(
      (await subject.engine.getSnapshot()).items
        .map((item) => item.watchId)
        .sort(),
    ).toEqual(["watch-1", "watch-2"]);
    await subject.engine.checkNewWatch("watch-2");
    expect(subject.fetchCalls()).toBe(2);
  });

  it("does not check paused or deleted watches", async () => {
    const subject = makeEngine({});
    await subject.engine.addWatch(watch({ enabled: false }));
    await subject.engine.checkNewWatch("watch-1");
    await subject.engine.checkNewWatch("deleted-watch");
    expect(subject.fetchCalls()).toBe(0);
  });

  it("keeps a saved watch and respects host backoff after a failed first check", async () => {
    const subject = makeEngine({
      fetch: async () => ({ httpStatus: 429, body: {}, retryAfterMs: 300_000 }),
    });
    await subject.engine.addWatch(watch());
    await subject.engine.checkNewWatch("watch-1");
    await subject.engine.addWatch(watch({ id: "watch-2" }));
    expect((await subject.engine.checkNewWatch("watch-2")).kind).toBe(
      "host_backoff",
    );
    expect(subject.fetchCalls()).toBe(1);
    const snapshot = await subject.engine.getSnapshot();
    expect(snapshot.watches).toHaveLength(2);
    expect(snapshot.items[0]?.status).toBe("unknown");
    expect(subject.scheduler.oneShot.at(-1)).toBe(300_000);
  });
});
