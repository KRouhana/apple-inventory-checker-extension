import { describe, expect, it } from "vitest";

import { validateCatalogMappings } from "../src/index.js";

describe("validateCatalogMappings", () => {
  it("accepts one exact mapping per market SKU", () => {
    expect(
      validateCatalogMappings([
        {
          marketCode: "US",
          sku: "SKU1",
          variantId: "v1",
          expectedTitle: "Phone One",
        },
        {
          marketCode: "CA",
          sku: "SKU1",
          variantId: "v2",
          expectedTitle: "Phone One",
        },
      ]),
    ).toEqual({
      valid: true,
      mappings: [
        {
          marketCode: "US",
          sku: "SKU1",
          variantId: "v1",
          expectedTitle: "Phone One",
        },
        {
          marketCode: "CA",
          sku: "SKU1",
          variantId: "v2",
          expectedTitle: "Phone One",
        },
      ],
      issues: [],
    });
  });

  it("reports duplicate rows", () => {
    const mapping = {
      marketCode: "US",
      sku: "SKU1",
      variantId: "v1",
      expectedTitle: "Phone One",
    };
    const result = validateCatalogMappings([mapping, mapping]);

    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues[0]?.code).toBe("duplicate_mapping");
  });

  it("reports conflicting variants and titles for the same market SKU", () => {
    const result = validateCatalogMappings([
      {
        marketCode: "US",
        sku: "SKU1",
        variantId: "v1",
        expectedTitle: "Phone One",
      },
      {
        marketCode: "US",
        sku: "SKU1",
        variantId: "v2",
        expectedTitle: "Phone Two",
      },
    ]);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: "conflicting_mapping",
          index: 1,
          conflictsWithIndex: 0,
        }),
      ]);
    }
  });

  it("reports malformed runtime rows instead of throwing", () => {
    const result = validateCatalogMappings([
      null,
      { marketCode: "US", sku: 42, variantId: "v1" },
    ]);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ index: 0, code: "missing_field" }),
          expect.objectContaining({ index: 1, code: "missing_field" }),
        ]),
      );
    }
  });

  it("reports a non-array import payload", () => {
    expect(validateCatalogMappings({ rows: [] })).toEqual({
      valid: false,
      mappings: [],
      issues: [expect.objectContaining({ index: -1, code: "missing_field" })],
    });
  });
});
