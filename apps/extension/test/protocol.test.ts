import { describe, expect, it } from "vitest";
import {
  buildCanonicalApplePurchaseUrl,
  buildCatalogApplePurchaseUrl,
  CHECKOUT_PROTOCOL,
  isCanonicalApplePurchaseUrl,
  isCatalogApplePurchaseUrl,
  isMandateForCurrentApplePage,
  parseCheckoutMandate,
} from "../src/protocol";

const now = Date.parse("2026-08-30T12:00:00.000Z");
const mandate = {
  protocol: CHECKOUT_PROTOCOL,
  type: "ARM_CHECKOUT",
  id: "checkout-1",
  createdAt: "2026-08-30T12:00:00.000Z",
  expiresAt: "2026-08-30T12:05:00.000Z",
  marketCode: "ca",
  sku: "TEST4VC/A",
  variantTitle: "iPhone 17 Pro Max 256GB Blue",
  purchaseUrl: "https://www.apple.com/ca/shop/buy-iphone?part=TEST4VC%2FA",
  store: { id: "store-id", appleStoreNumber: "R123", name: "Apple Test" },
} as const;

describe("checkout mandate", () => {
  it("accepts a short-lived, exact Apple handoff", () => {
    expect(parseCheckoutMandate(mandate, now)).toEqual(mandate);
  });

  it("builds only exact regional manual product chooser URLs", () => {
    expect(buildCanonicalApplePurchaseUrl("us", "TEST4VC/A")).toBe(
      "https://www.apple.com/shop/buy-iphone?part=TEST4VC%2FA",
    );
    expect(buildCanonicalApplePurchaseUrl("ca", "TEST4VC/A")).toBe(
      mandate.purchaseUrl,
    );
    expect(buildCanonicalApplePurchaseUrl("ca", "not a SKU")).toBeNull();
  });

  it("binds selected-device paths to the exact catalog variant, with legacy fallback", () => {
    const variant = {
      sku: "TEST4VC/A",
      buyPath: "/ca/shop/buy-iphone/iphone-18-pro/6.3-inch-display-256gb-black",
    };
    const expected =
      "https://www.apple.com/ca/shop/buy-iphone/iphone-18-pro/6.3-inch-display-256gb-black";
    expect(buildCatalogApplePurchaseUrl("ca", variant)).toBe(expected);
    expect(isCatalogApplePurchaseUrl(expected, "ca", variant)).toBe(true);
    expect(
      isCatalogApplePurchaseUrl(
        "https://www.apple.com/ca/shop/buy-iphone/iphone-18-pro/6.9-inch-display-256gb-black",
        "ca",
        variant,
      ),
    ).toBe(false);
    expect(buildCatalogApplePurchaseUrl("ca", { sku: "TEST4VC/A" })).toBe(
      mandate.purchaseUrl,
    );
    expect(buildCatalogApplePurchaseUrl("uk", variant)).toBeNull();
  });

  it("binds a verified regular iPhone 17 selected-device path to its exact catalog variant", () => {
    const variant = {
      sku: "MG6A4VC/A",
      buyPath: "/ca/shop/buy-iphone/iphone-17/6.3-inch-display-256gb-lavender",
    };
    const expected =
      "https://www.apple.com/ca/shop/buy-iphone/iphone-17/6.3-inch-display-256gb-lavender";
    expect(buildCatalogApplePurchaseUrl("ca", variant)).toBe(expected);
    expect(isCatalogApplePurchaseUrl(expected, "ca", variant)).toBe(true);
    expect(buildCatalogApplePurchaseUrl("us", variant)).toBeNull();
  });

  it("rejects expired, malformed, wrong-region, and redirecting handoffs", () => {
    expect(parseCheckoutMandate(mandate, now + 6 * 60_000)).toBeNull();
    expect(
      parseCheckoutMandate(
        { ...mandate, expiresAt: "2026-08-30T12:11:00.000Z" },
        now,
      ),
    ).toBeNull();
    expect(
      parseCheckoutMandate(
        { ...mandate, purchaseUrl: "https://attacker.example/checkout" },
        now,
      ),
    ).toBeNull();
    expect(
      parseCheckoutMandate(
        { ...mandate, purchaseUrl: "https://apple.com/ca/shop/buy-iphone" },
        now,
      ),
    ).toBeNull();
    for (const purchaseUrl of [
      "https://www.apple.com/uk/shop/buy-iphone?part=TEST4VC%2FA",
      "https://www.apple.com/ca/shop/buy-iphone?part=OTHER4VC%2FA",
      "https://www.apple.com/ca/shop/buy-iphone?part=TEST4VC%2FA&next=https%3A%2F%2Fevil.example",
      "https://user:pass@www.apple.com/ca/shop/buy-iphone?part=TEST4VC%2FA",
      "https://www.apple.com:444/ca/shop/buy-iphone?part=TEST4VC%2FA",
      "https://www.apple.com/ca/shop/buy-iphone?part=TEST4VC%2FA#fragment",
      "https://www.apple.com/ca/shop/buy-iphone/iphone-17-pro",
    ]) {
      expect(parseCheckoutMandate({ ...mandate, purchaseUrl }, now)).toBeNull();
    }
    expect(
      parseCheckoutMandate({ ...mandate, sku: "OTHER4VC/A" }, now),
    ).toBeNull();
    expect(
      parseCheckoutMandate({ ...mandate, marketCode: "uk" }, now),
    ).toBeNull();
    expect(
      parseCheckoutMandate({ ...mandate, extra: "forged" }, now),
    ).toBeNull();
    expect(
      parseCheckoutMandate(
        { ...mandate, createdAt: "2026-08-30T11:45:00.000Z" },
        now,
      ),
    ).toBeNull();
    expect(
      isCanonicalApplePurchaseUrl(mandate.purchaseUrl, "ca", mandate.sku),
    ).toBe(true);
  });

  it("matches only the expected Apple page", () => {
    const parsed = parseCheckoutMandate(mandate, now)!;
    expect(
      isMandateForCurrentApplePage(
        parsed,
        "https://www.apple.com/ca/shop/buy-iphone?part=TEST4VC%2FA",
      ),
    ).toBe(true);
    expect(
      isMandateForCurrentApplePage(
        parsed,
        "https://www.apple.com/ca/shop/buy-iphone?part=OTHER4VC%2FA",
      ),
    ).toBe(false);
  });
});
