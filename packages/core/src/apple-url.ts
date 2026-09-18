export const APPLE_ORIGIN = "https://www.apple.com";
export const MAX_PARTS_PER_REQUEST = 12;

export interface ApplePickupUrlOptions {
  /** Apple storefront path, for example "" for US, "ca", or "/uk". */
  marketPath: string;
  location: string;
  partNumbers: readonly string[];
  origin?: string;
}

function normalizedMarketPath(marketPath: string): string {
  const trimmed = marketPath.trim();
  if (trimmed === "" || trimmed === "/") {
    return "";
  }

  const withoutSlashes = trimmed.replace(/^\/+|\/+$/g, "");
  if (!/^[a-z]{2}(?:-[a-z]{2})?$/i.test(withoutSlashes)) {
    throw new Error(`Invalid Apple market path: ${marketPath}`);
  }
  return `/${withoutSlashes.toLowerCase()}`;
}

function assertPartNumber(partNumber: string): string {
  if (partNumber.length === 0 || partNumber.trim() !== partNumber) {
    throw new Error(
      "Part numbers must be non-empty and have no surrounding whitespace",
    );
  }
  return partNumber;
}

export function chunkPartNumbers(
  partNumbers: readonly string[],
  chunkSize = MAX_PARTS_PER_REQUEST,
): string[][] {
  if (
    !Number.isInteger(chunkSize) ||
    chunkSize < 1 ||
    chunkSize > MAX_PARTS_PER_REQUEST
  ) {
    throw new Error(
      `chunkSize must be an integer between 1 and ${MAX_PARTS_PER_REQUEST}`,
    );
  }
  if (partNumbers.length === 0) {
    throw new Error("At least one part number is required for batching");
  }

  const checked = partNumbers.map(assertPartNumber);
  const chunks: string[][] = [];
  for (let index = 0; index < checked.length; index += chunkSize) {
    chunks.push(checked.slice(index, index + chunkSize));
  }
  return chunks;
}

export function buildApplePickupMessageUrl(
  options: ApplePickupUrlOptions,
): string {
  const { partNumbers } = options;
  if (partNumbers.length < 1 || partNumbers.length > MAX_PARTS_PER_REQUEST) {
    throw new Error(
      `A pickup request must include between 1 and ${MAX_PARTS_PER_REQUEST} part numbers`,
    );
  }

  const location = options.location.trim();
  if (location.length === 0) {
    throw new Error("A pickup request requires a location");
  }

  const origin = new URL(options.origin ?? APPLE_ORIGIN);
  if (origin.protocol !== "https:") {
    throw new Error("Apple pickup origin must use HTTPS");
  }
  origin.pathname = `${normalizedMarketPath(options.marketPath)}/shop/retail/pickup-message`;
  origin.search = "";
  origin.hash = "";

  origin.searchParams.set("fae", "true");
  origin.searchParams.set("pl", "true");
  origin.searchParams.set("mts.0", "regular");
  partNumbers.map(assertPartNumber).forEach((partNumber, index) => {
    origin.searchParams.set(`parts.${index}`, partNumber);
  });
  origin.searchParams.set("location", location);

  return origin.toString();
}

export function buildApplePickupMessageUrls(
  options: Omit<ApplePickupUrlOptions, "partNumbers"> & {
    partNumbers: readonly string[];
    chunkSize?: number;
  },
): string[] {
  const chunks = chunkPartNumbers(options.partNumbers, options.chunkSize);
  return chunks.map((partNumbers) =>
    buildApplePickupMessageUrl({
      marketPath: options.marketPath,
      location: options.location,
      partNumbers,
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    }),
  );
}
