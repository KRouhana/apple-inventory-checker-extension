/**
 * Portable catalog export surface (L06 / issue #15).
 *
 * Integration notes for the platform coder (L05) and monitoring engine
 * (L08); this package performs no wiring itself:
 *
 * - Bundle `catalog/portable-catalog.json` (or its validated equivalent)
 *   and pass it as `bundledFallback` to `refreshPortableCatalog`. Validate
 *   it once at startup with `parsePortableCatalogSnapshot`.
 * - Keep `remoteUpdatesEnabled: false` until a real project hosting origin
 *   exists. When enabling, set `trustedOrigin`/`catalogUrl` at the
 *   build/adapter boundary, provide a `fetchPort` backed by the extension
 *   network stack (`redirect: "error"` enforced by the client), a
 *   `storagePort` over extension-local storage, and a WebCrypto SHA-256
 *   `sha256Hex`.
 * - Resolve poll-time locations only via `resolveWatchPollLocation`; a null
 *   result means unsupported/unknown — exclude the watch from polling and
 *   never substitute caller postal input (see
 *   `extractPersistableWatchStores`).
 * - After any catalog change, call `reconcileWatchWithCatalog` per watch
 *   and surface the returned issues in UI; never delete watches, rewrite
 *   items, or convert stock on catalog grounds.
 */
export {
  compareCatalogFreshness,
  extractPersistableWatchStores,
  isAllowedCatalogUrl,
  MAX_CATALOG_BYTES,
  parsePortableCatalogSnapshot,
  PORTABLE_MARKET_CODES,
  reconcileWatchWithCatalog,
  resolveWatchPollLocation,
  SUPPORTED_PORTABLE_CATALOG_SCHEMA_VERSION,
} from "./portableCatalog";
export type {
  CatalogFreshness,
  CatalogValidationIssue,
  PersistableWatchStoresResult,
  PollAnchorWatch,
  PortableCatalogMarket,
  PortableCatalogSnapshot,
  PortableCatalogStore,
  PortableCatalogVariant,
  PortableMarketCode,
  ReconciledWatch,
  TransientStoreLookup,
  WatchCatalogIssue,
} from "./portableCatalog";
export {
  DEFAULT_CATALOG_FETCH_TIMEOUT_MS,
  DEFAULT_CATALOG_REFRESH_CONFIG,
  refreshPortableCatalog,
} from "./catalogRefresh";
export type {
  CatalogFetchPort,
  CatalogFetchResponse,
  CatalogRefreshConfig,
  CatalogRefreshDeps,
  CatalogRefreshResult,
  CatalogStoragePort,
} from "./catalogRefresh";
