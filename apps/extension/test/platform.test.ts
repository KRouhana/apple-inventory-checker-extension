import { describe, expect, it, vi } from "vitest";
import type { ExtensionApi, ExtensionMessageSender } from "../src/platform/api";
import {
  createExtensionPlatform,
  isAllowedApplePurchaseUrl,
} from "../src/platform/adapters";
import { installCheckoutMessageHandler } from "../src/platform/background";
import {
  createOpenCheckoutMessage,
  isTrustedBridgeSender,
  PLATFORM_PROTOCOL,
} from "../src/platform/messages";
import { CHECKOUT_PROTOCOL, type CheckoutMandate } from "../src/protocol";

const now = new Date();
const mandate: CheckoutMandate = {
  protocol: CHECKOUT_PROTOCOL,
  type: "ARM_CHECKOUT",
  id: "checkout-1",
  createdAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
  marketCode: "ca",
  sku: "TEST4VC/A",
  variantTitle: "iPhone Test",
  purchaseUrl: "https://www.apple.com/ca/shop/buy-iphone?part=TEST4VC%2FA",
  store: { id: "store-id", appleStoreNumber: "R123", name: "Apple Test" },
};

function createApi() {
  const storage = new Map<string, unknown>();
  let messageListener:
    | ((
        input: unknown,
        sender: ExtensionMessageSender,
        response: (value: unknown) => void,
      ) => boolean | void)
    | undefined;
  const createdAlarms: Array<{ name: string; details: object }> = [];
  const createdNotifications: Array<{
    id: string;
    options: {
      type: "basic";
      iconUrl: string;
      title: string;
      message: string;
    };
  }> = [];
  const createdTabs: Array<{ url: string }> = [];
  const alarmListeners: Array<(alarm: { name: string }) => void> = [];
  const api: ExtensionApi = {
    runtime: {
      id: "test-extension",
      getURL: (path) => `chrome-extension://test-extension/${path}`,
      onMessage: { addListener: (listener) => (messageListener = listener) },
      sendMessage: () => undefined,
    },
    storage: {
      local: {
        get: (key, callback) =>
          callback?.({ [String(key)]: storage.get(String(key)) }),
        set: (items, callback) => {
          for (const [key, value] of Object.entries(items))
            storage.set(key, value);
          callback?.();
        },
        remove: (key, callback) => {
          storage.delete(String(key));
          callback?.();
        },
      },
    },
    alarms: {
      create: (name, details) => createdAlarms.push({ name, details }),
      clear: (_name, callback) => callback?.(true),
      onAlarm: { addListener: (listener) => alarmListeners.push(listener) },
    },
    notifications: {
      getPermissionLevel: (callback) => callback?.("granted"),
      create: (id, options, callback) => {
        createdNotifications.push({ id, options });
        callback?.();
      },
    },
    permissions: { request: (_details, callback) => callback?.(true) },
    tabs: {
      create: (properties, callback) => {
        createdTabs.push(properties);
        callback?.();
      },
    },
  };
  return {
    api,
    storage,
    createdAlarms,
    createdNotifications,
    createdTabs,
    wake: (name: string) =>
      alarmListeners.forEach((listener) => listener({ name })),
    dispatch: (input: unknown, sender: ExtensionMessageSender) =>
      new Promise<unknown>((resolve) =>
        messageListener?.(input, sender, resolve),
      ),
  };
}

describe("extension platform adapters", () => {
  it("persists values, reconciles named alarms, and exposes wakeups", async () => {
    const fake = createApi();
    const platform = createExtensionPlatform(fake.api, "chrome");
    await platform.storage.write("watch", { id: "watch-1" });
    expect(await platform.storage.read("watch")).toEqual({ id: "watch-1" });
    await platform.storage.remove("watch");
    expect(await platform.storage.read("watch")).toBeNull();

    platform.alarms.schedulePeriodic("poll", 60);
    platform.alarms.scheduleOnce("retry", 30_000);
    expect(fake.createdAlarms).toEqual([
      { name: "poll", details: { delayInMinutes: 1, periodInMinutes: 1 } },
      { name: "retry", details: { delayInMinutes: 0.5 } },
    ]);
    const wake = vi.fn();
    platform.alarms.onWake(wake);
    fake.wake("poll");
    expect(wake).toHaveBeenCalledWith("poll");
    await expect(platform.alarms.cancel("poll")).resolves.toBe(true);
  });

  it("fails closed for Safari notifications and non-Apple tabs", async () => {
    const fake = createApi();
    const safari = createExtensionPlatform(fake.api, "safari");
    expect(safari.notifications.capability()).toBe("native-wrapper-required");
    await expect(safari.notifications.permissionState()).resolves.toBe(
      "unsupported",
    );
    await expect(
      safari.notifications.notify("id", "Title", "Message"),
    ).rejects.toThrow("native wrapper");
    await expect(
      safari.tabs.openApplePurchase("https://example.test/"),
    ).rejects.toThrow("Only canonical HTTPS www.apple.com");
    await expect(
      safari.permissions.requestTelegramHostPermission(),
    ).resolves.toBe(false);
  });

  it("uses a packaged local icon for Chrome-compatible notifications", async () => {
    const fake = createApi();
    const platform = createExtensionPlatform(fake.api, "chrome");

    await expect(
      platform.notifications.notify("available-1", "Available", "Apple Test"),
    ).resolves.toBeUndefined();
    expect(fake.createdNotifications).toEqual([
      {
        id: "available-1",
        options: {
          type: "basic",
          iconUrl:
            "chrome-extension://test-extension/icons/inventory-signal.png",
          title: "Available",
          message: "Apple Test",
        },
      },
    ]);
  });

  it("uses promise-only APIs when the browser namespace is present", async () => {
    const fake = createApi();
    fake.api.storage.local.get = (key, callback) => {
      if (callback) {
        throw new Error("Firefox-style storage must not receive a callback");
      }
      return Promise.resolve({ [String(key)]: fake.storage.get(String(key)) });
    };
    fake.api.storage.local.set = (items, callback) => {
      if (callback) {
        throw new Error("Firefox-style storage must not receive a callback");
      }
      for (const [key, value] of Object.entries(items)) {
        fake.storage.set(key, value);
      }
      return Promise.resolve();
    };
    vi.stubGlobal("browser", {});
    try {
      const platform = createExtensionPlatform(fake.api, "firefox");
      await platform.storage.write("watch", { id: "watch-2" });
      await expect(platform.storage.read("watch")).resolves.toEqual({
        id: "watch-2",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("propagates Chrome callback errors and uses Firefox promise APIs", async () => {
    const chrome = createApi();
    chrome.api.notifications!.create = (_id, _options, callback) => {
      chrome.api.runtime.lastError = { message: "notifications blocked" };
      callback?.();
      delete chrome.api.runtime.lastError;
    };
    await expect(
      createExtensionPlatform(chrome.api, "chrome").notifications.notify(
        "available-2",
        "Available",
        "Apple Test",
      ),
    ).rejects.toThrow("notifications blocked");

    const firefox = createApi();
    firefox.api.notifications!.create = (_id, _options, callback) => {
      if (callback)
        throw new Error("Firefox notifications must not use callbacks");
      return Promise.resolve();
    };
    firefox.api.permissions!.request = (_details, callback) => {
      if (callback)
        throw new Error("Firefox permissions must not use callbacks");
      return Promise.resolve(true);
    };
    firefox.api.tabs.create = (_details, callback) => {
      if (callback) throw new Error("Firefox tabs must not use callbacks");
      return Promise.resolve();
    };
    vi.stubGlobal("browser", {});
    try {
      const platform = createExtensionPlatform(firefox.api, "firefox");
      await expect(
        platform.notifications.notify("available-3", "Available", "Apple Test"),
      ).resolves.toBeUndefined();
      await expect(
        platform.permissions.requestTelegramHostPermission(),
      ).resolves.toBe(true);
      await expect(
        platform.tabs.openApplePurchase(mandate.purchaseUrl),
      ).resolves.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("requests and rechecks Firefox Telegram consent without changing Chrome", async () => {
    const firefox = createApi();
    const requests: unknown[] = [];
    const removed: Array<
      (details: { origins?: string[]; data_collection?: string[] }) => void
    > = [];
    let granted = {
      origins: ["https://api.telegram.org/*"],
      data_collection: [
        "authenticationInfo",
        "personallyIdentifyingInfo",
        "personalCommunications",
      ],
    };
    firefox.api.permissions = {
      request: (details) => {
        requests.push(details);
        return Promise.resolve(true);
      },
      getAll: () => Promise.resolve(granted),
      onRemoved: { addListener: (listener) => removed.push(listener) },
    };
    vi.stubGlobal("browser", {});
    try {
      const platform = createExtensionPlatform(firefox.api, "firefox");
      await expect(
        platform.permissions.requestTelegramHostPermission(),
      ).resolves.toBe(true);
      expect(requests).toEqual([
        {
          origins: ["https://api.telegram.org/*"],
          data_collection: [
            "authenticationInfo",
            "personallyIdentifyingInfo",
            "personalCommunications",
          ],
        },
      ]);
      await expect(platform.permissions.hasTelegramPermission()).resolves.toBe(
        true,
      );
      const revoked = vi.fn();
      platform.permissions.onTelegramPermissionRemoved(revoked);
      granted = { origins: [], data_collection: [] };
      removed[0]?.({ data_collection: ["personalCommunications"] });
      expect(revoked).toHaveBeenCalledTimes(1);
      await expect(platform.permissions.hasTelegramPermission()).resolves.toBe(
        false,
      );
    } finally {
      vi.unstubAllGlobals();
    }

    const chrome = createApi();
    const chromeRequests: unknown[] = [];
    chrome.api.permissions = {
      request: (details, callback) => {
        chromeRequests.push(details);
        callback?.(true);
      },
      getAll: (callback) =>
        callback?.({ origins: ["https://api.telegram.org/*"] }),
    };
    const chromePlatform = createExtensionPlatform(chrome.api, "chrome");
    await chromePlatform.permissions.requestTelegramHostPermission();
    expect(chromeRequests).toEqual([
      { origins: ["https://api.telegram.org/*"] },
    ]);
    await expect(
      chromePlatform.permissions.hasTelegramPermission(),
    ).resolves.toBe(true);
  });

  it("fails closed when Telegram permission inspection is unavailable", async () => {
    const fake = createApi();
    const platform = createExtensionPlatform(fake.api, "firefox");
    await expect(platform.permissions.hasTelegramPermission()).resolves.toBe(
      false,
    );
  });
});

describe("manual Apple tab boundary", () => {
  it("opens canonical manual SKU pages for every supported market", async () => {
    for (const url of [
      "https://www.apple.com/shop/buy-iphone?part=TEST4VC%2FA",
      "https://www.apple.com/ca/shop/buy-iphone?part=TEST4VC%2FA",
      "https://www.apple.com/uk/shop/buy-iphone?part=TEST4VC%2FA",
    ]) {
      const fake = createApi();
      await expect(
        createExtensionPlatform(fake.api, "chrome").tabs.openApplePurchase(url),
      ).resolves.toBeUndefined();
      expect(fake.createdTabs).toEqual([{ url }]);
      expect(isAllowedApplePurchaseUrl(url)).toBe(true);
    }
  });

  it("permits only structurally canonical selected-device routes at the tab boundary", async () => {
    const url =
      "https://www.apple.com/shop/buy-iphone/iphone-18-pro/6.3-inch-display-256gb-black-unlocked";
    const fake = createApi();
    await expect(
      createExtensionPlatform(fake.api, "chrome").tabs.openApplePurchase(url),
    ).resolves.toBeUndefined();
    expect(fake.createdTabs).toEqual([{ url }]);
  });

  it("rejects hosts, credentials, ports, hashes, redirects, and bad region/SKU pairs", async () => {
    const invalidUrls = [
      "https://apple.com/ca/shop/buy-iphone?part=TEST4VC%2FA",
      "https://user:pass@www.apple.com/ca/shop/buy-iphone?part=TEST4VC%2FA",
      "https://www.apple.com:443/ca/shop/buy-iphone?part=TEST4VC%2FA",
      "https://www.apple.com/ca/shop/buy-iphone?part=TEST4VC%2FA#fragment",
      "https://www.apple.com/ca/shop/buy-iphone?part=TEST4VC%2FA&next=https%3A%2F%2Fevil.example",
      "https://www.apple.com/au/shop/buy-iphone?part=TEST4VC%2FA",
      "https://www.apple.com/ca/shop/buy-iphone?part=not-a-sku",
      "https://www.apple.com/ca/shop/buy-iphone?part=TEST4VC/A",
      "https://www.apple.com/ca/shop/buy-iphone/not-approved/extra",
      "https://www.apple.com/ca/shop/buy-iphone/iphone-18-pro/6.3-inch-display-256gb-black/extra",
      "https://www.apple.com/ca/shop/buy-iphone/iphone-18-pro/6.3-inch-display-256gb-black?next=x",
      "https://www.apple.com/ca/shop/buy-iphone/iphone-duo/6.3-inch-display-256gb-black",
      "https://www.apple.com/ca/shop/buy-iphone/iphone-18-pro/6.3-inch-display-256gb-black-unlocked",
    ];
    for (const url of invalidUrls) {
      const fake = createApi();
      const platform = createExtensionPlatform(fake.api, "chrome");
      expect(isAllowedApplePurchaseUrl(url)).toBe(false);
      await expect(platform.tabs.openApplePurchase(url)).rejects.toThrow(
        "Only canonical HTTPS www.apple.com",
      );
      expect(fake.createdTabs).toEqual([]);
    }
  });
});

describe("checkout message boundary", () => {
  it("ignores foreign protocols so the monitor handler owns its response", async () => {
    const fake = createApi();
    installCheckoutMessageHandler(
      fake.api,
      createExtensionPlatform(fake.api, "chrome"),
    );
    const outcome = await Promise.race([
      fake.dispatch(
        { protocol: "inventory-signal.local-monitor.v1", type: "GET_SNAPSHOT" },
        {
          id: "test-extension",
          url: "chrome-extension://test-extension/app.html",
        },
      ),
      Promise.resolve("ignored"),
    ]);
    expect(outcome).toBe("ignored");
    expect(fake.storage.size).toBe(0);
  });

  it("rejects external and content-script-like senders before touching storage", async () => {
    const fake = createApi();
    const platform = createExtensionPlatform(fake.api, "chrome");
    installCheckoutMessageHandler(fake.api, platform);
    const message = createOpenCheckoutMessage(mandate);

    expect(
      isTrustedBridgeSender(
        { id: "other", tab: { url: "http://localhost:3000/" } },
        fake.api.runtime,
      ),
    ).toBe(false);
    expect(
      isTrustedBridgeSender(
        { id: "test-extension", tab: { url: "https://attacker.test/" } },
        fake.api.runtime,
      ),
    ).toBe(false);
    await expect(
      fake.dispatch(message, {
        id: "other",
        tab: { url: "http://localhost:3000/" },
      }),
    ).resolves.toEqual({ accepted: false });
    expect(fake.storage.size).toBe(0);
  });

  it("accepts only the internal protocol from the exact local bridge", async () => {
    const fake = createApi();
    const platform = createExtensionPlatform(fake.api, "chrome");
    installCheckoutMessageHandler(fake.api, platform);
    await expect(
      fake.dispatch(createOpenCheckoutMessage(mandate), {
        id: "test-extension",
        tab: { url: "http://127.0.0.1:3000/results" },
      }),
    ).resolves.toEqual({ accepted: true });
    expect(fake.storage.size).toBe(1);
    await expect(
      fake.dispatch(
        { protocol: PLATFORM_PROTOCOL, type: "FETCH_ANY_URL" },
        { id: "test-extension", tab: { url: "http://localhost:3000/" } },
      ),
    ).resolves.toEqual({ accepted: false });
  });
});
