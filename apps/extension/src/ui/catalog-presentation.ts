import type {
  LocalCatalogVariant,
  LocalMarketCode,
} from "../../../../packages/core/src/local-monitor-contracts.js";
import type {
  LocalMonitorUiCatalog,
  LocalMonitorUiMarket,
} from "./controller.js";

export interface VariantDimensions {
  model: string;
  storage: string | null;
  color: string | null;
}

export interface WatchSelectionDraft {
  market: LocalMarketCode | "";
  model: string;
  storage: string;
  color: string;
  sku: string;
}

export const EMPTY_WATCH_SELECTION: WatchSelectionDraft = {
  market: "",
  model: "",
  storage: "",
  color: "",
  sku: "",
};

/**
 * The portable catalog's canonical title is the source for its three product
 * dimensions. It intentionally declines to guess if a curated title does not
 * have the conventional "model 256GB colour" shape.
 */
export function dimensionsForVariant(
  variant: LocalCatalogVariant,
): VariantDimensions {
  const match = /^(.*?)\s+(\d+(?:GB|TB))\s+(.+)$/i.exec(variant.title.trim());
  if (!match) {
    return {
      model: variant.familySlug ?? variant.title,
      storage: null,
      color: null,
    };
  }
  return {
    model: variant.familySlug ?? match[1].trim(),
    storage: match[2].toUpperCase(),
    color: match[3].trim(),
  };
}

export function modelLabel(
  market: LocalMonitorUiMarket,
  model: string,
): string {
  const variant = market.variants.find(
    (candidate) => dimensionsForVariant(candidate).model === model,
  );
  if (!variant) return model;
  const dimensions = dimensionsForVariant(variant);
  return dimensions.model === model && dimensions.storage
    ? variant.title.slice(0, variant.title.indexOf(dimensions.storage)).trim()
    : model.replace(/-/g, " ");
}

export interface SelectorOptions {
  markets: readonly LocalMonitorUiMarket[];
  models: readonly string[];
  storage: readonly string[];
  colors: readonly string[];
  variants: readonly LocalCatalogVariant[];
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true }),
  );
}

/** Storage labels sort by capacity, rather than their first character (1TB
 * must follow 512GB). Unknown labels retain a stable, locale-aware fallback.
 */
function storageSortValue(value: string): number | null {
  const match = /^(\d+)\s*(GB|TB)$/i.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount)) return null;
  return match[2]!.toUpperCase() === "TB" ? amount * 1_000 : amount;
}

function uniqueStorageSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => {
    const leftValue = storageSortValue(left);
    const rightValue = storageSortValue(right);
    if (leftValue !== null && rightValue !== null && leftValue !== rightValue)
      return leftValue - rightValue;
    if (leftValue !== null && rightValue === null) return -1;
    if (leftValue === null && rightValue !== null) return 1;
    return left.localeCompare(right, undefined, { numeric: true });
  });
}

export function selectorOptions(
  catalog: LocalMonitorUiCatalog,
  selection: WatchSelectionDraft,
): SelectorOptions {
  const market = catalog.markets.find(
    (entry) => entry.code === selection.market,
  );
  if (!market) {
    return {
      markets: catalog.markets,
      models: [],
      storage: [],
      colors: [],
      variants: [],
    };
  }
  const byModel = market.variants.filter(
    (variant) =>
      !selection.model ||
      dimensionsForVariant(variant).model === selection.model,
  );
  const byStorage = byModel.filter(
    (variant) =>
      !selection.storage ||
      dimensionsForVariant(variant).storage === selection.storage,
  );
  const variants = byStorage.filter(
    (variant) =>
      !selection.color ||
      dimensionsForVariant(variant).color === selection.color,
  );
  return {
    markets: catalog.markets,
    models: uniqueSorted(
      market.variants.map((variant) => dimensionsForVariant(variant).model),
    ),
    storage: uniqueStorageSorted(
      byModel.flatMap((variant) => {
        const value = dimensionsForVariant(variant).storage;
        return value ? [value] : [];
      }),
    ),
    colors: uniqueSorted(
      byStorage.flatMap((variant) => {
        const value = dimensionsForVariant(variant).color;
        return value ? [value] : [];
      }),
    ),
    variants,
  };
}

/** Reset every dependent selection that is no longer represented in catalog. */
export function normalizeWatchSelection(
  catalog: LocalMonitorUiCatalog,
  selection: WatchSelectionDraft,
): WatchSelectionDraft {
  const market = catalog.markets.find(
    (entry) => entry.code === selection.market,
  );
  if (!market) return { ...EMPTY_WATCH_SELECTION };
  const models = uniqueSorted(
    market.variants.map((variant) => dimensionsForVariant(variant).model),
  );
  if (!models.includes(selection.model)) {
    return { market: market.code, model: "", storage: "", color: "", sku: "" };
  }
  const byModel = market.variants.filter(
    (variant) => dimensionsForVariant(variant).model === selection.model,
  );
  const storage = uniqueStorageSorted(
    byModel.flatMap((variant) => {
      const value = dimensionsForVariant(variant).storage;
      return value ? [value] : [];
    }),
  );
  if (!storage.includes(selection.storage)) {
    return {
      market: market.code,
      model: selection.model,
      storage: "",
      color: "",
      sku: "",
    };
  }
  const byStorage = byModel.filter(
    (variant) => dimensionsForVariant(variant).storage === selection.storage,
  );
  const colors = uniqueSorted(
    byStorage.flatMap((variant) => {
      const value = dimensionsForVariant(variant).color;
      return value ? [value] : [];
    }),
  );
  if (!colors.includes(selection.color)) {
    return {
      market: market.code,
      model: selection.model,
      storage: selection.storage,
      color: "",
      sku: "",
    };
  }
  const matching = byStorage.filter(
    (variant) => dimensionsForVariant(variant).color === selection.color,
  );
  const selectedSku = matching.length === 1 ? matching[0]!.sku : "";
  return {
    market: market.code,
    model: selection.model,
    storage: selection.storage,
    color: selection.color,
    // SKU is derived, never independently selected. This prevents a previous
    // family selection from persisting as an invisible, invalid variant.
    sku: selectedSku,
  };
}

export function selectedVariant(
  catalog: LocalMonitorUiCatalog,
  selection: WatchSelectionDraft,
): LocalCatalogVariant | null {
  const market = catalog.markets.find(
    (entry) => entry.code === selection.market,
  );
  return (
    market?.variants.find((variant) => variant.sku === selection.sku) ?? null
  );
}
