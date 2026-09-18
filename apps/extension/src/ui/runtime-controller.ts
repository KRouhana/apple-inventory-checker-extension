import { callExtensionApi } from "../platform/async.js";
import type { ExtensionRuntime } from "../platform/api.js";
import {
  LOCAL_MONITOR_PROTOCOL,
  type LocalMonitorRuntimeCommand,
  type LocalMonitorRuntimeResponse,
} from "../platform/monitor-messages.js";
import {
  LOCAL_STORE_LOOKUP_UNKNOWN_REASONS,
  LocalCheckFailureSchema,
} from "../../../../packages/core/src/local-monitor-contracts.js";
import type {
  LocalWatch,
  LocalStoreLookupUnknownResult,
  StoreLookupInput,
} from "../../../../packages/core/src/local-monitor-contracts.js";
import type {
  LocalMonitorCycleReport,
  LocalMonitorUiCatalog,
  MonitorUiHistoryEvent,
  MonitorUiItem,
  MonitorUiPendingDelivery,
  MonitorUiSnapshot,
  LocalMonitorUiStore,
  MonitorUiCapabilities,
  MonitorUiController,
  StoreLookupUiResult,
} from "./controller.js";

const MAX_SNAPSHOT_ARRAY = 2_400;
const MAX_HISTORY_EVENTS = 2_000;
const MAX_LOOKUP_STORES = 50;

export class LocalMonitorRuntimeError extends Error {
  constructor(
    public readonly code:
      | "unauthorized"
      | "invalid_request"
      | "unavailable"
      | "operation_failed",
  ) {
    super(
      code === "unavailable"
        ? "The local monitor is not available in this browser yet."
        : "The local monitor request could not be completed.",
    );
    this.name = "LocalMonitorRuntimeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFailureCode(
  value: unknown,
): value is LocalMonitorRuntimeError["code"] {
  return [
    "unauthorized",
    "invalid_request",
    "unavailable",
    "operation_failed",
  ].includes(String(value));
}

function parseResponse(
  input: unknown,
  request: LocalMonitorRuntimeCommand["type"],
): LocalMonitorRuntimeResponse {
  if (
    !isRecord(input) ||
    input.protocol !== LOCAL_MONITOR_PROTOCOL ||
    input.type !== "RESULT" ||
    input.request !== request ||
    typeof input.ok !== "boolean"
  ) {
    throw new LocalMonitorRuntimeError("operation_failed");
  }
  if (!input.ok) {
    if (
      !hasExactKeys(input, ["protocol", "type", "request", "ok", "error"]) ||
      !isFailureCode(input.error)
    )
      throw new LocalMonitorRuntimeError("operation_failed");
    throw new LocalMonitorRuntimeError(input.error);
  }
  if (!hasExactKeys(input, ["protocol", "type", "request", "ok", "result"]))
    throw new LocalMonitorRuntimeError("operation_failed");
  return input as LocalMonitorRuntimeResponse;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match) return false;
  const [, year, month, day, hour, minute, second, zone] = match;
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  if (
    monthNumber < 1 ||
    monthNumber > 12 ||
    dayNumber < 1 ||
    dayNumber > new Date(Date.UTC(yearNumber, monthNumber, 0)).getUTCDate() ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  )
    return false;
  if (
    zone !== "Z" &&
    (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)
  )
    return false;
  return Number.isFinite(Date.parse(value));
}

function isWatchId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function isSku(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z0-9]+\/[A-Z]$/.test(value);
}

function isStoreNumber(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9-]{1,16}$/.test(value);
}

async function request(
  runtime: ExtensionRuntime,
  command: LocalMonitorRuntimeCommand,
): Promise<unknown> {
  try {
    const raw = await callExtensionApi<unknown>(
      runtime,
      (callback, usePromiseApi) =>
        usePromiseApi
          ? runtime.sendMessage(command)
          : runtime.sendMessage(command, callback),
    );
    const response = parseResponse(raw, command.type);
    return response.ok ? response.result : null;
  } catch (error) {
    if (error instanceof LocalMonitorRuntimeError) throw error;
    throw new LocalMonitorRuntimeError("operation_failed");
  }
}

function asCapabilities(value: unknown): MonitorUiCapabilities {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "monitor",
      "catalog",
      "storeLookup",
      "personalTelegram",
      "hostedRelay",
      ...(value.reason === undefined ? [] : ["reason"]),
    ]) ||
    typeof value.monitor !== "boolean" ||
    typeof value.catalog !== "boolean" ||
    typeof value.storeLookup !== "boolean" ||
    typeof value.personalTelegram !== "boolean" ||
    typeof value.hostedRelay !== "boolean" ||
    (value.reason !== undefined &&
      (typeof value.reason !== "string" || value.reason.length > 160))
  )
    throw new LocalMonitorRuntimeError("operation_failed");
  return {
    monitor: value.monitor,
    catalog: value.catalog,
    storeLookup: value.storeLookup,
    personalTelegram: value.personalTelegram,
    hostedRelay: value.hostedRelay,
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
  };
}

function asSnapshot(value: unknown): MonitorUiSnapshot {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "version",
      "watches",
      "items",
      "history",
      "pendingDelivery",
    ]) ||
    value.version !== 1 ||
    !Array.isArray(value.watches) ||
    value.watches.length > 20 ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_SNAPSHOT_ARRAY ||
    !Array.isArray(value.history) ||
    value.history.length > MAX_HISTORY_EVENTS ||
    !Array.isArray(value.pendingDelivery) ||
    value.pendingDelivery.length > 200 ||
    !value.watches.every(isUiWatch) ||
    !value.items.every(isUiItem) ||
    !value.history.every(isUiHistory) ||
    !value.pendingDelivery.every(isUiPendingDelivery)
  )
    throw new LocalMonitorRuntimeError("operation_failed");
  const snapshot = value as unknown as MonitorUiSnapshot;
  const watchIds = new Set(snapshot.watches.map((watch) => watch.id));
  if (
    watchIds.size !== snapshot.watches.length ||
    !snapshot.items.every((item) => watchIds.has(item.watchId)) ||
    !snapshot.pendingDelivery.every((entry) => watchIds.has(entry.watchId))
  )
    throw new LocalMonitorRuntimeError("operation_failed");
  return snapshot;
}

function isUiWatch(value: unknown): value is LocalWatch {
  if (!isRecord(value)) return false;
  const pollIntervalSec = value.pollIntervalSec;
  const catalogSchemaVersion = value.catalogSchemaVersion;
  if (
    !hasExactKeys(value, [
      "id",
      "market",
      "skus",
      "storeNumbers",
      "pollAnchor",
      "pollIntervalSec",
      "enabled",
      "deliveryChannels",
      "catalogSchemaVersion",
      "createdAt",
      "updatedAt",
    ]) ||
    !isWatchId(value.id) ||
    !["us", "ca", "uk"].includes(String(value.market)) ||
    !Array.isArray(value.skus) ||
    value.skus.length === 0 ||
    value.skus.length > 12 ||
    !value.skus.every(isSku) ||
    new Set(value.skus).size !== value.skus.length ||
    !Array.isArray(value.storeNumbers) ||
    value.storeNumbers.length === 0 ||
    value.storeNumbers.length > 10 ||
    !value.storeNumbers.every(isStoreNumber) ||
    new Set(value.storeNumbers).size !== value.storeNumbers.length ||
    !isRecord(value.pollAnchor) ||
    !hasExactKeys(value.pollAnchor, ["storeNumber"]) ||
    !isStoreNumber(value.pollAnchor.storeNumber) ||
    !value.storeNumbers.includes(value.pollAnchor.storeNumber) ||
    typeof pollIntervalSec !== "number" ||
    !Number.isInteger(pollIntervalSec) ||
    pollIntervalSec < 60 ||
    pollIntervalSec > 3600 ||
    typeof value.enabled !== "boolean" ||
    !isRecord(value.deliveryChannels) ||
    !hasExactKeys(value.deliveryChannels, [
      "desktop",
      "personalTelegram",
      "hostedRelay",
    ]) ||
    !Object.values(value.deliveryChannels).every(
      (channel) => typeof channel === "boolean",
    ) ||
    typeof catalogSchemaVersion !== "number" ||
    !Number.isInteger(catalogSchemaVersion) ||
    catalogSchemaVersion < 1 ||
    !isIso(value.createdAt) ||
    !isIso(value.updatedAt)
  )
    return false;
  return true;
}

function isUiItem(value: unknown): value is MonitorUiItem {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "watchId",
      "sku",
      "storeNumber",
      "status",
      "lastKnownStatus",
      "lastCheckedAt",
      "lastSuccessfulAt",
      ...(value.lastFailure === undefined ? [] : ["lastFailure"]),
    ]) &&
    (value.lastFailure === undefined ||
      (value.status === "unknown" &&
        LocalCheckFailureSchema.safeParse(value.lastFailure).success)) &&
    isWatchId(value.watchId) &&
    isSku(value.sku) &&
    isStoreNumber(value.storeNumber) &&
    ["available", "unavailable", "ineligible", "unknown"].includes(
      String(value.status),
    ) &&
    (value.lastKnownStatus === null ||
      ["available", "unavailable", "ineligible"].includes(
        String(value.lastKnownStatus),
      )) &&
    isIso(value.lastCheckedAt) &&
    (value.lastSuccessfulAt === null || isIso(value.lastSuccessfulAt))
  );
}

function isUiHistory(value: unknown): value is MonitorUiHistoryEvent {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["sku", "storeNumber", "to", "at"]) &&
    isSku(value.sku) &&
    isStoreNumber(value.storeNumber) &&
    ["available", "unavailable", "ineligible", "unknown"].includes(
      String(value.to),
    ) &&
    isIso(value.at)
  );
}

function isUiPendingDelivery(
  value: unknown,
): value is MonitorUiPendingDelivery {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["watchId"]) &&
    isWatchId(value.watchId)
  );
}

function asCatalog(value: unknown): LocalMonitorUiCatalog | null {
  if (value === null) return null;
  const schemaVersion = isRecord(value) ? value.schemaVersion : undefined;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "generatedAt", "markets"]) ||
    typeof schemaVersion !== "number" ||
    !Number.isInteger(schemaVersion) ||
    schemaVersion !== 1 ||
    !isIso(value.generatedAt) ||
    !Array.isArray(value.markets) ||
    value.markets.length > 3 ||
    !value.markets.every(isUiMarket)
  )
    throw new LocalMonitorRuntimeError("operation_failed");
  const catalog = value as unknown as LocalMonitorUiCatalog;
  const marketCodes = new Set(catalog.markets.map((market) => market.code));
  if (
    marketCodes.size !== catalog.markets.length ||
    catalog.markets.some(
      (market) =>
        new Set(market.variants.map((variant) => variant.sku)).size !==
          market.variants.length ||
        new Set(market.stores.map((store) => store.storeNumber)).size !==
          market.stores.length,
    )
  )
    throw new LocalMonitorRuntimeError("operation_failed");
  return catalog;
}

function isUiMarket(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "code",
      "name",
      "storefrontPath",
      "variants",
      "stores",
    ]) ||
    !["us", "ca", "uk"].includes(String(value.code)) ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    value.name.length > 80 ||
    typeof value.storefrontPath !== "string" ||
    value.storefrontPath.length > 16 ||
    !Array.isArray(value.variants) ||
    value.variants.length === 0 ||
    value.variants.length > 500 ||
    !Array.isArray(value.stores) ||
    value.stores.length > 500
  )
    return false;
  return value.variants.every(isUiVariant) && value.stores.every(isUiStore);
}

function isUiVariant(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "sku",
      "title",
      ...(value.familySlug === undefined ? [] : ["familySlug"]),
    ])
  )
    return false;
  return (
    typeof value.sku === "string" &&
    /^[A-Z0-9]+\/[A-Z]$/.test(value.sku) &&
    typeof value.title === "string" &&
    value.title.length > 0 &&
    value.title.length <= 200 &&
    (value.familySlug === undefined ||
      (typeof value.familySlug === "string" &&
        /^[a-z0-9-]{1,64}$/.test(value.familySlug)))
  );
}

function isUiStore(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["storeNumber", "name", "city", "region"]) &&
    isStoreNumber(value.storeNumber) &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    value.name.length <= 160 &&
    (value.city === null ||
      (typeof value.city === "string" && value.city.length <= 120)) &&
    (value.region === null ||
      (typeof value.region === "string" && value.region.length <= 120))
  );
}

function asStores(value: unknown): StoreLookupUiResult {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new LocalMonitorRuntimeError("operation_failed");
  }
  if (
    (value.kind === "unsupported" || value.kind === "throttled") &&
    hasExactKeys(value, ["kind"])
  ) {
    return { kind: value.kind };
  }
  if (value.kind === "unknown") {
    if (hasExactKeys(value, ["kind"])) return { kind: "unknown" };
    if (
      hasExactKeys(value, ["kind", "reason"]) &&
      typeof value.reason === "string" &&
      LOCAL_STORE_LOOKUP_UNKNOWN_REASONS.includes(
        value.reason as (typeof LOCAL_STORE_LOOKUP_UNKNOWN_REASONS)[number],
      )
    ) {
      return {
        kind: "unknown",
        reason: value.reason as LocalStoreLookupUnknownResult["reason"],
      };
    }
  }
  if (
    value.kind !== "matches" ||
    !hasExactKeys(value, ["kind", "stores"]) ||
    !Array.isArray(value.stores) ||
    value.stores.length > MAX_LOOKUP_STORES ||
    !value.stores.every((store) => isUiStore(store)) ||
    new Set(
      value.stores.map((store) =>
        isRecord(store) ? store.storeNumber : undefined,
      ),
    ).size !== value.stores.length
  )
    throw new LocalMonitorRuntimeError("operation_failed");
  return {
    kind: "matches",
    stores: value.stores as readonly LocalMonitorUiStore[],
  };
}

function asReport(value: unknown): LocalMonitorCycleReport {
  const attemptedBatches = isRecord(value) ? value.attemptedBatches : undefined;
  const queuedEvents = isRecord(value) ? value.queuedEvents : undefined;
  const expiredDeliveryEvents = isRecord(value)
    ? value.expiredDeliveryEvents
    : undefined;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "kind",
      "attemptedBatches",
      "unsupportedWatchIds",
      "queuedEvents",
      "expiredDeliveryEvents",
      "queueBackpressure",
    ]) ||
    !["completed", "busy", "host_backoff", "storage_error"].includes(
      String(value.kind),
    ) ||
    typeof attemptedBatches !== "number" ||
    !Number.isInteger(attemptedBatches) ||
    attemptedBatches < 0 ||
    attemptedBatches > 100 ||
    !Array.isArray(value.unsupportedWatchIds) ||
    value.unsupportedWatchIds.length > 20 ||
    !value.unsupportedWatchIds.every(isWatchId) ||
    typeof queuedEvents !== "number" ||
    !Number.isInteger(queuedEvents) ||
    queuedEvents < 0 ||
    queuedEvents > 200 ||
    typeof expiredDeliveryEvents !== "number" ||
    !Number.isInteger(expiredDeliveryEvents) ||
    expiredDeliveryEvents < 0 ||
    expiredDeliveryEvents > 200 ||
    typeof value.queueBackpressure !== "boolean"
  )
    throw new LocalMonitorRuntimeError("operation_failed");
  return value as unknown as LocalMonitorCycleReport;
}

function asBoolean(value: unknown): boolean {
  if (typeof value !== "boolean")
    throw new LocalMonitorRuntimeError("operation_failed");
  return value;
}

/**
 * Builds the UI controller from a narrow runtime protocol. Calling this does
 * not install a listener; platform integration owns that explicit step.
 */
export async function createRuntimeMonitorController(
  runtime: ExtensionRuntime,
): Promise<MonitorUiController> {
  const capabilities = asCapabilities(
    await request(runtime, {
      protocol: LOCAL_MONITOR_PROTOCOL,
      type: "GET_CAPABILITIES",
    }),
  );
  return {
    capabilities,
    getSnapshot: async () =>
      asSnapshot(
        await request(runtime, {
          protocol: LOCAL_MONITOR_PROTOCOL,
          type: "GET_SNAPSHOT",
        }),
      ),
    getCatalog: async () =>
      asCatalog(
        await request(runtime, {
          protocol: LOCAL_MONITOR_PROTOCOL,
          type: "GET_CATALOG",
        }),
      ),
    lookupStores: async (input: StoreLookupInput) =>
      asStores(
        await request(runtime, {
          protocol: LOCAL_MONITOR_PROTOCOL,
          type: "LOOKUP_STORES",
          input,
        }),
      ),
    start: async () =>
      asReport(
        await request(runtime, {
          protocol: LOCAL_MONITOR_PROTOCOL,
          type: "START",
        }),
      ),
    wake: async () =>
      asReport(
        await request(runtime, {
          protocol: LOCAL_MONITOR_PROTOCOL,
          type: "WAKE",
        }),
      ),
    checkNow: async (watchIds?: readonly string[]) =>
      asReport(
        await request(
          runtime,
          watchIds === undefined
            ? { protocol: LOCAL_MONITOR_PROTOCOL, type: "CHECK_NOW" }
            : { protocol: LOCAL_MONITOR_PROTOCOL, type: "CHECK_NOW", watchIds },
        ),
      ),
    openAvailableAtApple: async (input) => {
      const result = await request(runtime, {
        protocol: LOCAL_MONITOR_PROTOCOL,
        type: "OPEN_AVAILABLE_AT_APPLE",
        ...input,
      });
      if (result !== "opened" && result !== "unavailable") {
        throw new LocalMonitorRuntimeError("operation_failed");
      }
      return result;
    },
    addWatch: async (watch: LocalWatch) =>
      asBoolean(
        await request(runtime, {
          protocol: LOCAL_MONITOR_PROTOCOL,
          type: "ADD_WATCH",
          watch,
        }),
      ),
    replaceWatch: async (watch: LocalWatch) =>
      asBoolean(
        await request(runtime, {
          protocol: LOCAL_MONITOR_PROTOCOL,
          type: "REPLACE_WATCH",
          watch,
        }),
      ),
    setWatchEnabled: async (id: string, enabled: boolean) =>
      asBoolean(
        await request(runtime, {
          protocol: LOCAL_MONITOR_PROTOCOL,
          type: "SET_WATCH_ENABLED",
          id,
          enabled,
        }),
      ),
    deleteWatch: async (id: string) =>
      asBoolean(
        await request(runtime, {
          protocol: LOCAL_MONITOR_PROTOCOL,
          type: "DELETE_WATCH",
          id,
        }),
      ),
    reset: async () => {
      await request(runtime, {
        protocol: LOCAL_MONITOR_PROTOCOL,
        type: "RESET",
      });
    },
  };
}
