/**
 * Data-only portable catalog boundary for the local monitor (L06 / issue #15).
 *
 * The accepted L01 contracts in `packages/core` are the sole authority for
 * catalog shape, parsing, freshness, reconciliation, and privacy-preserving
 * store selection. This extension module deliberately adds only the
 * transport-facing executable-key guard and catalog download byte budget.
 * Keeping the types and helpers as aliases/re-exports prevents an extension
 * catalog model from drifting away from the monitor engine or UI.
 */
import {
  compareCatalogFreshness,
  extractPersistableWatchStores,
  isAllowedCatalogUrl,
  LOCAL_MARKETS,
  parseLocalCatalogSnapshot,
  reconcileWatchWithCatalog,
  resolveWatchPollLocation,
  SUPPORTED_LOCAL_CATALOG_SCHEMA_VERSION,
} from "../../../../packages/core/src/local-monitor-contracts.js";
import type {
  CatalogFreshness,
  LocalCatalogMarket,
  LocalCatalogSnapshot,
  LocalCatalogStore,
  LocalCatalogVariant,
  LocalMarketCode,
  LocalWatch,
  LocalWatchValidationIssue,
  PersistableWatchStoresResult,
  StoreLookupInput,
  WatchCatalogIssue,
} from "../../../../packages/core/src/local-monitor-contracts.js";

export const SUPPORTED_PORTABLE_CATALOG_SCHEMA_VERSION =
  SUPPORTED_LOCAL_CATALOG_SCHEMA_VERSION;
export const PORTABLE_MARKET_CODES = LOCAL_MARKETS;
export type PortableMarketCode = LocalMarketCode;

/** A remote catalog is never allowed to exceed this hard client-side cap. */
export const MAX_CATALOG_BYTES = 256 * 1024;

export type PortableCatalogVariant = LocalCatalogVariant;
export type PortableCatalogStore = LocalCatalogStore;
export type PortableCatalogMarket = LocalCatalogMarket;
export type PortableCatalogSnapshot = LocalCatalogSnapshot;
export type CatalogValidationIssue = LocalWatchValidationIssue;
export type PortableCatalogParseResult =
  | { success: true; data: PortableCatalogSnapshot }
  | { success: false; issues: readonly CatalogValidationIssue[] };
export type {
  CatalogFreshness,
  PersistableWatchStoresResult,
  WatchCatalogIssue,
};
export type PollAnchorWatch = Pick<LocalWatch, "market" | "pollAnchor">;
export type ReconciledWatch = Pick<
  LocalWatch,
  "market" | "skus" | "storeNumbers" | "pollAnchor"
>;
export type TransientStoreLookup = StoreLookupInput;

const EXECUTABLE_FIELD_NAMES: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reject JavaScript-meta fields before the canonical strict schema sees a
 * document. JSON data has no reason to contain these field names anywhere.
 */
function executableFieldIssue(
  value: unknown,
  path = "",
): CatalogValidationIssue | null {
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const issue = executableFieldIssue(
        child,
        `${path}${path ? "." : ""}${index}`,
      );
      if (issue) return issue;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const key of Object.keys(value)) {
    const childPath = `${path}${path ? "." : ""}${key}`;
    if (EXECUTABLE_FIELD_NAMES.has(key)) {
      return {
        path: childPath,
        message: `Catalog must not contain executable field ${key}`,
      };
    }
    const issue = executableFieldIssue(value[key], childPath);
    if (issue) return issue;
  }
  return null;
}

/**
 * Validate untrusted JSON as data-only and then delegate all catalog shape
 * semantics to the L01 core authority. Do not add extension-only schema
 * rules here: those would split the model consumed by L08/L09.
 */
export function parsePortableCatalogSnapshot(
  input: unknown,
): PortableCatalogParseResult {
  const executableIssue = executableFieldIssue(input);
  if (executableIssue) return { success: false, issues: [executableIssue] };
  return parseLocalCatalogSnapshot(input);
}

export {
  compareCatalogFreshness,
  extractPersistableWatchStores,
  isAllowedCatalogUrl,
  reconcileWatchWithCatalog,
  resolveWatchPollLocation,
};
