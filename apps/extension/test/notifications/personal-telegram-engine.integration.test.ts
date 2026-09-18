import { describe, expect, it } from "vitest";

import {
  createEmptySnapshot,
  parseLocalWatch,
  type LocalAvailabilityEvent,
  type LocalCatalogSnapshot,
  type LocalMonitorSnapshot,
  type LocalWatch,
} from "../../../../packages/core/src/local-monitor-contracts";
import { LocalMonitorEngine } from "../../src/monitor/local-monitor-engine";
import {
  createPersonalTelegramController,
  PERSONAL_TELEGRAM_STORAGE_KEY,
  type TelegramFetchPort,
  type TelegramResponse,
} from "../../src/notifications/telegram";

const START = Date.parse("2026-09-09T12:00:00.000Z");
const SKU = "MG464LL/A";
const STORE = "R123";
// Keep test credentials synthetic and constructed so source scanners cannot
// mistake a fixture for a usable secret.
const token = ["123456789", "abcdefghijklmnopqrstuvwx"].join(":");

class FakeClock {
  public constructor(private current = START) {}

  public now(): number {
    return this.current;
  }

  public nowMs(): number {
    return this.current;
  }

  public advance(milliseconds: number): void {
    this.current += milliseconds;
  }

  public setTimeout(_callback: () => void, _delayMs: number): number {
    // Network handlers resolve explicitly in each test. This lets the engine
    // own its own deadline without accidentally invoking a provider timeout.
    return 1;
  }

  public clearTimeout(_handle: unknown): void {}

  public sleeps: number[] = [];

  public async sleep(delayMs: number): Promise<void> {
    this.sleeps.push(delayMs);
  }
}

class FakeStorage {
  public saves: LocalMonitorSnapshot[] = [];

  public constructor(public snapshot: LocalMonitorSnapshot) {}

  public async load(): Promise<LocalMonitorSnapshot> {
    return structuredClone(this.snapshot);
  }

  public async save(snapshot: LocalMonitorSnapshot): Promise<void> {
    this.snapshot = structuredClone(snapshot);
    this.saves.push(structuredClone(snapshot));
  }
}

class FakeScheduler {
  public oneShots: number[] = [];

  public schedulePeriodic(_intervalSec: number): void {}

  public scheduleOneShot(delayMs: number): void {
    this.oneShots.push(delayMs);
  }

  public cancelAll(): void {}
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

function watch(overrides: Partial<LocalWatch> = {}): LocalWatch {
  const parsed = parseLocalWatch({
    id: "watch-1",
    market: "us",
    skus: [SKU],
    storeNumbers: [STORE],
    pollAnchor: { storeNumber: STORE },
    deliveryChannels: {
      desktop: false,
      personalTelegram: true,
      hostedRelay: false,
    },
    createdAt: new Date(START).toISOString(),
    updatedAt: new Date(START).toISOString(),
    ...overrides,
  });
  if (!parsed.success) throw new Error("test watch should parse");
  return parsed.data;
}

function eventFor(currentWatch: LocalWatch): LocalAvailabilityEvent {
  return {
    watchId: currentWatch.id,
    market: currentWatch.market,
    sku: SKU,
    title: "iPhone 17 256GB Black",
    storeNumber: STORE,
    storeName: "Fifth Avenue",
    observedAt: new Date(START).toISOString(),
    purchaseUrl: "https://www.apple.com/shop/buy-iphone",
  };
}

function pendingSnapshot(
  currentWatch = watch(),
  hostBackoffDelayMs: number | null = null,
): LocalMonitorSnapshot {
  const snapshot = createEmptySnapshot();
  snapshot.watches = [currentWatch];
  // A fresh observation means the poller is not due. This keeps the test at
  // the actual delivery boundary and lets the scheduler arm the provider's
  // deadline rather than an unrelated Apple request deadline.
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
  if (hostBackoffDelayMs !== null) {
    snapshot.runtime.nextEligibleAt = new Date(
      START + hostBackoffDelayMs,
    ).toISOString();
  }
  snapshot.pendingDelivery = [
    {
      eventId: "event-1",
      watchUpdatedAt: currentWatch.updatedAt,
      event: eventFor(currentWatch),
      createdAt: new Date(START).toISOString(),
      channels: [
        {
          channel: "personalTelegram",
          state: "pending",
          attempts: 0,
          nextAttemptAt: new Date(START).toISOString(),
          lastAttemptAt: null,
          completedAt: null,
        },
      ],
    },
  ];
  return snapshot;
}

function response(
  json: unknown,
  options: Partial<
    Pick<TelegramResponse, "httpStatus" | "retryAfterSeconds">
  > = {},
): TelegramResponse {
  return {
    httpStatus: 200,
    redirected: false,
    url: "https://api.telegram.org/synthetic",
    json: async () => json,
    ...options,
  };
}

type FetchHandler = (
  init: Parameters<TelegramFetchPort["fetch"]>[1],
) => Promise<TelegramResponse> | TelegramResponse;

function connectedTelegram(clock: FakeClock, handlers: FetchHandler[]) {
  const values = new Map<string, unknown>([
    [
      PERSONAL_TELEGRAM_STORAGE_KEY,
      {
        version: 1,
        active: { botToken: token, chatId: "12345" },
        botUsername: "SyntheticBot",
      },
    ],
  ]);
  const calls: Parameters<TelegramFetchPort["fetch"]>[1][] = [];
  const controller = createPersonalTelegramController({
    storage: {
      read: async (key) => values.get(key) ?? null,
      write: async (key, value) => {
        values.set(key, value);
      },
      remove: async (key) => {
        values.delete(key);
      },
    },
    fetchPort: {
      fetch: async (_url, init) => {
        calls.push(init);
        const handler = handlers.shift();
        if (!handler) throw new Error("unexpected synthetic Telegram request");
        return handler(init);
      },
    },
    clock,
    random: { bytes: () => Uint8Array.from({ length: 32 }, () => 0xab) },
    isSupported: () => true,
  });
  return { calls, controller, values };
}

function makeEngine(
  clock: FakeClock,
  storage: FakeStorage,
  controller: ReturnType<typeof createPersonalTelegramController>,
) {
  const scheduler = new FakeScheduler();
  const engine = new LocalMonitorEngine({
    clock,
    storage,
    scheduler,
    catalog: { getCatalog: () => catalog },
    fetch: {
      fetchPickup: async () => ({ httpStatus: 500, body: null }),
    },
    deliveryDispatcher: {
      deliver: async (channel, event, options) => {
        if (channel !== "personalTelegram") {
          throw new Error("unexpected channel in Telegram adapter test");
        }
        return controller.sendStoredAvailable(event, options);
      },
    },
    jitterMs: () => 0,
  });
  return { engine, scheduler };
}

function channel(snapshot: LocalMonitorSnapshot) {
  return snapshot.pendingDelivery[0]!.channels[0]!;
}

describe("personal Telegram + local monitor delivery boundary", () => {
  it.each([15, 31])(
    "persists a %is provider deadline across restart without an early send",
    async (seconds) => {
      const clock = new FakeClock();
      const hostBackoffDelayMs = 5 * 60_000;
      const storage = new FakeStorage(
        pendingSnapshot(watch(), hostBackoffDelayMs),
      );
      const telegram = connectedTelegram(clock, [
        () =>
          response(
            {
              ok: false,
              error_code: 429,
              parameters: { retry_after: seconds },
            },
            { httpStatus: 429, retryAfterSeconds: String(seconds) },
          ),
        () => response({ ok: true, result: { message_id: 1 } }),
      ]);

      const initial = makeEngine(clock, storage, telegram.controller);
      await initial.engine.wake();
      expect(telegram.calls).toHaveLength(1);
      expect(clock.sleeps).toEqual([]);
      expect(channel(storage.snapshot)).toMatchObject({
        state: "pending",
        attempts: 1,
        nextAttemptAt: new Date(START + seconds * 1_000).toISOString(),
      });
      // The engine remains in Apple backoff, but it must still arm the
      // earlier independent Telegram deadline after durable dispatch.
      expect(storage.snapshot.runtime.nextEligibleAt).toBe(
        new Date(START + hostBackoffDelayMs).toISOString(),
      );
      expect(initial.scheduler.oneShots).toContain(hostBackoffDelayMs);
      expect(initial.scheduler.oneShots).toContain(seconds * 1_000);

      clock.advance(seconds * 1_000 - 1);
      const beforeDeadline = makeEngine(clock, storage, telegram.controller);
      await beforeDeadline.engine.wake();
      expect(telegram.calls).toHaveLength(1);

      clock.advance(1);
      const atDeadline = makeEngine(clock, storage, telegram.controller);
      await atDeadline.engine.wake();
      expect(telegram.calls).toHaveLength(2);
      expect(channel(storage.snapshot)).toMatchObject({
        state: "delivered",
        attempts: 2,
        nextAttemptAt: null,
      });
    },
  );

  it.each([
    {
      name: "TTL-exceeding Retry-After",
      body: { retry_after: 601 },
      header: "601",
    },
    {
      name: "malformed Retry-After",
      body: { retry_after: "invalid" },
      header: undefined,
    },
  ])(
    "fails closed for $name rather than scheduling an early retry",
    async ({ body, header }) => {
      const clock = new FakeClock();
      const storage = new FakeStorage(pendingSnapshot());
      const telegram = connectedTelegram(clock, [
        () =>
          response(
            { ok: false, error_code: 429, parameters: body },
            {
              httpStatus: 429,
              ...(header === undefined ? {} : { retryAfterSeconds: header }),
            },
          ),
      ]);
      const initial = makeEngine(clock, storage, telegram.controller);

      await initial.engine.wake();
      expect(telegram.calls).toHaveLength(1);
      expect(channel(storage.snapshot)).toMatchObject({
        state: "failed",
        attempts: 1,
        nextAttemptAt: null,
      });

      clock.advance(9 * 60_000);
      const restarted = makeEngine(clock, storage, telegram.controller);
      await restarted.engine.wake();
      expect(telegram.calls).toHaveLength(1);
    },
  );

  it("bounds ordinary 500 retries in the adapter and the durable engine queue", async () => {
    const clock = new FakeClock();
    const storage = new FakeStorage(pendingSnapshot());
    const telegram = connectedTelegram(clock, [
      () => response({ ok: false, error_code: 500 }, { httpStatus: 500 }),
      () => response({ ok: false, error_code: 500 }, { httpStatus: 500 }),
      () => response({ ok: true, result: { message_id: 2 } }),
    ]);
    const initial = makeEngine(clock, storage, telegram.controller);

    await initial.engine.wake();
    expect(telegram.calls).toHaveLength(2);
    expect(clock.sleeps).toEqual([250]);
    expect(channel(storage.snapshot)).toMatchObject({
      state: "pending",
      attempts: 1,
      nextAttemptAt: new Date(START + 1_000).toISOString(),
    });

    clock.advance(999);
    await makeEngine(clock, storage, telegram.controller).engine.wake();
    expect(telegram.calls).toHaveLength(2);

    clock.advance(1);
    await makeEngine(clock, storage, telegram.controller).engine.wake();
    expect(telegram.calls).toHaveLength(3);
    expect(channel(storage.snapshot)).toMatchObject({
      state: "delivered",
      attempts: 2,
      nextAttemptAt: null,
    });
  });

  it.each([
    {
      name: "pause",
      mutate: async (engine: LocalMonitorEngine) =>
        engine.setWatchEnabled("watch-1", false),
    },
    {
      name: "channel-off",
      mutate: async (engine: LocalMonitorEngine) => {
        const current = (await engine.getSnapshot()).watches[0]!;
        return engine.replaceWatch({
          ...current,
          deliveryChannels: {
            ...current.deliveryChannels,
            personalTelegram: false,
          },
        });
      },
    },
    {
      name: "delete",
      mutate: async (engine: LocalMonitorEngine) =>
        engine.deleteWatch("watch-1"),
    },
    {
      name: "reset",
      mutate: async (engine: LocalMonitorEngine) => engine.reset(),
    },
  ])(
    "aborts a real Telegram fetch on $name and ignores its late receipt",
    async ({ mutate }) => {
      const clock = new FakeClock();
      const storage = new FakeStorage(pendingSnapshot());
      let release: (() => void) | undefined;
      let started: (() => void) | undefined;
      const startedFetch = new Promise<void>((resolve) => {
        started = resolve;
      });
      const telegram = connectedTelegram(clock, [
        (init) =>
          new Promise<TelegramResponse>((resolve) => {
            started?.();
            release = () =>
              resolve(response({ ok: true, result: { message_id: 3 } }));
            // The fake intentionally ignores abort while pending, matching a
            // late browser/provider settlement. The controller still sees
            // the signal and the engine must never revive this delivery.
            void init.signal;
          }),
      ]);
      const { engine } = makeEngine(clock, storage, telegram.controller);

      const cycle = engine.wake();
      await startedFetch;
      await mutate(engine);
      expect(telegram.calls).toHaveLength(1);
      expect(telegram.calls[0]!.signal.aborted).toBe(true);
      release?.();
      await cycle;
      await Promise.resolve();

      const after = await engine.getSnapshot();
      expect(telegram.calls).toHaveLength(1);
      expect(
        after.pendingDelivery.flatMap((pending) =>
          pending.channels.map((entry) => entry.state),
        ),
      ).not.toContain("pending");
    },
  );
});
