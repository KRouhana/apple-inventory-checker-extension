import { describe, expect, it } from "vitest";

import {
  buildApplePickupMessageUrl,
  buildApplePickupMessageUrls,
  chunkPartNumbers,
  MAX_PARTS_PER_REQUEST,
} from "../src/index.js";

describe("Apple pickup URL construction", () => {
  it("builds the US path and indexed part parameters", () => {
    const url = new URL(
      buildApplePickupMessageUrl({
        marketPath: "",
        location: "10001",
        partNumbers: ["MFXH4LL/A", "SECOND/A"],
      }),
    );

    expect(url.origin).toBe("https://www.apple.com");
    expect(url.pathname).toBe("/shop/retail/pickup-message");
    expect(url.searchParams.get("parts.0")).toBe("MFXH4LL/A");
    expect(url.searchParams.get("parts.1")).toBe("SECOND/A");
    expect(url.searchParams.get("location")).toBe("10001");
    expect(url.searchParams.get("mts.0")).toBe("regular");
  });

  it("normalizes a country storefront path", () => {
    const url = new URL(
      buildApplePickupMessageUrl({
        marketPath: "/CA/",
        location: "H3A 0B4",
        partNumbers: ["MFYA4VC/A"],
      }),
    );
    expect(url.pathname).toBe("/ca/shop/retail/pickup-message");
    expect(url.searchParams.get("location")).toBe("H3A 0B4");
  });

  it("rejects invalid market paths and oversized batches", () => {
    expect(() =>
      buildApplePickupMessageUrl({
        marketPath: "ca/shop/evil",
        location: "H3A0B4",
        partNumbers: ["SKU1"],
      }),
    ).toThrow("Invalid Apple market path");

    expect(() =>
      buildApplePickupMessageUrl({
        marketPath: "ca",
        location: "H3A0B4",
        partNumbers: Array.from(
          { length: MAX_PARTS_PER_REQUEST + 1 },
          (_, i) => `SKU${i}`,
        ),
      }),
    ).toThrow("between 1 and 12");
  });
});

describe("SKU batching", () => {
  it("chunks at no more than 12 parts", () => {
    const skus = Array.from({ length: 25 }, (_, index) => `SKU-${index}`);
    expect(chunkPartNumbers(skus).map((chunk) => chunk.length)).toEqual([
      12, 12, 1,
    ]);
    expect(
      buildApplePickupMessageUrls({
        marketPath: "ca",
        location: "H3A0B4",
        partNumbers: skus,
      }),
    ).toHaveLength(3);
  });

  it("does not allow callers to raise the upstream maximum", () => {
    expect(() => chunkPartNumbers(["SKU1"], 13)).toThrow("between 1 and 12");
  });

  it("rejects an empty batch instead of silently scheduling nothing", () => {
    expect(() => chunkPartNumbers([])).toThrow("At least one part number");
    expect(() =>
      buildApplePickupMessageUrls({
        marketPath: "ca",
        location: "H3A0B4",
        partNumbers: [],
      }),
    ).toThrow("At least one part number");
  });
});
