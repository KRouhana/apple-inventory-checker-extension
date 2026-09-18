import { callExtensionApi } from "../platform/async.js";
import type { ExtensionRuntime } from "../platform/api.js";
import {
  POPUP_MONITOR_SUMMARY_PROTOCOL,
  PopupMonitorSummarySchema,
  type PopupMonitorSummary,
  type PopupWatchItem,
} from "../platform/popup-summary-messages.js";

export class PopupMonitorSummaryError extends Error {}
async function request(
  runtime: ExtensionRuntime,
  type: "GET_SUMMARY" | "OPEN_AVAILABLE",
  fields: Record<string, string> = {},
  timeoutMs = 2500,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const input = { protocol: POPUP_MONITOR_SUMMARY_PROTOCOL, type, ...fields };
    const raw = await Promise.race([
      callExtensionApi<unknown>(runtime, (cb, promise) =>
        promise ? runtime.sendMessage(input) : runtime.sendMessage(input, cb),
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new PopupMonitorSummaryError(
                "The monitor did not respond. Open Settings and try again.",
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new PopupMonitorSummaryError("Could not load the monitor.");
    const data = raw as Record<string, unknown>;
    if (
      data.protocol !== POPUP_MONITOR_SUMMARY_PROTOCOL ||
      data.type !== "RESULT" ||
      data.request !== type ||
      data.ok !== true ||
      Object.keys(data).sort().join() !==
        ["protocol", "type", "request", "ok", "result"].sort().join()
    )
      throw new PopupMonitorSummaryError(
        "Could not load the monitor. Open Settings to check it.",
      );
    return data.result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
export async function requestPopupMonitorSummary(
  runtime: ExtensionRuntime,
  timeoutMs = 2500,
): Promise<PopupMonitorSummary> {
  const parsed = PopupMonitorSummarySchema.safeParse(
    await request(runtime, "GET_SUMMARY", {}, timeoutMs),
  );
  if (!parsed.success)
    throw new PopupMonitorSummaryError("Could not read watch status.");
  return parsed.data;
}
const labels: Record<PopupWatchItem["status"], string> = {
  available: "Available",
  unavailable: "Out of stock",
  ineligible: "Pickup unavailable",
  unknown: "Unknown",
  waiting: "Waiting for first check",
  stale: "Check needed",
  paused: "Paused",
  retired: "Model or store removed",
};
function checkedAt(value: string | null): string {
  if (!value) return "Not checked yet";
  return `Checked ${new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
}
export async function mountPopupMonitorSummary(
  document: Document,
  runtime: ExtensionRuntime,
  options: { openSettings?: () => void; timeoutMs?: number } = {},
): Promise<void> {
  const list = document.querySelector<HTMLElement>("[data-watches]");
  const status = document.querySelector<HTMLElement>("[data-popup-status]");
  if (!list || !status) return;
  status.textContent = "Loading watches…";
  try {
    const summary = await requestPopupMonitorSummary(
      runtime,
      options.timeoutMs,
    );
    list.replaceChildren();
    if (summary.watches.length === 0) {
      status.textContent = "Let’s set up your first watch.";
      const setup = document.createElement("button");
      setup.type = "button";
      setup.className = "setup-watch";
      setup.textContent = "Set up your first watch";
      setup.addEventListener("click", () => options.openSettings?.());
      list.append(setup);
      return;
    }
    status.textContent = `${summary.watches.length} saved watch${summary.watches.length === 1 ? "" : "es"}`;
    for (const watch of summary.watches) {
      const card = document.createElement("article");
      card.className = "watch-card";
      const heading = document.createElement("h2");
      heading.textContent = watch.title;
      card.append(heading);
      const region = document.createElement("p");
      region.className = "watch-region";
      region.textContent = watch.market.toUpperCase();
      card.append(region);
      for (const item of watch.items) {
        const row = document.createElement("div");
        row.className = "store-row";
        if (watch.items.some((other) => other.sku !== item.sku)) {
          const phone = document.createElement("p");
          phone.className = "item-phone";
          phone.textContent = item.title;
          row.append(phone);
        }
        const top = document.createElement("div");
        top.className = "store-top";
        const name = document.createElement("strong");
        name.textContent = item.storeName;
        const badge = document.createElement("span");
        badge.className = `stock stock--${item.status}`;
        badge.textContent = labels[item.status];
        top.append(name, badge);
        row.append(top);
        const time = document.createElement("p");
        time.className = "checked-at";
        time.textContent = checkedAt(item.lastCheckedAt);
        row.append(time);
        if (item.status === "available") {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = "Open at Apple";
          button.className = "open-apple";
          button.addEventListener("click", () => {
            button.disabled = true;
            button.textContent = "Opening…";
            void request(
              runtime,
              "OPEN_AVAILABLE",
              {
                watchId: watch.id,
                sku: item.sku,
                storeNumber: item.storeNumber,
              },
              5000,
            ).then(
              (result) => {
                if (result === "opened") {
                  button.textContent = "Opened at Apple";
                  button.disabled = false;
                } else {
                  button.textContent = "Availability changed";
                  status.textContent =
                    "This result is no longer current. Open Settings to check the watch.";
                }
              },
              () => {
                button.textContent = "Try again";
                button.disabled = false;
                status.textContent =
                  "Could not open Apple. Open Settings to check this watch.";
              },
            );
          });
          row.append(button);
        }
        if (item.status === "unknown" || item.status === "stale") {
          const help = document.createElement("p");
          help.className = "status-help";
          help.textContent =
            item.status === "unknown"
              ? "Stock could not be verified. Details in Settings."
              : "This result needs a fresh check.";
          row.append(help);
        }
        card.append(row);
      }
      list.append(card);
    }
  } catch {
    status.textContent =
      "Could not load watches. Open Settings to check the monitor.";
  }
}
