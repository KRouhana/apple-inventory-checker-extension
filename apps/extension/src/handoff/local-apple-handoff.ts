/**
 * Local-only manual Apple handoff (L14 / issue #23).
 *
 * The monitor engine calls the factory only after its strict pickup parser has
 * classified a row as available. This module deliberately has no stock-status
 * input, network access, browser globals, or checkout controls; callers must
 * not use it to turn unknown or unavailable UI rows into a handoff.
 */
import {
  parseLocalCatalogSnapshot,
  parseLocalWatch,
  type LocalAvailabilityEvent,
  type LocalCatalogSnapshot,
  type LocalWatch,
} from "../../../../packages/core/src/local-monitor-contracts.js";

import { buildCatalogApplePurchaseUrl } from "../protocol";

const MAX_EVENT_AGE_MS = 10 * 60_000;
const MAX_OBSERVED_AT_FUTURE_SKEW_MS = 60_000;

export interface LocalAppleHandoffEventFactory {
  /**
   * Create a catalog-derived manual product handoff for an already-available
   * pickup observation. `title` and `storeName` are intentionally ignored:
   * only the current validated catalog may supply display data.
   */
  create(input: {
    watch: LocalWatch;
    sku: string;
    storeNumber: string;
    title: string;
    storeName: string;
    observedAt: string;
  }): LocalAvailabilityEvent | null;
}

export interface LocalAppleHandoffOptions {
  /** A last-known-good catalog supplied by the catalog port; never fetched. */
  getCatalog(): LocalCatalogSnapshot | null;
  now?: () => number;
}

function validObservationTime(value: string, now: number): boolean {
  const observedAt = Date.parse(value);
  return (
    Number.isFinite(observedAt) &&
    new Date(observedAt).toISOString() === value &&
    observedAt <= now + MAX_OBSERVED_AT_FUTURE_SKEW_MS &&
    observedAt >= now - MAX_EVENT_AGE_MS
  );
}

/**
 * Re-derives every displayed/purchase field from the market-scoped portable
 * catalog. A stale, retired, wrong-region, disabled, or forged watch/input
 * fails closed. This has no localhost or website dependency.
 */
export function createLocalAppleHandoffEventFactory(
  options: LocalAppleHandoffOptions,
): LocalAppleHandoffEventFactory {
  return {
    create(input) {
      try {
        const now = options.now?.() ?? Date.now();
        if (
          !Number.isFinite(now) ||
          !validObservationTime(input.observedAt, now)
        ) {
          return null;
        }

        const parsedWatch = parseLocalWatch(input.watch);
        if (!parsedWatch.success || !parsedWatch.data.enabled) return null;
        const watch = parsedWatch.data;
        if (
          !watch.skus.includes(input.sku) ||
          !watch.storeNumbers.includes(input.storeNumber)
        ) {
          return null;
        }

        const candidateCatalog = options.getCatalog();
        const parsedCatalog = parseLocalCatalogSnapshot(candidateCatalog);
        if (!parsedCatalog.success) return null;
        const catalog = parsedCatalog.data;
        if (watch.catalogSchemaVersion !== catalog.schemaVersion) return null;

        const market = catalog.markets.find(
          (entry) => entry.code === watch.market,
        );
        if (!market) return null;
        const variants = market.variants.filter(
          (entry) => entry.sku === input.sku,
        );
        const stores = market.stores.filter(
          (entry) => entry.storeNumber === input.storeNumber,
        );
        // The parser already rejects duplicates. Keep this defensive guard for
        // callers that constructed a typed object outside JSON validation.
        if (variants.length !== 1 || stores.length !== 1) return null;

        const variant = variants[0]!;
        const store = stores[0]!;
        const purchaseUrl = buildCatalogApplePurchaseUrl(watch.market, variant);
        if (!purchaseUrl) return null;

        return {
          watchId: watch.id,
          market: watch.market,
          sku: variant.sku,
          title: variant.title,
          storeNumber: store.storeNumber,
          storeName: store.name,
          observedAt: input.observedAt,
          purchaseUrl,
        };
      } catch {
        return null;
      }
    },
  };
}
