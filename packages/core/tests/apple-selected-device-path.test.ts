import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  isAppleSelectedDevicePath,
  parseAppleSelectedDevicePath,
} from "../src/index.js";

describe("Apple selected-device route guard", () => {
  it("accepts the public active catalog paths and binds their market", () => {
    const catalog = JSON.parse(
      readFileSync(
        new URL("../../../catalog/portable-catalog.json", import.meta.url),
        "utf8",
      ),
    );
    expect(
      catalog.markets.flatMap(
        (market: { variants: unknown[] }) => market.variants,
      ),
    ).toHaveLength(120);
    for (const market of catalog.markets)
      for (const variant of market.variants) {
        expect(
          parseAppleSelectedDevicePath(market.code, variant.buyPath)
            ?.familySlug,
        ).toBe(variant.familySlug);
        expect(isAppleSelectedDevicePath(variant.buyPath)).toBe(true);
      }
  });

  it("keeps literal market, carrier, capacity, and color bounds", () => {
    for (const path of [
      "/ca/shop/buy-iphone/iphone-17/6.3-inch-display-256gb-lavender-unlocked",
      "/shop/buy-iphone/iphone-17/6.3-inch-display-256gb-lavender",
      "/ca/shop/buy-iphone/iphone-17/6.3-inch-display-1tb-lavender",
      "/ca/shop/buy-iphone/iphone-17/6.3-inch-display-256gb-cosmic-orange",
      "/ca/shop/buy-iphone/iphone-17/6.9-inch-display-256gb-lavender",
      "/ca/shop/buy-iphone/iphone-17/6.3-inch-display-256gb-lavender?next=x",
    ]) {
      expect(isAppleSelectedDevicePath(path)).toBe(false);
    }
  });
});
