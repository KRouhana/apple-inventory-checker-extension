// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { mountLocalMonitorUi } from "../../src/ui/view.js";
import type {
  LocalMonitorUiCatalog,
  MonitorUiController,
  MonitorUiSnapshot,
} from "../../src/ui/controller.js";
import type { LocalWatch } from "../../../../packages/core/src/local-monitor-contracts.js";
import type { PublicTelegramStatus } from "../../src/platform/telegram-messages.js";

const snapshot: MonitorUiSnapshot = {
  version: 1,
  watches: [],
  items: [],
  history: [],
  pendingDelivery: [],
};

const catalog: LocalMonitorUiCatalog = {
  schemaVersion: 1,
  generatedAt: "2026-09-09T12:00:00.000Z",
  markets: [
    {
      code: "ca",
      name: "Canada",
      storefrontPath: "/ca",
      variants: [
        {
          sku: "TEST4VC/A",
          title: "iPhone Test 256GB Blue",
          familySlug: "iphone-test",
        },
      ],
      stores: [
        {
          storeNumber: "R123",
          name: "Apple Test",
          city: "Toronto",
          region: "ON",
        },
        {
          storeNumber: "R124",
          name: "Apple Test Two",
          city: "Toronto",
          region: "ON",
        },
      ],
    },
    {
      code: "us",
      name: "United States",
      storefrontPath: "/us",
      variants: [
        {
          sku: "TEST4LL/A",
          title: "iPhone Test 256GB Blue",
          familySlug: "iphone-test",
        },
      ],
      stores: [
        {
          storeNumber: "R999",
          name: "Apple Other Market",
          city: "New York",
          region: "NY",
        },
      ],
    },
  ],
};

async function flush(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

function makeController(
  telegram: MonitorUiController["personalTelegram"],
): MonitorUiController {
  const report = {
    kind: "completed" as const,
    attemptedBatches: 0,
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
      personalTelegram: true,
      hostedRelay: false,
    },
    personalTelegram: telegram,
    getSnapshot: vi.fn(async () => snapshot),
    getCatalog: vi.fn(async () => catalog),
    lookupStores: vi.fn(async () => ({
      kind: "matches" as const,
      stores: catalog.markets[0]!.stores,
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

describe("mounted Personal Telegram setup UI", () => {
  it("offers explicit recovery when saved Telegram credentials cannot be read", async () => {
    let unreadable = true;
    const disconnected = { kind: "disconnected" } as const;
    const disconnect = vi.fn(async () => {
      unreadable = false;
      return disconnected;
    });
    const root = document.createElement("div");
    const mounted = mountLocalMonitorUi(
      root,
      makeController({
        status: vi.fn(async () => {
          if (unreadable) throw new Error("Saved connection unavailable");
          return disconnected;
        }),
        startPairing: vi.fn(async () => disconnected),
        confirmPairing: vi.fn(async () => disconnected),
        sendTest: vi.fn(async () => disconnected),
        disconnect,
      }),
    );
    await mounted.refresh();
    expect(root.textContent).toContain(
      "The saved Telegram connection could not be read",
    );
    expect(root.querySelector("[data-telegram-token]")).toBeNull();
    expect(disconnect).not.toHaveBeenCalled();
    root
      .querySelector<HTMLButtonElement>("[data-action=telegram-disconnect]")!
      .click();
    await flush(20);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(root.querySelector("[data-telegram-token]")).not.toBeNull();
    expect(root.textContent).not.toContain(
      "The saved Telegram connection could not be read",
    );
    mounted.destroy();
  });

  it("explains an unknown check without turning it into an out-of-stock result", async () => {
    const savedWatch: LocalWatch = {
      id: "watch-one",
      market: "ca",
      skus: ["TEST4VC/A"],
      storeNumbers: ["R123"],
      pollAnchor: { storeNumber: "R123" },
      enabled: true,
      pollIntervalSec: 120,
      deliveryChannels: {
        desktop: false,
        personalTelegram: false,
        hostedRelay: false,
      },
      catalogSchemaVersion: 1,
      createdAt: "2026-09-09T12:00:00.000Z",
      updatedAt: "2026-09-09T12:00:00.000Z",
    };
    let failed: MonitorUiSnapshot = {
      ...snapshot,
      watches: [savedWatch],
      items: [
        {
          watchId: savedWatch.id,
          sku: "TEST4VC/A",
          storeNumber: "R123",
          status: "unknown",
          lastKnownStatus: null,
          lastCheckedAt: savedWatch.createdAt,
          lastSuccessfulAt: null,
          lastFailure: { reason: "http_error", httpStatus: 541 },
        },
      ],
    };
    const root = document.createElement("div");
    const mounted = mountLocalMonitorUi(root, {
      ...makeController(undefined),
      getSnapshot: vi.fn(async () => failed),
    });
    await mounted.refresh();
    expect(root.textContent).toContain("Apple returned HTTP 541");
    expect(root.textContent).toContain(
      "Stock is unknown, not confirmed out of stock",
    );
    expect(
      root.querySelector("[data-action=open-available-at-apple]"),
    ).toBeNull();
    failed = {
      ...failed,
      items: failed.items.map(({ lastFailure: _lastFailure, ...item }) => item),
    };
    await mounted.refresh();
    expect(root.textContent).toContain("No detailed reason was saved");
    mounted.destroy();
  });

  it("explains an empty Connect retry without requesting permission or contacting Telegram", async () => {
    const status = { kind: "disconnected" } as const;
    const startPairing = vi.fn(async () => status);
    const permission = vi.fn(async () => true);
    const root = document.createElement("div");
    const mounted = mountLocalMonitorUi(
      root,
      makeController({
        status: vi.fn(async () => status),
        startPairing,
        confirmPairing: vi.fn(async () => status),
        sendTest: vi.fn(async () => status),
        disconnect: vi.fn(async () => status),
      }),
      { requestTelegramHostPermission: permission },
    );
    await mounted.refresh();
    root
      .querySelector<HTMLButtonElement>("[data-action=telegram-start]")!
      .click();
    await flush();
    expect(root.textContent).toContain(
      "Paste the complete bot token into the Bot token field",
    );
    expect(permission).not.toHaveBeenCalled();
    expect(startPairing).not.toHaveBeenCalled();
    mounted.destroy();
  });

  it("offers a test for a saved token without pairing and enables alerts only after success", async () => {
    let status: PublicTelegramStatus = {
      kind: "token_saved",
      botUsername: "SyntheticBot",
    };
    const sendTest = vi.fn(async () => {
      status = { kind: "connected", botUsername: "SyntheticBot" };
      return status;
    });
    const confirmPairing = vi.fn(async () => status);
    const root = document.createElement("div");
    const mounted = mountLocalMonitorUi(
      root,
      makeController({
        status: vi.fn(async () => status),
        startPairing: vi.fn(async () => status),
        confirmPairing,
        sendTest,
        disconnect: vi.fn(async () => ({ kind: "disconnected" }) as const),
      }),
    );
    await mounted.refresh();
    expect(root.textContent).toContain("Token saved");
    expect(root.textContent).not.toContain("Check connection");
    expect(root.textContent).not.toContain("expires");
    expect(
      root.querySelector<HTMLInputElement>("input[name=telegram]")!.disabled,
    ).toBe(true);
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(confirmPairing).not.toHaveBeenCalled();
    expect(sendTest).not.toHaveBeenCalled();
    const button = root.querySelector<HTMLButtonElement>(
      "[data-action=telegram-test]",
    )!;
    expect(button.disabled).toBe(false);
    button.click();
    await flush();
    expect(sendTest).toHaveBeenCalledTimes(1);
    expect(root.textContent).toContain("Connected to @SyntheticBot");
    expect(
      root.querySelector<HTMLInputElement>("input[name=telegram]")!.disabled,
    ).toBe(false);
    mounted.destroy();
  });

  it("keeps the token saved and offers retry after a failed test", async () => {
    const status = {
      kind: "token_saved",
      botUsername: "SyntheticBot",
    } as const;
    const root = document.createElement("div");
    const mounted = mountLocalMonitorUi(
      root,
      makeController({
        status: vi.fn(async () => status),
        startPairing: vi.fn(async () => status),
        confirmPairing: vi.fn(async () => status),
        sendTest: vi.fn(async () => {
          throw new Error(
            "No private chat was found. Send any message to your bot, then try again.",
          );
        }),
        disconnect: vi.fn(async () => status),
      }),
    );
    await mounted.refresh();
    root
      .querySelector<HTMLButtonElement>("[data-action=telegram-test]")!
      .click();
    await flush();
    expect(root.textContent).toContain("No private chat was found");
    expect(
      root.querySelector<HTMLButtonElement>("[data-action=telegram-test]")!
        .disabled,
    ).toBe(false);
    expect(
      root.querySelector<HTMLInputElement>("input[name=telegram]")!.disabled,
    ).toBe(true);
    mounted.destroy();
  });

  it("keeps a connected channel selected after a transient status failure", async () => {
    const connected = {
      kind: "connected",
      botUsername: "SyntheticBot",
    } as const;
    const status = vi.fn(async () => connected);
    const root = document.createElement("div");
    const mounted = mountLocalMonitorUi(
      root,
      makeController({
        status,
        startPairing: vi.fn(async () => connected),
        confirmPairing: vi.fn(async () => connected),
        sendTest: vi.fn(async () => connected),
        disconnect: vi.fn(async () => ({ kind: "disconnected" }) as const),
      }),
    );
    await mounted.refresh();
    const channel = root.querySelector<HTMLInputElement>(
      "input[name=telegram]",
    )!;
    channel.checked = true;
    channel.dispatchEvent(new Event("change"));
    status.mockRejectedValueOnce(
      new Error("background temporarily unavailable"),
    );
    await mounted.refresh();
    expect(
      root.querySelector<HTMLInputElement>("input[name=telegram]")!.checked,
    ).toBe(true);
    expect(
      root.querySelector<HTMLInputElement>("input[name=telegram]")!.disabled,
    ).toBe(true);
    mounted.destroy();
  });

  it("does not let an older refresh undo a successful connection", async () => {
    let status: PublicTelegramStatus = {
      kind: "pairing",
      pairingCommand: `INVENTORY SIGNAL ${"a".repeat(64)}`,
      expiresAt: "2026-09-09T12:10:00.000Z",
    };
    const controller = makeController({
      status: vi.fn(async () => status),
      startPairing: vi.fn(async () => status),
      sendTest: vi.fn(async () => {
        status = { kind: "connected", botUsername: "SyntheticBot" };
        return status;
      }),
      confirmPairing: vi.fn(async () => status),
      disconnect: vi.fn(async () => status),
    });
    const root = document.createElement("div");
    const mounted = mountLocalMonitorUi(root, controller);
    await mounted.refresh();
    let finish!: (value: MonitorUiSnapshot) => void;
    vi.mocked(controller.getSnapshot).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const olderRefresh = mounted.refresh();
    await flush();
    root
      .querySelector<HTMLButtonElement>("[data-action=telegram-test]")!
      .click();
    await flush();
    finish(snapshot);
    await olderRefresh;
    expect(root.textContent).toContain("Connected to @SyntheticBot");
    expect(
      root.querySelector<HTMLInputElement>("input[name=telegram]")!.disabled,
    ).toBe(false);
    mounted.destroy();
  });

  it("creates a watch from the latest postal lookup and retains watch controls", async () => {
    const root = document.createElement("div");
    let currentSnapshot = snapshot;
    const addWatch = vi.fn(async (watch) => {
      currentSnapshot = { ...snapshot, watches: [watch] };
      return true;
    });
    const controller: MonitorUiController = {
      ...makeController(undefined),
      capabilities: {
        monitor: true,
        catalog: true,
        storeLookup: true,
        personalTelegram: false,
        hostedRelay: false,
      },
      getSnapshot: vi.fn(async () => currentSnapshot),
      addWatch,
    };
    const mounted = mountLocalMonitorUi(root, controller);
    await mounted.refresh();

    expect(
      root.querySelector<HTMLButtonElement>("button[type=submit]")!.disabled,
    ).toBe(true);
    expect(root.textContent).toContain(
      "Enter a postal code to find public stores",
    );
    expect(root.textContent).toContain(
      "Select stores from a postal-code search to create this watch.",
    );
    expect(root.querySelector("select[name=poll-anchor]")).toBeNull();

    const select = (name: string, value: string) => {
      const element = root.querySelector<HTMLSelectElement>(
        `select[name=${name}]`,
      )!;
      element.value = value;
      element.dispatchEvent(new Event("change"));
    };
    select("market", "ca");
    select("model", "iphone-test");
    select("storage", "256GB");
    select("color", "Blue");
    const location = root.querySelector<HTMLInputElement>(
      "input[name=location]",
    )!;
    location.value = "M5V 2T6";
    location.dispatchEvent(new Event("input"));
    root
      .querySelector<HTMLButtonElement>("[data-action=lookup-stores]")!
      .click();
    await flush();
    const store = root.querySelector<HTMLInputElement>(
      "input[data-store-number=R123]",
    )!;
    store.checked = true;
    store.dispatchEvent(new Event("change"));
    expect(
      root.querySelector<HTMLButtonElement>("button[type=submit]")!.disabled,
    ).toBe(false);
    root
      .querySelector<HTMLFormElement>("[data-watch-form]")!
      .dispatchEvent(new Event("submit", { cancelable: true }));
    await flush(16);

    expect(addWatch).toHaveBeenCalledWith(
      expect.objectContaining({
        market: "ca",
        skus: ["TEST4VC/A"],
        storeNumbers: ["R123"],
        pollAnchor: { storeNumber: "R123" },
      }),
    );
    expect(JSON.stringify(addWatch.mock.calls)).not.toContain("Toronto");

    const watch = currentSnapshot.watches[0]!;
    root.querySelector<HTMLButtonElement>("[data-action=check-watch]")!.click();
    await flush();
    expect(controller.checkNow).toHaveBeenCalledWith([watch.id]);
    root
      .querySelector<HTMLButtonElement>("[data-action=toggle-watch]")!
      .click();
    await flush();
    expect(controller.setWatchEnabled).toHaveBeenCalledWith(watch.id, false);
    mounted.destroy();
  });

  it("sorts storage, auto-selects a unique variant, validates whole minutes, and hides hosted relay controls", async () => {
    const root = document.createElement("div");
    const formCatalog: LocalMonitorUiCatalog = {
      ...catalog,
      markets: [
        {
          ...catalog.markets[0]!,
          variants: [
            {
              sku: "TEST4VC/A",
              title: "iPhone Test 256GB Blue",
              familySlug: "iphone-test",
            },
            {
              sku: "TEST5VC/A",
              title: "iPhone Test 512GB Blue",
              familySlug: "iphone-test",
            },
            {
              sku: "TEST6VC/A",
              title: "iPhone Test 1TB Blue",
              familySlug: "iphone-test",
            },
            {
              sku: "TEST7VC/A",
              title: "iPhone Test 2TB Blue",
              familySlug: "iphone-test",
            },
          ],
        },
      ],
    };
    const mounted = mountLocalMonitorUi(root, {
      ...makeController(undefined),
      capabilities: {
        monitor: true,
        catalog: true,
        storeLookup: false,
        personalTelegram: false,
        // Backend capability remains intact; this local form must not expose it.
        hostedRelay: true,
      },
      getCatalog: vi.fn(async () => formCatalog),
    });
    await mounted.refresh();

    const select = (name: string, value: string) => {
      const element = root.querySelector<HTMLSelectElement>(
        `select[name=${name}]`,
      )!;
      element.value = value;
      element.dispatchEvent(new Event("change"));
    };
    select("market", "ca");
    select("model", "iphone-test");
    expect(
      Array.from(
        root.querySelectorAll<HTMLSelectElement>("select[name=storage] option"),
      )
        .map((option) => option.value)
        .filter(Boolean),
    ).toEqual(["256GB", "512GB", "1TB", "2TB"]);
    select("storage", "1TB");
    select("color", "Blue");

    expect(root.querySelector("select[name=sku]")).toBeNull();
    expect(root.textContent).toContain("iPhone Test 1TB Blue");
    expect(root.textContent).toContain("TEST6VC/A");
    expect(root.textContent).not.toContain("(read-only)");
    expect(root.textContent).not.toContain("Hosted relay");
    expect(root.querySelector("input[name=relay]")).toBeNull();

    const interval = root.querySelector<HTMLInputElement>(
      "input[name=interval]",
    )!;
    expect(interval.min).toBe("2");
    expect(interval.max).toBe("60");
    expect(interval.step).toBe("1");
    interval.value = "2.5";
    interval.dispatchEvent(new Event("input"));
    root
      .querySelector<HTMLFormElement>("[data-watch-form]")!
      .dispatchEvent(new Event("submit", { cancelable: true }));
    expect(root.textContent).toContain(
      "Choose a whole check interval from 2 to 60 minutes.",
    );
    mounted.destroy();
  });

  it("preserves each existing delivery channel while editing without surfacing hosted relay", async () => {
    const root = document.createElement("div");
    const watch: LocalWatch = {
      id: "watch-edit",
      market: "ca",
      skus: ["TEST4VC/A"],
      storeNumbers: ["R123", "R124"],
      pollAnchor: { storeNumber: "R124" },
      pollIntervalSec: 120,
      enabled: false,
      deliveryChannels: {
        desktop: false,
        personalTelegram: false,
        hostedRelay: true,
      },
      catalogSchemaVersion: 1,
      createdAt: "2026-09-09T12:00:00.000Z",
      updatedAt: "2026-09-09T12:00:00.000Z",
    };
    let currentSnapshot: MonitorUiSnapshot = { ...snapshot, watches: [watch] };
    const replaceWatch = vi.fn(async (replacement: LocalWatch) => {
      currentSnapshot = { ...snapshot, watches: [replacement] };
      return true;
    });
    const mounted = mountLocalMonitorUi(root, {
      ...makeController(undefined),
      getSnapshot: vi.fn(async () => currentSnapshot),
      replaceWatch,
    });
    await mounted.refresh();

    root.querySelector<HTMLButtonElement>("[data-action=edit-watch]")!.click();
    expect(root.querySelector("input[name=relay]")).toBeNull();
    expect(root.textContent).not.toContain("Hosted relay");
    root
      .querySelector<HTMLFormElement>("[data-watch-form]")!
      .dispatchEvent(new Event("submit", { cancelable: true }));
    await flush(16);

    expect(replaceWatch).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
        pollAnchor: { storeNumber: "R124" },
        deliveryChannels: {
          desktop: false,
          personalTelegram: false,
          hostedRelay: true,
        },
      }),
    );
    mounted.destroy();
  });

  it("keeps an edit's saved stores and custom anchor after catalog refresh fails", async () => {
    const root = document.createElement("div");
    const watch: LocalWatch = {
      id: "watch-refresh-failure",
      market: "ca",
      skus: ["TEST4VC/A"],
      storeNumbers: ["R123", "R124"],
      pollAnchor: { storeNumber: "R124" },
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
    let rejectRefresh = false;
    const replaceWatch = vi.fn(async () => true);
    const mounted = mountLocalMonitorUi(root, {
      ...makeController(undefined),
      getSnapshot: vi.fn(async () => ({ ...snapshot, watches: [watch] })),
      getCatalog: vi.fn(async () => {
        if (rejectRefresh) throw new Error("synthetic catalog failure");
        return catalog;
      }),
      lookupStores: vi.fn(async () => ({
        kind: "matches" as const,
        stores: catalog.markets[0]!.stores,
      })),
      replaceWatch,
    });
    await mounted.refresh();
    root.querySelector<HTMLButtonElement>("[data-action=edit-watch]")!.click();
    rejectRefresh = true;
    const postal = root.querySelector<HTMLInputElement>(
      "input[name=location]",
    )!;
    postal.value = "M5V 2T6";
    postal.dispatchEvent(new Event("input"));
    root
      .querySelector<HTMLButtonElement>("[data-action=lookup-stores]")!
      .click();
    await flush();

    expect(root.textContent).toContain(
      "Could not load stores. Existing store choices were kept. Try again.",
    );
    expect(
      root.querySelector<HTMLInputElement>("input[data-store-number=R123]")!
        .checked,
    ).toBe(true);
    expect(
      root.querySelector<HTMLInputElement>("input[data-store-number=R124]")!
        .checked,
    ).toBe(true);
    root
      .querySelector<HTMLFormElement>("[data-watch-form]")!
      .dispatchEvent(new Event("submit", { cancelable: true }));
    await flush(16);
    expect(replaceWatch).toHaveBeenCalledWith(
      expect.objectContaining({
        storeNumbers: ["R123", "R124"],
        pollAnchor: { storeNumber: "R124" },
      }),
    );
    mounted.destroy();
  });

  it("ignores a late catalog-refresh failure after the postal input changes", async () => {
    const root = document.createElement("div");
    let deferRefresh = false;
    let rejectRefresh!: (reason?: unknown) => void;
    const mounted = mountLocalMonitorUi(root, {
      ...makeController(undefined),
      getCatalog: vi.fn(() => {
        if (!deferRefresh) return Promise.resolve(catalog);
        return new Promise<LocalMonitorUiCatalog>((_resolve, reject) => {
          rejectRefresh = reject;
        });
      }),
      lookupStores: vi.fn(async () => ({
        kind: "matches" as const,
        stores: catalog.markets[0]!.stores,
      })),
    });
    await mounted.refresh();
    deferRefresh = true;
    const market = root.querySelector<HTMLSelectElement>(
      "select[name=market]",
    )!;
    market.value = "ca";
    market.dispatchEvent(new Event("change"));
    const postal = root.querySelector<HTMLInputElement>(
      "input[name=location]",
    )!;
    postal.value = "M5V 2T6";
    postal.dispatchEvent(new Event("input"));
    root
      .querySelector<HTMLButtonElement>("[data-action=lookup-stores]")!
      .click();
    await flush();

    const replacement = root.querySelector<HTMLInputElement>(
      "input[name=location]",
    )!;
    expect(replacement.disabled).toBe(false);
    replacement.value = "M5V 2T7";
    replacement.dispatchEvent(new Event("input"));
    rejectRefresh(new Error("late synthetic failure"));
    await flush();

    expect(
      root.querySelector<HTMLInputElement>("input[name=location]")!.value,
    ).toBe("M5V 2T7");
    expect(root.textContent).not.toContain(
      "Store lookup could not refresh the current catalog.",
    );
    expect(
      root.querySelector<HTMLButtonElement>("[data-action=lookup-stores]")!
        .disabled,
    ).toBe(false);
    mounted.destroy();
  });

  it("ignores an A-to-B-to-A stale catalog refresh by lookup generation", async () => {
    const root = document.createElement("div");
    let deferRefresh = false;
    let resolveRefresh!: (catalog: LocalMonitorUiCatalog) => void;
    const mounted = mountLocalMonitorUi(root, {
      ...makeController(undefined),
      getCatalog: vi.fn(() => {
        if (!deferRefresh) return Promise.resolve(catalog);
        return new Promise<LocalMonitorUiCatalog>((resolve) => {
          resolveRefresh = resolve;
        });
      }),
      lookupStores: vi.fn(async () => ({
        kind: "matches" as const,
        stores: catalog.markets[0]!.stores,
      })),
    });
    await mounted.refresh();
    deferRefresh = true;
    const market = root.querySelector<HTMLSelectElement>(
      "select[name=market]",
    )!;
    market.value = "ca";
    market.dispatchEvent(new Event("change"));
    const setPostal = (value: string) => {
      const postal = root.querySelector<HTMLInputElement>(
        "input[name=location]",
      )!;
      postal.value = value;
      postal.dispatchEvent(new Event("input"));
    };
    setPostal("M5V 2T6");
    root
      .querySelector<HTMLButtonElement>("[data-action=lookup-stores]")!
      .click();
    await flush();
    setPostal("M5V 2T7");
    setPostal("M5V 2T6");
    resolveRefresh(catalog);
    await flush();

    expect(root.querySelectorAll("[data-store-number]")).toHaveLength(0);
    expect(root.textContent).not.toContain(
      "Choose public stores returned by the latest lookup.",
    );
    expect(
      root.querySelector<HTMLButtonElement>("[data-action=lookup-stores]")!
        .disabled,
    ).toBe(false);
    mounted.destroy();
  });

  it("clears selected stores and the anchor when the selected region changes", async () => {
    const root = document.createElement("div");
    const mounted = mountLocalMonitorUi(root, makeController(undefined));
    await mounted.refresh();
    const market = root.querySelector<HTMLSelectElement>(
      "select[name=market]",
    )!;
    market.value = "ca";
    market.dispatchEvent(new Event("change"));
    const location = root.querySelector<HTMLInputElement>(
      "input[name=location]",
    )!;
    location.value = "M5V 2T6";
    location.dispatchEvent(new Event("input"));
    root
      .querySelector<HTMLButtonElement>("[data-action=lookup-stores]")!
      .click();
    await flush();
    const store = root.querySelector<HTMLInputElement>(
      "input[data-store-number=R123]",
    )!;
    store.checked = true;
    store.dispatchEvent(new Event("change"));

    const changedPostal = root.querySelector<HTMLInputElement>(
      "input[name=location]",
    )!;
    changedPostal.value = "M5V 2T7";
    changedPostal.dispatchEvent(new Event("input"));
    expect(root.querySelectorAll("[data-store-number]")).toHaveLength(0);

    const changedMarket = root.querySelector<HTMLSelectElement>(
      "select[name=market]",
    )!;
    changedMarket.value = "us";
    changedMarket.dispatchEvent(new Event("change"));

    expect(root.querySelectorAll("[data-store-number]")).toHaveLength(0);
    expect(root.textContent).toContain(
      "Choose a region, enter a postal code, then find public stores.",
    );
    mounted.destroy();
  });

  it("uses only catalog records refreshed after a successful postal lookup", async () => {
    const root = document.createElement("div");
    const lookedUpStore = {
      storeNumber: "R456",
      name: "Apple Refreshed",
      city: "Toronto",
      region: "ON",
    };
    const refreshedCatalog: LocalMonitorUiCatalog = {
      ...catalog,
      markets: [
        {
          ...catalog.markets[0]!,
          stores: [lookedUpStore],
        },
        catalog.markets[1]!,
      ],
    };
    let catalogReads = 0;
    const addWatch = vi.fn(async () => true);
    const mounted = mountLocalMonitorUi(root, {
      ...makeController(undefined),
      getCatalog: vi.fn(async () => {
        catalogReads += 1;
        return catalogReads === 1 ? catalog : refreshedCatalog;
      }),
      lookupStores: vi.fn(async () => ({
        kind: "matches" as const,
        stores: [lookedUpStore],
      })),
      addWatch,
    });
    await mounted.refresh();
    const select = (name: string, value: string) => {
      const element = root.querySelector<HTMLSelectElement>(
        `select[name=${name}]`,
      )!;
      element.value = value;
      element.dispatchEvent(new Event("change"));
    };
    select("market", "ca");
    select("model", "iphone-test");
    select("storage", "256GB");
    select("color", "Blue");
    const postal = root.querySelector<HTMLInputElement>(
      "input[name=location]",
    )!;
    postal.value = "M5V 2T6";
    postal.dispatchEvent(new Event("input"));
    const readsBeforeLookup = catalogReads;
    root
      .querySelector<HTMLButtonElement>("[data-action=lookup-stores]")!
      .click();
    await flush();

    expect(catalogReads).toBe(readsBeforeLookup + 1);
    expect(root.textContent).toContain("Apple Refreshed");
    expect(root.textContent).not.toContain("Apple Test");
    const store = root.querySelector<HTMLInputElement>(
      "input[data-store-number=R456]",
    )!;
    store.checked = true;
    store.dispatchEvent(new Event("change"));
    root
      .querySelector<HTMLFormElement>("[data-watch-form]")!
      .dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();

    expect(addWatch).toHaveBeenCalledWith(
      expect.objectContaining({
        storeNumbers: ["R456"],
        pollAnchor: { storeNumber: "R456" },
      }),
    );
    mounted.destroy();
  });

  it("rejects a lookup result that is absent from the refreshed regional catalog", async () => {
    const root = document.createElement("div");
    const mounted = mountLocalMonitorUi(root, {
      ...makeController(undefined),
      lookupStores: vi.fn(async () => ({
        kind: "matches" as const,
        stores: [
          {
            storeNumber: "R-STALE",
            name: "Stale store",
            city: null,
            region: null,
          },
        ],
      })),
    });
    await mounted.refresh();
    const market = root.querySelector<HTMLSelectElement>(
      "select[name=market]",
    )!;
    market.value = "ca";
    market.dispatchEvent(new Event("change"));
    const postal = root.querySelector<HTMLInputElement>(
      "input[name=location]",
    )!;
    postal.value = "M5V 2T6";
    postal.dispatchEvent(new Event("input"));
    root
      .querySelector<HTMLButtonElement>("[data-action=lookup-stores]")!
      .click();
    await flush();

    expect(root.querySelectorAll("[data-store-number]")).toHaveLength(0);
    expect(root.textContent).toContain(
      "Could not verify stores from Apple's response. Try again.",
    );
    mounted.destroy();
  });

  it("does not surface catalog stores before an explicit postal lookup", async () => {
    const root = document.createElement("div");
    const emptyCatalog: LocalMonitorUiCatalog = {
      ...catalog,
      markets: [
        {
          ...catalog.markets[0]!,
          stores: [],
        },
      ],
    };
    const mounted = mountLocalMonitorUi(root, {
      ...makeController(undefined),
      capabilities: makeController(undefined).capabilities,
      getCatalog: vi.fn(async () => emptyCatalog),
    });
    await mounted.refresh();
    const market = root.querySelector<HTMLSelectElement>(
      "select[name=market]",
    )!;
    market.value = "ca";
    market.dispatchEvent(new Event("change"));

    expect(root.textContent).toContain(
      "Choose a region, enter a postal code, then find public stores.",
    );
    expect(root.querySelectorAll("[data-store-number]")).toHaveLength(0);
    mounted.destroy();
  });

  it("does not present a transient unknown lookup as an empty store result", async () => {
    const root = document.createElement("div");
    const lookupStores = vi.fn(
      async () => ({ kind: "unknown", reason: "invalid_postal_code" }) as never,
    );
    const mounted = mountLocalMonitorUi(root, {
      ...makeController(undefined),
      lookupStores,
    });
    await mounted.refresh();
    const market = root.querySelector<HTMLSelectElement>(
      "select[name=market]",
    )!;
    market.value = "ca";
    market.dispatchEvent(new Event("change"));
    const location = root.querySelector<HTMLInputElement>(
      "input[name=location]",
    )!;
    location.value = "M5V 2T6";
    location.dispatchEvent(new Event("input"));
    root
      .querySelector<HTMLButtonElement>("[data-action=lookup-stores]")!
      .click();
    await flush();
    expect(lookupStores).toHaveBeenCalledWith({
      market: "ca",
      userPostalInput: "M5V 2T6",
    });
    expect(root.textContent).toContain(
      "Check the postal-code format for the selected region and try again.",
    );
    expect(root.textContent).not.toContain("M5V 2T6");
    expect(root.textContent).not.toContain(
      "No supported public stores matched",
    );
    mounted.destroy();
  });

  it.each([
    [
      "apple_blocked",
      "Apple did not complete this store lookup. Try again later.",
    ],
    ["storage_error", "Could not save or load store data. Try again."],
  ])(
    "renders the neutral %s lookup reason",
    async (reason, expectedMessage) => {
      const root = document.createElement("div");
      const mounted = mountLocalMonitorUi(root, {
        ...makeController(undefined),
        lookupStores: vi.fn(async () => ({ kind: "unknown", reason }) as never),
      });
      await mounted.refresh();
      const market = root.querySelector<HTMLSelectElement>(
        "select[name=market]",
      )!;
      market.value = "ca";
      market.dispatchEvent(new Event("change"));
      const location = root.querySelector<HTMLInputElement>(
        "input[name=location]",
      )!;
      location.value = "M5V 2T6";
      location.dispatchEvent(new Event("input"));
      root
        .querySelector<HTMLButtonElement>("[data-action=lookup-stores]")!
        .click();
      await flush();

      expect(root.textContent).toContain(expectedMessage);
      expect(root.textContent).not.toContain("M5V 2T6");
      mounted.destroy();
    },
  );

  it("clears lookup busy state when a controller seam throws synchronously", async () => {
    const root = document.createElement("div");
    const lookupStores = vi.fn(() => {
      throw new Error("must not reach the page");
    });
    const mounted = mountLocalMonitorUi(root, {
      ...makeController(undefined),
      lookupStores,
    });
    await mounted.refresh();
    const market = root.querySelector<HTMLSelectElement>(
      "select[name=market]",
    )!;
    market.value = "ca";
    market.dispatchEvent(new Event("change"));
    const location = root.querySelector<HTMLInputElement>(
      "input[name=location]",
    )!;
    location.value = "M5V 2T6";
    location.dispatchEvent(new Event("input"));
    root
      .querySelector<HTMLButtonElement>("[data-action=lookup-stores]")!
      .click();
    await flush();
    expect(lookupStores).toHaveBeenCalledTimes(1);
    expect(root.textContent).toContain(
      "Could not load stores. Please try again shortly.",
    );
    expect(
      root.querySelector<HTMLButtonElement>("[data-action=lookup-stores]")!
        .disabled,
    ).toBe(false);
    mounted.destroy();
  });

  it("sends the fixed desktop diagnostic only from the visible app button", async () => {
    const root = document.createElement("div");
    const sendTest = vi.fn(async () => "scheduled" as const);
    const controller: MonitorUiController = {
      ...makeController(undefined),
      desktopDiagnostic: { sendTest },
    };
    const mounted = mountLocalMonitorUi(root, controller);
    await mounted.refresh();
    const button = root.querySelector<HTMLButtonElement>(
      "[data-action=desktop-test]",
    )!;
    button.click();
    expect(
      root.querySelector<HTMLButtonElement>("[data-action=desktop-test]")!
        .disabled,
    ).toBe(true);
    await flush();
    expect(sendTest).toHaveBeenCalledTimes(1);
    expect(root.textContent).toContain(
      "Test notification was scheduled. This does not confirm an operating-system receipt. If nothing appeared, check your operating-system notification settings and Focus/Do Not Disturb.",
    );
    expect(root.textContent).toContain("Desktop notifications");
    expect(root.textContent).not.toContain("Desktop event queue");
    expect(root.textContent).toContain(
      "It does not report stock or confirm that your operating system displayed it.",
    );
    mounted.destroy();
  });

  it("renders the enabled diagnostic button with its exact non-stock disclaimer without invoking it", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const sendTest = vi.fn(async () => "scheduled" as const);
    const mounted = mountLocalMonitorUi(root, {
      ...makeController(undefined),
      desktopDiagnostic: { sendTest },
    });
    await mounted.refresh();

    const button = root.querySelector<HTMLButtonElement>(
      "[data-action=desktop-test]",
    );
    const section = button?.closest("section");
    expect(button?.isConnected).toBe(true);
    expect(button?.disabled).toBe(false);
    expect(button?.textContent).toBe("Send test notification");
    expect(section?.textContent).toContain(
      "Schedules a fixed test notification only.",
    );
    expect(section?.textContent).toContain(
      "It does not report stock or confirm that your operating system displayed it.",
    );
    expect(sendTest).not.toHaveBeenCalled();
    mounted.destroy();
    root.remove();
  });

  it("does not update a destroyed view after a diagnostic settles", async () => {
    let settle!: (value: "unavailable") => void;
    const controller: MonitorUiController = {
      ...makeController(undefined),
      desktopDiagnostic: {
        sendTest: () =>
          new Promise((resolve) => {
            settle = resolve;
          }),
      },
    };
    const root = document.createElement("div");
    const mounted = mountLocalMonitorUi(root, controller);
    await mounted.refresh();
    root
      .querySelector<HTMLButtonElement>("[data-action=desktop-test]")!
      .click();
    mounted.destroy();
    settle("unavailable");
    await flush();
    expect(root.childElementCount).toBe(0);
  });

  it("requests permission in the visible click stack and clears the token before a pending request", async () => {
    let status: PublicTelegramStatus = { kind: "disconnected" };
    let allowPermission!: (granted: boolean) => void;
    const permission = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          allowPermission = resolve;
        }),
    );
    const startPairing = vi.fn(async (_token: string) => {
      status = {
        kind: "pairing",
        pairingCommand: `INVENTORY SIGNAL ${"a".repeat(64)}`,
        expiresAt: "2026-09-09T12:10:00.000Z",
      };
      return status;
    });
    const root = document.createElement("div");
    const mounted = mountLocalMonitorUi(
      root,
      makeController({
        status: vi.fn(async () => status),
        startPairing,
        confirmPairing: vi.fn(async () => status),
        sendTest: vi.fn(async () => status),
        disconnect: vi.fn(async () => status),
      }),
      { requestTelegramHostPermission: permission },
    );
    await mounted.refresh();
    const token = root.querySelector<HTMLInputElement>(
      "[data-telegram-token]",
    )!;
    const button = root.querySelector<HTMLButtonElement>(
      "[data-action=telegram-start]",
    )!;
    token.value = `12345:${"a".repeat(20)}`;
    button.click();

    // The click synchronously requested permission and cleared the DOM field;
    // no token-bearing background request can start while permission is pending.
    expect(permission).toHaveBeenCalledTimes(1);
    expect(token.value).toBe("");
    expect(startPairing).not.toHaveBeenCalled();
    allowPermission(true);
    await flush();
    expect(startPairing).toHaveBeenCalledWith(`12345:${"a".repeat(20)}`);
    mounted.destroy();
  });

  it("keeps the desktop diagnostic available while Telegram permission is pending", async () => {
    let allowPermission!: (granted: boolean) => void;
    const permission = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          allowPermission = resolve;
        }),
    );
    const sendTest = vi.fn(async () => "scheduled" as const);
    const root = document.createElement("div");
    const mounted = mountLocalMonitorUi(
      root,
      {
        ...makeController({
          status: vi.fn(async () => ({ kind: "disconnected" }) as const),
          startPairing: vi.fn(async () => ({ kind: "disconnected" }) as const),
          confirmPairing: vi.fn(
            async () => ({ kind: "disconnected" }) as const,
          ),
          sendTest: vi.fn(async () => ({ kind: "disconnected" }) as const),
          disconnect: vi.fn(async () => ({ kind: "disconnected" }) as const),
        }),
        desktopDiagnostic: { sendTest },
      },
      { requestTelegramHostPermission: permission },
    );
    await mounted.refresh();
    root.querySelector<HTMLInputElement>("[data-telegram-token]")!.value =
      `12345:${"a".repeat(20)}`;
    root
      .querySelector<HTMLButtonElement>("[data-action=telegram-start]")!
      .click();
    root
      .querySelector<HTMLButtonElement>("[data-action=desktop-test]")!
      .click();
    await flush();

    expect(sendTest).toHaveBeenCalledTimes(1);
    allowPermission(true);
    mounted.destroy();
  });

  it("keeps per-watch Telegram disabled while disconnected and clears a token on teardown", async () => {
    let status: PublicTelegramStatus = { kind: "disconnected" };
    const root = document.createElement("div");
    const mounted = mountLocalMonitorUi(
      root,
      makeController({
        status: vi.fn(async () => status),
        startPairing: vi.fn(async () => status),
        confirmPairing: vi.fn(async () => status),
        sendTest: vi.fn(async () => status),
        disconnect: vi.fn(async () => status),
      }),
    );
    await mounted.refresh();
    const channel = root.querySelector<HTMLInputElement>(
      "input[name=telegram]",
    )!;
    const token = root.querySelector<HTMLInputElement>(
      "[data-telegram-token]",
    )!;
    expect(channel.disabled).toBe(true);
    token.value = `12345:${"a".repeat(20)}`;
    mounted.destroy();
    expect(token.value).toBe("");
    expect(root.childElementCount).toBe(0);
  });

  it("renders a plain bot link for legacy saved setup and keeps the setup inside the watch form", async () => {
    const nonce = "a".repeat(64);
    const status = {
      kind: "pairing" as const,
      pairingCommand: `INVENTORY SIGNAL ${nonce}`,
      expiresAt: "2026-09-09T12:10:00.000Z",
      pairingUrl: `https://t.me/SyntheticBot?start=${nonce}`,
    };
    const root = document.createElement("div");
    const mounted = mountLocalMonitorUi(
      root,
      makeController({
        status: vi.fn(async () => status as never),
        startPairing: vi.fn(async () => status as never),
        confirmPairing: vi.fn(async () => status as never),
        sendTest: vi.fn(async () => status as never),
        disconnect: vi.fn(async () => ({ kind: "disconnected" }) as const),
      }),
    );
    await mounted.refresh();

    const link = root.querySelector<HTMLAnchorElement>(
      "[data-watch-form] a[href]",
    );
    expect(link?.textContent).toBe("open your bot");
    expect(link?.href).toBe("https://t.me/SyntheticBot");
    expect(link?.search).toBe("");
    expect(root.querySelectorAll(".pairing-steps > li")).toHaveLength(0);
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toBe("noopener noreferrer");
    expect(root.textContent).toContain("send any message once");
    expect(root.textContent).not.toContain("Check connection");
    expect(root.querySelector("[data-watch-form] code")).toBeNull();
    expect(root.textContent).not.toContain(`INVENTORY SIGNAL ${nonce}`);
    expect(root.querySelector("main > #telegram-title")).toBeNull();
    mounted.destroy();
  });

  it("preserves an in-progress watch draft through token setup and test delivery", async () => {
    let status: PublicTelegramStatus = { kind: "disconnected" };
    const pairing = {
      kind: "pairing" as const,
      pairingCommand: `INVENTORY SIGNAL ${"d".repeat(64)}`,
      expiresAt: "2026-09-09T12:10:00.000Z",
    };
    const connected: PublicTelegramStatus = {
      kind: "connected",
      botUsername: "SyntheticBot",
    };
    const root = document.createElement("div");
    const mounted = mountLocalMonitorUi(
      root,
      makeController({
        status: vi.fn(async () => status),
        startPairing: vi.fn(async () => {
          status = pairing;
          return status;
        }),
        sendTest: vi.fn(async () => {
          status = connected;
          return status;
        }),
        confirmPairing: vi.fn(async () => status),
        disconnect: vi.fn(async () => status),
      }),
      { requestTelegramHostPermission: vi.fn(async () => true) },
    );
    await mounted.refresh();
    const select = (name: string, value: string) => {
      const element = root.querySelector<HTMLSelectElement>(
        `select[name=${name}]`,
      )!;
      element.value = value;
      element.dispatchEvent(new Event("change"));
    };
    select("market", "ca");
    select("model", "iphone-test");
    select("storage", "256GB");
    select("color", "Blue");
    const postal = root.querySelector<HTMLInputElement>(
      "input[name=location]",
    )!;
    postal.value = "M5V 2T6";
    postal.dispatchEvent(new Event("input"));
    root
      .querySelector<HTMLButtonElement>("[data-action=lookup-stores]")!
      .click();
    await flush();
    const store = root.querySelector<HTMLInputElement>(
      "input[data-store-number=R123]",
    )!;
    store.checked = true;
    store.dispatchEvent(new Event("change"));
    const interval = root.querySelector<HTMLInputElement>(
      "input[name=interval]",
    )!;
    interval.value = "5";
    interval.dispatchEvent(new Event("input"));
    const desktop = root.querySelector<HTMLInputElement>(
      "input[name=desktop]",
    )!;
    desktop.checked = false;
    desktop.dispatchEvent(new Event("change"));
    const token = root.querySelector<HTMLInputElement>(
      "[data-telegram-token]",
    )!;
    token.value = `12345:${"a".repeat(20)}`;
    root
      .querySelector<HTMLButtonElement>("[data-action=telegram-start]")!
      .click();
    await flush(16);

    expect(root.querySelector("[data-watch-form] code")).toBeNull();
    expect(
      root.querySelector<HTMLInputElement>("input[name=location]")!.value,
    ).toBe("M5V 2T6");
    expect(
      root.querySelector<HTMLInputElement>("input[data-store-number=R123]")!
        .checked,
    ).toBe(true);
    expect(
      root.querySelector<HTMLInputElement>("input[name=interval]")!.value,
    ).toBe("5");
    expect(
      root.querySelector<HTMLInputElement>("input[name=desktop]")!.checked,
    ).toBe(false);
    root
      .querySelector<HTMLButtonElement>("[data-action=telegram-test]")!
      .click();
    await flush(16);

    expect(root.textContent).toContain("Connected to @SyntheticBot");
    expect(
      root.querySelector<HTMLInputElement>("input[name=location]")!.value,
    ).toBe("M5V 2T6");
    expect(
      root.querySelector<HTMLInputElement>("input[data-store-number=R123]")!
        .checked,
    ).toBe(true);
    expect(
      root.querySelector<HTMLInputElement>("input[name=interval]")!.value,
    ).toBe("5");
    expect(
      root.querySelector<HTMLInputElement>("input[name=desktop]")!.checked,
    ).toBe(false);
    mounted.destroy();
  });

  it("omits invalid legacy links without displaying pairing commands", async () => {
    const nonce = "b".repeat(64);
    const status = {
      kind: "pairing" as const,
      pairingCommand: `INVENTORY SIGNAL ${nonce}`,
      expiresAt: "2026-09-09T12:10:00.000Z",
      pairingUrl: `https://t.me/SyntheticBot?start=${"c".repeat(64)}`,
    };
    const root = document.createElement("div");
    const mounted = mountLocalMonitorUi(
      root,
      makeController({
        status: vi.fn(async () => status as never),
        startPairing: vi.fn(async () => status as never),
        confirmPairing: vi.fn(async () => status as never),
        sendTest: vi.fn(async () => status as never),
        disconnect: vi.fn(async () => ({ kind: "disconnected" }) as const),
      }),
    );
    await mounted.refresh();

    expect(root.querySelector("[data-watch-form] a[href]")).toBeNull();
    expect(root.querySelector("[data-watch-form] code")).toBeNull();
    expect(root.textContent).not.toContain("Check connection");
    mounted.destroy();
  });

  it("renders escaped catalog names for a history event from a different market", async () => {
    const historyCatalog: LocalMonitorUiCatalog = {
      ...catalog,
      markets: [
        catalog.markets[0]!,
        {
          ...catalog.markets[1]!,
          variants: [
            {
              sku: "TEST4LL/A",
              title: "US <b>Phone</b>",
              familySlug: "iphone-test",
            },
          ],
          stores: [
            {
              storeNumber: "R999",
              name: "Store <img>",
              city: "New York",
              region: "NY",
            },
          ],
        },
      ],
    };
    const historySnapshot: MonitorUiSnapshot = {
      ...snapshot,
      history: [
        {
          sku: "TEST4LL/A",
          storeNumber: "R999",
          to: "available",
          at: "2026-09-09T12:00:00.000Z",
        },
      ],
    };
    const root = document.createElement("div");
    const mounted = mountLocalMonitorUi(root, {
      ...makeController(undefined),
      getCatalog: vi.fn(async () => historyCatalog),
      getSnapshot: vi.fn(async () => historySnapshot),
    });
    await mounted.refresh();

    expect(root.textContent).toContain("US <b>Phone</b>");
    expect(root.textContent).toContain("Store <img> · R999");
    expect(root.innerHTML).not.toContain("<b>Phone</b>");
    expect(root.innerHTML).not.toContain("<img>");
    mounted.destroy();
  });

  it("offers a user-click Open at Apple action only for a recorded available item", async () => {
    const now = new Date().toISOString();
    const currentSnapshot: MonitorUiSnapshot = {
      ...snapshot,
      watches: [
        {
          id: "watch-one",
          market: "ca",
          skus: ["TEST4VC/A"],
          storeNumbers: ["R123"],
          pollAnchor: { storeNumber: "R123" },
          pollIntervalSec: 60,
          enabled: true,
          deliveryChannels: {
            desktop: false,
            personalTelegram: false,
            hostedRelay: false,
          },
          catalogSchemaVersion: 1,
          createdAt: now,
          updatedAt: now,
        },
      ],
      items: [
        {
          watchId: "watch-one",
          sku: "TEST4VC/A",
          storeNumber: "R123",
          status: "available",
          lastKnownStatus: "available",
          lastCheckedAt: now,
          lastSuccessfulAt: now,
        },
      ],
    };
    const openAvailableAtApple = vi.fn(async () => "opened" as const);
    const root = document.createElement("div");
    const mounted = mountLocalMonitorUi(root, {
      ...makeController(undefined),
      getSnapshot: vi.fn(async () => currentSnapshot),
      openAvailableAtApple,
    });
    await mounted.refresh();
    const action = root.querySelector<HTMLButtonElement>(
      "[data-action=open-available-at-apple]",
    );
    expect(action?.textContent).toBe("Open at Apple · Apple Test");
    expect(root.textContent).toContain("does not reserve or purchase");
    expect(root.textContent).toContain(
      "Checks continue after stock is found every 1 minute.",
    );
    action!.click();
    await flush();
    expect(openAvailableAtApple).toHaveBeenCalledWith({
      watchId: "watch-one",
      sku: "TEST4VC/A",
      storeNumber: "R123",
    });
    expect(root.textContent).toContain(
      "Confirm pickup and complete any purchase directly with Apple.",
    );
    mounted.destroy();
  });
});
