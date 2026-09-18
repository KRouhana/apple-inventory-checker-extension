import type { ExtensionMessageSender, ExtensionRuntime } from "./api.js";
import { isTrustedOwnExtensionAppSender } from "./trusted-app-sender.js";
import type {
  LocalCatalogSnapshot,
  LocalCatalogStore,
  LocalMarketCode,
  LocalStoreLookupUnknownResult,
  LocalMonitorSnapshot,
  LocalWatch,
  StoreLookupInput,
} from "../../../../packages/core/src/local-monitor-contracts.js";
import {
  LOCAL_STORE_LOOKUP_UNKNOWN_REASONS,
  LocalCatalogStoreSchema,
  parseLocalCatalogSnapshot,
  parseLocalMonitorSnapshot,
  parseLocalWatch,
} from "../../../../packages/core/src/local-monitor-contracts.js";
import type {
  LocalMonitorCycleReport,
  MonitorUiCapabilities,
  LocalMonitorUiCatalog,
  MonitorUiSnapshot,
  LocalMonitorUiStore,
  StoreLookupUiResult,
} from "../ui/controller.js";
import { projectCatalogForUi } from "../ui/controller.js";
import type { PickupDiagnostic } from "../runtime/apple-pickup-fetch.js";
import type { PickupParseDiagnostic } from "../monitor/local-monitor-engine.js";

export const LOCAL_MONITOR_PROTOCOL = "inventory-signal.local-monitor.v1";
const LOCAL_MONITOR_APP_PATH = "app.html";
const MAX_LOCATION_INPUT_LENGTH = 120;
const MAX_WATCH_IDS_PER_CHECK = 20;
const MAX_PUBLIC_IDENTITY_SKU_LENGTH = 32;
const MAX_PUBLIC_PRODUCT_TITLE_LENGTH = 200;
const PUBLIC_IDENTITY_SKU_PATTERN = /^[A-Z0-9]{1,30}\/[A-Z]$/;
const PUBLIC_PRODUCT_TITLE_PATTERN =
  /^iPhone[ \u00a0\u202f][A-Za-z0-9 .,'’()&+/\u00a0\u202f-]*$/;
const PUBLIC_PRODUCT_URL_PATTERN = /(?:https?:\/\/|www\.)/i;
const PUBLIC_PICKUP_DISPLAY_TOKEN_PATTERN =
  /^[A-Za-z][A-Za-z0-9 _-]{0,63}(?![\s\S])/;
const MAX_LOOKUP_STORES = 50;
const MAX_WATCHES = 20;
const MAX_SNAPSHOT_ITEMS = 2_400;
const MAX_HISTORY_EVENTS = 2_000;
const MAX_PENDING_DELIVERY = 200;

type MonitorCommandType =
  | "GET_CAPABILITIES"
  | "GET_SNAPSHOT"
  | "GET_CATALOG"
  | "GET_PICKUP_DIAGNOSTIC"
  | "GET_PICKUP_PARSE_DIAGNOSTIC"
  | "LOOKUP_STORES"
  | "START"
  | "WAKE"
  | "CHECK_NOW"
  | "OPEN_AVAILABLE_AT_APPLE"
  | "ADD_WATCH"
  | "REPLACE_WATCH"
  | "SET_WATCH_ENABLED"
  | "DELETE_WATCH"
  | "RESET";

const MONITOR_COMMAND_TYPES: readonly MonitorCommandType[] = [
  "GET_CAPABILITIES",
  "GET_SNAPSHOT",
  "GET_CATALOG",
  "GET_PICKUP_DIAGNOSTIC",
  "GET_PICKUP_PARSE_DIAGNOSTIC",
  "LOOKUP_STORES",
  "START",
  "WAKE",
  "CHECK_NOW",
  "OPEN_AVAILABLE_AT_APPLE",
  "ADD_WATCH",
  "REPLACE_WATCH",
  "SET_WATCH_ENABLED",
  "DELETE_WATCH",
  "RESET",
];

function isMonitorCommandType(value: unknown): value is MonitorCommandType {
  return MONITOR_COMMAND_TYPES.includes(value as MonitorCommandType);
}

export type LocalMonitorRuntimeCommand =
  | { protocol: typeof LOCAL_MONITOR_PROTOCOL; type: "GET_CAPABILITIES" }
  | { protocol: typeof LOCAL_MONITOR_PROTOCOL; type: "GET_SNAPSHOT" }
  | { protocol: typeof LOCAL_MONITOR_PROTOCOL; type: "GET_CATALOG" }
  | { protocol: typeof LOCAL_MONITOR_PROTOCOL; type: "GET_PICKUP_DIAGNOSTIC" }
  | {
      protocol: typeof LOCAL_MONITOR_PROTOCOL;
      type: "GET_PICKUP_PARSE_DIAGNOSTIC";
    }
  | {
      protocol: typeof LOCAL_MONITOR_PROTOCOL;
      type: "LOOKUP_STORES";
      input: StoreLookupInput;
    }
  | { protocol: typeof LOCAL_MONITOR_PROTOCOL; type: "START" }
  | { protocol: typeof LOCAL_MONITOR_PROTOCOL; type: "WAKE" }
  | {
      protocol: typeof LOCAL_MONITOR_PROTOCOL;
      type: "CHECK_NOW";
      watchIds?: readonly string[];
    }
  | {
      protocol: typeof LOCAL_MONITOR_PROTOCOL;
      type: "OPEN_AVAILABLE_AT_APPLE";
      watchId: string;
      sku: string;
      storeNumber: string;
    }
  | {
      protocol: typeof LOCAL_MONITOR_PROTOCOL;
      type: "ADD_WATCH";
      watch: LocalWatch;
    }
  | {
      protocol: typeof LOCAL_MONITOR_PROTOCOL;
      type: "REPLACE_WATCH";
      watch: LocalWatch;
    }
  | {
      protocol: typeof LOCAL_MONITOR_PROTOCOL;
      type: "SET_WATCH_ENABLED";
      id: string;
      enabled: boolean;
    }
  | {
      protocol: typeof LOCAL_MONITOR_PROTOCOL;
      type: "DELETE_WATCH";
      id: string;
    }
  | { protocol: typeof LOCAL_MONITOR_PROTOCOL; type: "RESET" };

export type LocalMonitorRuntimeResult =
  | MonitorUiCapabilities
  | MonitorUiSnapshot
  | LocalMonitorUiCatalog
  | PickupDiagnostic
  | PickupParseDiagnostic
  | StoreLookupUiResult
  | LocalMonitorCycleReport
  | boolean
  | "opened"
  | "unavailable"
  | null;

export type LocalMonitorRuntimeResponse =
  | {
      protocol: typeof LOCAL_MONITOR_PROTOCOL;
      type: "RESULT";
      request: MonitorCommandType;
      ok: true;
      result: LocalMonitorRuntimeResult;
    }
  | {
      protocol: typeof LOCAL_MONITOR_PROTOCOL;
      type: "RESULT";
      request: MonitorCommandType | "UNKNOWN";
      ok: false;
      error:
        | "unauthorized"
        | "invalid_request"
        | "unavailable"
        | "operation_failed";
    };

/** The minimum engine shape, kept here so L08 stays dependency-injected. */
export interface LocalMonitorRuntimeEngine {
  start(): Promise<LocalMonitorCycleReport>;
  wake(): Promise<LocalMonitorCycleReport>;
  checkNow(watchIds?: readonly string[]): Promise<LocalMonitorCycleReport>;
  getSnapshot(): Promise<LocalMonitorSnapshot>;
  addWatch(watch: LocalWatch): Promise<boolean>;
  replaceWatch(watch: LocalWatch): Promise<boolean>;
  setWatchEnabled(id: string, enabled: boolean): Promise<boolean>;
  deleteWatch(id: string): Promise<boolean>;
  reset(): Promise<void>;
}

export interface LocalMonitorRuntimeDependencies {
  engine: LocalMonitorRuntimeEngine;
  /** May wait for a cold worker's packaged-catalog initialization. */
  getCatalog():
    | LocalCatalogSnapshot
    | null
    | Promise<LocalCatalogSnapshot | null>;
  /** Optional worker-lifetime-only adapter diagnostic for trusted app reads. */
  getPickupDiagnostic?: () => PickupDiagnostic | null;
  /** Optional worker-lifetime-only core parser result for trusted app reads. */
  getPickupParseDiagnostic?: () => PickupParseDiagnostic | null;
  lookupStores(input: StoreLookupInput): Promise<LocalMonitorStoreLookupResult>;
  capabilities(): MonitorUiCapabilities | Promise<MonitorUiCapabilities>;
  openAvailableAtApple(input: {
    watchId: string;
    sku: string;
    storeNumber: string;
  }): Promise<"opened" | "unavailable">;
}

/** Internal trusted result before poll locations are projected away. */
export type LocalMonitorStoreLookupResult =
  | { readonly kind: "matches"; readonly stores: readonly LocalCatalogStore[] }
  | { readonly kind: "unsupported" }
  | LocalStoreLookupUnknownResult
  | { readonly kind: "throttled" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function isMarket(value: unknown): value is LocalMarketCode {
  return value === "us" || value === "ca" || value === "uk";
}

function isWatchId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function isStoreNumber(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9-]{1,16}$/.test(value);
}

function parseWatch(value: unknown): LocalWatch | null {
  if (!isRecord(value)) return null;
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
    ])
  )
    return null;
  const parsed = parseLocalWatch(value);
  return parsed.success ? parsed.data : null;
}

function parseLookupInput(value: unknown): StoreLookupInput | null {
  if (!isRecord(value) || !hasExactKeys(value, ["market", "userPostalInput"]))
    return null;
  if (!isMarket(value.market) || typeof value.userPostalInput !== "string")
    return null;
  const userPostalInput = value.userPostalInput.trim();
  if (
    userPostalInput.length === 0 ||
    userPostalInput.length > MAX_LOCATION_INPUT_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(userPostalInput)
  )
    return null;
  return { market: value.market, userPostalInput };
}

function projectStoreForUi(store: unknown): LocalMonitorUiStore | null {
  const parsed = LocalCatalogStoreSchema.safeParse(store);
  if (!parsed.success) return null;
  const { storeNumber, name, city, region } = parsed.data;
  return {
    storeNumber,
    name,
    city,
    region,
  };
}

function projectLookupResultForUi(value: unknown): StoreLookupUiResult | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "unsupported" || value.kind === "throttled") {
    return hasExactKeys(value, ["kind"]) ? { kind: value.kind } : null;
  }
  if (value.kind === "unknown") {
    if (hasExactKeys(value, ["kind"])) return { kind: "unknown" };
    return hasExactKeys(value, ["kind", "reason"]) &&
      typeof value.reason === "string" &&
      LOCAL_STORE_LOOKUP_UNKNOWN_REASONS.includes(
        value.reason as (typeof LOCAL_STORE_LOOKUP_UNKNOWN_REASONS)[number],
      )
      ? {
          kind: "unknown",
          reason: value.reason as LocalStoreLookupUnknownResult["reason"],
        }
      : null;
  }
  if (
    value.kind !== "matches" ||
    !hasExactKeys(value, ["kind", "stores"]) ||
    !Array.isArray(value.stores) ||
    value.stores.length > MAX_LOOKUP_STORES
  ) {
    return null;
  }
  const stores = value.stores.map(projectStoreForUi);
  return stores.every(
    (store): store is LocalMonitorUiStore => store !== null,
  ) && new Set(stores.map((store) => store.storeNumber)).size === stores.length
    ? { kind: "matches", stores }
    : null;
}

function projectCatalogForRuntime(
  catalog: unknown,
): LocalMonitorUiCatalog | null {
  const parsed = parseLocalCatalogSnapshot(catalog);
  if (!parsed.success) return null;
  if (
    parsed.data.markets.length > 3 ||
    parsed.data.markets.some(
      (market) => market.variants.length > 500 || market.stores.length > 500,
    )
  )
    return null;
  return projectCatalogForUi(parsed.data);
}

function projectPickupDiagnostic(value: unknown): PickupDiagnostic | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["phase", "byteCount", "httpStatus"])
  )
    return null;
  const phase = value.phase;
  const byteCount = value.byteCount;
  const httpStatus = value.httpStatus;
  if (
    typeof phase !== "string" ||
    typeof byteCount !== "number" ||
    !(httpStatus === null || typeof httpStatus === "number")
  ) {
    return null;
  }
  const phases = [
    "request_invalid",
    "network_failure",
    "http_rejected",
    "url_mismatch",
    "content_length_rejected",
    "body_missing",
    "body_non_bytes",
    "body_too_large",
    "body_read_failed",
    "invalid_json",
    "json_parsed",
  ] as const;
  if (
    !phases.includes(phase as (typeof phases)[number]) ||
    !Number.isSafeInteger(byteCount) ||
    byteCount < 0 ||
    byteCount > 512 * 1024 ||
    !(
      httpStatus === null ||
      (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599)
    )
  ) {
    return null;
  }
  return {
    phase: phase as PickupDiagnostic["phase"],
    byteCount,
    httpStatus,
  };
}

function projectPickupParseDiagnostic(
  value: unknown,
): PickupParseDiagnostic | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "outcome",
      "reason",
      "storeCount",
      "observationCount",
      "targetStatus",
      "targetAvailability",
      "identityMismatch",
    ])
  )
    return null;
  const reasons = [
    "upstream_http_error",
    "upstream_payload_error",
    "invalid_json",
    "invalid_shape",
    "sku_set_mismatch",
    "identity_validation_failed",
  ];
  const statuses = [
    "available",
    "unavailable",
    "ineligible",
    "unknown",
    "missing",
    "mixed",
    "not_parsed",
  ];
  const outcome = value.outcome;
  const reason = value.reason;
  const storeCount = value.storeCount;
  const observationCount = value.observationCount;
  const targetStatus = value.targetStatus;
  const targetAvailability = projectTargetAvailability(
    value.targetAvailability,
  );
  const identityMismatch = projectIdentityMismatch(value.identityMismatch);
  if (
    typeof outcome !== "string" ||
    !(reason === null || typeof reason === "string") ||
    typeof storeCount !== "number" ||
    typeof observationCount !== "number" ||
    typeof targetStatus !== "string" ||
    targetAvailability === undefined ||
    identityMismatch === undefined
  )
    return null;
  if (
    !["success", "failure", "not_parsed"].includes(outcome) ||
    !(reason === null || reasons.includes(reason)) ||
    !Number.isSafeInteger(storeCount) ||
    storeCount < 0 ||
    storeCount > 2_000 ||
    !Number.isSafeInteger(observationCount) ||
    observationCount < 0 ||
    observationCount > 2_000 ||
    !statuses.includes(targetStatus)
  )
    return null;
  if (
    targetAvailability !== null &&
    (outcome !== "success" ||
      ["missing", "mixed", "not_parsed"].includes(targetStatus) ||
      targetStatus !== targetAvailabilityStatus(targetAvailability))
  )
    return null;
  if (
    identityMismatch !== null &&
    !(outcome === "failure" && reason === "identity_validation_failed")
  )
    return null;
  if (
    (outcome === "success" &&
      (reason !== null || targetStatus === "not_parsed")) ||
    (outcome === "failure" &&
      (reason === null ||
        targetStatus !== "not_parsed" ||
        storeCount !== 0 ||
        observationCount !== 0)) ||
    (outcome === "not_parsed" &&
      (reason !== null ||
        targetStatus !== "not_parsed" ||
        storeCount !== 0 ||
        observationCount !== 0))
  )
    return null;
  return {
    outcome: outcome as PickupParseDiagnostic["outcome"],
    reason: reason as PickupParseDiagnostic["reason"],
    storeCount,
    observationCount,
    targetStatus: targetStatus as PickupParseDiagnostic["targetStatus"],
    targetAvailability,
    identityMismatch,
  };
}

function projectTargetAvailability(
  value: unknown,
): PickupParseDiagnostic["targetAvailability"] | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "pickupDisplay",
      "pickupDisplayToken",
      "storePickEligible",
      "isBuyable",
    ]) ||
    typeof value.pickupDisplay !== "string" ||
    !["available", "unavailable", "ineligible", "other"].includes(
      value.pickupDisplay,
    ) ||
    !(
      value.pickupDisplayToken === null ||
      (typeof value.pickupDisplayToken === "string" &&
        PUBLIC_PICKUP_DISPLAY_TOKEN_PATTERN.test(value.pickupDisplayToken))
    ) ||
    (value.pickupDisplay !== "other" && value.pickupDisplayToken !== null) ||
    typeof value.storePickEligible !== "boolean" ||
    !(value.isBuyable === null || typeof value.isBuyable === "boolean")
  )
    return undefined;
  return {
    pickupDisplay: value.pickupDisplay as
      | "available"
      | "unavailable"
      | "ineligible"
      | "other",
    pickupDisplayToken: value.pickupDisplayToken,
    storePickEligible: value.storePickEligible,
    isBuyable: value.isBuyable,
  };
}

function targetAvailabilityStatus(
  value: NonNullable<PickupParseDiagnostic["targetAvailability"]>,
): PickupParseDiagnostic["targetStatus"] {
  if (value.pickupDisplay === "ineligible") {
    return value.isBuyable === true ? "unknown" : "ineligible";
  }
  if (!value.storePickEligible) {
    return value.pickupDisplay === "available" || value.isBuyable === true
      ? "unknown"
      : "ineligible";
  }
  if (value.pickupDisplay === "available") {
    return value.isBuyable === false ? "unknown" : "available";
  }
  if (value.pickupDisplay === "unavailable") {
    return value.isBuyable === true ? "unknown" : "unavailable";
  }
  return "unknown";
}

function projectIdentityMismatch(
  value: unknown,
): PickupParseDiagnostic["identityMismatch"] | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  if (hasExactKeys(value, ["kind"]) && value.kind === "redacted") {
    return { kind: "redacted" };
  }
  if (
    !hasExactKeys(value, [
      "kind",
      "requestedSku",
      "expectedTitle",
      "observedTitle",
    ]) ||
    value.kind !== "public_product" ||
    typeof value.requestedSku !== "string" ||
    value.requestedSku.length > MAX_PUBLIC_IDENTITY_SKU_LENGTH ||
    !PUBLIC_IDENTITY_SKU_PATTERN.test(value.requestedSku) ||
    typeof value.expectedTitle !== "string" ||
    typeof value.observedTitle !== "string" ||
    !publicProductTitle(value.expectedTitle) ||
    !publicProductTitle(value.observedTitle)
  )
    return undefined;
  return {
    kind: "public_product",
    requestedSku: value.requestedSku,
    expectedTitle: value.expectedTitle,
    observedTitle: value.observedTitle,
  };
}

function publicProductTitle(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_PUBLIC_PRODUCT_TITLE_LENGTH &&
    PUBLIC_PRODUCT_TITLE_PATTERN.test(value) &&
    !PUBLIC_PRODUCT_URL_PATTERN.test(value)
  );
}

function projectSnapshotForUi(snapshot: unknown): MonitorUiSnapshot | null {
  const parsed = parseLocalMonitorSnapshot(snapshot);
  if (!parsed.success) return null;
  const canonical = parsed.data;
  if (
    canonical.watches.length > MAX_WATCHES ||
    canonical.items.length > MAX_SNAPSHOT_ITEMS ||
    canonical.history.length > MAX_HISTORY_EVENTS ||
    canonical.pendingDelivery.length > MAX_PENDING_DELIVERY
  )
    return null;
  return {
    version: 1,
    watches: canonical.watches,
    items: canonical.items.map((item) => ({
      watchId: item.watchId,
      sku: item.sku,
      storeNumber: item.storeNumber,
      status: item.status,
      lastKnownStatus: item.lastKnownStatus,
      lastCheckedAt: item.lastCheckedAt,
      lastSuccessfulAt: item.lastSuccessfulAt,
      ...(item.lastFailure ? { lastFailure: item.lastFailure } : {}),
    })),
    history: canonical.history.map((event) => ({
      sku: event.sku,
      storeNumber: event.storeNumber,
      to: event.to,
      at: event.at,
    })),
    pendingDelivery: canonical.pendingDelivery.map((entry) => ({
      watchId: entry.event.watchId,
    })),
  };
}

function projectCapabilities(
  value: MonitorUiCapabilities,
): MonitorUiCapabilities | null {
  if (
    !isRecord(value) ||
    !Object.keys(value).every((key) =>
      [
        "monitor",
        "catalog",
        "storeLookup",
        "personalTelegram",
        "hostedRelay",
        "reason",
      ].includes(key),
    ) ||
    typeof value.monitor !== "boolean" ||
    typeof value.catalog !== "boolean" ||
    typeof value.storeLookup !== "boolean" ||
    typeof value.personalTelegram !== "boolean" ||
    typeof value.hostedRelay !== "boolean" ||
    (value.reason !== undefined &&
      (typeof value.reason !== "string" || value.reason.length > 160))
  )
    return null;
  return {
    monitor: value.monitor,
    catalog: value.catalog,
    storeLookup: value.storeLookup,
    personalTelegram: value.personalTelegram,
    hostedRelay: value.hostedRelay,
    ...(value.reason ? { reason: value.reason } : {}),
  };
}

function projectCycleReport(
  value: LocalMonitorCycleReport,
): LocalMonitorCycleReport | null {
  if (
    !isRecord(value) ||
    !["completed", "busy", "host_backoff", "storage_error"].includes(
      String(value.kind),
    ) ||
    !Number.isInteger(value.attemptedBatches) ||
    value.attemptedBatches < 0 ||
    value.attemptedBatches > 100 ||
    !Array.isArray(value.unsupportedWatchIds) ||
    value.unsupportedWatchIds.length > 20 ||
    !value.unsupportedWatchIds.every(isWatchId) ||
    !Number.isInteger(value.queuedEvents) ||
    value.queuedEvents < 0 ||
    value.queuedEvents > 200 ||
    !Number.isInteger(value.expiredDeliveryEvents) ||
    value.expiredDeliveryEvents < 0 ||
    value.expiredDeliveryEvents > 200 ||
    typeof value.queueBackpressure !== "boolean"
  )
    return null;
  return {
    kind: value.kind as LocalMonitorCycleReport["kind"],
    attemptedBatches: value.attemptedBatches,
    unsupportedWatchIds: [...value.unsupportedWatchIds],
    queuedEvents: value.queuedEvents,
    expiredDeliveryEvents: value.expiredDeliveryEvents,
    queueBackpressure: value.queueBackpressure,
  };
}

export function parseLocalMonitorRuntimeCommand(
  input: unknown,
): LocalMonitorRuntimeCommand | null {
  if (
    !isRecord(input) ||
    input.protocol !== LOCAL_MONITOR_PROTOCOL ||
    typeof input.type !== "string"
  )
    return null;
  switch (input.type) {
    case "GET_CAPABILITIES":
    case "GET_SNAPSHOT":
    case "GET_CATALOG":
    case "GET_PICKUP_DIAGNOSTIC":
    case "GET_PICKUP_PARSE_DIAGNOSTIC":
    case "START":
    case "WAKE":
    case "RESET":
      return hasExactKeys(input, ["protocol", "type"])
        ? { protocol: LOCAL_MONITOR_PROTOCOL, type: input.type }
        : null;
    case "LOOKUP_STORES": {
      if (!hasExactKeys(input, ["protocol", "type", "input"])) return null;
      const lookup = parseLookupInput(input.input);
      return lookup
        ? {
            protocol: LOCAL_MONITOR_PROTOCOL,
            type: "LOOKUP_STORES",
            input: lookup,
          }
        : null;
    }
    case "CHECK_NOW": {
      if (
        !hasExactKeys(input, ["protocol", "type"]) &&
        !hasExactKeys(input, ["protocol", "type", "watchIds"])
      )
        return null;
      if (input.watchIds === undefined)
        return { protocol: LOCAL_MONITOR_PROTOCOL, type: "CHECK_NOW" };
      if (
        !Array.isArray(input.watchIds) ||
        input.watchIds.length === 0 ||
        input.watchIds.length > MAX_WATCH_IDS_PER_CHECK ||
        !input.watchIds.every(isWatchId) ||
        new Set(input.watchIds).size !== input.watchIds.length
      )
        return null;
      return {
        protocol: LOCAL_MONITOR_PROTOCOL,
        type: "CHECK_NOW",
        watchIds: [...input.watchIds],
      };
    }
    case "OPEN_AVAILABLE_AT_APPLE":
      return hasExactKeys(input, [
        "protocol",
        "type",
        "watchId",
        "sku",
        "storeNumber",
      ]) &&
        isWatchId(input.watchId) &&
        typeof input.sku === "string" &&
        /^[A-Z0-9]+\/[A-Z]$/.test(input.sku) &&
        isStoreNumber(input.storeNumber)
        ? {
            protocol: LOCAL_MONITOR_PROTOCOL,
            type: "OPEN_AVAILABLE_AT_APPLE",
            watchId: input.watchId,
            sku: input.sku,
            storeNumber: input.storeNumber,
          }
        : null;
    case "ADD_WATCH":
    case "REPLACE_WATCH": {
      if (!hasExactKeys(input, ["protocol", "type", "watch"])) return null;
      const watch = parseWatch(input.watch);
      return watch
        ? { protocol: LOCAL_MONITOR_PROTOCOL, type: input.type, watch }
        : null;
    }
    case "SET_WATCH_ENABLED":
      return hasExactKeys(input, ["protocol", "type", "id", "enabled"]) &&
        isWatchId(input.id) &&
        typeof input.enabled === "boolean"
        ? {
            protocol: LOCAL_MONITOR_PROTOCOL,
            type: "SET_WATCH_ENABLED",
            id: input.id,
            enabled: input.enabled,
          }
        : null;
    case "DELETE_WATCH":
      return hasExactKeys(input, ["protocol", "type", "id"]) &&
        isWatchId(input.id)
        ? {
            protocol: LOCAL_MONITOR_PROTOCOL,
            type: "DELETE_WATCH",
            id: input.id,
          }
        : null;
    default:
      return null;
  }
}

export function isTrustedLocalMonitorPageSender(
  sender: ExtensionMessageSender,
  runtime: ExtensionRuntime,
): boolean {
  return isTrustedOwnExtensionAppSender(
    sender,
    runtime,
    LOCAL_MONITOR_APP_PATH,
  );
}

function failure(
  request: MonitorCommandType | "UNKNOWN",
  error:
    | "unauthorized"
    | "invalid_request"
    | "unavailable"
    | "operation_failed",
): LocalMonitorRuntimeResponse {
  return {
    protocol: LOCAL_MONITOR_PROTOCOL,
    type: "RESULT",
    request,
    ok: false,
    error,
  };
}

function publicResponse(
  request: MonitorCommandType,
  result: LocalMonitorRuntimeResult,
): LocalMonitorRuntimeResponse {
  return {
    protocol: LOCAL_MONITOR_PROTOCOL,
    type: "RESULT",
    request,
    ok: true,
    result,
  };
}

function booleanResponse(
  request: Extract<
    MonitorCommandType,
    "ADD_WATCH" | "REPLACE_WATCH" | "SET_WATCH_ENABLED" | "DELETE_WATCH"
  >,
  result: unknown,
): LocalMonitorRuntimeResponse {
  return typeof result === "boolean"
    ? publicResponse(request, result)
    : failure(request, "operation_failed");
}

/**
 * Installs no entrypoint by itself. The chief integration slice explicitly
 * calls this from the background with a real engine/catalog/lookup adapter.
 */
export function installLocalMonitorMessageHandler(
  runtime: ExtensionRuntime,
  dependencies: LocalMonitorRuntimeDependencies,
): void {
  runtime.onMessage.addListener((input, sender, sendResponse) => {
    if (!isRecord(input) || input.protocol !== LOCAL_MONITOR_PROTOCOL) return;
    const parsed = parseLocalMonitorRuntimeCommand(input);
    const request = isMonitorCommandType(input.type) ? input.type : "UNKNOWN";
    if (!isTrustedLocalMonitorPageSender(sender, runtime)) {
      sendResponse(failure(request, "unauthorized"));
      return;
    }
    if (!parsed) {
      sendResponse(failure(request, "invalid_request"));
      return;
    }
    void dispatchLocalMonitorCommand(parsed, dependencies).then(
      sendResponse,
      () => sendResponse(failure(parsed.type, "operation_failed")),
    );
    return true;
  });
}

async function dispatchLocalMonitorCommand(
  command: LocalMonitorRuntimeCommand,
  dependencies: LocalMonitorRuntimeDependencies,
): Promise<LocalMonitorRuntimeResponse> {
  switch (command.type) {
    case "GET_CAPABILITIES": {
      const result = projectCapabilities(await dependencies.capabilities());
      return result
        ? publicResponse(command.type, result)
        : failure(command.type, "unavailable");
    }
    case "GET_SNAPSHOT": {
      const result = projectSnapshotForUi(
        await dependencies.engine.getSnapshot(),
      );
      return result
        ? publicResponse(command.type, result)
        : failure(command.type, "operation_failed");
    }
    case "GET_CATALOG": {
      const catalog = await dependencies.getCatalog();
      if (catalog === null) return publicResponse(command.type, null);
      const result = projectCatalogForRuntime(catalog);
      return result
        ? publicResponse(command.type, result)
        : failure(command.type, "operation_failed");
    }
    case "GET_PICKUP_DIAGNOSTIC": {
      const result = projectPickupDiagnostic(
        dependencies.getPickupDiagnostic?.() ?? null,
      );
      return publicResponse(command.type, result);
    }
    case "GET_PICKUP_PARSE_DIAGNOSTIC": {
      const result = projectPickupParseDiagnostic(
        dependencies.getPickupParseDiagnostic?.() ?? null,
      );
      return publicResponse(command.type, result);
    }
    case "LOOKUP_STORES": {
      const result = projectLookupResultForUi(
        await dependencies.lookupStores(command.input),
      );
      return result
        ? publicResponse(command.type, result)
        : failure(command.type, "operation_failed");
    }
    case "START": {
      const result = projectCycleReport(await dependencies.engine.start());
      return result
        ? publicResponse(command.type, result)
        : failure(command.type, "operation_failed");
    }
    case "WAKE": {
      const result = projectCycleReport(await dependencies.engine.wake());
      return result
        ? publicResponse(command.type, result)
        : failure(command.type, "operation_failed");
    }
    case "CHECK_NOW": {
      const result = projectCycleReport(
        await dependencies.engine.checkNow(command.watchIds),
      );
      return result
        ? publicResponse(command.type, result)
        : failure(command.type, "operation_failed");
    }
    case "OPEN_AVAILABLE_AT_APPLE": {
      const result = await dependencies.openAvailableAtApple({
        watchId: command.watchId,
        sku: command.sku,
        storeNumber: command.storeNumber,
      });
      return result === "opened" || result === "unavailable"
        ? publicResponse(command.type, result)
        : failure(command.type, "operation_failed");
    }
    case "ADD_WATCH":
      return booleanResponse(
        command.type,
        await dependencies.engine.addWatch(command.watch),
      );
    case "REPLACE_WATCH":
      return booleanResponse(
        command.type,
        await dependencies.engine.replaceWatch(command.watch),
      );
    case "SET_WATCH_ENABLED":
      return booleanResponse(
        command.type,
        await dependencies.engine.setWatchEnabled(command.id, command.enabled),
      );
    case "DELETE_WATCH":
      return booleanResponse(
        command.type,
        await dependencies.engine.deleteWatch(command.id),
      );
    case "RESET":
      await dependencies.engine.reset();
      return publicResponse(command.type, null);
  }
}
