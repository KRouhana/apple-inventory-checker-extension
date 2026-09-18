import type {
  LocalWatch,
  WatchDeliveryChannels,
} from "../../../../packages/core/src/local-monitor-contracts.js";
import {
  MAX_LOCAL_POLL_INTERVAL_SEC,
  MIN_LOCAL_POLL_INTERVAL_SEC,
} from "../../../../packages/core/src/local-monitor-contracts.js";
import type { LocalMonitorUiCatalog } from "./controller.js";
import type { WatchSelectionDraft } from "./catalog-presentation.js";

export interface WatchDraftInput {
  id: string;
  selection: WatchSelectionDraft;
  selectedStoreNumbers: readonly string[];
  pollAnchorStoreNumber: string;
  pollIntervalSec: number;
  enabled: boolean;
  deliveryChannels: WatchDeliveryChannels;
  now: string;
  createdAt?: string;
}

export type BuildWatchResult =
  | { success: true; watch: LocalWatch }
  | { success: false; message: string };

/** Builds only the public, persistable watch shape. Raw location never enters. */
export function buildWatchFromDraft(
  catalog: LocalMonitorUiCatalog,
  input: WatchDraftInput,
): BuildWatchResult {
  const market = catalog.markets.find(
    (entry) => entry.code === input.selection.market,
  );
  if (!market) return { success: false, message: "Choose a supported region." };
  const variant = market.variants.find(
    (entry) => entry.sku === input.selection.sku,
  );
  if (!variant)
    return { success: false, message: "Choose a current catalog variant." };
  const selected = [...new Set(input.selectedStoreNumbers)];
  if (selected.length === 0)
    return { success: false, message: "Choose at least one public store." };
  if (selected.length > 10)
    return { success: false, message: "Choose at most 10 stores." };
  // The catalog is the sole authority for persisted store numbers. Nearby
  // lookup results are themselves projected from this market's catalog, so a
  // caller can never turn an arbitrary lookup/UI value into a LocalWatch.
  const catalogStoreNumbers = new Set(
    market.stores.map((store) => store.storeNumber),
  );
  if (!selected.every((storeNumber) => catalogStoreNumbers.has(storeNumber))) {
    return {
      success: false,
      message: "Choose stores included in the selected region's catalog.",
    };
  }
  if (!selected.includes(input.pollAnchorStoreNumber)) {
    return {
      success: false,
      message: "Choose one selected store as the polling anchor.",
    };
  }
  if (
    !Number.isInteger(input.pollIntervalSec) ||
    input.pollIntervalSec < MIN_LOCAL_POLL_INTERVAL_SEC ||
    input.pollIntervalSec > MAX_LOCAL_POLL_INTERVAL_SEC
  ) {
    return {
      success: false,
      message: `Check interval must be between ${MIN_LOCAL_POLL_INTERVAL_SEC / 60} and ${MAX_LOCAL_POLL_INTERVAL_SEC / 60} minutes.`,
    };
  }
  return {
    success: true,
    watch: {
      id: input.id,
      market: market.code,
      skus: [variant.sku],
      storeNumbers: selected,
      pollAnchor: { storeNumber: input.pollAnchorStoreNumber },
      pollIntervalSec: input.pollIntervalSec,
      enabled: input.enabled,
      deliveryChannels: input.deliveryChannels,
      catalogSchemaVersion: catalog.schemaVersion,
      createdAt: input.createdAt ?? input.now,
      updatedAt: input.now,
    },
  };
}

export function makeUiWatchId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return `watch-${random.replaceAll("-", "")}`.slice(0, 64);
  return `watch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
