/** Runtime ownership of the validated, packaged catalog and transient lookup. */
import {
  LOCAL_STORE_LOOKUP_UNKNOWN_REASONS,
  LocalCatalogStoreSchema,
  parseLocalCatalogSnapshot,
  type LocalCatalogMarket,
  type LocalCatalogSnapshot,
  type LocalCatalogStore,
  type LocalMarketCode,
  type LocalStoreLookupUnknownResult,
  type StoreLookupInput,
} from "../../../../packages/core/src/local-monitor-contracts.js";
import type { ExtensionPlatform } from "../platform/adapters.js";

const CATALOG_ASSET = "portable-catalog.json";
const MAX_CATALOG_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_LOOKUP_RESULTS = 50;
const MAX_DISCOVERED_STORES_PER_MARKET = 500;
const STORE_CACHE_KEY = "inventorySignal.publicStoreCache.v1";
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 5_000;
const MAX_BOOTSTRAP_TIMEOUT_MS = 30_000;
const DEFAULT_LOOKUP_TIMEOUT_MS = 5_000;
const MAX_LOOKUP_TIMEOUT_MS = 15_000;

export interface RuntimeCatalogAssetResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly url: string;
  readonly redirected: boolean;
  readonly headers: { get(name: string): string | null };
  readonly body: ReadableStream<Uint8Array> | null;
}

export type RuntimeCatalogAssetFetch = (
  input: string,
  init: RequestInit,
) => Promise<RuntimeCatalogAssetResponse>;

/**
 * Provider-facing outcome. A source may not add diagnostic text, locations,
 * URLs, or arbitrary status data to this boundary. `matches` means its
 * request completed; the runtime still intersects every returned record with
 * the active canonical market before anything reaches the app.
 */
export type ValidatedStoreLookupPortResult =
  | { readonly kind: "matches"; readonly stores: readonly LocalCatalogStore[] }
  | LocalStoreLookupUnknownResult
  | { readonly kind: "throttled" };

/**
 * App-facing lookup outcome. `unsupported` is derived locally when no
 * qualified catalog coverage or lookup port exists; it is not a provider
 * assertion. Caller location remains transient for every variant.
 */
export type RuntimeStoreLookupResult =
  | { readonly kind: "matches"; readonly stores: readonly LocalCatalogStore[] }
  | { readonly kind: "unsupported" }
  | LocalStoreLookupUnknownResult
  | { readonly kind: "throttled" };

export interface StoreLookupRequestOptions {
  readonly signal: AbortSignal;
}

/**
 * This is deliberately a seam, not an implementation of arbitrary geocoding.
 * A future source must return only independently-qualified public records,
 * honour the request abort signal, and use its finite outcome union.
 */
export interface ValidatedStoreLookupPort {
  lookup(
    input: StoreLookupInput,
    options: StoreLookupRequestOptions,
  ): Promise<ValidatedStoreLookupPortResult>;
}

/**
 * A lookup result can extend catalog coverage only when it was produced by the
 * concrete background provider. Regular injected ports retain the old
 * canonical-intersection behavior and cannot make UI input into catalog data.
 */
const trustedStoreLookup = Symbol("trustedStoreLookup");

interface TrustedStoreLookupPort extends ValidatedStoreLookupPort {
  readonly [trustedStoreLookup]: true;
}

export function bindTrustedStoreLookup(
  lookup: ValidatedStoreLookupPort,
): ValidatedStoreLookupPort {
  return Object.freeze({ ...lookup, [trustedStoreLookup]: true });
}

function isTrustedStoreLookup(
  value: ValidatedStoreLookupPort,
): value is TrustedStoreLookupPort {
  return (
    (value as Partial<TrustedStoreLookupPort>)[trustedStoreLookup] === true
  );
}

export interface LocalRuntimeCatalogOptions {
  readonly platform: Pick<ExtensionPlatform, "storage">;
  readonly assetUrl: string;
  readonly fetch?: RuntimeCatalogAssetFetch;
  readonly storeLookup?: ValidatedStoreLookupPort;
  /** Independent cap for packaged-asset fetch and body reads. */
  readonly bootstrapTimeoutMs?: number;
  /** Independent deadline for a user-initiated transient store lookup. */
  readonly lookupTimeoutMs?: number;
  /** Test seam for observing cancellation without changing global browser APIs. */
  readonly createAbortController?: () => AbortController;
}

function validContentLength(value: string | null): boolean {
  return (
    value === null ||
    (/^\d{1,9}$/.test(value) && Number(value) <= MAX_CATALOG_ASSET_BYTES)
  );
}

function normalizedTimeoutMs(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || value === undefined || value < 1) {
    return DEFAULT_BOOTSTRAP_TIMEOUT_MS;
  }
  return Math.min(value, MAX_BOOTSTRAP_TIMEOUT_MS);
}

function normalizedLookupTimeoutMs(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || value === undefined || value < 1) {
    return DEFAULT_LOOKUP_TIMEOUT_MS;
  }
  return Math.min(value, MAX_LOOKUP_TIMEOUT_MS);
}

function isStoreLookupInput(value: StoreLookupInput): boolean {
  return (
    (value.market === "us" || value.market === "ca" || value.market === "uk") &&
    typeof value.userPostalInput === "string" &&
    value.userPostalInput.trim().length > 0 &&
    value.userPostalInput.trim().length <= 120 &&
    !/[\u0000-\u001f\u007f]/.test(value.userPostalInput)
  );
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPortResult(value: unknown): value is ValidatedStoreLookupPortResult {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "throttled") {
    return hasExactKeys(value, ["kind"]);
  }
  if (value.kind === "unknown") {
    return (
      hasExactKeys(value, ["kind"]) ||
      (hasExactKeys(value, ["kind", "reason"]) &&
        typeof value.reason === "string" &&
        LOCAL_STORE_LOOKUP_UNKNOWN_REASONS.includes(
          value.reason as (typeof LOCAL_STORE_LOOKUP_UNKNOWN_REASONS)[number],
        ))
    );
  }
  return (
    value.kind === "matches" &&
    hasExactKeys(value, ["kind", "stores"]) &&
    Array.isArray(value.stores) &&
    value.stores.length <= MAX_LOOKUP_RESULTS
  );
}

type PublicStoreCache = Readonly<{
  version: 1;
  markets: Readonly<
    Partial<Record<LocalMarketCode, readonly LocalCatalogStore[]>>
  >;
}>;

function emptyPublicStoreCache(): PublicStoreCache {
  return { version: 1, markets: {} };
}

function parsePublicStoreCache(value: unknown): PublicStoreCache | null {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "markets"])) {
    return null;
  }
  if (value.version !== 1 || !isRecord(value.markets)) return null;
  const markets: Partial<
    Record<LocalMarketCode, readonly LocalCatalogStore[]>
  > = {};
  for (const [market, entries] of Object.entries(value.markets)) {
    if (market !== "us" && market !== "ca" && market !== "uk") return null;
    if (
      !Array.isArray(entries) ||
      entries.length > MAX_DISCOVERED_STORES_PER_MARKET
    ) {
      return null;
    }
    const stores: LocalCatalogStore[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const parsed = LocalCatalogStoreSchema.safeParse(entry);
      if (!parsed.success || seen.has(parsed.data.storeNumber)) return null;
      seen.add(parsed.data.storeNumber);
      stores.push(parsed.data);
    }
    markets[market] = stores;
  }
  return { version: 1, markets };
}

function mergedMarket(
  market: LocalCatalogMarket,
  cached: readonly LocalCatalogStore[],
): LocalCatalogMarket | null {
  const byStoreNumber = new Map(
    market.stores.map((store) => [store.storeNumber, store]),
  );
  for (const store of cached) {
    const existing = byStoreNumber.get(store.storeNumber);
    // A cache record may never overwrite a bundled record. Treat a mismatch
    // as corruption rather than silently changing a watch's poll location.
    if (existing && JSON.stringify(existing) !== JSON.stringify(store))
      return null;
    if (!existing) byStoreNumber.set(store.storeNumber, store);
  }
  if (byStoreNumber.size > MAX_DISCOVERED_STORES_PER_MARKET) return null;
  return { ...market, stores: [...byStoreNumber.values()] };
}

function mergeCachedStores(
  catalog: LocalCatalogSnapshot,
  cache: PublicStoreCache,
): LocalCatalogSnapshot | null {
  const markets: LocalCatalogMarket[] = [];
  for (const market of catalog.markets) {
    const merged = mergedMarket(market, cache.markets[market.code] ?? []);
    if (!merged) return null;
    markets.push(merged);
  }
  const parsed = parseLocalCatalogSnapshot({ ...catalog, markets });
  return parsed.success ? parsed.data : null;
}

function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  void reader.cancel("catalog bootstrap cancelled").catch(() => undefined);
  try {
    reader.releaseLock();
  } catch {
    // A settled or cancelled stream may have already released its lock.
  }
}

function waitForAbort(signal: AbortSignal): Promise<null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(null), { once: true });
  });
}

async function withTimeout<T>(
  operation: Promise<T>,
  controller: AbortController,
  timeoutMs: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      operation.catch(() => null),
      timedOut,
      waitForAbort(controller.signal),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function readBoundedJson(
  stream: ReadableStream<Uint8Array> | null,
  controller: AbortController,
  timeoutMs: number,
): Promise<unknown | null> {
  if (!stream || controller.signal.aborted) return null;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  // Reuse this one promise for the entire stream. Creating a new listener for
  // every chunk would retain an unbounded number of abort callbacks for a
  // valid-but-tiny-chunk catalog.
  const aborted = waitForAbort(controller.signal);
  try {
    while (true) {
      // One deadline covers the complete body, not each individual chunk. A
      // hostile stream that dribbles bytes forever cannot keep bootstrap open.
      const result = await Promise.race([
        reader.read().catch(() => null),
        aborted,
      ]);
      if (result === null) {
        releaseReader(reader);
        return null;
      }
      const { done, value } = result;
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        releaseReader(reader);
        return null;
      }
      total += value.byteLength;
      if (total > MAX_CATALOG_ASSET_BYTES) {
        releaseReader(reader);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    try {
      reader.releaseLock();
    } catch {
      // Cancellation can have already released the reader.
    }
  }
  if (controller.signal.aborted) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

/**
 * Holds only a validated catalog snapshot. It never writes user location to
 * storage. The platform storage parameter remains intentional: it reserves a
 * narrow, reviewed place for L06 last-known-good refresh once a public project
 * origin and signed catalog release exist; remote refresh is disabled here.
 */
export class LocalRuntimeCatalog {
  private catalog: LocalCatalogSnapshot | null = null;
  private publicStoreCache: PublicStoreCache = emptyPublicStoreCache();
  private storeMergeTail: Promise<void> = Promise.resolve();

  public constructor(private readonly options: LocalRuntimeCatalogOptions) {}

  public getCatalog(): LocalCatalogSnapshot | null {
    return this.catalog === null ? null : structuredClone(this.catalog);
  }

  public async loadBundled(): Promise<LocalCatalogSnapshot | null> {
    const fetchAsset =
      this.options.fetch ?? (globalThis.fetch as RuntimeCatalogAssetFetch);
    const controller =
      this.options.createAbortController?.() ?? new AbortController();
    const timeoutMs = normalizedTimeoutMs(this.options.bootstrapTimeoutMs);
    try {
      const response = await withTimeout(
        fetchAsset(this.options.assetUrl, {
          method: "GET",
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
        }),
        controller,
        timeoutMs,
      );
      if (
        response === null ||
        !response.ok ||
        response.redirected ||
        response.url !== this.options.assetUrl ||
        !validContentLength(response.headers.get("content-length"))
      ) {
        this.catalog = null;
        return null;
      }
      const parsed = parseLocalCatalogSnapshot(
        await readBoundedJson(response.body, controller, timeoutMs),
      );
      if (!parsed.success) {
        this.catalog = null;
        return null;
      }
      let cached: PublicStoreCache | null = null;
      try {
        const cacheController = (
          this.options.createAbortController ?? (() => new AbortController())
        )();
        cached = parsePublicStoreCache(
          await withTimeout(
            this.options.platform.storage.read<unknown>(STORE_CACHE_KEY),
            cacheController,
            timeoutMs,
          ),
        );
      } catch {
        // A cache read failure must not discard the separately validated
        // bundled catalog. Discovery still requires a later successful write.
      }
      this.publicStoreCache = cached ?? emptyPublicStoreCache();
      const merged = mergeCachedStores(parsed.data, this.publicStoreCache);
      if (merged === null) {
        // Keep the safe bundled catalog but do not carry a conflicting cache
        // into later commits. Do not delete persistent state or any watches.
        this.publicStoreCache = emptyPublicStoreCache();
        this.catalog = parsed.data;
      } else {
        this.catalog = merged;
      }
      return this.getCatalog();
    } catch {
      this.catalog = null;
      return null;
    }
  }

  /**
   * Only the branded concrete provider may add validated Apple store records.
   * Any regular injected port remains restricted to existing catalog records.
   */
  public async lookupStores(
    input: StoreLookupInput,
  ): Promise<RuntimeStoreLookupResult> {
    const catalog = this.catalog;
    const lookup = this.options.storeLookup;
    if (!isStoreLookupInput(input)) {
      return { kind: "unknown", reason: "invalid_postal_code" };
    }
    if (!catalog || !lookup) return { kind: "unsupported" };
    const market = catalog.markets.find((entry) => entry.code === input.market);
    if (
      !market ||
      (!isTrustedStoreLookup(lookup) && market.stores.length === 0)
    ) {
      return { kind: "unsupported" };
    }
    const controller = (
      this.options.createAbortController ?? (() => new AbortController())
    )();
    const lookupTimeoutMs = normalizedLookupTimeoutMs(
      this.options.lookupTimeoutMs,
    );
    const deadline = Date.now() + lookupTimeoutMs;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timeoutResult = new Promise<null>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, lookupTimeoutMs);
    });
    try {
      const candidate = await Promise.race([
        lookup
          .lookup(
            Object.freeze({
              market: input.market,
              userPostalInput: input.userPostalInput.trim(),
            }),
            { signal: controller.signal },
          )
          .catch(() => ({ kind: "unknown", reason: "network_error" })),
        timeoutResult,
      ]);
      // An abort listener in a provider can synchronously settle its promise
      // before the timeout promise wins this race. The deadline remains the
      // authority: an aborted request can never become a successful empty
      // match merely because its cancellation callback ran first.
      if (controller.signal.aborted)
        return { kind: "unknown", reason: "timeout" };
      if (!isPortResult(candidate))
        return { kind: "unknown", reason: "invalid_response" };
      if (candidate.kind === "unknown" || candidate.kind === "throttled") {
        return candidate;
      }
      const seen = new Set<string>();
      const accepted: LocalCatalogStore[] = [];
      for (const value of candidate.stores) {
        const parsed = LocalCatalogStoreSchema.safeParse(value);
        if (!parsed.success || seen.has(parsed.data.storeNumber)) {
          return { kind: "unknown", reason: "invalid_response" };
        }
        const canonical = market.stores.find(
          (store) => store.storeNumber === parsed.data.storeNumber,
        );
        if (!isTrustedStoreLookup(lookup) && !canonical) {
          return { kind: "unknown", reason: "invalid_response" };
        }
        seen.add(parsed.data.storeNumber);
        // Existing bundled/cache records are authoritative for display and
        // poll routing. Apple may vary public names/city spellings; a fresh
        // discovery must not overwrite a selected store's known route.
        accepted.push(canonical ?? parsed.data);
      }
      if (!isTrustedStoreLookup(lookup)) {
        return { kind: "matches", stores: accepted };
      }
      const committed = await Promise.race([
        this.commitDiscoveredStores(
          input.market,
          accepted,
          controller,
          deadline,
        ),
        timeoutResult,
      ]);
      return (
        committed ?? {
          kind: "unknown",
          reason: controller.signal.aborted ? "timeout" : "invalid_response",
        }
      );
    } catch {
      return {
        kind: "unknown",
        reason: controller.signal.aborted ? "timeout" : "invalid_response",
      };
    } finally {
      if (timeout !== null) clearTimeout(timeout);
      // A provider that ignores the timeout race must still receive prompt
      // best-effort cancellation after any terminal local result.
      if (!controller.signal.aborted) controller.abort();
    }
  }

  public storeLookupAvailable(): boolean {
    return (
      this.options.storeLookup !== undefined &&
      (isTrustedStoreLookup(this.options.storeLookup) ||
        this.catalog?.markets.some((market) => market.stores.length > 0) ===
          true)
    );
  }

  private async commitDiscoveredStores(
    marketCode: LocalMarketCode,
    stores: readonly LocalCatalogStore[],
    controller: AbortController,
    deadline: number,
  ): Promise<RuntimeStoreLookupResult> {
    const previousPhysicalWrite = this.storeMergeTail;
    let releasePhysicalWrite: () => void;
    const currentPhysicalWrite = new Promise<void>((resolve) => {
      releasePhysicalWrite = resolve;
    });
    // Advance this gate synchronously. A later lookup therefore queues behind
    // the actual storage operation even if this caller's UI deadline returns
    // `unknown` before that operation settles.
    this.storeMergeTail = previousPhysicalWrite.then(
      () => currentPhysicalWrite,
      () => currentPhysicalWrite,
    );
    let writeStarted = false;
    const scheduled = previousPhysicalWrite.then(async () => {
      const remaining = deadline - Date.now();
      if (controller.signal.aborted || remaining < 1) {
        if (!controller.signal.aborted) controller.abort();
        releasePhysicalWrite!();
        return { kind: "unknown", reason: "timeout" } as const;
      }
      const catalog = this.catalog;
      if (!catalog) {
        releasePhysicalWrite!();
        return { kind: "unknown", reason: "invalid_response" } as const;
      }
      const market = catalog.markets.find((entry) => entry.code === marketCode);
      if (!market) {
        releasePhysicalWrite!();
        return { kind: "unknown", reason: "invalid_response" } as const;
      }
      const existing = this.publicStoreCache.markets[marketCode] ?? [];
      const byStoreNumber = new Map(
        existing.map((store) => [store.storeNumber, store]),
      );
      for (const store of stores) {
        const bundled = market.stores.find(
          (candidate) => candidate.storeNumber === store.storeNumber,
        );
        if (bundled) {
          continue;
        }
        const prior = byStoreNumber.get(store.storeNumber);
        // Cache records are likewise authoritative once committed. Ignore
        // provider display churn instead of replacing a stored poll location.
        if (!prior) byStoreNumber.set(store.storeNumber, store);
      }
      if (byStoreNumber.size > MAX_DISCOVERED_STORES_PER_MARKET) {
        releasePhysicalWrite!();
        return { kind: "unknown", reason: "invalid_response" } as const;
      }
      const cache: PublicStoreCache = {
        version: 1,
        markets: {
          ...this.publicStoreCache.markets,
          [marketCode]: [...byStoreNumber.values()],
        },
      };
      const merged = mergeCachedStores(catalog, cache);
      if (!merged) {
        releasePhysicalWrite!();
        return { kind: "unknown", reason: "invalid_response" } as const;
      }
      let write: Promise<void> | null = null;
      try {
        write = Promise.resolve(
          this.options.platform.storage.write(STORE_CACHE_KEY, cache),
        );
        writeStarted = true;
        const persisted = await withTimeout(write, controller, remaining);
        if (persisted === null || controller.signal.aborted) {
          // The UI deadline may have elapsed while the physical storage write
          // is still pending. Keep the queue closed until that old write has
          // actually settled, preventing it from overwriting a later commit.
          void write.then(releasePhysicalWrite!, releasePhysicalWrite!);
          return {
            kind: "unknown",
            reason: controller.signal.aborted ? "timeout" : "storage_error",
          } as const;
        }
      } catch {
        if (!writeStarted) {
          // `storage.write` can throw synchronously; no raw write exists to
          // release the gate later in that case.
          releasePhysicalWrite!();
        } else if (write) {
          void write.then(releasePhysicalWrite!, releasePhysicalWrite!);
        }
        return { kind: "unknown", reason: "storage_error" } as const;
      }
      // Publish state before releasing the physical-write gate. A queued
      // merge must see this cache/catalog pair together, never storage's
      // settled value before this in-memory transaction is visible.
      this.publicStoreCache = cache;
      this.catalog = merged;
      releasePhysicalWrite!();
      return { kind: "matches", stores: [...stores] } as const;
    });
    return scheduled.catch(() => {
      if (!writeStarted) releasePhysicalWrite!();
      return { kind: "unknown", reason: "storage_error" };
    });
  }
}

export function createBundledRuntimeCatalog(
  platform: Pick<ExtensionPlatform, "storage">,
  getAssetUrl: (path: string) => string,
  storeLookup?: ValidatedStoreLookupPort,
): LocalRuntimeCatalog {
  return new LocalRuntimeCatalog({
    platform,
    assetUrl: getAssetUrl(CATALOG_ASSET),
    storeLookup,
  });
}
