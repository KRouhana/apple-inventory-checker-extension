import { describe, expect, it } from "vitest";
import type { LocalCatalogSnapshot } from "../../../../packages/core/src/local-monitor-contracts.js";
import {
  dimensionsForVariant,
  normalizeWatchSelection,
  selectorOptions,
} from "../../src/ui/catalog-presentation.js";

const catalog: LocalCatalogSnapshot = {
  schemaVersion: 1,
  generatedAt: "2026-09-09T12:00:00.000Z",
  markets: ["us", "ca", "uk"].map((code) => ({
    code: code as "us" | "ca" | "uk",
    name: code.toUpperCase(),
    storefrontPath: code === "us" ? "" : `/${code}`,
    variants: [
      {
        sku: `AA1${code.toUpperCase()}/A`,
        title: "iPhone 17 Pro 256GB Silver",
        familySlug: "iphone-17-pro",
      },
      {
        sku: `AA2${code.toUpperCase()}/A`,
        title: "iPhone 17 Pro 256GB Deep Blue",
        familySlug: "iphone-17-pro",
      },
      {
        sku: `BB1${code.toUpperCase()}/A`,
        title: "iPhone Air 512GB Cloud White",
        familySlug: "iphone-air",
      },
      {
        sku: `CC1${code.toUpperCase()}/A`,
        title: "iPhone 17 Pro 1TB Silver",
        familySlug: "iphone-17-pro",
      },
      {
        sku: `DD1${code.toUpperCase()}/A`,
        title: "iPhone 17 Pro 2TB Silver",
        familySlug: "iphone-17-pro",
      },
    ],
    stores: [],
  })),
};

describe("portable catalog selector presentation", () => {
  it("derives all model, storage, colour, and region choices from every catalog market", () => {
    for (const market of catalog.markets) {
      const options = selectorOptions(catalog, {
        market: market.code,
        model: "",
        storage: "",
        color: "",
        sku: "",
      });
      expect(options.models).toEqual(["iphone-17-pro", "iphone-air"]);
      expect(options.storage).toEqual(["256GB", "512GB", "1TB", "2TB"]);
      expect(options.markets.map((entry) => entry.code)).toEqual([
        "us",
        "ca",
        "uk",
      ]);
    }
    expect(dimensionsForVariant(catalog.markets[0]!.variants[0]!)).toEqual({
      model: "iphone-17-pro",
      storage: "256GB",
      color: "Silver",
    });
  });

  it("resets invalid dependent selections instead of preserving a hidden variant", () => {
    const normalized = normalizeWatchSelection(catalog, {
      market: "ca",
      model: "iphone-17-pro",
      storage: "4TB",
      color: "Silver",
      sku: "AA1CA/A",
    });
    expect(normalized).toEqual({
      market: "ca",
      model: "iphone-17-pro",
      storage: "",
      color: "",
      sku: "",
    });
    expect(
      normalizeWatchSelection(catalog, {
        market: "us",
        model: "missing-model",
        storage: "256GB",
        color: "Silver",
        sku: "AA1US/A",
      }),
    ).toEqual({ market: "us", model: "", storage: "", color: "", sku: "" });
  });

  it("derives the SKU when four dimensions identify exactly one variant", () => {
    expect(
      normalizeWatchSelection(catalog, {
        market: "us",
        model: "iphone-air",
        storage: "512GB",
        color: "Cloud White",
        // A stale SKU from a different family must never survive invisibly.
        sku: "AA1US/A",
      }),
    ).toEqual({
      market: "us",
      model: "iphone-air",
      storage: "512GB",
      color: "Cloud White",
      sku: "BB1US/A",
    });
  });

  it("returns empty dependent choices for an unsupported or empty catalog selection", () => {
    expect(
      selectorOptions(catalog, {
        market: "",
        model: "",
        storage: "",
        color: "",
        sku: "",
      }),
    ).toMatchObject({ models: [], storage: [], colors: [], variants: [] });
  });
});
