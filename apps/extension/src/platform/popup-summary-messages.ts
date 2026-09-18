import type { ExtensionMessageSender, ExtensionRuntime } from "./api.js";
import { isTrustedOwnExtensionAppSender } from "./trusted-app-sender.js";
import { z } from "../../../../packages/core/src/local-zod-mini.js";
import {
  parseLocalMonitorSnapshot,
  parseLocalCatalogSnapshot,
  LocalWatchIdSchema,
  LocalSkuSchema,
  LocalStoreNumberSchema,
  LocalMarketCodeSchema,
} from "../../../../packages/core/src/local-monitor-contracts.js";

export const POPUP_MONITOR_SUMMARY_PROTOCOL =
  "inventory-signal.popup-watches.v2";
export const PopupWatchItemSchema = z.strictObject({
  sku: LocalSkuSchema,
  title: z.string().min(1).max(512),
  storeNumber: LocalStoreNumberSchema,
  storeName: z.string().min(1).max(512),
  status: z.enum([
    "available",
    "unavailable",
    "ineligible",
    "unknown",
    "waiting",
    "stale",
    "paused",
    "retired",
  ]),
  lastCheckedAt: z.string().datetime({ offset: true }).nullable(),
});
export const PopupMonitorSummarySchema = z.strictObject({
  watches: z
    .array(
      z.strictObject({
        id: LocalWatchIdSchema,
        market: LocalMarketCodeSchema,
        title: z.string().min(1).max(512),
        enabled: z.boolean(),
        items: z.array(PopupWatchItemSchema).max(120),
      }),
    )
    .max(20),
});
export type PopupMonitorSummary = z.infer<typeof PopupMonitorSummarySchema>;
export type PopupWatchItem = z.infer<typeof PopupWatchItemSchema>;
const openRequest = z.strictObject({
  protocol: z.literal(POPUP_MONITOR_SUMMARY_PROTOCOL),
  type: z.literal("OPEN_AVAILABLE"),
  watchId: LocalWatchIdSchema,
  sku: LocalSkuSchema,
  storeNumber: LocalStoreNumberSchema,
});
const summaryRequest = z.strictObject({
  protocol: z.literal(POPUP_MONITOR_SUMMARY_PROTOCOL),
  type: z.literal("GET_SUMMARY"),
});
export interface PopupMonitorSummaryDependencies {
  getSnapshot(): Promise<unknown>;
  getCatalog(): Promise<unknown>;
  openAvailableAtApple(input: {
    watchId: string;
    sku: string;
    storeNumber: string;
  }): Promise<"opened" | "unavailable">;
  now?: () => number;
}
export function isTrustedPopupMonitorSummarySender(
  sender: ExtensionMessageSender,
  runtime: ExtensionRuntime,
): boolean {
  return isTrustedOwnExtensionAppSender(sender, runtime, "popup.html");
}
/** Only public watch/store identity and stock state reach the popup. */
export function projectPopupMonitorSummary(
  candidate: unknown,
  catalogCandidate: unknown,
  now = Date.now(),
): PopupMonitorSummary | null {
  const parsed = parseLocalMonitorSnapshot(candidate);
  const catalog = parseLocalCatalogSnapshot(catalogCandidate);
  if (!parsed.success || !catalog.success || !Number.isFinite(now)) return null;
  const snapshot = parsed.data;
  const watches = snapshot.watches.map((watch) => {
    const market = catalog.data.markets.find((m) => m.code === watch.market);
    const items: PopupWatchItem[] = watch.skus.flatMap((sku) =>
      watch.storeNumbers.map((storeNumber) => {
        const variant = market?.variants.find((v) => v.sku === sku);
        const store = market?.stores.find((s) => s.storeNumber === storeNumber);
        const item = snapshot.items.find(
          (i) =>
            i.watchId === watch.id &&
            i.sku === sku &&
            i.storeNumber === storeNumber,
        );
        let status: PopupWatchItem["status"] = item?.status ?? "waiting";
        const checked = item ? Date.parse(item.lastCheckedAt) : NaN;
        if (
          !variant ||
          !store ||
          watch.catalogSchemaVersion !== catalog.data.schemaVersion
        )
          status = "retired";
        else if (!watch.enabled) status = "paused";
        else if (
          item &&
          (!Number.isFinite(checked) ||
            checked < now - 10 * 60_000 ||
            checked > now + 60_000)
        )
          status = "stale";
        else if (
          item &&
          item.status !== "unknown" &&
          item.lastCheckedAt !== item.lastSuccessfulAt
        )
          status = "unknown";
        return {
          sku,
          title: variant?.title ?? "Model no longer supported",
          storeNumber,
          storeName: store?.name ?? storeNumber,
          status,
          lastCheckedAt: item?.lastCheckedAt ?? null,
        };
      }),
    );
    return {
      id: watch.id,
      market: watch.market,
      title:
        watch.skus.length === 1
          ? (items[0]?.title ?? "Saved watch")
          : `${watch.skus.length} selected phones`,
      enabled: watch.enabled,
      items,
    };
  });
  const result = PopupMonitorSummarySchema.safeParse({ watches });
  return result.success ? result.data : null;
}
/** Exact popup only; arbitrary URLs and general monitor mutations are forbidden. */
export function installPopupMonitorSummaryMessageHandler(
  runtime: ExtensionRuntime,
  deps: PopupMonitorSummaryDependencies,
): void {
  runtime.onMessage.addListener((input, sender, respond) => {
    if (
      !input ||
      typeof input !== "object" ||
      !("protocol" in input) ||
      input.protocol !== POPUP_MONITOR_SUMMARY_PROTOCOL
    )
      return;
    const type =
      "type" in input &&
      (input.type === "GET_SUMMARY" || input.type === "OPEN_AVAILABLE")
        ? input.type
        : "UNKNOWN";
    const reply = (ok: boolean, result: unknown) =>
      respond({
        protocol: POPUP_MONITOR_SUMMARY_PROTOCOL,
        type: "RESULT",
        request: type,
        ok,
        ...(ok ? { result } : { error: result }),
      });
    if (!isTrustedPopupMonitorSummarySender(sender, runtime)) {
      reply(false, "unauthorized");
      return;
    }
    const command =
      type === "OPEN_AVAILABLE"
        ? openRequest.safeParse(input)
        : summaryRequest.safeParse(input);
    if (!command.success) {
      reply(false, "invalid_request");
      return;
    }
    void (async () => {
      try {
        if (command.data.type === "OPEN_AVAILABLE") {
          const { watchId, sku, storeNumber } = command.data;
          // Re-read state for every click, even if the rendered popup is stale.
          const current = projectPopupMonitorSummary(
            await deps.getSnapshot(),
            await deps.getCatalog(),
            deps.now?.(),
          );
          if (
            !current?.watches
              .find((w) => w.id === watchId)
              ?.items.some(
                (i) =>
                  i.sku === sku &&
                  i.storeNumber === storeNumber &&
                  i.status === "available",
              )
          ) {
            reply(true, "unavailable");
            return;
          }
          reply(
            true,
            await deps.openAvailableAtApple({ watchId, sku, storeNumber }),
          );
        } else {
          const result = projectPopupMonitorSummary(
            await deps.getSnapshot(),
            await deps.getCatalog(),
            deps.now?.(),
          );
          reply(result !== null, result ?? "unavailable");
        }
      } catch {
        reply(false, "unavailable");
      }
    })();
    return true;
  });
}
