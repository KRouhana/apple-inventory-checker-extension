import { describe, expect, it } from "vitest";

import {
  createEmptySnapshot,
  LOCAL_MONITOR_STORAGE_KEY,
  parseLocalWatch,
} from "../../../../packages/core/src/local-monitor-contracts.js";
import {
  createSafeMonitorExport,
  ValidatedLocalMonitorStorage,
} from "../../src/storage/local-monitor-storage.js";

const CREATED = "2026-09-09T12:00:00.000Z";

function validWatch() {
  const parsed = parseLocalWatch({
    id: "watch-1",
    market: "us",
    skus: ["MG464LL/A"],
    storeNumbers: ["R123"],
    pollAnchor: { storeNumber: "R123" },
    createdAt: CREATED,
    updatedAt: CREATED,
  });
  if (!parsed.success) throw new Error("fixture must parse");
  return parsed.data;
}

describe("ValidatedLocalMonitorStorage", () => {
  it("recovers malformed storage without overwriting it during load", async () => {
    const writes: unknown[] = [];
    const storage = new ValidatedLocalMonitorStorage({
      get: async () => ({ version: 999, privatePostalInput: "10001" }),
      set: async (_key, value) => {
        writes.push(value);
      },
    });

    const recovered = await storage.loadWithRecovery();

    expect(recovered.kind).toBe("recovered_corrupt");
    expect(recovered.snapshot).toEqual(createEmptySnapshot());
    expect(writes).toEqual([]);
  });

  it("migrates a valid legacy 60-second watch without losing observations or history", async () => {
    const legacy = createEmptySnapshot();
    legacy.watches = [{ ...validWatch(), pollIntervalSec: 60 }];
    legacy.items = [
      {
        watchId: "watch-1",
        market: "us",
        sku: "MG464LL/A",
        storeNumber: "R123",
        status: "unknown",
        lastKnownStatus: "available",
        lastChangedAt: CREATED,
        lastCheckedAt: CREATED,
        lastSuccessfulAt: CREATED,
        consecutiveUnknowns: 2,
      },
    ];
    legacy.history = [
      {
        watchId: "watch-1",
        market: "us",
        sku: "MG464LL/A",
        storeNumber: "R123",
        from: "unavailable",
        to: "available",
        at: CREATED,
      },
    ];
    const writes: unknown[] = [];
    const storage = new ValidatedLocalMonitorStorage({
      get: async () => legacy,
      set: async (_key, value) => {
        writes.push(value);
      },
    });

    const result = await storage.loadWithRecovery();

    expect(result.kind).toBe("migrated");
    expect(result.snapshot.watches[0]?.pollIntervalSec).toBe(120);
    expect(result.snapshot.items).toEqual(legacy.items);
    expect(result.snapshot.history).toEqual(legacy.history);
    expect(writes).toEqual([result.snapshot]);
  });

  it("does not treat a non-finite interval as migratable legacy data", async () => {
    const malformed = createEmptySnapshot();
    malformed.watches = [
      { ...validWatch(), pollIntervalSec: Number.POSITIVE_INFINITY },
    ] as never;
    const writes: unknown[] = [];
    const storage = new ValidatedLocalMonitorStorage({
      get: async () => malformed,
      set: async (_key, value) => {
        writes.push(value);
      },
    });

    await expect(storage.loadWithRecovery()).resolves.toMatchObject({
      kind: "recovered_corrupt",
      snapshot: createEmptySnapshot(),
    });
    expect(writes).toEqual([]);
  });

  it("validates saves, resets predictably, and excludes queue payloads from export", async () => {
    let value: unknown = null;
    const storage = new ValidatedLocalMonitorStorage({
      get: async () => value,
      set: async (key, next) => {
        expect(key).toBe(LOCAL_MONITOR_STORAGE_KEY);
        value = next;
      },
    });
    const snapshot = createEmptySnapshot();
    snapshot.watches = [validWatch()];
    snapshot.pendingDelivery = [
      {
        eventId: "event-1",
        watchUpdatedAt: CREATED,
        createdAt: CREATED,
        event: {
          watchId: "watch-1",
          market: "us",
          sku: "MG464LL/A",
          title: "iPhone 17 256GB Black",
          storeNumber: "R123",
          storeName: "Fifth Avenue",
          observedAt: CREATED,
          purchaseUrl: "https://www.apple.com/shop/buy-iphone",
        },
        channels: [
          {
            channel: "desktop",
            state: "pending",
            attempts: 0,
            nextAttemptAt: CREATED,
            lastAttemptAt: null,
            completedAt: null,
          },
        ],
      },
    ];

    await storage.save(snapshot);
    expect((await storage.loadWithRecovery()).kind).toBe("loaded");
    const exported = createSafeMonitorExport(snapshot);
    expect("pendingDelivery" in exported).toBe(false);
    expect(JSON.stringify(exported)).not.toContain("10001");

    await storage.reset();
    expect(await storage.load()).toEqual(createEmptySnapshot());
  });
});
