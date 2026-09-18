import { describe, expect, it, vi } from "vitest";

import type { LocalAvailabilityEvent } from "../../../packages/core/src/local-monitor-contracts";
import {
  DesktopAlertService,
  type DesktopAlertCurrentStateValidator,
  type DesktopAlertNativePort,
} from "../src/notifications/desktop";
import type { ExtensionApi } from "../src/platform/api";
import {
  createExtensionPlatform,
  type ExtensionPlatform,
} from "../src/platform/adapters";

const event: LocalAvailabilityEvent = {
  watchId: "watch-1",
  market: "ca",
  sku: "TEST4VC/A",
  title: "iPhone Test",
  storeNumber: "R123",
  storeName: "Apple Test Toronto",
  observedAt: "2026-09-09T11:59:00.000Z",
  purchaseUrl: "https://www.apple.com/ca/shop/buy-iphone?part=TEST4VC%2FA",
};

function createHarness(
  options: {
    permission?: "granted" | "denied" | "unsupported";
    capability?: "browser-api" | "native-wrapper-required";
    decision?: "open-apple" | "show-local-result" | "deny";
    now?: number;
    sound?: { enabled: boolean; play: () => Promise<void> };
    native?: DesktopAlertNativePort;
  } = {},
) {
  const storage = new Map<string, unknown>();
  const notified: Array<{ id: string; title: string; message: string }> = [];
  const opened: string[] = [];
  const badges: string[] = [];
  const clickListeners: Array<(id: string) => void> = [];
  const currentState: DesktopAlertCurrentStateValidator = {
    canDeliver: vi.fn(async () => true),
    resolveClick: vi.fn(async () => options.decision ?? "open-apple"),
  };
  const platform = {
    notifications: {
      capability: () => options.capability ?? "browser-api",
      permissionState: async () => options.permission ?? "granted",
      notify: async (id: string, title: string, message: string) => {
        notified.push({ id, title, message });
      },
    },
    storage: {
      read: async <T>(key: string) =>
        (storage.get(key) as T | undefined) ?? null,
      write: async (key: string, value: unknown) => {
        storage.set(key, structuredClone(value));
      },
    },
    tabs: {
      openApplePurchase: async (url: string) => {
        opened.push(url);
      },
    },
  } as unknown as ExtensionPlatform;
  const api: ExtensionApi = {
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: { addListener: () => undefined },
      sendMessage: () => undefined,
    },
    storage: {
      local: {
        get: () => undefined,
        set: () => undefined,
        remove: () => undefined,
      },
    },
    tabs: { create: () => undefined },
    notifications: {
      create: () => undefined,
      onClicked: { addListener: (listener) => clickListeners.push(listener) },
    },
    action: {
      setBadgeText: ({ text }, callback) => {
        badges.push(text);
        callback?.();
      },
    },
  };
  const service = new DesktopAlertService({
    platform,
    api,
    currentState,
    sound: options.sound,
    native: options.native,
    now: () => options.now ?? Date.parse("2026-09-09T12:00:00.000Z"),
  });
  return {
    service,
    storage,
    notified,
    opened,
    badges,
    clickListeners,
    currentState,
  };
}

describe("desktop alerts", () => {
  it("schedules only fixed-content user diagnostics without a stock event or ledger", async () => {
    const harness = createHarness();
    await expect(harness.service.sendUserInitiatedTest()).resolves.toEqual({
      kind: "scheduled",
    });
    expect(harness.notified).toEqual([
      {
        id: "inventory-signal-diagnostic-v1",
        title: "Inventory Signal test notification",
        message:
          "This is a test notification. It does not report Apple availability.",
      },
    ]);
    await expect(harness.service.unreadCount()).resolves.toBe(0);
    await expect(harness.service.sendUserInitiatedTest()).resolves.toEqual({
      kind: "cooldown",
    });
  });

  it("bounds a diagnostic timeout and reports browser permission honestly", async () => {
    const denied = createHarness({ permission: "denied" });
    await expect(denied.service.sendUserInitiatedTest()).resolves.toEqual({
      kind: "permission-denied",
    });
    const hanging = createHarness();
    hanging.service as unknown as { options: unknown };
    // Replace the harness notification implementation through a dedicated
    // service with a tiny test-only deadline; no notification receipt follows.
    const storage = new Map<string, unknown>();
    const platform = {
      notifications: {
        capability: () => "browser-api" as const,
        permissionState: async () => "granted" as const,
        notify: () => new Promise<void>(() => undefined),
      },
      storage: {
        read: async () => storage.get("x") ?? null,
        write: async () => undefined,
      },
      tabs: { openApplePurchase: async () => undefined },
    } as unknown as ExtensionPlatform;
    const service = new DesktopAlertService({
      platform,
      api: createHarness().service["options"].api,
      currentState: {
        canDeliver: async () => false,
        resolveClick: async () => "deny",
      },
      diagnosticTimeoutMs: 1,
    });
    await expect(service.sendUserInitiatedTest()).resolves.toEqual({
      kind: "unavailable",
    });
    const nativeUnavailable: DesktopAlertNativePort = {
      schedule: async () => "unavailable",
      scheduleDiagnostic: async () => "unavailable",
      installClickListener: () => false,
    };
    const safari = createHarness({
      capability: "native-wrapper-required",
      native: nativeUnavailable,
    });
    await expect(safari.service.sendUserInitiatedTest()).resolves.toEqual({
      kind: "unavailable",
    });
  });
  it("reports denied and unsupported browser delivery without scheduling a notification", async () => {
    const denied = createHarness({ permission: "denied" });
    await expect(denied.service.notifyAvailable(event)).resolves.toMatchObject({
      kind: "permission-denied",
    });
    expect(denied.notified).toEqual([]);

    const safari = createHarness({ capability: "native-wrapper-required" });
    await expect(safari.service.notifyAvailable(event)).resolves.toMatchObject({
      kind: "unsupported",
    });
    expect(safari.notified).toEqual([]);
  });

  it("uses collision-resistant public event fingerprints for restart-safe deduplication", async () => {
    const first = createHarness();
    await expect(first.service.notifyAvailable(event)).resolves.toMatchObject({
      kind: "scheduled",
    });
    expect(first.notified).toHaveLength(1);
    expect(first.notified[0]!.id).toMatch(
      /^inventory-signal-available-[a-f0-9]{64}$/,
    );

    const restarted = createHarness();
    restarted.storage.set(
      "desktop-alert-state-v1",
      first.storage.get("desktop-alert-state-v1"),
    );
    await expect(
      restarted.service.notifyAvailable(event),
    ).resolves.toMatchObject({ kind: "deduplicated" });
    expect(restarted.notified).toEqual([]);
  });

  it("uses the injected native port and revalidates opaque native clicks", async () => {
    const scheduled: Array<{
      eventFingerprint: string;
      expiresAt: string;
      purchaseUrl: string;
    }> = [];
    let nativeClick: ((fingerprint: string) => void) | undefined;
    const native: DesktopAlertNativePort = {
      schedule: async (request) => {
        scheduled.push({
          eventFingerprint: request.eventFingerprint,
          expiresAt: request.expiresAt,
          purchaseUrl: request.event.purchaseUrl,
        });
        return "scheduled";
      },
      installClickListener: (listener) => {
        nativeClick = listener;
        return true;
      },
      scheduleDiagnostic: async () => "scheduled",
    };
    const harness = createHarness({
      capability: "native-wrapper-required",
      decision: "deny",
      native,
    });
    await expect(harness.service.notifyAvailable(event)).resolves.toMatchObject(
      {
        kind: "scheduled",
      },
    );
    expect(harness.notified).toEqual([]);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.eventFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(harness.service.installNativeClickHandler()).toBe(true);
    expect(nativeClick).toBeTypeOf("function");
    await expect(
      harness.service.handleNativeClick(scheduled[0]!.eventFingerprint),
    ).resolves.toEqual({ kind: "denied", reason: "stale-watch-or-stock" });
    expect(harness.opened).toEqual([]);
    await expect(
      harness.service.handleNativeClick("not-a-fingerprint"),
    ).resolves.toEqual({
      kind: "denied",
      reason: "unknown-notification",
    });
  });

  it("creates a new alert for a distinct restock observation", async () => {
    const harness = createHarness();
    await harness.service.notifyAvailable(event);
    await harness.service.notifyAvailable({
      ...event,
      observedAt: "2026-09-09T12:00:00.000Z",
    });
    expect(harness.notified).toHaveLength(2);
  });

  it("serializes concurrent public-ledger writes without losing either alert", async () => {
    const harness = createHarness();
    await Promise.all([
      harness.service.notifyAvailable(event),
      harness.service.notifyAvailable({
        ...event,
        sku: "OTHER4VC/A",
        purchaseUrl:
          "https://www.apple.com/ca/shop/buy-iphone?part=OTHER4VC%2FA",
      }),
    ]);
    expect(harness.notified).toHaveLength(2);
    await expect(harness.service.unreadCount()).resolves.toBe(2);
  });

  it("requires current watch/catalog/availability validation before a click opens Apple", async () => {
    const harness = createHarness({ decision: "deny" });
    await harness.service.notifyAvailable(event);
    const notificationId = harness.notified[0]!.id;
    await expect(harness.service.handleClick(notificationId)).resolves.toEqual({
      kind: "denied",
      reason: "stale-watch-or-stock",
    });
    expect(harness.opened).toEqual([]);
    expect(harness.currentState.resolveClick).toHaveBeenCalledWith(event);
  });

  it("rechecks current watch/catalog/availability immediately before notification scheduling", async () => {
    const harness = createHarness();
    harness.currentState.canDeliver = vi.fn(async () => false);
    await expect(harness.service.notifyAvailable(event)).resolves.toMatchObject(
      {
        kind: "stale",
      },
    );
    expect(harness.notified).toEqual([]);
  });

  it("denies expired and malformed click references instead of opening arbitrary URLs", async () => {
    const fresh = createHarness();
    await fresh.service.notifyAvailable(event);
    const id = fresh.notified[0]!.id;
    const expired = createHarness({
      now: Date.parse("2026-09-09T12:11:00.000Z"),
    });
    expired.storage.set(
      "desktop-alert-state-v1",
      fresh.storage.get("desktop-alert-state-v1"),
    );
    await expect(expired.service.handleClick(id)).resolves.toEqual({
      kind: "denied",
      reason: "expired-or-unknown",
    });
    expect(expired.opened).toEqual([]);

    const malformed = createHarness();
    const saved = structuredClone(
      fresh.storage.get("desktop-alert-state-v1"),
    ) as {
      references: Array<{ event: { purchaseUrl: string } }>;
    };
    saved.references[0]!.event.purchaseUrl =
      "https://attacker.example/checkout";
    malformed.storage.set("desktop-alert-state-v1", saved);
    await expect(malformed.service.handleClick(id)).resolves.toMatchObject({
      kind: "denied",
    });
    expect(malformed.opened).toEqual([]);
  });

  it("updates a bounded unread badge only on delivery and explicit UI mark-read", async () => {
    const harness = createHarness();
    await harness.service.notifyAvailable(event);
    const id = harness.notified[0]!.id;
    expect(harness.badges).toEqual(["1"]);
    await harness.service.handleClick(id);
    expect(harness.badges).toEqual(["1"]);
    await expect(harness.service.markRead(id)).resolves.toBe(true);
    expect(harness.badges).toEqual(["1", ""]);
    await expect(harness.service.unreadCount()).resolves.toBe(0);
  });

  it("binds saved notification references to the validated event hash", async () => {
    const fresh = createHarness();
    await fresh.service.notifyAvailable(event);
    const saved = structuredClone(
      fresh.storage.get("desktop-alert-state-v1"),
    ) as {
      references: Array<{
        expiresAt: string;
        eventFingerprint: string;
        notificationId: string;
      }>;
    };
    saved.references[0]!.expiresAt = "2099-01-01T00:00:00.000Z";
    saved.references[0]!.eventFingerprint = "f".repeat(64);
    saved.references[0]!.notificationId =
      "inventory-signal-available-" + "f".repeat(64);

    const restarted = createHarness();
    restarted.storage.set("desktop-alert-state-v1", saved);
    await expect(restarted.service.reconcile()).resolves.toBe(0);
    expect(restarted.storage.get("desktop-alert-state-v1")).toEqual({
      version: 1,
      references: [],
    });
  });

  it("prunes future-expiry records and reconciles a stale badge after restart", async () => {
    const fresh = createHarness();
    await fresh.service.notifyAvailable(event);
    expect(fresh.badges).toEqual(["1"]);
    const saved = structuredClone(fresh.storage.get("desktop-alert-state-v1"));
    const restarted = createHarness({
      now: Date.parse("2026-09-09T12:11:00.000Z"),
    });
    restarted.storage.set("desktop-alert-state-v1", saved);
    await expect(restarted.service.start()).resolves.toBe(0);
    expect(restarted.badges).toEqual([""]);
    expect(restarted.storage.get("desktop-alert-state-v1")).toEqual({
      version: 1,
      references: [],
    });
    await expect(
      restarted.service.notifyAvailable({
        ...event,
        observedAt: "2026-09-09T12:10:30.000Z",
      }),
    ).resolves.toMatchObject({ kind: "scheduled" });
  });

  it("installs one browser click listener and handles caller cancellation before side effects", async () => {
    const harness = createHarness();
    expect(harness.service.installClickHandler()).toBe(true);
    expect(harness.service.installClickHandler()).toBe(false);
    expect(harness.clickListeners).toHaveLength(1);
    const controller = new AbortController();
    controller.abort();
    await expect(
      harness.service.notifyAvailable(event, { signal: controller.signal }),
    ).resolves.toMatchObject({ kind: "aborted" });
    expect(harness.notified).toEqual([]);
  });

  it("reports optional sound blocking without failing a scheduled desktop alert", async () => {
    const harness = createHarness({
      sound: {
        enabled: true,
        play: async () => Promise.reject(new Error("autoplay blocked")),
      },
    });
    await expect(harness.service.notifyAvailable(event)).resolves.toMatchObject(
      {
        kind: "scheduled",
        sound: "blocked",
      },
    );
    expect(harness.notified).toHaveLength(1);
  });

  it("uses the existing Chrome callback and Firefox promise platform adapters", async () => {
    for (const mode of ["callback", "promise"] as const) {
      const values = new Map<string, unknown>();
      const notifications: string[] = [];
      const badges: string[] = [];
      const api: ExtensionApi = {
        runtime: {
          getURL: (path) => `extension://test/${path}`,
          onMessage: { addListener: () => undefined },
          sendMessage: () => undefined,
        },
        storage: {
          local: {
            get: (key, callback) => {
              if (mode === "promise") {
                if (callback)
                  throw new Error("Firefox must not receive a callback");
                return Promise.resolve({
                  [String(key)]: values.get(String(key)),
                });
              }
              callback?.({ [String(key)]: values.get(String(key)) });
              return undefined;
            },
            set: (input, callback) => {
              if (mode === "promise") {
                if (callback)
                  throw new Error("Firefox must not receive a callback");
                for (const [key, value] of Object.entries(input))
                  values.set(key, value);
                return Promise.resolve();
              }
              for (const [key, value] of Object.entries(input))
                values.set(key, value);
              callback?.();
              return undefined;
            },
            remove: () => undefined,
          },
        },
        notifications: {
          getPermissionLevel: (callback) => {
            if (mode === "promise") {
              if (callback)
                throw new Error("Firefox must not receive a callback");
              return Promise.resolve("granted" as const);
            }
            callback?.("granted");
            return undefined;
          },
          create: (id, _options, callback) => {
            if (mode === "promise") {
              if (callback)
                throw new Error("Firefox must not receive a callback");
              notifications.push(id);
              return Promise.resolve();
            }
            notifications.push(id);
            callback?.();
            return undefined;
          },
        },
        action: {
          setBadgeText: ({ text }, callback) => {
            if (mode === "promise") {
              if (callback)
                throw new Error("Firefox must not receive a callback");
              badges.push(text);
              return Promise.resolve();
            }
            badges.push(text);
            callback?.();
            return undefined;
          },
        },
        tabs: { create: () => undefined },
      };
      if (mode === "promise") vi.stubGlobal("browser", {});
      try {
        const service = new DesktopAlertService({
          platform: createExtensionPlatform(
            api,
            mode === "promise" ? "firefox" : "chrome",
          ),
          api,
          currentState: {
            canDeliver: async () => true,
            resolveClick: async () => "deny",
          },
          now: () => Date.parse("2026-09-09T12:00:00.000Z"),
        });
        await expect(service.notifyAvailable(event)).resolves.toMatchObject({
          kind: "scheduled",
        });
      } finally {
        vi.unstubAllGlobals();
      }
      expect(notifications).toHaveLength(1);
      expect(badges).toEqual(["1"]);
    }
  });
});
