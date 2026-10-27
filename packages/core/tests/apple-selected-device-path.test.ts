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

  it.each(["ca", "uk", "us"] as const)(
    "parses every Duo capacity and color in %s without conflating it with Pro Max",
    (market) => {
      const prefix = market === "us" ? "" : `/${market}`;
      const suffix = market === "us" ? "-unlocked" : "";
      for (const capacity of ["256gb", "512gb", "1tb", "2tb"]) {
        for (const [color, label] of [
          ["star-white", "Star White"],
          ["night-sky", "Night Sky"],
        ]) {
          const path = `${prefix}/shop/buy-iphone/iphone-duo/7.6-inch-display-${capacity}-${color}${suffix}`;
          expect(parseAppleSelectedDevicePath(market, path)).toEqual({
            familySlug: "iphone-duo",
            capacity: capacity.toUpperCase(),
            color: label,
          });
          for (const otherMarket of ["ca", "uk", "us"] as const) {
            if (otherMarket !== market) {
              expect(
                parseAppleSelectedDevicePath(otherMarket, path),
              ).toBeNull();
            }
          }
        }
      }
    },
  );

  it.each([
    "/ca/shop/buy-iphone/iphone-duo/6.3-inch-display-256gb-star-white",
    "/ca/shop/buy-iphone/iphone-duo/6.9-inch-display-256gb-star-white",
    "/ca/shop/buy-iphone/iphone-duo/7.6-inch-display-256gb-black",
    "/ca/shop/buy-iphone/iphone-duo/7.6-inch-display-256gb-silver",
    "/ca/shop/buy-iphone/iphone-duo/7.6-inch-display-128gb-star-white",
    "/ca/shop/buy-iphone/iphone-duo/7.6-inch-display-4tb-star-white",
    "/ca/shop/buy-iphone/iphone-duo/7.6-inch-display-256gb-star-white-unlocked",
    "/shop/buy-iphone/iphone-duo/7.6-inch-display-256gb-star-white",
    "/ca/shop/buy-iphone/iphone-18-pro/7.6-inch-display-256gb-star-white",
    "/ca/shop/buy-iphone/iphone-duo/7.6-inch-display-256gb-star-white?part=OTHER",
  ])("rejects a non-catalog Duo route: %s", (path) => {
    expect(isAppleSelectedDevicePath(path)).toBe(false);
  });
});
