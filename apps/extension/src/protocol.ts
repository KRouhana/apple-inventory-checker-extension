import { parseAppleSelectedDevicePath } from "../../../packages/core/src/apple-selected-device-path.js";

export const CHECKOUT_PROTOCOL = "inventory-signal.checkout.v1";
export const CHECKOUT_STORAGE_KEY = "armedCheckoutMandate";

export interface CheckoutMandate {
  protocol: typeof CHECKOUT_PROTOCOL;
  type: "ARM_CHECKOUT";
  id: string;
  createdAt: string;
  expiresAt: string;
  marketCode: "us" | "ca" | "uk";
  sku: string;
  variantTitle: string;
  purchaseUrl: string;
  store: {
    id: string;
    appleStoreNumber: string;
    name: string;
  };
}

export const CHECKOUT_MARKETS = ["us", "ca", "uk"] as const;
export type CheckoutMarket = (typeof CHECKOUT_MARKETS)[number];

export type CatalogPurchaseVariant = {
  sku: string;
  buyPath?: string;
};

const SKU_PATTERN = /^[A-Z0-9]+\/[A-Z]$/;
const STORE_NUMBER_PATTERN = /^[A-Za-z0-9-]{1,16}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_MANDATE_LIFETIME_MS = 10 * 60_000;
const MAX_CREATED_AT_FUTURE_SKEW_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}

function isCheckoutMarket(value: unknown): value is CheckoutMarket {
  return (
    typeof value === "string" &&
    CHECKOUT_MARKETS.includes(value as CheckoutMarket)
  );
}

function shortString(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function canonicalStorefrontPath(marketCode: CheckoutMarket): string {
  return marketCode === "us"
    ? "/shop/buy-iphone"
    : `/${marketCode}/shop/buy-iphone`;
}

function catalogStorefrontPrefix(marketCode: CheckoutMarket): string {
  return marketCode === "us" ? "" : `/${marketCode}`;
}

/**
 * Validate only the *shape* of a catalog-owned selected-device path. The
 * caller must bind it to an exact current catalog variant with
 * `isCatalogApplePurchaseUrl`; syntax alone never authorizes navigation.
 */
function canonicalCatalogBuyPath(
  marketCode: CheckoutMarket,
  value: unknown,
): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 240)
    return null;
  const prefix = `${catalogStorefrontPrefix(marketCode)}/shop/buy-iphone/`;
  if (
    !value.startsWith(prefix) ||
    value.startsWith("//") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("%") ||
    value.includes("..") ||
    !/^\/[a-z0-9./-]+$/.test(value)
  ) {
    return null;
  }
  return parseAppleSelectedDevicePath(marketCode, value) ? value : null;
}

/**
 * The only Apple destination a local handoff may open. It is a manual product
 * chooser, not a cart or reservation URL. Keeping it canonical means the
 * SKU and regional storefront can be verified before a browser tab is opened.
 */
export function buildCanonicalApplePurchaseUrl(
  marketCode: CheckoutMarket,
  sku: string,
): string | null {
  if (!SKU_PATTERN.test(sku)) return null;
  return `https://www.apple.com${canonicalStorefrontPath(marketCode)}?part=${encodeURIComponent(sku)}`;
}

/**
 * A local runtime-only handoff derived from one exact canonical catalog
 * variant. Existing manifests that have no reviewed selected-device path keep
 * the narrow legacy product chooser fallback.
 */
export function buildCatalogApplePurchaseUrl(
  marketCode: CheckoutMarket,
  variant: CatalogPurchaseVariant,
): string | null {
  if (!SKU_PATTERN.test(variant.sku)) return null;
  const path =
    variant.buyPath === undefined
      ? canonicalStorefrontPath(marketCode)
      : canonicalCatalogBuyPath(marketCode, variant.buyPath);
  if (!path) return null;
  return variant.buyPath === undefined
    ? buildCanonicalApplePurchaseUrl(marketCode, variant.sku)
    : `https://www.apple.com${path}`;
}

/** Reject redirects, credentials, alternate ports, paths, and extra params. */
export function isCanonicalApplePurchaseUrl(
  value: unknown,
  marketCode: CheckoutMarket,
  sku: string,
): value is string {
  if (typeof value !== "string" || value.length > 500) return false;
  const expected = buildCanonicalApplePurchaseUrl(marketCode, sku);
  if (!expected || value !== expected) return false;
  try {
    const url = new URL(value);
    const storefrontPath = url.pathname;
    return (
      url.protocol === "https:" &&
      url.hostname === "www.apple.com" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.pathname === canonicalStorefrontPath(marketCode) &&
      url.hash === "" &&
      [...url.searchParams].length === 1 &&
      url.searchParams.get("part") === sku
    );
  } catch {
    return false;
  }
}

/**
 * Catalog-aware strict equality for every local availability handoff. A
 * same-origin Apple URL is not enough: it must be the URL re-derived from the
 * currently validated market/SKU catalog record.
 */
export function isCatalogApplePurchaseUrl(
  value: unknown,
  marketCode: CheckoutMarket,
  variant: CatalogPurchaseVariant,
): value is string {
  return (
    typeof value === "string" &&
    value === buildCatalogApplePurchaseUrl(marketCode, variant)
  );
}

/** Bounded syntax guard for untrusted persisted delivery references. */
export function isSafeApplePurchaseUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 500) return false;
  try {
    const url = new URL(value);
    const chooserPaths = [
      "/shop/buy-iphone",
      "/ca/shop/buy-iphone",
      "/uk/shop/buy-iphone",
    ];
    const chooser = chooserPaths.includes(url.pathname);
    const selectedMarket: CheckoutMarket = url.pathname.startsWith("/ca/")
      ? "ca"
      : url.pathname.startsWith("/uk/")
        ? "uk"
        : "us";
    return (
      url.protocol === "https:" &&
      url.hostname === "www.apple.com" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.hash === "" &&
      ((chooser &&
        [...url.searchParams].length === 1 &&
        isCanonicalApplePurchaseUrl(
          value,
          url.pathname === "/shop/buy-iphone"
            ? "us"
            : url.pathname.startsWith("/ca/")
              ? "ca"
              : "uk",
          url.searchParams.get("part") ?? "",
        )) ||
        (canonicalCatalogBuyPath(selectedMarket, url.pathname) !== null &&
          [...url.searchParams].length === 0 &&
          value === url.toString()))
    );
  } catch {
    return false;
  }
}

function exactIsoDate(value: unknown): number | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    return null;
  }
  return parsed;
}

export function parseCheckoutMandate(
  input: unknown,
  now = Date.now(),
): CheckoutMandate | null {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      "protocol",
      "type",
      "id",
      "createdAt",
      "expiresAt",
      "marketCode",
      "sku",
      "variantTitle",
      "purchaseUrl",
      "store",
    ]) ||
    !isRecord(input.store) ||
    !hasExactKeys(input.store, ["id", "appleStoreNumber", "name"])
  ) {
    return null;
  }
  if (
    input.protocol !== CHECKOUT_PROTOCOL ||
    input.type !== "ARM_CHECKOUT" ||
    typeof input.id !== "string" ||
    !OPAQUE_ID_PATTERN.test(input.id) ||
    !isCheckoutMarket(input.marketCode) ||
    typeof input.sku !== "string" ||
    !SKU_PATTERN.test(input.sku) ||
    !shortString(input.variantTitle, 200) ||
    !isCanonicalApplePurchaseUrl(
      input.purchaseUrl,
      input.marketCode,
      input.sku,
    ) ||
    typeof input.store.id !== "string" ||
    !OPAQUE_ID_PATTERN.test(input.store.id) ||
    typeof input.store.appleStoreNumber !== "string" ||
    !STORE_NUMBER_PATTERN.test(input.store.appleStoreNumber) ||
    !shortString(input.store.name, 160)
  ) {
    return null;
  }

  const createdAt = exactIsoDate(input.createdAt);
  const expiresAt = exactIsoDate(input.expiresAt);
  if (
    createdAt === null ||
    expiresAt === null ||
    createdAt > now + MAX_CREATED_AT_FUTURE_SKEW_MS ||
    createdAt < now - MAX_MANDATE_LIFETIME_MS ||
    expiresAt <= now ||
    expiresAt <= createdAt ||
    expiresAt - createdAt > 10 * 60_000
  ) {
    return null;
  }
  return input as unknown as CheckoutMandate;
}

export function isMandateForCurrentApplePage(
  mandate: CheckoutMandate,
  currentUrl: string,
): boolean {
  return isCanonicalApplePurchaseUrl(
    currentUrl,
    mandate.marketCode,
    mandate.sku,
  );
}
