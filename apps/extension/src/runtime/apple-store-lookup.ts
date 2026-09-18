/**
 * One-request Apple public-store discovery for the local monitor.
 *
 * This parser is intentionally limited to the documented historical pickup
 * record shape: `address.postalCode` or `retailStore.address.postalCode`, and
 * the corresponding documented country/city/state fields. Current live
 * qualification remains separate; an HTTP 541 or every malformed response is
 * `unknown`, never an empty nearby-store result.
 * Historical schema reference: https://pkg.go.dev/github.com/xuzhenglun/apple-store-exporter/pkg/models
 */
import { parseApplePickupMessage } from "../../../../packages/core/src/apple-pickup.js";
import type {
  AppleFetchPort,
  LocalCatalogSnapshot,
  LocalCatalogStore,
  LocalMarketCode,
  StoreLookupInput,
} from "../../../../packages/core/src/local-monitor-contracts.js";
import {
  bindTrustedStoreLookup,
  type ValidatedStoreLookupPort,
} from "./catalog.js";

const DISCOVERY_ANCHOR_STORE_NUMBER = "store-discovery";
const MAX_DISCOVERED_STORES_PER_RESPONSE = 50;

type UnknownRecord = Record<string, unknown>;

export interface AppleStoreLookupOptions {
  readonly fetch: AppleFetchPort;
  readonly getCatalog: () => LocalCatalogSnapshot | null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 &&
    normalized.length <= maximum &&
    !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : null;
}

function expectedCountry(market: LocalMarketCode): "US" | "CA" | "GB" {
  return market === "us" ? "US" : market === "ca" ? "CA" : "GB";
}

function normalizePostal(
  market: LocalMarketCode,
  value: unknown,
): string | null {
  const source = normalizeText(value, 16)?.toUpperCase() ?? null;
  if (!source) return null;
  if (market === "us") {
    return /^\d{5}(?:-\d{4})?$/.test(source) ? source : null;
  }
  if (market === "ca") {
    const compact = source.replace(/[ -]/g, "");
    return /^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(compact)
      ? `${compact.slice(0, 3)} ${compact.slice(3)}`
      : null;
  }
  const compact = source.replace(/\s/g, "");
  return /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(compact)
    ? `${compact.slice(0, -3)} ${compact.slice(-3)}`
    : null;
}

function pickupStores(body: unknown): readonly UnknownRecord[] | null {
  if (!isRecord(body) || !isRecord(body.body)) return null;
  const content = body.body.content;
  const nested =
    isRecord(content) && isRecord(content.pickupMessage)
      ? content.pickupMessage.stores
      : undefined;
  const stores = Array.isArray(nested) ? nested : body.body.stores;
  if (
    !Array.isArray(stores) ||
    stores.length > MAX_DISCOVERED_STORES_PER_RESPONSE
  ) {
    return null;
  }
  const records: UnknownRecord[] = [];
  for (const store of stores) {
    if (!isRecord(store)) return null;
    records.push(store);
  }
  return records;
}

function rawStoreNumber(store: UnknownRecord): string | null {
  const direct = normalizeText(store.storeNumber, 16);
  const legacy = normalizeText(store.storeUniqueId, 16);
  if (direct && legacy && direct !== legacy) return null;
  const value = direct ?? legacy;
  return value && /^R\d{3,6}$/.test(value) ? value : null;
}

function normalizedCountries(store: UnknownRecord): readonly string[] | null {
  const address = isRecord(store.address) ? store.address : null;
  const retailAddress =
    isRecord(store.retailStore) && isRecord(store.retailStore.address)
      ? store.retailStore.address
      : null;
  const values = [
    store.country,
    address?.countryCode,
    retailAddress?.countryCode,
  ]
    .filter((value) => value !== undefined)
    .map((value) => normalizeText(value, 3)?.toUpperCase() ?? null);
  return values.every((value) => value !== null) ? (values as string[]) : null;
}

function providerPostal(
  market: LocalMarketCode,
  store: UnknownRecord,
): string | null {
  const address = isRecord(store.address) ? store.address : null;
  const retailAddress =
    isRecord(store.retailStore) && isRecord(store.retailStore.address)
      ? store.retailStore.address
      : null;
  const hasDirect = address !== null && Object.hasOwn(address, "postalCode");
  const hasRetail =
    retailAddress !== null && Object.hasOwn(retailAddress, "postalCode");
  const direct = hasDirect
    ? normalizePostal(market, address!.postalCode)
    : null;
  const retail = hasRetail
    ? normalizePostal(market, retailAddress!.postalCode)
    : null;
  if ((hasDirect && !direct) || (hasRetail && !retail)) return null;
  if (!direct && !retail) return null;
  return direct && retail && direct !== retail ? null : (direct ?? retail);
}

function currentDiscoveryVariant(
  catalog: LocalCatalogSnapshot,
  market: LocalMarketCode,
) {
  const entry = catalog.markets.find((candidate) => candidate.code === market);
  if (!entry) return null;
  return (
    entry.variants.find((variant) => variant.familySlug === "iphone-17") ??
    entry.variants[0] ??
    null
  );
}

function discoverStores(
  market: LocalMarketCode,
  body: unknown,
  observations: readonly {
    readonly store: {
      readonly storeNumber: string;
      readonly storeName: string;
      readonly city: string | null;
      readonly state: string | null;
      readonly country: string | null;
    };
  }[],
): readonly LocalCatalogStore[] | null {
  const raw = pickupStores(body);
  if (!raw || raw.length !== observations.length) return null;
  const records = new Map<string, UnknownRecord>();
  for (const store of raw) {
    const id = rawStoreNumber(store);
    if (!id || records.has(id)) return null;
    records.set(id, store);
  }
  const expected = expectedCountry(market);
  const stores: LocalCatalogStore[] = [];
  const seen = new Set<string>();
  for (const observation of observations) {
    const rawStore = records.get(observation.store.storeNumber);
    if (!rawStore || seen.has(observation.store.storeNumber)) return null;
    seen.add(observation.store.storeNumber);
    const observationCountry = normalizeText(
      observation.store.country,
      3,
    )?.toUpperCase();
    const countries = normalizedCountries(rawStore);
    if (
      observationCountry !== expected ||
      countries === null ||
      countries.length === 0 ||
      countries.some((country) => country !== expected)
    ) {
      return null;
    }
    const pollLocation = providerPostal(market, rawStore);
    if (!pollLocation) return null;
    const parsed = {
      storeNumber: observation.store.storeNumber,
      name: observation.store.storeName,
      city: observation.store.city,
      region: observation.store.state,
      pollLocation,
    } satisfies LocalCatalogStore;
    stores.push(parsed);
  }
  return stores;
}

/**
 * The returned port is branded by the runtime catalog; only this concrete
 * provider can add records to the local public-store cache. Its request uses
 * one current catalog SKU and one transient user postal input, never an
 * arbitrary URL, host, credential, or retained personal location.
 */
export function createAppleStoreLookupProvider(
  options: AppleStoreLookupOptions,
): ValidatedStoreLookupPort {
  return bindTrustedStoreLookup({
    async lookup(input: StoreLookupInput, requestOptions) {
      const catalog = options.getCatalog();
      if (!catalog || requestOptions.signal.aborted) return { kind: "unknown" };
      const location = normalizePostal(input.market, input.userPostalInput);
      if (!location) return { kind: "unknown", reason: "invalid_postal_code" };
      const variant = currentDiscoveryVariant(catalog, input.market);
      if (!variant) return { kind: "unknown", reason: "invalid_response" };
      let response;
      try {
        response = await options.fetch.fetchPickup(
          {
            market: input.market,
            // This field is required by the shared fetch contract but is not
            // sent to Apple. Discovery has no selected anchor store yet.
            anchorStoreNumber: DISCOVERY_ANCHOR_STORE_NUMBER,
            location,
            skus: [variant.sku],
          },
          { signal: requestOptions.signal },
        );
      } catch {
        return requestOptions.signal.aborted
          ? { kind: "unknown" }
          : { kind: "unknown", reason: "network_error" };
      }
      if (requestOptions.signal.aborted) return { kind: "unknown" };
      if (response.httpStatus === 429) return { kind: "throttled" };
      if (response.httpStatus === 403 || response.httpStatus === 541) {
        return { kind: "unknown", reason: "apple_blocked" };
      }
      if (response.httpStatus === 599) {
        return { kind: "unknown", reason: "network_error" };
      }
      const parsed = parseApplePickupMessage({
        body: response.body,
        httpStatus: response.httpStatus,
        expectedSkus: [variant.sku],
        validateProductIdentity: ({ requestedSku, responseSku, title }) =>
          requestedSku === variant.sku &&
          responseSku === variant.sku &&
          title === variant.title
            ? { valid: true }
            : { valid: false, reason: "catalog_identity_mismatch" },
      });
      if (!parsed.ok) return { kind: "unknown", reason: "invalid_response" };
      const stores = discoverStores(
        input.market,
        response.body,
        parsed.observations,
      );
      return stores
        ? { kind: "matches", stores }
        : { kind: "unknown", reason: "invalid_response" };
    },
  });
}
