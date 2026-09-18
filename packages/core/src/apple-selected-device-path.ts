export const APPLE_SELECTED_DEVICE_MARKETS = ["us", "ca", "uk"] as const;
export type AppleSelectedDeviceMarket =
  (typeof APPLE_SELECTED_DEVICE_MARKETS)[number];

export type AppleSelectedDevicePath = Readonly<{
  familySlug:
    | "iphone-17"
    | "iphone-18-pro"
    | "iphone-18-pro-max"
    | "iphone-duo";
  capacity: "256GB" | "512GB" | "1TB" | "2TB";
  color: string;
}>;

const ROUTE_PATTERN =
  /^(iphone-17|iphone-18-pro|iphone-duo)\/(6\.3|6\.9|7\.6)-inch-display-(256gb|512gb|1tb|2tb)-(black|white|mist-blue|lavender|sage|silver|burgundy|glacier|star-white|night-sky)(-unlocked)?$/;

function storefrontPrefix(market: AppleSelectedDeviceMarket): string {
  return market === "us" ? "" : `/${market}`;
}

function titleCase(value: string): string {
  return value
    .split("-")
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Accepts only the literal Apple selected-device routes reviewed for the
 * active iPhone 17 and iPhone 18 families. This is syntax validation only;
 * callers must still bind the path to an exact catalog SKU/title.
 */
export function parseAppleSelectedDevicePath(
  market: AppleSelectedDeviceMarket,
  value: unknown,
): AppleSelectedDevicePath | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 240 ||
    value.startsWith("//") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("%") ||
    value.includes("..") ||
    !/^\/[a-z0-9./-]+$/.test(value)
  ) {
    return null;
  }
  const prefix = `${storefrontPrefix(market)}/shop/buy-iphone/`;
  if (!value.startsWith(prefix)) return null;
  const match = value.slice(prefix.length).match(ROUTE_PATTERN);
  if (!match) return null;
  const [, familyPath, dimension, rawCapacity, rawColor, unlocked] = match;
  if (!familyPath || !dimension || !rawCapacity || !rawColor) return null;
  if (market === "us" ? unlocked !== "-unlocked" : unlocked !== undefined) {
    return null;
  }
  const isRegularIphone17 = familyPath === "iphone-17";
  const isIphone18Pro = familyPath === "iphone-18-pro";
  const isDuo = familyPath === "iphone-duo";
  if (
    (isRegularIphone17 &&
      (dimension !== "6.3" ||
        !["256gb", "512gb"].includes(rawCapacity) ||
        !["black", "white", "mist-blue", "lavender", "sage"].includes(
          rawColor,
        ))) ||
    (isIphone18Pro &&
      (!(["6.3", "6.9"] as const).includes(dimension as "6.3" | "6.9") ||
        !["black", "silver", "burgundy", "glacier"].includes(rawColor))) ||
    (isDuo &&
      (dimension !== "7.6" || !["star-white", "night-sky"].includes(rawColor)))
  ) {
    return null;
  }
  return {
    familySlug: isRegularIphone17
      ? "iphone-17"
      : isDuo
        ? "iphone-duo"
        : dimension === "6.9"
          ? "iphone-18-pro-max"
          : "iphone-18-pro",
    capacity: rawCapacity.toUpperCase() as AppleSelectedDevicePath["capacity"],
    color: titleCase(rawColor),
  };
}

export function isAppleSelectedDevicePath(value: unknown): value is string {
  return APPLE_SELECTED_DEVICE_MARKETS.some(
    (market) => parseAppleSelectedDevicePath(market, value) !== null,
  );
}
