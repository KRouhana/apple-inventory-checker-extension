import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";

afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Offline test"));
  Object.defineProperty(globalThis, "indexedDB", {
    value: new IDBFactory(),
    configurable: true,
  });
});

import {
  createEmptySnapshot,
  LOCAL_MONITOR_STORAGE_KEY,
  parseLocalWatch,
} from "../../../packages/core/src/local-monitor-contracts.js";
import type {
  ExtensionApi,
  ExtensionMessageSender,
} from "../src/platform/api.js";
import { LOCAL_MONITOR_PROTOCOL } from "../src/platform/monitor-messages.js";
import { POPUP_MONITOR_SUMMARY_PROTOCOL } from "../src/platform/popup-summary-messages.js";
import { PERSONAL_TELEGRAM_PROTOCOL } from "../src/platform/telegram-messages.js";
import { LocalRuntimeCatalog } from "../src/runtime/catalog.js";
import {
  applePickupCredentialsForTarget,
  installLocalMonitorRuntime,
} from "../src/runtime/local-monitor-runtime.js";
import {
  BrowserMonitorScheduler,
  LOCAL_MONITOR_ALARM_NAMES,
} from "../src/runtime/scheduler.js";

// Monitor, popup summary, desktop diagnostic, and personal Telegram
// each own one message listener, including during repeated/cold installation.
const EXPECTED_MESSAGE_LISTENER_COUNT = 4;

describe("Apple pickup credential policy", () => {
  it("uses browser-managed credentials only for Chrome composition", () => {
    expect(applePickupCredentialsForTarget("chrome")).toBe("include");
    expect(applePickupCredentialsForTarget("firefox")).toBe("omit");
    expect(applePickupCredentialsForTarget("safari")).toBe("omit");
  });

  it("wires Chrome credentials into both discovery and engine requests only", async () => {
    const originalFetch = globalThis.fetch;
    const observed: Array<{ target: string; credentials: RequestCredentials }> =
      [];
    let target = "";
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.endsWith("/portable-catalog.json")) {
        return {
          ok: true,
          status: 200,
          url,
          redirected: false,
          headers: { get: () => null },
          body: catalogStream({ withStore: true }),
        };
      }
      observed.push({
        target,
        credentials: init?.credentials ?? "same-origin",
      });
      return {
        status: 541,
        url,
        redirected: false,
        headers: { get: () => null },
        body: null,
      };
    }) as unknown as typeof fetch;
    try {
      for (const currentTarget of ["chrome", "firefox", "safari"] as const) {
        target = currentTarget;
        const fake = createApi();
        const runtime = installLocalMonitorRuntime({
          api: fake.api,
          target: currentTarget,
        });
        await runtime.ready;
        if (currentTarget === "chrome") {
          await runtime.catalog.lookupStores({
            market: "ca",
            userPostalInput: "M5V 2T6",
          });
        }
        await runtime.engine.addWatch({
          ...telegramWatch(`watch-${currentTarget}`),
          deliveryChannels: {
            desktop: true,
            personalTelegram: false,
            hostedRelay: false,
          },
        });
        await runtime.engine.checkNow([`watch-${currentTarget}`]);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(observed).toEqual([
      { target: "chrome", credentials: "include" },
      { target: "chrome", credentials: "include" },
      { target: "firefox", credentials: "omit" },
      { target: "safari", credentials: "omit" },
    ]);
  });
});

function catalogStream(
  options: { withStore?: boolean } = {},
): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
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
            },
          ],
          stores: options.withStore
            ? [
                {
                  storeNumber: "R123",
                  name: "Apple Test",
                  city: "Toronto",
                  region: "ON",
                  pollLocation: "qualified-public-anchor",
                },
              ]
            : [],
        },
      ],
    }),
  );
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function createApi(initialStorage = new Map<string, unknown>()) {
  const listeners: Array<
    (
      input: unknown,
      sender: ExtensionMessageSender,
      respond: (response: unknown) => void,
    ) => boolean | void
  > = [];
  const alarmListeners: Array<(alarm: { name: string }) => void> = [];
  const notificationListeners: Array<(id: string) => void> = [];
  const nativePortListeners: Array<(message: unknown) => void> = [];
  const permissionRemovedListeners: Array<
    (details: { origins?: string[]; data_collection?: string[] }) => void
  > = [];
  let telegramPermissions = {
    origins: ["https://api.telegram.org/*"],
    data_collection: [
      "authenticationInfo",
      "personallyIdentifyingInfo",
      "personalCommunications",
    ],
  };
  const scheduled: Array<{ name: string; delay?: number; period?: number }> =
    [];
  const notifications: Array<{ id: string; title: string; message: string }> =
    [];
  const api: ExtensionApi = {
    runtime: {
      id: "test-extension",
      getURL: (path) => `chrome-extension://test-extension/${path}`,
      onMessage: { addListener: (listener) => listeners.push(listener) },
      sendMessage: () => undefined,
      connectNative: () => ({
        onMessage: {
          addListener: (listener) => nativePortListeners.push(listener),
        },
      }),
    },
    storage: {
      local: {
        setAccessLevel: (_details, callback) => callback?.(),
        get: (key, callback) =>
          callback?.({ [String(key)]: initialStorage.get(String(key)) }),
        set: (items, callback) => {
          for (const [key, value] of Object.entries(items)) {
            initialStorage.set(key, structuredClone(value));
          }
          callback?.();
        },
        remove: (key, callback) => {
          initialStorage.delete(String(key));
          callback?.();
        },
      },
    },
    alarms: {
      create: (name, details) =>
        scheduled.push({
          name,
          delay: details.delayInMinutes,
          period: details.periodInMinutes,
        }),
      clear: (_name, callback) => callback?.(true),
      onAlarm: { addListener: (listener) => alarmListeners.push(listener) },
    },
    notifications: {
      getPermissionLevel: (callback) => callback?.("granted"),
      create: (id, options, callback) => {
        notifications.push({
          id,
          title: options.title,
          message: options.message,
        });
        callback?.();
      },
      onClicked: {
        addListener: (listener) => notificationListeners.push(listener),
      },
    },
    permissions: {
      getAll: (callback) => callback?.(structuredClone(telegramPermissions)),
      request: (_details, callback) => callback?.(true),
      onRemoved: {
        addListener: (listener) => permissionRemovedListeners.push(listener),
      },
    },
    tabs: { create: (_details, callback) => callback?.() },
  };
  const dispatch = (input: unknown, sender: ExtensionMessageSender) =>
    new Promise<unknown>((resolve) => {
      for (const listener of listeners) {
        if (listener(input, sender, resolve)) return;
      }
    });
  return {
    api,
    listeners,
    alarmListeners,
    notificationListeners,
    nativePortListeners,
    revokeTelegramPermissions: () => {
      telegramPermissions = { origins: [], data_collection: [] };
      for (const listener of permissionRemovedListeners) {
        listener({
          origins: ["https://api.telegram.org/*"],
          data_collection: ["personalCommunications"],
        });
      }
    },
    scheduled,
    notifications,
    dispatch,
  };
}

async function flush(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

function telegramWatch(id: string) {
  return {
    id,
    market: "ca" as const,
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
    createdAt: "2026-09-09T12:00:00.000Z",
    updatedAt: "2026-09-09T12:00:00.000Z",
  };
}

function immediatelyLoadedCatalog() {
  return new LocalRuntimeCatalog({
    platform: { storage: {} } as never,
    assetUrl: "chrome-extension://test-extension/portable-catalog.json",
    fetch: async () => ({
      ok: true,
      status: 200,
      url: "chrome-extension://test-extension/portable-catalog.json",
      redirected: false,
      headers: { get: () => null },
      body: catalogStream({ withStore: true }),
    }),
  });
}

describe("local runtime cold bootstrap", () => {
  it("handles Firefox consent revocation registered during cold bootstrap", async () => {
    const storage = new Map<string, unknown>([
      [
        "inventorySignal.personalTelegram.v1",
        {
          version: 1,
          active: { botToken: `12345:${"a".repeat(20)}`, chatId: "12345" },
          botUsername: "SafeBot",
        },
      ],
    ]);
    let resolveFetch:
      | ((value: {
          ok: boolean;
          status: number;
          url: string;
          redirected: boolean;
          headers: { get(name: string): string | null };
          body: ReadableStream<Uint8Array>;
        }) => void)
      | undefined;
    const catalog = new LocalRuntimeCatalog({
      platform: { storage: {} } as never,
      assetUrl: "chrome-extension://test-extension/portable-catalog.json",
      fetch: () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    });
    const fake = createApi(storage);
    const runtime = installLocalMonitorRuntime({
      api: fake.api,
      target: "firefox",
      catalog,
    });
    expect(fake.listeners).toHaveLength(EXPECTED_MESSAGE_LISTENER_COUNT);
    fake.revokeTelegramPermissions();
    resolveFetch?.({
      ok: true,
      status: 200,
      url: "chrome-extension://test-extension/portable-catalog.json",
      redirected: false,
      headers: { get: () => null },
      body: catalogStream({ withStore: true }),
    });
    await runtime.ready;
    for (let index = 0; index < 20; index += 1) {
      if (!storage.has("inventorySignal.personalTelegram.v1")) break;
      await flush();
    }
    expect(storage.has("inventorySignal.personalTelegram.v1")).toBe(false);

    const sender = {
      id: "test-extension",
      url: "chrome-extension://test-extension/app.html",
    };
    await fake.dispatch(
      {
        protocol: LOCAL_MONITOR_PROTOCOL,
        type: "ADD_WATCH",
        watch: telegramWatch("revoked"),
      },
      sender,
    );
    const snapshot = await runtime.engine.getSnapshot();
    expect(snapshot.watches[0]?.deliveryChannels.personalTelegram).toBe(false);
  });

  it("serializes two app-page saves with disconnect and leaves both current watches Telegram-disabled", async () => {
    const storage = new Map<string, unknown>([
      [
        "inventorySignal.personalTelegram.v1",
        {
          version: 1,
          active: { botToken: `12345:${"a".repeat(20)}`, chatId: "12345" },
          botUsername: "SafeBot",
        },
      ],
    ]);
    const fake = createApi(storage);
    const runtime = installLocalMonitorRuntime({
      api: fake.api,
      target: "chrome",
      catalog: immediatelyLoadedCatalog(),
    });
    await runtime.ready;
    const sender = {
      id: "test-extension",
      url: "chrome-extension://test-extension/app.html",
    };
    await fake.dispatch(
      {
        protocol: LOCAL_MONITOR_PROTOCOL,
        type: "ADD_WATCH",
        watch: telegramWatch("first"),
      },
      sender,
    );
    const disconnect = fake.dispatch(
      { protocol: PERSONAL_TELEGRAM_PROTOCOL, type: "DISCONNECT" },
      sender,
    );
    const staleReplace = fake.dispatch(
      {
        protocol: LOCAL_MONITOR_PROTOCOL,
        type: "REPLACE_WATCH",
        watch: telegramWatch("first"),
      },
      sender,
    );
    const staleAdd = fake.dispatch(
      {
        protocol: LOCAL_MONITOR_PROTOCOL,
        type: "ADD_WATCH",
        watch: telegramWatch("second"),
      },
      sender,
    );
    await Promise.all([disconnect, staleReplace, staleAdd]);
    const snapshot = await runtime.engine.getSnapshot();
    expect(snapshot.watches).toHaveLength(2);
    expect(
      snapshot.watches.map((watch) => watch.deliveryChannels.personalTelegram),
    ).toEqual([false, false]);
  });

  it("clears active Firefox credentials and disables every Telegram watch on revocation", async () => {
    const storage = new Map<string, unknown>([
      [
        "inventorySignal.personalTelegram.v1",
        {
          version: 1,
          active: { botToken: `12345:${"a".repeat(20)}`, chatId: "12345" },
          botUsername: "SafeBot",
        },
      ],
    ]);
    const fake = createApi(storage);
    const runtime = installLocalMonitorRuntime({
      api: fake.api,
      target: "firefox",
      catalog: immediatelyLoadedCatalog(),
    });
    await runtime.ready;
    const sender = {
      id: "test-extension",
      url: "chrome-extension://test-extension/app.html",
    };
    await fake.dispatch(
      {
        protocol: LOCAL_MONITOR_PROTOCOL,
        type: "ADD_WATCH",
        watch: telegramWatch("active"),
      },
      sender,
    );
    expect(
      (await runtime.engine.getSnapshot()).watches[0]?.deliveryChannels
        .personalTelegram,
    ).toBe(true);

    fake.revokeTelegramPermissions();
    await vi.waitFor(async () => {
      const snapshot = await runtime.engine.getSnapshot();
      expect(storage.has("inventorySignal.personalTelegram.v1")).toBe(false);
      expect(storage.has("inventorySignal.personalTelegram.v1.encrypted")).toBe(
        false,
      );
      expect(snapshot.watches[0]?.deliveryChannels.personalTelegram).toBe(
        false,
      );
    });
    expect(storage.has("inventorySignal.personalTelegram.v1")).toBe(false);
    expect(
      (await runtime.engine.getSnapshot()).watches[0]?.deliveryChannels
        .personalTelegram,
    ).toBe(false);
  });

  it("shares one runtime and bootstrap promise for repeated installation", async () => {
    let resolveFetch:
      | ((value: {
          ok: boolean;
          status: number;
          url: string;
          redirected: boolean;
          headers: { get(name: string): string | null };
          body: ReadableStream<Uint8Array>;
        }) => void)
      | null = null;
    const catalog = new LocalRuntimeCatalog({
      platform: { storage: {} } as never,
      assetUrl: "chrome-extension://test-extension/portable-catalog.json",
      fetch: () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    });
    const fake = createApi();
    const first = installLocalMonitorRuntime({
      api: fake.api,
      target: "chrome",
      catalog,
    });
    const second = installLocalMonitorRuntime({
      api: fake.api,
      target: "chrome",
      catalog: new LocalRuntimeCatalog({
        platform: { storage: {} } as never,
        assetUrl: "chrome-extension://ignored/portable-catalog.json",
        fetch: () => new Promise(() => undefined),
      }),
    });
    expect(second).toBe(first);
    expect(fake.listeners).toHaveLength(EXPECTED_MESSAGE_LISTENER_COUNT);
    expect(fake.alarmListeners).toHaveLength(1);
    const completeFetch = resolveFetch as unknown as (value: {
      ok: boolean;
      status: number;
      url: string;
      redirected: boolean;
      headers: { get(name: string): string | null };
      body: ReadableStream<Uint8Array>;
    }) => void;
    completeFetch({
      ok: true,
      status: 200,
      url: "chrome-extension://test-extension/portable-catalog.json",
      redirected: false,
      headers: { get: () => null },
      body: catalogStream(),
    });
    await Promise.all([first.ready, second.ready]);
  });

  it("settles an app command after catalog bootstrap times out", async () => {
    const catalog = new LocalRuntimeCatalog({
      platform: { storage: {} } as never,
      assetUrl: "chrome-extension://test-extension/portable-catalog.json",
      bootstrapTimeoutMs: 10,
      fetch: () => new Promise(() => undefined),
    });
    const fake = createApi();
    const runtime = installLocalMonitorRuntime({
      api: fake.api,
      target: "chrome",
      catalog,
    });
    await expect(
      fake.dispatch(
        { protocol: LOCAL_MONITOR_PROTOCOL, type: "GET_CAPABILITIES" },
        {
          id: "test-extension",
          url: "chrome-extension://test-extension/app.html",
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: { monitor: true, catalog: false, storeLookup: false },
    });
    await runtime.ready;
  });

  it("keeps the popup summary listener synchronous but bounds cold readiness to two seconds", async () => {
    vi.useFakeTimers();
    try {
      const catalog = new LocalRuntimeCatalog({
        platform: { storage: {} } as never,
        assetUrl: "chrome-extension://test-extension/portable-catalog.json",
        fetch: () => new Promise(() => undefined),
        bootstrapTimeoutMs: 3_000,
      });
      const fake = createApi();
      const runtime = installLocalMonitorRuntime({
        api: fake.api,
        target: "chrome",
        catalog,
      });
      expect(fake.listeners).toHaveLength(EXPECTED_MESSAGE_LISTENER_COUNT);

      const response = fake.dispatch(
        { protocol: POPUP_MONITOR_SUMMARY_PROTOCOL, type: "GET_SUMMARY" },
        {
          id: "test-extension",
          url: "chrome-extension://test-extension/popup.html",
          tab: { id: 4, url: "chrome-extension://test-extension/popup.html" },
        },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(response).resolves.toMatchObject({
        ok: false,
        error: "unavailable",
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await runtime.ready;
    } finally {
      vi.useRealTimers();
    }
  });

  it("registers cold-wake listeners synchronously and gates monitor replies on catalog bootstrap", async () => {
    let resolveFetch:
      | ((value: {
          ok: boolean;
          status: number;
          url: string;
          redirected: boolean;
          headers: { get(name: string): string | null };
          body: ReadableStream<Uint8Array>;
        }) => void)
      | null = null;
    const catalog = new LocalRuntimeCatalog({
      platform: { storage: {} } as never,
      assetUrl: "chrome-extension://test-extension/portable-catalog.json",
      fetch: () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    });
    const fake = createApi();
    const runtime = installLocalMonitorRuntime({
      api: fake.api,
      target: "chrome",
      catalog,
    });

    expect(fake.listeners).toHaveLength(EXPECTED_MESSAGE_LISTENER_COUNT);
    expect(fake.alarmListeners).toHaveLength(1);
    expect(fake.notificationListeners).toHaveLength(1);
    const pending = fake.dispatch(
      { protocol: LOCAL_MONITOR_PROTOCOL, type: "GET_CAPABILITIES" },
      {
        id: "test-extension",
        url: "chrome-extension://test-extension/app.html",
      },
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    const completeFetch = resolveFetch as unknown as (value: {
      ok: boolean;
      status: number;
      url: string;
      redirected: boolean;
      headers: { get(name: string): string | null };
      body: ReadableStream<Uint8Array>;
    }) => void;
    completeFetch({
      ok: true,
      status: 200,
      url: "chrome-extension://test-extension/portable-catalog.json",
      redirected: false,
      headers: { get: () => null },
      body: catalogStream(),
    });
    await expect(pending).resolves.toMatchObject({
      ok: true,
      result: { monitor: true, catalog: true, storeLookup: false },
    });
    await runtime.ready;
  });

  it("registers the Safari native click listener before asynchronous bootstrap", () => {
    const fake = createApi();
    const catalog = new LocalRuntimeCatalog({
      platform: { storage: {} } as never,
      assetUrl: "safari-web-extension://test-extension/portable-catalog.json",
      fetch: () => new Promise(() => undefined),
      bootstrapTimeoutMs: 10,
    });
    installLocalMonitorRuntime({ api: fake.api, target: "safari", catalog });
    expect(fake.nativePortListeners).toHaveLength(1);
    expect(fake.notificationListeners).toHaveLength(0);
  });

  it("does not self-deadlock a pending desktop delivery during startup", async () => {
    const now = new Date().toISOString();
    const parsedWatch = parseLocalWatch({
      id: "watch-1",
      market: "ca",
      skus: ["TEST4VC/A"],
      storeNumbers: ["R123"],
      pollAnchor: { storeNumber: "R123" },
      createdAt: now,
      updatedAt: now,
    });
    if (!parsedWatch.success) throw new Error("valid runtime fixture");
    const snapshot = createEmptySnapshot();
    snapshot.watches = [parsedWatch.data];
    snapshot.items = [
      {
        watchId: "watch-1",
        market: "ca",
        sku: "TEST4VC/A",
        storeNumber: "R123",
        status: "available",
        lastKnownStatus: "available",
        lastChangedAt: now,
        lastCheckedAt: now,
        lastSuccessfulAt: now,
        consecutiveUnknowns: 0,
      },
    ];
    snapshot.pendingDelivery = [
      {
        eventId: "startup-event",
        watchUpdatedAt: now,
        createdAt: now,
        event: {
          watchId: "watch-1",
          market: "ca",
          sku: "TEST4VC/A",
          title: "iPhone Test",
          storeNumber: "R123",
          storeName: "Apple Test",
          observedAt: now,
          purchaseUrl:
            "https://www.apple.com/ca/shop/buy-iphone?part=TEST4VC%2FA",
        },
        channels: [
          {
            channel: "desktop",
            state: "pending",
            attempts: 0,
            nextAttemptAt: now,
            lastAttemptAt: null,
            completedAt: null,
          },
        ],
      },
    ];
    const storage = new Map<string, unknown>([
      [LOCAL_MONITOR_STORAGE_KEY, snapshot],
    ]);
    const fake = createApi(storage);
    const catalog = new LocalRuntimeCatalog({
      platform: { storage: {} } as never,
      assetUrl: "chrome-extension://test-extension/portable-catalog.json",
      fetch: async (url) => ({
        ok: true,
        status: 200,
        url,
        redirected: false,
        headers: { get: () => null },
        body: catalogStream({ withStore: true }),
      }),
    });
    const runtime = installLocalMonitorRuntime({
      api: fake.api,
      target: "chrome",
      catalog,
    });
    await runtime.ready;
    for (
      let index = 0;
      index < 20 && fake.notifications.length === 0;
      index += 1
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(fake.notifications).toHaveLength(1);
  });
});

describe("browser alarm reconciliation", () => {
  it("serializes delayed clears so an old clear cannot erase a replacement alarm", async () => {
    const active = new Set<string>();
    const periodicIntervals: number[] = [];
    const pendingClears: Array<() => void> = [];
    const alarms = {
      schedulePeriodic: (name: string, intervalSec: number) => {
        active.add(name);
        periodicIntervals.push(intervalSec);
      },
      scheduleOnce: (name: string) => {
        active.add(name);
      },
      cancel: (name: string) =>
        new Promise<boolean>((resolve) => {
          pendingClears.push(() => {
            active.delete(name);
            resolve(true);
          });
        }),
      onWake: () => undefined,
    };
    const scheduler = new BrowserMonitorScheduler(alarms, "chrome");
    scheduler.schedulePeriodic(60);
    await flush();
    scheduler.cancelAll();
    scheduler.schedulePeriodic(60);
    for (let index = 0; index < 20; index += 1) {
      while (pendingClears.length > 0) pendingClears.shift()?.();
      await flush();
      if (active.has(LOCAL_MONITOR_ALARM_NAMES.periodic)) break;
    }
    expect(active).toEqual(new Set([LOCAL_MONITOR_ALARM_NAMES.periodic]));
    expect(periodicIntervals).toEqual([120]);
  });

  it("uses target-aware alarm floors, allowing delayed but never early retry wakes", async () => {
    const recorded: number[] = [];
    const alarms = {
      schedulePeriodic: () => undefined,
      scheduleOnce: (_name: string, delayMs: number) => recorded.push(delayMs),
      cancel: async () => true,
      onWake: () => undefined,
    };
    const chrome = new BrowserMonitorScheduler(alarms, "chrome");
    chrome.scheduleOneShot(15_000);
    await flush();
    const firefox = new BrowserMonitorScheduler(alarms, "firefox");
    firefox.scheduleOneShot(15_000);
    await flush();
    expect(recorded).toEqual([30_000, 60_000]);
  });
});

describe("new watch runtime save", () => {
  it("checks after persistence, returns saved results, and does not check a rejected duplicate", async () => {
    const fake = createApi();
    const runtime = installLocalMonitorRuntime({
      api: fake.api,
      target: "chrome",
      catalog: immediatelyLoadedCatalog(),
    });
    await runtime.ready;
    const check = vi.spyOn(runtime.engine, "checkNewWatch");
    const response = await fake.dispatch(
      {
        protocol: LOCAL_MONITOR_PROTOCOL,
        type: "ADD_WATCH",
        watch: telegramWatch("first"),
      },
      {
        id: "test-extension",
        url: "chrome-extension://test-extension/app.html",
      },
    );
    expect(response).toMatchObject({ ok: true, result: true });
    expect(check).toHaveBeenCalledExactlyOnceWith("first");
    const snapshot = await runtime.engine.getSnapshot();
    expect(snapshot.watches).toHaveLength(1);
    expect(snapshot.items[0]?.lastCheckedAt).not.toBeNull();
    expect(snapshot.items[0]?.status).toBe("unknown");
    const duplicate = await fake.dispatch(
      {
        protocol: LOCAL_MONITOR_PROTOCOL,
        type: "ADD_WATCH",
        watch: telegramWatch("first"),
      },
      {
        id: "test-extension",
        url: "chrome-extension://test-extension/app.html",
      },
    );
    expect(duplicate).toMatchObject({ ok: true, result: false });
    expect(check).toHaveBeenCalledTimes(1);
  });
});
