import type {
  LocalCatalogVariant,
  LocalCatalogSnapshot,
  LocalMarketCode,
  LocalStoreLookupUnknownResult,
  LocalWatch,
  LocalCheckFailure,
  StoreLookupInput,
} from "../../../../packages/core/src/local-monitor-contracts.js";
import type { PublicTelegramStatus } from "../platform/telegram-messages.js";

/** Token-free UI seam for the finite Personal Telegram background protocol. */
export interface PersonalTelegramUiController {
  status(): Promise<PublicTelegramStatus>;
  startPairing(botToken: string): Promise<PublicTelegramStatus>;
  confirmPairing(): Promise<PublicTelegramStatus>;
  sendTest(): Promise<PublicTelegramStatus>;
  disconnect(): Promise<PublicTelegramStatus>;
}

export interface DesktopDiagnosticUiController {
  sendTest(): Promise<
    | "scheduled"
    | "permission-denied"
    | "unsupported"
    | "cooldown"
    | "in-flight"
    | "unavailable"
  >;
}

export type MonitorUiItemStatus =
  | "available"
  | "unavailable"
  | "ineligible"
  | "unknown";

export interface MonitorUiItem {
  watchId: string;
  /** Public catalog identifiers only; used for a user-initiated Apple handoff. */
  sku: string;
  storeNumber: string;
  status: MonitorUiItemStatus;
  lastKnownStatus: Exclude<MonitorUiItemStatus, "unknown"> | null;
  lastCheckedAt: string;
  lastSuccessfulAt: string | null;
  lastFailure?: LocalCheckFailure;
}

export interface MonitorUiHistoryEvent {
  sku: string;
  storeNumber: string;
  to: MonitorUiItemStatus;
  at: string;
}

/** Deliberately only a countable watch reference; no delivery payload leaks. */
export interface MonitorUiPendingDelivery {
  watchId: string;
}

export interface MonitorUiSnapshot {
  version: 1;
  watches: readonly LocalWatch[];
  items: readonly MonitorUiItem[];
  history: readonly MonitorUiHistoryEvent[];
  pendingDelivery: readonly MonitorUiPendingDelivery[];
}

/** Catalog projection intentionally omits pollLocation from every UI response. */
export interface LocalMonitorUiStore {
  storeNumber: string;
  name: string;
  city: string | null;
  region: string | null;
}

/**
 * Finite projection of a transient store lookup. This never carries the
 * submitted location, a provider diagnostic, or a poll-time location.
 */
export type StoreLookupUiResult =
  | {
      readonly kind: "matches";
      readonly stores: readonly LocalMonitorUiStore[];
    }
  | { readonly kind: "unsupported" }
  | LocalStoreLookupUnknownResult
  | { readonly kind: "throttled" };

export interface LocalMonitorUiMarket {
  code: LocalMarketCode;
  name: string;
  storefrontPath: string;
  variants: readonly LocalCatalogVariant[];
  stores: readonly LocalMonitorUiStore[];
}

export interface LocalMonitorUiCatalog {
  schemaVersion: number;
  generatedAt: string;
  markets: readonly LocalMonitorUiMarket[];
}

export function projectCatalogForUi(
  catalog: LocalCatalogSnapshot,
): LocalMonitorUiCatalog {
  return {
    schemaVersion: catalog.schemaVersion,
    generatedAt: catalog.generatedAt,
    markets: catalog.markets.map((market) => ({
      code: market.code,
      name: market.name,
      storefrontPath: market.storefrontPath,
      variants: market.variants.map((variant) => ({
        sku: variant.sku,
        title: variant.title,
        ...(variant.familySlug ? { familySlug: variant.familySlug } : {}),
      })),
      stores: market.stores.map((store) => ({
        storeNumber: store.storeNumber,
        name: store.name,
        city: store.city,
        region: store.region,
      })),
    })),
  };
}

/**
 * UI-facing engine seam. The background entry owns the trusted runtime
 * message transport; this deliberately does not expose generic storage or a
 * generic `send` method to the page.
 */
export interface LocalMonitorCycleReport {
  kind: "completed" | "busy" | "host_backoff" | "storage_error";
  attemptedBatches: number;
  unsupportedWatchIds: readonly string[];
  queuedEvents: number;
  expiredDeliveryEvents: number;
  queueBackpressure: boolean;
}

export interface MonitorUiCapabilities {
  /** The trusted background controller is reachable from this page. */
  monitor: boolean;
  /** A validated catalog is available for dependent selectors. */
  catalog: boolean;
  /** A transient location lookup transport is available. */
  storeLookup: boolean;
  /** Optional configuration surfaces; no secret is ever exposed to the UI. */
  personalTelegram: boolean;
  hostedRelay: boolean;
  reason?: string;
}

export interface MonitorUiController {
  readonly capabilities: MonitorUiCapabilities;
  /** Optional because unavailable/older backgrounds remain fail-closed. */
  readonly personalTelegram?: PersonalTelegramUiController;
  readonly desktopDiagnostic?: DesktopDiagnosticUiController;
  getSnapshot(): Promise<MonitorUiSnapshot>;
  getCatalog(): Promise<LocalMonitorUiCatalog | null>;
  /**
   * Location input only crosses this method in memory. Implementations must
   * not retain it; only selected public store numbers become a LocalWatch.
   */
  lookupStores?(input: StoreLookupInput): Promise<StoreLookupUiResult>;
  start(): Promise<LocalMonitorCycleReport>;
  wake(): Promise<LocalMonitorCycleReport>;
  checkNow(watchIds?: readonly string[]): Promise<LocalMonitorCycleReport>;
  /** Opens Apple only after the background has revalidated this exact item. */
  openAvailableAtApple(input: {
    watchId: string;
    sku: string;
    storeNumber: string;
  }): Promise<"opened" | "unavailable">;
  addWatch(watch: LocalWatch): Promise<boolean>;
  replaceWatch(watch: LocalWatch): Promise<boolean>;
  setWatchEnabled(id: string, enabled: boolean): Promise<boolean>;
  deleteWatch(id: string): Promise<boolean>;
  reset(): Promise<void>;
}

export type MonitorUiCommand =
  | { type: "start" }
  | { type: "wake" }
  | { type: "check-now"; watchIds?: readonly string[] }
  | { type: "add-watch"; watch: LocalWatch }
  | { type: "replace-watch"; watch: LocalWatch }
  | { type: "set-watch-enabled"; id: string; enabled: boolean }
  | { type: "delete-watch"; id: string }
  | { type: "reset" };

/** Only this finite command union may mutate the monitor from the UI. */
export async function dispatchMonitorCommand(
  controller: MonitorUiController,
  command: MonitorUiCommand,
): Promise<LocalMonitorCycleReport | boolean | void> {
  switch (command.type) {
    case "start":
      return controller.start();
    case "wake":
      return controller.wake();
    case "check-now":
      return controller.checkNow(command.watchIds);
    case "add-watch":
      return controller.addWatch(command.watch);
    case "replace-watch":
      return controller.replaceWatch(command.watch);
    case "set-watch-enabled":
      return controller.setWatchEnabled(command.id, command.enabled);
    case "delete-watch":
      return controller.deleteWatch(command.id);
    case "reset":
      return controller.reset();
    default:
      throw new MonitorUiUnavailableError("Unknown local monitor command");
  }
}

export class MonitorUiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MonitorUiUnavailableError";
  }
}

/**
 * Used by the packaged page until L08/platform integration supplies a
 * sender-validated background controller. It is intentionally fail-closed:
 * the page has no direct storage, host, or network fallback.
 */
export function createUnavailableMonitorController(
  reason = "The local monitor background is not connected to this page yet.",
  catalog: LocalCatalogSnapshot | null = null,
): MonitorUiController {
  const unavailable = (): never => {
    throw new MonitorUiUnavailableError(reason);
  };
  return {
    capabilities: {
      monitor: false,
      catalog: catalog !== null,
      storeLookup: false,
      personalTelegram: false,
      hostedRelay: false,
      reason,
    },
    getSnapshot: async () => unavailable(),
    getCatalog: async () => (catalog ? projectCatalogForUi(catalog) : null),
    start: async () => unavailable(),
    wake: async () => unavailable(),
    checkNow: async () => unavailable(),
    openAvailableAtApple: async () => unavailable(),
    addWatch: async () => unavailable(),
    replaceWatch: async () => unavailable(),
    setWatchEnabled: async () => unavailable(),
    deleteWatch: async () => unavailable(),
    reset: async () => unavailable(),
  };
}
