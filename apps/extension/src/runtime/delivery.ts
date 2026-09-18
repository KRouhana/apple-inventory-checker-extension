import {
  parseLocalMonitorSnapshot,
  parseLocalCatalogSnapshot,
  type LocalAvailabilityEvent,
  type LocalDeliveryChannel,
  type LocalDeliveryDispatchResult,
  type LocalMonitorSnapshot,
} from "../../../../packages/core/src/local-monitor-contracts.js";
import { isCatalogApplePurchaseUrl } from "../protocol.js";
import type { LocalAvailabilityEventFactory } from "../monitor/local-monitor-engine.js";
import {
  DesktopAlertService,
  type DesktopAlertCurrentStateValidator,
  type DesktopAlertNativePort,
} from "../notifications/desktop.js";
import {
  PersonalTelegramError,
  type PersonalTelegramController,
} from "../notifications/telegram.js";
import type {
  LocalCatalogPort,
  LocalDeliveryDispatcher,
} from "../monitor/local-monitor-engine.js";
import type { ExtensionApi } from "../platform/api.js";
import type { ExtensionPlatform } from "../platform/adapters.js";
import { callExtensionVoid } from "../platform/async.js";

export interface RuntimeEngineSnapshotPort {
  getSnapshot(): Promise<LocalMonitorSnapshot>;
}

const AVAILABLE_HANDOFF_MAX_AGE_MS = 10 * 60_000;
const AVAILABLE_HANDOFF_MAX_FUTURE_SKEW_MS = 60_000;

export type AvailableApplePurchaseInput = {
  watchId: string;
  sku: string;
  storeNumber: string;
};

/**
 * User-initiated fallback when a desktop or Telegram alert was disabled,
 * dismissed, or unavailable. The caller controls only public identifiers;
 * this re-reads the stored source observation and catalog before opening a
 * single manual Apple product page. It never creates a cart, pickup hold,
 * Apple session, or purchase.
 */
export async function openCurrentAvailableAtApple(options: {
  engine: RuntimeEngineSnapshotPort;
  catalog: LocalCatalogPort;
  eventFactory: LocalAvailabilityEventFactory;
  platform: Pick<ExtensionPlatform, "tabs">;
  input: AvailableApplePurchaseInput;
  now?: () => number;
}): Promise<"opened" | "unavailable"> {
  try {
    const now = options.now?.() ?? Date.now();
    if (!Number.isFinite(now)) return "unavailable";
    const parsedSnapshot = parseLocalMonitorSnapshot(
      await options.engine.getSnapshot(),
    );
    const parsedCatalog = parseLocalCatalogSnapshot(
      options.catalog.getCatalog(),
    );
    if (!parsedSnapshot.success || !parsedCatalog.success) return "unavailable";
    const snapshot = parsedSnapshot.data;
    const watch = snapshot.watches.find(
      (entry) => entry.id === options.input.watchId,
    );
    if (
      !watch ||
      !watch.enabled ||
      !watch.skus.includes(options.input.sku) ||
      !watch.storeNumbers.includes(options.input.storeNumber) ||
      watch.catalogSchemaVersion !== parsedCatalog.data.schemaVersion
    ) {
      return "unavailable";
    }
    const item = snapshot.items.find(
      (entry) =>
        entry.watchId === watch.id &&
        entry.market === watch.market &&
        entry.sku === options.input.sku &&
        entry.storeNumber === options.input.storeNumber,
    );
    const observedAt = item?.lastSuccessfulAt;
    const observedMs =
      observedAt === null || observedAt === undefined
        ? Number.NaN
        : Date.parse(observedAt);
    if (
      item?.status !== "available" ||
      item.lastCheckedAt !== observedAt ||
      !Number.isFinite(observedMs) ||
      observedMs < now - AVAILABLE_HANDOFF_MAX_AGE_MS ||
      observedMs > now + AVAILABLE_HANDOFF_MAX_FUTURE_SKEW_MS
    ) {
      return "unavailable";
    }
    const market = parsedCatalog.data.markets.find(
      (entry) => entry.code === watch.market,
    );
    const variant = market?.variants.find((entry) => entry.sku === item.sku);
    const store = market?.stores.find(
      (entry) => entry.storeNumber === item.storeNumber,
    );
    if (!variant || !store) return "unavailable";
    const event = options.eventFactory.create({
      watch,
      sku: item.sku,
      storeNumber: item.storeNumber,
      title: variant.title,
      storeName: store.name,
      observedAt,
    });
    if (
      !event ||
      !isCatalogApplePurchaseUrl(event.purchaseUrl, event.market, variant)
    ) {
      return "unavailable";
    }
    await options.platform.tabs.openApplePurchase(event.purchaseUrl);
    return "opened";
  } catch {
    return "unavailable";
  }
}

function currentAvailability(
  snapshot: LocalMonitorSnapshot,
  event: LocalAvailabilityEvent,
): boolean {
  const watch = snapshot.watches.find((entry) => entry.id === event.watchId);
  if (
    !watch ||
    !watch.enabled ||
    watch.market !== event.market ||
    !watch.skus.includes(event.sku) ||
    !watch.storeNumbers.includes(event.storeNumber)
  ) {
    return false;
  }
  const item = snapshot.items.find(
    (entry) =>
      entry.watchId === event.watchId &&
      entry.sku === event.sku &&
      entry.storeNumber === event.storeNumber,
  );
  const observedAt = Date.parse(event.observedAt);
  return (
    item?.status === "available" &&
    item.lastSuccessfulAt !== null &&
    Number.isFinite(observedAt) &&
    Date.parse(item.lastSuccessfulAt) >= observedAt
  );
}

function currentCatalogMatches(
  catalogPort: LocalCatalogPort,
  event: LocalAvailabilityEvent,
): boolean {
  const parsed = parseLocalCatalogSnapshot(catalogPort.getCatalog());
  if (!parsed.success) return false;
  const market = parsed.data.markets.find(
    (entry) => entry.code === event.market,
  );
  return (
    market?.variants.some(
      (variant) =>
        variant.sku === event.sku &&
        variant.title === event.title &&
        isCatalogApplePurchaseUrl(event.purchaseUrl, event.market, variant),
    ) === true &&
    market.stores.some(
      (store) =>
        store.storeNumber === event.storeNumber &&
        store.name === event.storeName,
    )
  );
}

/**
 * Rebuild a queued event from the current catalog and durable item instead of
 * trusting its embedded Apple URL. This is used immediately before every
 * desktop/Telegram delivery; UI click handling has the equivalent catalog
 * equality check in its current-state validator.
 */
export async function resolveCurrentAvailabilityEvent(options: {
  engine: RuntimeEngineSnapshotPort;
  catalog: LocalCatalogPort;
  eventFactory: LocalAvailabilityEventFactory;
  event: LocalAvailabilityEvent;
}): Promise<LocalAvailabilityEvent | null> {
  try {
    const parsedSnapshot = parseLocalMonitorSnapshot(
      await options.engine.getSnapshot(),
    );
    const parsedCatalog = parseLocalCatalogSnapshot(
      options.catalog.getCatalog(),
    );
    if (!parsedSnapshot.success || !parsedCatalog.success) return null;
    const watch = parsedSnapshot.data.watches.find(
      (entry) => entry.id === options.event.watchId,
    );
    const item = parsedSnapshot.data.items.find(
      (entry) =>
        entry.watchId === options.event.watchId &&
        entry.sku === options.event.sku &&
        entry.storeNumber === options.event.storeNumber,
    );
    const market = parsedCatalog.data.markets.find(
      (entry) => entry.code === options.event.market,
    );
    const variant = market?.variants.find(
      (entry) => entry.sku === options.event.sku,
    );
    const store = market?.stores.find(
      (entry) => entry.storeNumber === options.event.storeNumber,
    );
    if (
      !watch ||
      !item ||
      !variant ||
      !store ||
      !currentAvailability(parsedSnapshot.data, options.event) ||
      item.lastSuccessfulAt !== options.event.observedAt ||
      !currentCatalogMatches(options.catalog, {
        ...options.event,
        title: variant.title,
        storeName: store.name,
        purchaseUrl: options.event.purchaseUrl,
      })
    ) {
      return null;
    }
    const resolved = options.eventFactory.create({
      watch,
      sku: variant.sku,
      storeNumber: store.storeNumber,
      title: variant.title,
      storeName: store.name,
      observedAt: options.event.observedAt,
    });
    return resolved &&
      resolved.title === options.event.title &&
      resolved.storeName === options.event.storeName
      ? resolved
      : null;
  } catch {
    return null;
  }
}

export function createDesktopCurrentStateValidator(
  engine: RuntimeEngineSnapshotPort,
  catalog: LocalCatalogPort,
): DesktopAlertCurrentStateValidator {
  const isCurrent = async (event: LocalAvailabilityEvent): Promise<boolean> => {
    try {
      const snapshot = await engine.getSnapshot();
      return (
        currentAvailability(snapshot, event) &&
        currentCatalogMatches(catalog, event)
      );
    } catch {
      return false;
    }
  };
  return {
    canDeliver: isCurrent,
    async resolveClick(event) {
      // A stale desktop notification may still lead to the extension-owned
      // history view, but it can never open Apple without a current available
      // item and catalog match.
      return (await isCurrent(event)) ? "open-apple" : "show-local-result";
    },
  };
}

export async function openOwnedLocalMonitorTab(
  api: ExtensionApi,
): Promise<void> {
  const url = api.runtime.getURL("app.html");
  // The value comes from runtime.getURL, not a message or notification field.
  await callExtensionVoid(api.runtime, (callback, usePromiseApi) =>
    usePromiseApi
      ? api.tabs.create({ url })
      : api.tabs.create({ url }, callback),
  );
}

export function createDesktopAlertService(options: {
  api: ExtensionApi;
  platform: ExtensionPlatform;
  engine: RuntimeEngineSnapshotPort;
  catalog: LocalCatalogPort;
  native?: DesktopAlertNativePort;
}): DesktopAlertService {
  return new DesktopAlertService({
    api: options.api,
    platform: options.platform,
    currentState: createDesktopCurrentStateValidator(
      options.engine,
      options.catalog,
    ),
    showLocalResult: () => openOwnedLocalMonitorTab(options.api),
    native: options.native,
  });
}

function terminalForDesktop(kind: string): LocalDeliveryDispatchResult {
  // Permission denied, wrapper-required, stale and invalid are all honest
  // terminal outcomes. Treating them as a scheduled OS alert would be false.
  return kind === "scheduled" || kind === "deduplicated"
    ? { kind: "delivered" }
    : { kind: "terminal" };
}

export function createRuntimeDeliveryDispatcher(options: {
  desktop: DesktopAlertService;
  personalTelegram?: PersonalTelegramController;
  /** Re-derives a safe delivery event from current catalog + observation state. */
  resolveCurrentEvent?: (
    event: LocalAvailabilityEvent,
  ) => Promise<LocalAvailabilityEvent | null>;
}): LocalDeliveryDispatcher {
  return {
    async deliver(
      channel: LocalDeliveryChannel,
      event: LocalAvailabilityEvent,
      deliveryOptions?: { signal?: AbortSignal },
    ): Promise<LocalDeliveryDispatchResult> {
      if (deliveryOptions?.signal?.aborted) throw new Error("delivery aborted");
      const eventForDelivery = options.resolveCurrentEvent
        ? await options.resolveCurrentEvent(event)
        : event;
      if (!eventForDelivery) return { kind: "terminal" };
      if (channel === "desktop") {
        const result = await options.desktop.notifyAvailable(
          eventForDelivery,
          deliveryOptions,
        );
        if (result.kind === "aborted") throw new Error("delivery aborted");
        return terminalForDesktop(result.kind);
      }
      if (channel === "personalTelegram") {
        if (!options.personalTelegram) return { kind: "terminal" };
        try {
          return await options.personalTelegram.sendStoredAvailable(
            eventForDelivery,
            deliveryOptions,
          );
        } catch (error) {
          // A cancelled engine generation is retried/revoked by its own
          // signal path. A missing setup/permission is terminal and must not
          // be represented as an accepted Telegram notification.
          if (
            error instanceof PersonalTelegramError &&
            error.code === "cancelled"
          ) {
            throw error;
          }
          return { kind: "terminal" };
        }
      }
      // Hosted relay remains explicit cloud mode. Local delivery must never
      // register, authenticate, or start remote polling as a side effect.
      return { kind: "terminal" };
    },
  };
}
