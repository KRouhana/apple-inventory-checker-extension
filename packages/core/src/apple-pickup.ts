import type { AvailabilityStatus } from "./availability.js";
import type { ProductIdentityValidator } from "./catalog.js";
import { MAX_PARTS_PER_REQUEST } from "./apple-url.js";

export type ApplePickupParseErrorCode =
  | "upstream_http_error"
  | "upstream_payload_error"
  | "invalid_json"
  | "invalid_shape"
  | "sku_set_mismatch"
  | "identity_validation_failed";

export interface ApplePickupParseError {
  code: ApplePickupParseErrorCode;
  message: string;
  path?: string;
  httpStatus?: number;
}

export interface AppleStoreIdentity {
  storeNumber: string;
  storeName: string;
  city: string | null;
  state: string | null;
  country: string | null;
  distance: number | null;
  distanceWithUnit: string | null;
}

export interface ApplePickupObservation {
  store: AppleStoreIdentity;
  sku: string;
  title: string;
  status: AvailabilityStatus;
  pickupDisplay: string;
  pickupQuote: string | null;
  storePickEligible: boolean;
  isBuyable: boolean | null;
  inventory: number | null;
}

export interface ApplePickupParseSuccess {
  ok: true;
  observations: readonly ApplePickupObservation[];
  storeCount: number;
}

export interface ApplePickupParseFailure {
  ok: false;
  error: ApplePickupParseError;
}

export type ApplePickupParseResult =
  | ApplePickupParseSuccess
  | ApplePickupParseFailure;

export interface ParseApplePickupOptions {
  body: unknown;
  httpStatus?: number;
  /** The exact SKUs sent in this upstream request. */
  expectedSkus: readonly string[];
  validateProductIdentity?: ProductIdentityValidator;
}

type UnknownRecord = Record<string, unknown>;

function failure(
  code: ApplePickupParseErrorCode,
  message: string,
  extras: Pick<ApplePickupParseError, "path" | "httpStatus"> = {},
): ApplePickupParseFailure {
  return { ok: false, error: { code, message, ...extras } };
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredRecord(
  parent: UnknownRecord,
  key: string,
  path: string,
): UnknownRecord | ApplePickupParseFailure {
  const value = parent[key];
  return isRecord(value)
    ? value
    : failure("invalid_shape", `${path} must be an object`, { path });
}

function requiredString(
  parent: UnknownRecord,
  key: string,
  path: string,
): string | ApplePickupParseFailure {
  const value = parent[key];
  return typeof value === "string" && value.length > 0
    ? value
    : failure("invalid_shape", `${path} must be a non-empty string`, { path });
}

/**
 * Apple occasionally renders otherwise-identical product titles with a
 * non-breaking space. Product identity remains literal after this deliberately
 * narrow typography normalization; no other whitespace or title characters
 * are altered.
 */
function normalizeProductTitleTypography(value: string): string {
  return value.replace(/[\u00a0\u202f]/g, " ");
}

function requiredStringFromAliases(
  parent: UnknownRecord,
  keys: readonly string[],
  path: string,
): string | ApplePickupParseFailure {
  for (const key of keys) {
    const value = parent[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return failure("invalid_shape", `${path} must contain a non-empty string`, {
    path,
  });
}

function optionalString(
  value: unknown,
  path: string,
): string | null | ApplePickupParseFailure {
  if (value === undefined || value === null) return null;
  return typeof value === "string"
    ? value
    : failure("invalid_shape", `${path} must be a string when present`, {
        path,
      });
}

function optionalNumber(
  value: unknown,
  path: string,
): number | null | ApplePickupParseFailure {
  if (value === undefined || value === null) return null;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : failure("invalid_shape", `${path} must be a finite number when present`, {
        path,
      });
}

function isFailure<T>(
  value: T | ApplePickupParseFailure,
): value is ApplePickupParseFailure {
  return isRecord(value) && value.ok === false;
}

function availabilityStatus(
  pickupDisplay: string,
  storePickEligible: boolean,
  isBuyable: boolean | null,
): AvailabilityStatus {
  if (pickupDisplay === "ineligible") {
    return isBuyable === true ? "unknown" : "ineligible";
  }
  if (!storePickEligible) {
    return pickupDisplay === "available" || isBuyable === true
      ? "unknown"
      : "ineligible";
  }
  if (pickupDisplay === "available") {
    return isBuyable === false ? "unknown" : "available";
  }
  if (pickupDisplay === "unavailable") {
    return isBuyable === true ? "unknown" : "unavailable";
  }
  return "unknown";
}

function parseBody(body: unknown): UnknownRecord | ApplePickupParseFailure {
  if (typeof body !== "string") {
    return isRecord(body)
      ? body
      : failure("invalid_shape", "Apple response body must be a JSON object");
  }

  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed)
      ? parsed
      : failure(
          "invalid_shape",
          "Apple response JSON must contain an object at its root",
        );
  } catch {
    return failure("invalid_json", "Apple response body was not valid JSON");
  }
}

function validateExpectedSkus(
  expectedSkus: readonly string[],
): string[] | ApplePickupParseFailure {
  if (expectedSkus.length < 1 || expectedSkus.length > MAX_PARTS_PER_REQUEST) {
    return failure(
      "sku_set_mismatch",
      `Expected SKU list must contain between 1 and ${MAX_PARTS_PER_REQUEST} items`,
    );
  }
  const unique = new Set<string>();
  for (const sku of expectedSkus) {
    if (sku.length === 0 || sku.trim() !== sku) {
      return failure(
        "sku_set_mismatch",
        "Expected SKUs must be non-empty and unpadded",
      );
    }
    if (unique.has(sku)) {
      return failure(
        "sku_set_mismatch",
        `Expected SKU list contains duplicate ${sku}`,
      );
    }
    unique.add(sku);
  }
  return [...unique];
}

/**
 * Strictly parses Apple's `/shop/retail/pickup-message` response.
 *
 * A parse failure is intentionally separate from an unavailable observation;
 * callers must translate every failure into an `unknown` poll result.
 */
export function parseApplePickupMessage(
  options: ParseApplePickupOptions,
): ApplePickupParseResult {
  if (
    options.httpStatus !== undefined &&
    (!Number.isInteger(options.httpStatus) ||
      options.httpStatus < 200 ||
      options.httpStatus >= 300)
  ) {
    return failure(
      "upstream_http_error",
      `Apple pickup endpoint returned HTTP ${options.httpStatus}`,
      { httpStatus: options.httpStatus },
    );
  }

  const root = parseBody(options.body);
  if (isFailure(root)) return root;

  const head = root.head;
  if (head !== undefined) {
    if (!isRecord(head) || (head.status !== "200" && head.status !== 200)) {
      return failure(
        "upstream_payload_error",
        "Apple payload head.status was not 200",
        {
          path: "head.status",
        },
      );
    }
  }

  const body = requiredRecord(root, "body", "body");
  if (isFailure(body)) return body;

  let storesValue: readonly unknown[];
  let storesPath = "body.content.pickupMessage.stores";
  const content = body.content;
  if (
    isRecord(content) &&
    isRecord(content.pickupMessage) &&
    Array.isArray(content.pickupMessage.stores)
  ) {
    storesValue = content.pickupMessage.stores;
  } else if (Array.isArray(body.stores)) {
    storesValue = body.stores;
    storesPath = "body.stores";
  } else {
    return failure(
      "invalid_shape",
      "Apple response body must contain a stores array at body.content.pickupMessage.stores or body.stores",
      {
        path: storesPath,
      },
    );
  }

  const expectedSkusResult = validateExpectedSkus(options.expectedSkus);
  if (isFailure(expectedSkusResult)) return expectedSkusResult;
  const expectedSkus = expectedSkusResult;
  const expectedSkuSet = new Set(expectedSkus);
  const observations: ApplePickupObservation[] = [];

  for (const [storeIndex, storeValue] of storesValue.entries()) {
    const storePath = `${storesPath}[${storeIndex}]`;
    if (!isRecord(storeValue)) {
      return failure("invalid_shape", `${storePath} must be an object`, {
        path: storePath,
      });
    }

    const storeNumber = requiredStringFromAliases(
      storeValue,
      ["storeNumber", "storeUniqueId"],
      `${storePath}.storeNumber|storeUniqueId`,
    );
    if (isFailure(storeNumber)) return storeNumber;
    const storeName = requiredStringFromAliases(
      storeValue,
      ["storeName", "name"],
      `${storePath}.storeName|name`,
    );
    if (isFailure(storeName)) return storeName;
    const address = isRecord(storeValue.address) ? storeValue.address : null;
    const retailStore = isRecord(storeValue.retailStore)
      ? storeValue.retailStore
      : null;
    const retailAddress = isRecord(retailStore?.address)
      ? retailStore.address
      : null;
    const city = optionalString(
      storeValue.city ?? address?.city ?? retailAddress?.city,
      `${storePath}.city`,
    );
    if (isFailure(city)) return city;
    const state = optionalString(
      storeValue.state ?? address?.state ?? retailAddress?.state,
      `${storePath}.state`,
    );
    if (isFailure(state)) return state;
    const country = optionalString(
      storeValue.country ?? address?.countryCode ?? retailAddress?.countryCode,
      `${storePath}.country`,
    );
    if (isFailure(country)) return country;
    const distance = optionalNumber(
      storeValue.storedistance,
      `${storePath}.storedistance`,
    );
    if (isFailure(distance)) return distance;
    const distanceWithUnit = optionalString(
      storeValue.storeDistanceWithUnit,
      `${storePath}.storeDistanceWithUnit`,
    );
    if (isFailure(distanceWithUnit)) return distanceWithUnit;

    const parts = requiredRecord(
      storeValue,
      "partsAvailability",
      `${storePath}.partsAvailability`,
    );
    if (isFailure(parts)) return parts;
    const responseSkus = Object.keys(parts);
    if (expectedSkus.length > 0) {
      const missing = expectedSkus.filter((sku) => !Object.hasOwn(parts, sku));
      const unexpected = responseSkus.filter((sku) => !expectedSkuSet.has(sku));
      if (missing.length > 0 || unexpected.length > 0) {
        return failure(
          "sku_set_mismatch",
          `Store ${storeNumber} SKU set mismatch (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"})`,
          { path: `${storePath}.partsAvailability` },
        );
      }
    }

    for (const [responseSku, partValue] of Object.entries(parts)) {
      const partPath = `${storePath}.partsAvailability[${JSON.stringify(responseSku)}]`;
      if (!isRecord(partValue)) {
        return failure("invalid_shape", `${partPath} must be an object`, {
          path: partPath,
        });
      }

      const partNumber = requiredString(
        partValue,
        "partNumber",
        `${partPath}.partNumber`,
      );
      if (isFailure(partNumber)) return partNumber;
      if (partNumber !== responseSku) {
        return failure(
          "sku_set_mismatch",
          `Part key ${responseSku} does not match partNumber ${partNumber}`,
          { path: `${partPath}.partNumber` },
        );
      }
      const storePickEligible = partValue.storePickEligible;
      if (storePickEligible !== true && storePickEligible !== false) {
        return failure(
          "invalid_shape",
          `${partPath}.storePickEligible must be a boolean`,
          { path: `${partPath}.storePickEligible` },
        );
      }
      const pickupDisplay = requiredString(
        partValue,
        "pickupDisplay",
        `${partPath}.pickupDisplay`,
      );
      if (isFailure(pickupDisplay)) return pickupDisplay;

      const messageTypes = requiredRecord(
        partValue,
        "messageTypes",
        `${partPath}.messageTypes`,
      );
      if (isFailure(messageTypes)) return messageTypes;
      const regular = requiredRecord(
        messageTypes,
        "regular",
        `${partPath}.messageTypes.regular`,
      );
      if (isFailure(regular)) return regular;
      const rawTitle = requiredString(
        regular,
        "storePickupProductTitle",
        `${partPath}.messageTypes.regular.storePickupProductTitle`,
      );
      if (isFailure(rawTitle)) return rawTitle;
      const title = normalizeProductTitleTypography(rawTitle);

      const pickupQuote = optionalString(
        partValue.pickupSearchQuote,
        `${partPath}.pickupSearchQuote`,
      );
      if (isFailure(pickupQuote)) return pickupQuote;

      let isBuyable: boolean | null = null;
      let inventory: number | null = null;
      if (partValue.buyability !== undefined && partValue.buyability !== null) {
        if (!isRecord(partValue.buyability)) {
          return failure(
            "invalid_shape",
            `${partPath}.buyability must be an object`,
            {
              path: `${partPath}.buyability`,
            },
          );
        }
        const candidate = partValue.buyability.isBuyable;
        if (candidate !== true && candidate !== false) {
          return failure(
            "invalid_shape",
            `${partPath}.buyability.isBuyable must be a boolean`,
            { path: `${partPath}.buyability.isBuyable` },
          );
        }
        isBuyable = candidate;
        const inventoryResult = optionalNumber(
          partValue.buyability.inventory,
          `${partPath}.buyability.inventory`,
        );
        if (isFailure(inventoryResult)) return inventoryResult;
        inventory = inventoryResult;
      }

      const validation = options.validateProductIdentity?.({
        requestedSku: responseSku,
        responseSku: partNumber,
        title,
        storeNumber,
      });
      if (validation && !validation.valid) {
        return failure("identity_validation_failed", validation.reason, {
          path: partPath,
        });
      }

      observations.push({
        store: {
          storeNumber,
          storeName,
          city,
          state,
          country,
          distance,
          distanceWithUnit,
        },
        sku: partNumber,
        title,
        status: availabilityStatus(pickupDisplay, storePickEligible, isBuyable),
        pickupDisplay,
        pickupQuote,
        storePickEligible,
        isBuyable,
        inventory,
      });
    }
  }

  return { ok: true, observations, storeCount: storesValue.length };
}
