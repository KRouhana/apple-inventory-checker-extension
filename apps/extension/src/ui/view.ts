import type {
  LocalWatch,
  WatchDeliveryChannels,
} from "../../../../packages/core/src/local-monitor-contracts.js";
import { DEFAULT_LOCAL_POLL_INTERVAL_SEC } from "../../../../packages/core/src/local-monitor-contracts.js";
import {
  EMPTY_WATCH_SELECTION,
  dimensionsForVariant,
  modelLabel,
  normalizeWatchSelection,
  selectedVariant,
  selectorOptions,
  type WatchSelectionDraft,
} from "./catalog-presentation.js";
import {
  dispatchMonitorCommand,
  type LocalMonitorCycleReport,
  type LocalMonitorUiCatalog,
  type MonitorUiItem,
  type LocalMonitorUiStore,
  type MonitorUiSnapshot,
  type MonitorUiController,
  type PersonalTelegramUiController,
} from "./controller.js";
import type { PublicTelegramStatus } from "../platform/telegram-messages.js";
import { buildWatchFromDraft, makeUiWatchId } from "./watch-draft.js";

interface UiState {
  snapshot: MonitorUiSnapshot | null;
  catalog: LocalMonitorUiCatalog | null;
  selection: WatchSelectionDraft;
  locationInput: string;
  lookupStores: readonly LocalMonitorUiStore[];
  hasLookupResult: boolean;
  /** Original edit values survive a transient/invalid lookup attempt. */
  savedStoreNumbers: readonly string[];
  lookupRequestGeneration: number;
  lookupPending: boolean;
  selectedStoreNumbers: readonly string[];
  pollAnchorStoreNumber: string;
  pollIntervalSec: number;
  deliveryChannels: WatchDeliveryChannels;
  editingWatchId: string | null;
  message: string;
  messageKind: "info" | "error";
  busy: boolean;
  telegramStatus: PublicTelegramStatus | null;
  telegramBusy: boolean;
  telegramStatusUnavailable: boolean;
  desktopTestBusy: boolean;
}

export interface MountedMonitorUi {
  refresh(): Promise<void>;
  destroy(): void;
}

const DEFAULT_CHANNELS: WatchDeliveryChannels = {
  desktop: true,
  personalTelegram: false,
  hostedRelay: false,
};
const MIN_INTERVAL_MINUTES = 2;
const MAX_INTERVAL_MINUTES = 60;
const DEFAULT_UI_POLL_INTERVAL_SEC = Math.max(
  DEFAULT_LOCAL_POLL_INTERVAL_SEC,
  MIN_INTERVAL_MINUTES * 60,
);
const OPEN_AT_APPLE_MAX_AGE_MS = 10 * 60_000;
const TELEGRAM_ORIGIN = "https://t.me";

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    const escapes: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    };
    return escapes[character] ?? character;
  });
}

function formatAt(value: string | null | undefined): string {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleString();
}

function displayStatus(
  item: MonitorUiItem | undefined,
  watch: LocalWatch,
): string {
  if (!item) return watch.enabled ? "Waiting for first check" : "Paused";
  if (item.status === "unknown") {
    return item.lastKnownStatus
      ? `Unknown (last known ${item.lastKnownStatus})`
      : "Unknown (no successful check yet)";
  }
  return item.status;
}

function latestForWatch(
  snapshot: MonitorUiSnapshot,
  watch: LocalWatch,
): MonitorUiItem | undefined {
  return snapshot.items
    .filter((item) => item.watchId === watch.id)
    .sort(
      (left, right) =>
        Date.parse(right.lastCheckedAt) - Date.parse(left.lastCheckedAt),
    )[0];
}

function availableItemsForWatch(
  snapshot: MonitorUiSnapshot,
  watch: LocalWatch,
): readonly MonitorUiItem[] {
  const now = Date.now();
  return snapshot.items.filter((item) => {
    const checkedAt = Date.parse(item.lastCheckedAt);
    const successfulAt = item.lastSuccessfulAt
      ? Date.parse(item.lastSuccessfulAt)
      : Number.NaN;
    return (
      watch.enabled &&
      item.watchId === watch.id &&
      item.status === "available" &&
      item.lastCheckedAt === item.lastSuccessfulAt &&
      Number.isFinite(checkedAt) &&
      Number.isFinite(successfulAt) &&
      successfulAt >= now - OPEN_AT_APPLE_MAX_AGE_MS &&
      successfulAt <= now + 60_000
    );
  });
}

function catalogIssueForWatch(
  catalog: LocalMonitorUiCatalog | null,
  watch: LocalWatch,
): string | null {
  if (!catalog) return "Catalog unavailable";
  const market = catalog.markets.find((entry) => entry.code === watch.market);
  if (!market) return "Catalog no longer supports this region";
  if (
    !watch.skus.every((sku) =>
      market.variants.some((variant) => variant.sku === sku),
    )
  ) {
    return "A selected variant is no longer supported by the catalog";
  }
  if (
    !watch.storeNumbers.every((id) =>
      market.stores.some((store) => store.storeNumber === id),
    )
  ) {
    return "A selected store is no longer supported by the catalog";
  }
  return null;
}

function reportMessage(report: LocalMonitorCycleReport): string {
  if (report.kind === "busy")
    return "A check is already running. The existing result will be used.";
  if (report.kind === "host_backoff")
    return "Apple request backoff is active. No unavailable result was inferred.";
  if (report.kind === "storage_error")
    return "Local monitor storage needs recovery before another check.";
  const unsupported = report.unsupportedWatchIds.length
    ? ` ${report.unsupportedWatchIds.length} watch${report.unsupportedWatchIds.length === 1 ? "" : "es"} need catalog attention.`
    : "";
  const queued = report.queuedEvents
    ? ` ${report.queuedEvents} alert event${report.queuedEvents === 1 ? "" : "s"} queued.`
    : "";
  return `Checked ${report.attemptedBatches} request batch${report.attemptedBatches === 1 ? "" : "es"}.${unsupported}${queued}`;
}

function option(
  value: string,
  label: string,
  selected: string,
  disabled = false,
): string {
  return `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}${disabled ? " disabled" : ""}>${escapeHtml(label)}</option>`;
}

function checked(value: boolean): string {
  return value ? " checked" : "";
}

function disabled(value: boolean): string {
  return value ? " disabled" : "";
}

function currentMarket(
  catalog: LocalMonitorUiCatalog | null,
  selection: WatchSelectionDraft,
) {
  return catalog?.markets.find((market) => market.code === selection.market);
}

/**
 * The catalog remains authoritative. Lookup results may refine the visible
 * choices, but they cannot add an arbitrary store number to a watch draft.
 */
function savedStoreChoices(
  catalog: LocalMonitorUiCatalog | null,
  selection: WatchSelectionDraft,
  storeNumbers: readonly string[],
): readonly LocalMonitorUiStore[] {
  const market = currentMarket(catalog, selection);
  return storeNumbers.map(
    (storeNumber) =>
      market?.stores.find((store) => store.storeNumber === storeNumber) ?? {
        storeNumber,
        name: `Saved public store ${storeNumber}`,
        city: null,
        region: null,
      },
  );
}

function visibleStoreChoices(state: UiState): readonly LocalMonitorUiStore[] {
  if (state.hasLookupResult) return state.lookupStores;
  // An edit must keep its saved public-store IDs selectable after a transient
  // lookup failure. A successful new lookup intentionally replaces this list.
  return state.editingWatchId
    ? savedStoreChoices(state.catalog, state.selection, state.savedStoreNumbers)
    : [];
}

type LookupFailureReason =
  | "invalid_postal_code"
  | "apple_blocked"
  | "network_error"
  | "timeout"
  | "invalid_response"
  | "storage_error";

function lookupFailureReason(value: unknown): LookupFailureReason | null {
  if (!value || typeof value !== "object" || !("reason" in value)) return null;
  const reason = value.reason;
  return typeof reason === "string" &&
    [
      "invalid_postal_code",
      "apple_blocked",
      "network_error",
      "timeout",
      "invalid_response",
      "storage_error",
    ].includes(reason)
    ? (reason as LookupFailureReason)
    : null;
}

function lookupFailureMessage(
  state: UiState,
  reason: LookupFailureReason | null = null,
): string {
  if (reason === "invalid_postal_code")
    return "Check the postal-code format for the selected region and try again.";
  if (reason === "apple_blocked")
    return "Apple did not complete this store lookup. Try again later.";
  if (reason === "network_error")
    return "Could not reach Apple to load stores. Check your connection and try again.";
  if (reason === "timeout") return "The store lookup timed out. Try again.";
  if (reason === "invalid_response")
    return "Could not verify stores from Apple's response. Try again.";
  if (reason === "storage_error")
    return "Could not save or load store data. Try again.";
  return visibleStoreChoices(state).length > 0
    ? "Could not load stores. Existing store choices were kept. Try again."
    : "Could not load stores. Please try again shortly.";
}

function renderStoreChoices(
  stores: readonly LocalMonitorUiStore[],
  selectedStoreNumbers: readonly string[],
  label: string,
): string {
  return `<div class="store-results" role="group" aria-label="${escapeHtml(label)}">${stores
    .map(
      (store) =>
        `<label class="check"><input type="checkbox" data-store-number="${escapeHtml(store.storeNumber)}"${checked(selectedStoreNumbers.includes(store.storeNumber))} />${escapeHtml(store.name)} <span>${escapeHtml([store.city, store.region].filter(Boolean).join(", ") || store.storeNumber)} · ${escapeHtml(store.storeNumber)}</span></label>`,
    )
    .join("")}</div>`;
}

function checkFailureMessage(item: MonitorUiItem | undefined): string | null {
  if (!item || item.status !== "unknown") return null;
  const failure = item.lastFailure;
  let detail: string;
  switch (failure?.reason) {
    case "http_error":
      detail = `Apple returned HTTP ${failure.httpStatus ?? "error"} instead of a usable pickup result. Wait for the next scheduled check; repeated manual retries may not help.`;
      break;
    case "request_failed":
      detail =
        "The Apple request could not complete. Check your internet connection; the request may also have timed out.";
      break;
    case "identity_mismatch":
      detail =
        "Apple returned product details that did not match the selected phone. The result was ignored to avoid reporting stock for the wrong device.";
      break;
    case "invalid_response":
      detail = "Apple's response could not be verified as pickup inventory.";
      break;
    case "missing_result":
      detail =
        "Apple's response did not include this phone and store combination.";
      break;
    case "unrecognized_availability":
      detail =
        "Apple returned a pickup status the monitor could not interpret safely.";
      break;
    case "catalog_unavailable":
      detail =
        "The local product or store catalog could not be validated for this check.";
      break;
    default:
      detail =
        "The previous check did not produce a verified pickup result. No detailed reason was saved; the next check will record one.";
  }
  return `${detail} Stock is unknown, not confirmed out of stock. No stock alert is sent for an unknown result.`;
}

function renderWatchCard(state: UiState, watch: LocalWatch): string {
  const snapshot = state.snapshot;
  if (!snapshot) return "";
  const item = latestForWatch(snapshot, watch);
  const catalogIssue = catalogIssueForWatch(state.catalog, watch);
  const failureMessage = checkFailureMessage(item);
  const pending = snapshot.pendingDelivery.filter(
    (entry) => entry.watchId === watch.id,
  ).length;
  const title =
    state.catalog?.markets
      .find((market) => market.code === watch.market)
      ?.variants.find((variant) => variant.sku === watch.skus[0])?.title ??
    watch.skus.join(", ");
  const watchStoreLabels = watch.storeNumbers.map((storeNumber) => {
    const store = state.catalog?.markets
      .find((entry) => entry.code === watch.market)
      ?.stores.find((entry) => entry.storeNumber === storeNumber);
    return store ? `${store.name} · ${store.storeNumber}` : storeNumber;
  });
  const available = availableItemsForWatch(snapshot, watch);
  const intervalMinutes = watch.pollIntervalSec / 60;
  const checkExplanation = watch.enabled
    ? `Checks continue after stock is found every ${intervalMinutes} minute${intervalMinutes === 1 ? "" : "s"}. Unchanged stock does not repeat an alert; pause this watch manually when you no longer want checks.`
    : "This watch is paused. Resume it manually when you want checks to continue.";
  const market = state.catalog?.markets.find(
    (entry) => entry.code === watch.market,
  );
  const handoff = available.length
    ? `<div class="handoff"><p class="field-help">Apple will confirm current pickup eligibility. This opens Apple for you to continue manually; it does not reserve or purchase a device.</p>${available
        .map((entry) => {
          const storeName =
            market?.stores.find(
              (store) => store.storeNumber === entry.storeNumber,
            )?.name ?? entry.storeNumber;
          const variantTitle = market?.variants.find(
            (variant) => variant.sku === entry.sku,
          )?.title;
          const label =
            watch.skus.length > 1 && variantTitle
              ? `Open ${variantTitle} at ${storeName}`
              : `Open at Apple · ${storeName}`;
          return `<button type="button" class="secondary" data-action="open-available-at-apple" data-watch-id="${escapeHtml(watch.id)}" data-sku="${escapeHtml(entry.sku)}" data-store-number="${escapeHtml(entry.storeNumber)}"${disabled(state.busy)}>${escapeHtml(label)}</button>`;
        })
        .join("")}</div>`
    : "";
  return `<article class="watch-card" data-watch-id="${escapeHtml(watch.id)}">
    <div class="watch-card__top"><div><p class="eyebrow">${escapeHtml(watch.market.toUpperCase())} · ${escapeHtml(watchStoreLabels.join("; "))}</p><h3>${escapeHtml(title)}</h3></div><span class="status status--${item?.status ?? "waiting"}">${escapeHtml(displayStatus(item, watch))}</span></div>
    ${catalogIssue ? `<p class="notice notice--error">${escapeHtml(catalogIssue)}. Checks are kept honest and will not be treated as unavailable.</p>` : ""}
    ${failureMessage ? `<p class="notice notice--info">${escapeHtml(failureMessage)}</p>` : ""}
    <dl class="watch-meta"><div><dt>Last attempt</dt><dd>${escapeHtml(formatAt(item?.lastCheckedAt))}</dd></div><div><dt>Last successful</dt><dd>${escapeHtml(formatAt(item?.lastSuccessfulAt))}</dd></div><div><dt>Queued alerts</dt><dd>${pending}</dd></div></dl>
    <p class="field-help">${escapeHtml(checkExplanation)}</p>
    ${handoff}<div class="button-row"><button type="button" data-action="check-watch" data-watch-id="${escapeHtml(watch.id)}"${disabled(!state.snapshot || state.busy)}>Check now</button><button type="button" class="secondary" data-action="toggle-watch" data-watch-id="${escapeHtml(watch.id)}"${disabled(state.busy)}>${watch.enabled ? "Pause" : "Resume"}</button><button type="button" class="tertiary" data-action="edit-watch" data-watch-id="${escapeHtml(watch.id)}"${disabled(state.busy)}>Edit</button><button type="button" class="tertiary danger" data-action="delete-watch" data-watch-id="${escapeHtml(watch.id)}"${disabled(state.busy)}>Delete</button></div>
  </article>`;
}

function renderHistory(state: UiState): string {
  const history = state.snapshot?.history ?? [];
  if (history.length === 0)
    return '<p class="empty">No alert transitions yet. Failed or blocked checks remain unknown and do not create a restock event.</p>';
  return `<ol class="history">${history
    .slice(0, 30)
    .map((event) => {
      const matches = (state.catalog?.markets ?? []).filter(
        (market) =>
          market.variants.some((variant) => variant.sku === event.sku) &&
          market.stores.some(
            (store) => store.storeNumber === event.storeNumber,
          ),
      );
      const market = matches.length === 1 ? matches[0] : undefined;
      const title = market?.variants.find(
        (variant) => variant.sku === event.sku,
      )?.title;
      const store = market?.stores.find(
        (entry) => entry.storeNumber === event.storeNumber,
      );
      return `<li><strong>${escapeHtml(event.to)}</strong> · ${escapeHtml(title ?? event.sku)} at ${escapeHtml(store ? `${store.name} · ${store.storeNumber}` : event.storeNumber)}<time>${escapeHtml(formatAt(event.at))}</time></li>`;
    })
    .join("")}</ol>`;
}

function validatedPairingUrl(status: {
  pairingCommand: string;
}): string | null {
  const pairingUrl = (status as { pairingUrl?: unknown }).pairingUrl;
  const commandMatch = /^INVENTORY SIGNAL ([a-f0-9]{64})$/.exec(
    status.pairingCommand,
  );
  if (!commandMatch || typeof pairingUrl !== "string") return null;
  try {
    const url = new URL(pairingUrl);
    const username = /^\/([A-Za-z0-9_]{1,32})$/.exec(url.pathname)?.[1];
    const nonce = url.searchParams.get("start");
    if (
      url.protocol !== "https:" ||
      url.hostname !== "t.me" ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      !username ||
      !nonce ||
      nonce !== commandMatch[1] ||
      !/^[a-f0-9]{64}$/.test(nonce) ||
      Array.from(url.searchParams.keys()).length !== 1 ||
      pairingUrl !== `${TELEGRAM_ORIGIN}/${username}?start=${nonce}`
    )
      return null;
    return pairingUrl;
  } catch {
    return null;
  }
}

function renderTelegramSetup(
  state: UiState,
  telegram: PersonalTelegramUiController | undefined,
): string {
  if (!telegram)
    return `<fieldset><legend>Personal Telegram</legend><p class="empty">Personal Telegram setup is not available until the local background is updated.</p></fieldset>`;
  const status = state.telegramStatus;
  const busy = disabled(state.telegramBusy);
  let body: string;
  if (state.telegramStatusUnavailable) {
    body = `<p class="notice notice--error">The saved Telegram connection could not be read. Reload this page to try again. If it stays unavailable, disconnect the saved connection and save your bot token again. Your watches will be kept.</p><button type="button" class="tertiary danger" data-action="telegram-disconnect"${busy}>Disconnect saved Telegram connection</button>`;
  } else if (!status || status.kind === "disconnected") {
    body = `<p>Connect your bot once. The connection has no expiry and is saved in this browser profile across browser sessions. Paste your token, save it, then send a test notification.</p><p class="field-help">Your bot credential is stored encrypted in this browser profile and sent directly to Telegram for authentication. <a href="https://krouhana.github.io/apple-inventory-checker-extension/privacy.html" target="_blank" rel="noopener noreferrer">Privacy details</a>.</p><label>Bot token<input data-telegram-token type="password" autocomplete="off" spellcheck="false" /></label><div class="button-row"><button type="button" data-action="telegram-start"${busy}>Save token</button></div>`;
  } else if (status.kind === "token_saved" || status.kind === "pairing") {
    const botUrl =
      status.kind === "token_saved"
        ? status.botUsername && /^[A-Za-z0-9_]{5,32}$/.test(status.botUsername)
          ? `https://t.me/${status.botUsername}`
          : null
        : validatedPairingUrl(status)?.split("?")[0];
    body = `<p>Token saved. Send a test notification to finish connecting. Your setup stays saved across sessions with no expiry.</p><div class="button-row"><button type="button" data-action="telegram-test"${busy}>Send test notification</button><button type="button" class="tertiary" data-action="telegram-disconnect"${busy}>Remove token</button></div><p class="field-help">If no chat is found, ${botUrl ? `<a href="${escapeHtml(botUrl)}" target="_blank" rel="noopener noreferrer">open your bot</a>` : "open your bot in Telegram"}, send any message once, then try the test again. Use a dedicated personal bot.</p>`;
  } else if (status.kind === "connected") {
    const bot = status.botUsername
      ? `@${status.botUsername}`
      : "your connected bot";
    body = `<p>Connected to ${escapeHtml(bot)}. No expiry. Saved in this browser profile across sessions; used for any watch where you select Personal Telegram.</p><div class="button-row"><button type="button" data-action="telegram-test"${busy}>Send Telegram test notification</button><button type="button" class="tertiary danger" data-action="telegram-disconnect"${busy}>Disconnect</button></div>`;
  } else {
    body = `<p>Personal Telegram is not supported by this browser target. No setup request was made.</p>`;
  }
  return `<fieldset${disabled(state.telegramBusy)}><legend>Personal Telegram</legend>${body}</fieldset>`;
}

function renderDesktopDiagnostic(
  state: UiState,
  controller: MonitorUiController,
): string {
  return `<fieldset><legend>Desktop notifications</legend><p>Schedules a fixed test notification only. It does not report stock or confirm that your operating system displayed it.</p><div class="button-row"><button type="button" data-action="desktop-test"${disabled(controller.desktopDiagnostic === undefined || state.desktopTestBusy)}>Send test notification</button></div></fieldset>`;
}

function render(state: UiState, controller: MonitorUiController): string {
  const catalog = state.catalog;
  // Telegram pairing/disconnect changes channel authorization. Keep watch
  // edits disabled until that background operation has settled.
  const interactive =
    controller.capabilities.monitor && !state.busy && !state.telegramBusy;
  const options = catalog ? selectorOptions(catalog, state.selection) : null;
  const selected = catalog ? selectedVariant(catalog, state.selection) : null;
  const stores = visibleStoreChoices(state);
  const title = state.editingWatchId ? "Edit watch" : "Create a watch";
  const message = state.message
    ? `<p class="notice notice--${state.messageKind}" role="status" aria-live="polite">${escapeHtml(state.message)}</p>`
    : "";
  const integration = !controller.capabilities.monitor
    ? `<aside class="integration-gap" role="status"><strong>Monitor connection required</strong><p>${escapeHtml(controller.capabilities.reason ?? "The local monitor controller is unavailable.")}</p><p>This page does not bypass the background, write storage directly, or make Apple requests. L08/platform wiring must provide the sender-validated controller.</p></aside>`
    : "";
  const regionOptions =
    options?.markets
      .map((market) => option(market.code, market.name, state.selection.market))
      .join("") ?? "";
  const modelOptions =
    options?.models
      .map((model) =>
        option(
          model,
          modelLabel(
            catalog!.markets.find(
              (market) => market.code === state.selection.market,
            )!,
            model,
          ),
          state.selection.model,
        ),
      )
      .join("") ?? "";
  const storageOptions =
    options?.storage
      .map((value) => option(value, value, state.selection.storage))
      .join("") ?? "";
  const colorOptions =
    options?.colors
      .map((value) => option(value, value, state.selection.color))
      .join("") ?? "";
  const selectionSummary = selected
    ? `<p class="selection-summary" aria-live="polite">Selected: <strong>${escapeHtml(selected.title)}</strong> <span>· ${escapeHtml(selected.sku)}</span></p>`
    : '<p class="selection-summary field-help" aria-live="polite">Choose a region, model, storage, and colour to identify a variant.</p>';
  const channelDisabled = !interactive;
  const telegramConnected =
    state.telegramStatus?.kind === "connected" &&
    !state.telegramStatusUnavailable;
  const canSubmitStores =
    state.selectedStoreNumbers.length > 0 &&
    Boolean(state.pollAnchorStoreNumber) &&
    (Boolean(state.editingWatchId) || state.hasLookupResult);
  const creationPrerequisite =
    !state.editingWatchId && !canSubmitStores
      ? '<p class="field-help" role="status">Select stores from a postal-code search to create this watch.</p>'
      : "";
  return `<main class="monitor-shell">
    <header class="monitor-header"><div><p class="eyebrow">Inventory Signal</p><h1>Settings &amp; watches</h1><p class="lede">Runs only while this desktop browser is open and awake. It never purchases a device.</p></div><div class="header-actions"><button type="button" data-action="start"${disabled(!interactive)}>Start monitor</button><button type="button" class="secondary" data-action="check-all"${disabled(!interactive)}>Check all now</button></div></header>
    ${integration}${message}
    <section class="card" aria-labelledby="watch-form-title"><div class="section-heading"><div><p class="eyebrow">No account required</p><h2 id="watch-form-title">${title}</h2></div>${state.editingWatchId ? '<button type="button" class="tertiary" data-action="cancel-edit">Cancel edit</button>' : ""}</div>
      <form data-watch-form>
        <fieldset${disabled(!controller.capabilities.catalog || !interactive)}><legend>Phone</legend><div class="form-grid">
          <label>Region<select name="market" aria-label="Region"><option value="">Choose a region</option>${regionOptions}</select></label>
          <label>Model<select name="model" aria-label="Model"><option value="">Choose a model</option>${modelOptions}</select></label>
          <label>Storage<select name="storage" aria-label="Storage"${disabled(!state.selection.model)}><option value="">Choose storage</option>${storageOptions}</select></label>
          <label>Colour<select name="color" aria-label="Colour"${disabled(!state.selection.storage)}><option value="">Choose colour</option>${colorOptions}</select></label>
        </div>${selectionSummary}</fieldset>
        <fieldset${disabled(!controller.capabilities.storeLookup || state.telegramBusy || (state.busy && !state.lookupPending))}><legend>Find public stores</legend>${controller.capabilities.storeLookup ? '<p class="field-help">Enter a postal code to find public stores in the selected region. It is used only for this lookup and stays only in this page while it is open.</p><div class="lookup-row"><label>Postal code<input name="location" inputmode="text" autocomplete="postal-code" value="' + escapeHtml(state.locationInput) + '" /></label><button type="button" data-action="lookup-stores"' + disabled(!interactive) + ">Find stores</button></div>" : '<p class="empty">Store lookup is not enabled in this version.</p>'}
          ${
            !controller.capabilities.storeLookup
              ? ""
              : state.hasLookupResult
                ? stores.length
                  ? `<p class="field-help">Choose from the latest successful lookup. The first selected store is used as the polling anchor.</p>${renderStoreChoices(stores, state.selectedStoreNumbers, "Stores returned by this lookup")}`
                  : '<p class="empty">No supported public stores matched this lookup.</p>'
                : state.editingWatchId
                  ? `<p class="field-help">Saved stores remain selected until you successfully look up replacements.</p>${renderStoreChoices(stores, state.selectedStoreNumbers, "Saved stores for this watch")}`
                  : '<p class="empty">Choose a region, enter a postal code, then find public stores.</p>'
          }
        </fieldset>
        ${renderTelegramSetup(state, controller.personalTelegram)}
        ${renderDesktopDiagnostic(state, controller)}
        <fieldset${disabled(!interactive)}><legend>Monitoring and channels</legend><div class="form-grid"><label>Check interval (2–60 minutes)<input name="interval" aria-label="Check interval (2–60 minutes)" type="number" inputmode="numeric" min="${MIN_INTERVAL_MINUTES}" max="${MAX_INTERVAL_MINUTES}" step="1" required value="${escapeHtml(String(state.pollIntervalSec / 60))}" /><span class="field-help">Whole minutes only; choose 2–60 minutes.</span></label></div><div class="channel-list"><label class="check"><input type="checkbox" name="desktop"${checked(state.deliveryChannels.desktop)}${disabled(channelDisabled)} />Desktop notifications <span>Delivery verification is tracked separately.</span></label><label class="check"><input type="checkbox" name="telegram"${checked(state.deliveryChannels.personalTelegram)}${disabled(channelDisabled || !telegramConnected)} />Personal Telegram <span>${telegramConnected ? "Connected locally. Save this watch to enable alerts." : state.telegramStatus?.kind === "pairing" || state.telegramStatus?.kind === "token_saved" ? "Send a test notification above to enable Telegram alerts." : "Connect your bot above to enable Telegram alerts."}</span></label></div></fieldset>
        ${creationPrerequisite}<div class="button-row"><button type="submit"${disabled(!interactive || !controller.capabilities.catalog || !canSubmitStores)}>${state.editingWatchId ? "Save changes" : "Create watch"}</button></div>
      </form></section>
    <section class="section-block" aria-labelledby="watches-title"><div class="section-heading"><div><p class="eyebrow">Saved locally</p><h2 id="watches-title">Your watches</h2></div>${state.snapshot?.watches.length ? '<button type="button" class="tertiary danger" data-action="reset">Clear local monitor data</button>' : ""}</div>${state.snapshot ? (state.snapshot.watches.length ? state.snapshot.watches.map((watch) => renderWatchCard(state, watch)).join("") : '<p class="empty">No watches yet. Select a phone and public stores above.</p>') : '<p class="empty">Monitor state is unavailable until the background connection is wired.</p>'}</section>
    <section class="section-block" aria-labelledby="history-title"><div class="section-heading"><div><p class="eyebrow">Local history</p><h2 id="history-title">Alert transitions</h2></div></div>${renderHistory(state)}</section>
  </main>`;
}

function initialState(): UiState {
  return {
    snapshot: null,
    catalog: null,
    selection: { ...EMPTY_WATCH_SELECTION },
    locationInput: "",
    lookupStores: [],
    hasLookupResult: false,
    savedStoreNumbers: [],
    lookupRequestGeneration: 0,
    lookupPending: false,
    selectedStoreNumbers: [],
    pollAnchorStoreNumber: "",
    pollIntervalSec: DEFAULT_UI_POLL_INTERVAL_SEC,
    deliveryChannels: { ...DEFAULT_CHANNELS },
    editingWatchId: null,
    message: "",
    messageKind: "info",
    busy: false,
    telegramStatus: null,
    telegramBusy: false,
    telegramStatusUnavailable: false,
    desktopTestBusy: false,
  };
}

export function mountLocalMonitorUi(
  root: HTMLElement,
  controller: MonitorUiController,
  options: { requestTelegramHostPermission?: () => Promise<boolean> } = {},
): MountedMonitorUi {
  let state = initialState();
  let destroyed = false;
  let telegramRevision = 0;

  const rerender = () => {
    if (destroyed) return;
    root.innerHTML = render(state, controller);
    bindEvents();
  };

  const refresh = async () => {
    const revision = telegramRevision;
    let statusUnavailable = false;
    const loadedTelegramStatus = controller.personalTelegram
      ? await controller.personalTelegram.status().catch(() => {
          statusUnavailable = true;
          return state.telegramStatus;
        })
      : null;
    if (!controller.capabilities.monitor) {
      if (controller.capabilities.catalog) {
        try {
          state = { ...state, catalog: await controller.getCatalog() };
        } catch {
          // The page remains fail-closed: an unavailable local catalog only
          // removes selectors; it never falls back to an arbitrary source.
        }
      }
      const telegramStatus =
        revision === telegramRevision
          ? loadedTelegramStatus
          : state.telegramStatus;
      state = {
        ...state,
        telegramStatus,
        telegramStatusUnavailable:
          revision === telegramRevision
            ? statusUnavailable
            : state.telegramStatusUnavailable,
        ...(telegramStatus?.kind === "connected"
          ? {}
          : {
              deliveryChannels: {
                ...state.deliveryChannels,
                personalTelegram: false,
              },
            }),
      };
      rerender();
      return;
    }
    try {
      const [snapshot, catalog] = await Promise.all([
        controller.getSnapshot(),
        controller.getCatalog(),
      ]);
      const telegramStatus =
        revision === telegramRevision
          ? loadedTelegramStatus
          : state.telegramStatus;
      state = {
        ...state,
        snapshot,
        catalog,
        selection: catalog
          ? normalizeWatchSelection(catalog, state.selection)
          : { ...EMPTY_WATCH_SELECTION },
        telegramStatus,
        telegramStatusUnavailable:
          revision === telegramRevision
            ? statusUnavailable
            : state.telegramStatusUnavailable,
        ...(telegramStatus?.kind === "connected"
          ? {}
          : {
              deliveryChannels: {
                ...state.deliveryChannels,
                personalTelegram: false,
              },
            }),
      };
    } catch (error) {
      state = {
        ...state,
        message:
          error instanceof Error
            ? error.message
            : "Unable to load local monitor state.",
        messageKind: "error",
      };
    }
    rerender();
  };

  const run = async (
    operation: () => Promise<unknown>,
    pendingMessage = "",
  ) => {
    if (!controller.capabilities.monitor || state.busy) return;
    state = {
      ...state,
      busy: true,
      message: pendingMessage,
      messageKind: "info",
    };
    rerender();
    try {
      const result = await operation();
      state = {
        ...state,
        message: isCycleReport(result)
          ? reportMessage(result)
          : result === "opened"
            ? "Apple opened in a new tab. Confirm pickup and complete any purchase directly with Apple."
            : "Saved locally.",
        messageKind: "info",
      };
    } catch (error) {
      state = {
        ...state,
        message:
          error instanceof Error
            ? error.message
            : "The local monitor command failed.",
        messageKind: "error",
      };
    } finally {
      state = { ...state, busy: false };
      await refresh();
    }
  };

  const runTelegram = async (
    operation: () => Promise<PublicTelegramStatus>,
    successMessage = "Personal Telegram settings updated locally.",
  ) => {
    if (!controller.personalTelegram || state.telegramBusy || destroyed) return;
    telegramRevision += 1;
    state = { ...state, telegramBusy: true, message: "" };
    rerender();
    try {
      const telegramStatus = await operation();
      if (destroyed) return;
      telegramRevision += 1;
      state = {
        ...state,
        telegramStatus,
        telegramStatusUnavailable: false,
        deliveryChannels:
          telegramStatus.kind === "connected"
            ? state.deliveryChannels
            : { ...state.deliveryChannels, personalTelegram: false },
        message:
          telegramStatus.kind === "connected"
            ? successMessage === "Personal Telegram settings updated locally."
              ? "Telegram is connected and saved with no expiry. You can now select Personal Telegram for this watch or send a test notification."
              : successMessage
            : telegramStatus.kind === "pairing" ||
                telegramStatus.kind === "token_saved"
              ? "Token saved. Send a test notification to finish connecting."
              : "Personal Telegram settings updated locally.",
        messageKind: "info",
      };
    } catch (error) {
      // Expired pairing is cleared by the background. Refresh that state so
      // the page offers setup again instead of leaving a dead pairing link.
      let statusUnavailable = false;
      const telegramStatus = await controller.personalTelegram
        .status()
        .catch(() => {
          statusUnavailable = true;
          return state.telegramStatus;
        });
      if (destroyed) return;
      telegramRevision += 1;
      state = {
        ...state,
        telegramStatus,
        telegramStatusUnavailable: statusUnavailable,
        deliveryChannels:
          telegramStatus?.kind === "connected"
            ? state.deliveryChannels
            : { ...state.deliveryChannels, personalTelegram: false },
        message:
          error instanceof Error
            ? error.message
            : "Personal Telegram setup could not be completed.",
        messageKind: "error",
      };
    } finally {
      if (!destroyed) {
        state = { ...state, telegramBusy: false };
        rerender();
      }
    }
  };

  const checkPairingOnReturn = () => {
    const telegram = controller.personalTelegram;
    if (
      !telegram ||
      destroyed ||
      state.telegramBusy ||
      state.busy ||
      root.ownerDocument.visibilityState === "hidden" ||
      state.telegramStatus?.kind !== "pairing"
    )
      return;
    // One bounded check on return; no background polling or automatic messages.
    void runTelegram(async () => {
      const latest = await telegram.status();
      return latest;
    });
  };

  const updateSelection = (name: keyof WatchSelectionDraft, value: string) => {
    if (!state.catalog) return;
    const next = { ...state.selection, [name]: value } as WatchSelectionDraft;
    const selection = normalizeWatchSelection(state.catalog, next);
    const changedMarket =
      name === "market" && selection.market !== state.selection.market;
    state = {
      ...state,
      selection,
      ...(changedMarket
        ? {
            lookupStores: [],
            hasLookupResult: false,
            savedStoreNumbers: [],
            selectedStoreNumbers: [],
            pollAnchorStoreNumber: "",
            lookupRequestGeneration: state.lookupRequestGeneration + 1,
            lookupPending: false,
            busy: false,
          }
        : {}),
    };
    rerender();
  };

  const editWatch = (watch: LocalWatch) => {
    if (!state.catalog) return;
    const market = state.catalog.markets.find(
      (entry) => entry.code === watch.market,
    );
    const variant = market?.variants.find(
      (entry) => entry.sku === watch.skus[0],
    );
    if (!market || !variant) {
      state = {
        ...state,
        message:
          "This watch cannot be edited until its catalog entry is restored.",
        messageKind: "error",
      };
      rerender();
      return;
    }
    const dimensions = dimensionsForVariant(variant);
    state = {
      ...state,
      editingWatchId: watch.id,
      selection: {
        market: market.code,
        model: dimensions.model,
        storage: dimensions.storage ?? "",
        color: dimensions.color ?? "",
        sku: variant.sku,
      },
      lookupStores: [],
      hasLookupResult: false,
      savedStoreNumbers: watch.storeNumbers,
      selectedStoreNumbers: watch.storeNumbers,
      pollAnchorStoreNumber: watch.pollAnchor.storeNumber,
      pollIntervalSec: watch.pollIntervalSec,
      deliveryChannels: watch.deliveryChannels,
      lookupRequestGeneration: state.lookupRequestGeneration + 1,
      lookupPending: false,
      message:
        Number.isInteger(watch.pollIntervalSec / 60) &&
        watch.pollIntervalSec >= MIN_INTERVAL_MINUTES * 60 &&
        watch.pollIntervalSec <= MAX_INTERVAL_MINUTES * 60
          ? "Saved stores are retained until you successfully look up replacements."
          : "Replace this watch's interval with a whole value from 2 to 60 minutes before saving.",
      messageKind: "info",
    };
    rerender();
  };

  const bindEvents = () => {
    root
      .querySelector<HTMLFormElement>("[data-watch-form]")
      ?.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!state.catalog) return;
        const intervalMinutes = state.pollIntervalSec / 60;
        if (
          !Number.isInteger(intervalMinutes) ||
          intervalMinutes < MIN_INTERVAL_MINUTES ||
          intervalMinutes > MAX_INTERVAL_MINUTES
        ) {
          state = {
            ...state,
            message: "Choose a whole check interval from 2 to 60 minutes.",
            messageKind: "error",
          };
          rerender();
          return;
        }
        const old = state.editingWatchId
          ? state.snapshot?.watches.find(
              (watch) => watch.id === state.editingWatchId,
            )
          : undefined;
        const built = buildWatchFromDraft(state.catalog, {
          id: old?.id ?? makeUiWatchId(),
          selection: state.selection,
          selectedStoreNumbers: state.selectedStoreNumbers,
          pollAnchorStoreNumber: state.pollAnchorStoreNumber,
          pollIntervalSec: state.pollIntervalSec,
          enabled: old?.enabled ?? true,
          deliveryChannels: state.deliveryChannels,
          now: new Date().toISOString(),
          createdAt: old?.createdAt,
        });
        if (!built.success) {
          state = { ...state, message: built.message, messageKind: "error" };
          rerender();
          return;
        }
        void run(
          async () => {
            const result = await dispatchMonitorCommand(
              controller,
              old
                ? { type: "replace-watch", watch: built.watch }
                : { type: "add-watch", watch: built.watch },
            );
            state = {
              ...state,
              editingWatchId: null,
              selection: { ...EMPTY_WATCH_SELECTION },
              lookupStores: [],
              hasLookupResult: false,
              savedStoreNumbers: [],
              selectedStoreNumbers: [],
              pollAnchorStoreNumber: "",
              locationInput: "",
              pollIntervalSec: DEFAULT_UI_POLL_INTERVAL_SEC,
              deliveryChannels: { ...DEFAULT_CHANNELS },
            };
            return result;
          },
          old ? "Saving changes…" : "Saving watch and checking availability…",
        );
      });
    root
      .querySelectorAll<HTMLSelectElement>(
        "select[name=market], select[name=model], select[name=storage], select[name=color]",
      )
      .forEach((select) =>
        select.addEventListener("change", () =>
          updateSelection(
            select.name as keyof WatchSelectionDraft,
            select.value,
          ),
        ),
      );
    root
      .querySelector<HTMLInputElement>("input[name=location]")
      ?.addEventListener("input", (event) => {
        const input = event.currentTarget as HTMLInputElement;
        const value = input.value;
        state = {
          ...state,
          locationInput: value,
          lookupStores: [],
          hasLookupResult: false,
          ...(state.editingWatchId && !state.hasLookupResult
            ? {}
            : { selectedStoreNumbers: [], pollAnchorStoreNumber: "" }),
          lookupRequestGeneration: state.lookupRequestGeneration + 1,
          lookupPending: false,
          busy: false,
        };
        rerender();
        const replacement = root.querySelector<HTMLInputElement>(
          "input[name=location]",
        );
        replacement?.focus();
        replacement?.setSelectionRange(value.length, value.length);
      });
    root
      .querySelector<HTMLInputElement>("input[name=interval]")
      ?.addEventListener("input", (event) => {
        const minutes = Number((event.currentTarget as HTMLInputElement).value);
        state = {
          ...state,
          // Retain an invalid value as NaN until submit so the core-backed
          // draft validation reports it instead of silently rounding it.
          pollIntervalSec:
            Number.isInteger(minutes) &&
            minutes >= MIN_INTERVAL_MINUTES &&
            minutes <= MAX_INTERVAL_MINUTES
              ? minutes * 60
              : Number.NaN,
        };
      });
    root
      .querySelector<HTMLInputElement>("input[name=desktop]")
      ?.addEventListener("change", (event) => {
        state = {
          ...state,
          deliveryChannels: {
            ...state.deliveryChannels,
            desktop: (event.currentTarget as HTMLInputElement).checked,
          },
        };
      });
    root
      .querySelector<HTMLInputElement>("input[name=telegram]")
      ?.addEventListener("change", (event) => {
        if (state.telegramStatus?.kind !== "connected") return;
        state = {
          ...state,
          deliveryChannels: {
            ...state.deliveryChannels,
            personalTelegram: (event.currentTarget as HTMLInputElement).checked,
          },
        };
      });
    root
      .querySelectorAll<HTMLInputElement>("[data-store-number]")
      .forEach((input) =>
        input.addEventListener("change", () => {
          const storeNumber = input.dataset.storeNumber;
          if (!storeNumber) return;
          if (
            !visibleStoreChoices(state).some(
              (store) => store.storeNumber === storeNumber,
            )
          )
            return;
          const selected = new Set(state.selectedStoreNumbers);
          input.checked
            ? selected.add(storeNumber)
            : selected.delete(storeNumber);
          state = {
            ...state,
            selectedStoreNumbers: [...selected],
            pollAnchorStoreNumber: [...selected][0] ?? "",
          };
          rerender();
        }),
      );
    root
      .querySelectorAll<HTMLButtonElement>("button[data-action]")
      .forEach((button) =>
        button.addEventListener("click", () => {
          const action = button.dataset.action;
          const watchId = button.dataset.watchId;
          const telegram = controller.personalTelegram;
          if (action === "telegram-start" && telegram) {
            const tokenInput = root.querySelector<HTMLInputElement>(
              "[data-telegram-token]",
            );
            const token = (tokenInput?.value ?? "").trim();
            // Clear before any permission or background await; token never enters UiState.
            if (tokenInput) tokenInput.value = "";
            if (
              !/^\d{5,20}:[A-Za-z0-9_-]{20,256}$/.test(token) ||
              token.length > 277
            ) {
              state = {
                ...state,
                message:
                  "Paste the complete bot token into the Bot token field, then select Save token. The field is cleared after each attempt.",
                messageKind: "error",
              };
              rerender();
              return;
            }
            let permission: Promise<boolean>;
            try {
              // Must be called directly from this visible button click.
              permission = options.requestTelegramHostPermission
                ? options.requestTelegramHostPermission()
                : Promise.resolve(false);
            } catch {
              permission = Promise.resolve(false);
            }
            runTelegram(async () => {
              if (!(await permission))
                throw new Error(
                  "Telegram permission was not granted in this browser.",
                );
              return telegram.startPairing(token);
            });
          }
          if (action === "telegram-test" && telegram)
            void runTelegram(
              () => telegram.sendTest(),
              "Telegram accepted the test notification. Check your bot chat for receipt.",
            );
          if (action === "telegram-disconnect" && telegram)
            void runTelegram(() => telegram.disconnect()).then(() => {
              if (!destroyed) void refresh();
            });
          if (
            action === "desktop-test" &&
            controller.desktopDiagnostic &&
            !state.desktopTestBusy
          ) {
            state = { ...state, desktopTestBusy: true, message: "" };
            rerender();
            void controller.desktopDiagnostic.sendTest().then(
              (result) => {
                const message =
                  result === "scheduled"
                    ? "Test notification was scheduled. This does not confirm an operating-system receipt. If nothing appeared, check your operating-system notification settings and Focus/Do Not Disturb."
                    : result === "permission-denied"
                      ? "Desktop notification permission is not granted."
                      : result === "unsupported"
                        ? "Desktop test notifications are unavailable in this browser."
                        : result === "cooldown"
                          ? "Please wait before sending another test notification."
                          : result === "in-flight"
                            ? "A test notification request is already in progress."
                            : "The test notification could not be scheduled. Check browser or operating-system notification permissions; Safari may require permission in its containing app.";
                if (destroyed) return;
                state = {
                  ...state,
                  desktopTestBusy: false,
                  message,
                  messageKind: result === "scheduled" ? "info" : "error",
                };
                rerender();
              },
              () => {
                if (destroyed) return;
                state = {
                  ...state,
                  desktopTestBusy: false,
                  message: "The test notification could not be scheduled.",
                  messageKind: "error",
                };
                rerender();
              },
            );
          }
          if (action === "start")
            void run(() =>
              dispatchMonitorCommand(controller, { type: "start" }),
            );
          if (action === "check-all")
            void run(() =>
              dispatchMonitorCommand(controller, { type: "check-now" }),
            );
          if (action === "check-watch" && watchId)
            void run(() =>
              dispatchMonitorCommand(controller, {
                type: "check-now",
                watchIds: [watchId],
              }),
            );
          if (
            action === "open-available-at-apple" &&
            watchId &&
            button.dataset.sku &&
            button.dataset.storeNumber
          )
            void run(async () => {
              const result = await controller.openAvailableAtApple({
                watchId,
                sku: button.dataset.sku!,
                storeNumber: button.dataset.storeNumber!,
              });
              if (result !== "opened") {
                throw new Error(
                  "That availability result is no longer current. Run a new check before opening Apple.",
                );
              }
              return result;
            });
          if (action === "toggle-watch" && watchId) {
            const watch = state.snapshot?.watches.find(
              (entry) => entry.id === watchId,
            );
            if (watch)
              void run(() =>
                dispatchMonitorCommand(controller, {
                  type: "set-watch-enabled",
                  id: watch.id,
                  enabled: !watch.enabled,
                }),
              );
          }
          if (action === "edit-watch" && watchId) {
            const watch = state.snapshot?.watches.find(
              (entry) => entry.id === watchId,
            );
            if (watch) editWatch(watch);
          }
          if (action === "delete-watch" && watchId)
            void run(() =>
              dispatchMonitorCommand(controller, {
                type: "delete-watch",
                id: watchId,
              }),
            );
          if (action === "reset") {
            state = {
              ...state,
              lookupRequestGeneration: state.lookupRequestGeneration + 1,
              lookupPending: false,
            };
            void run(() =>
              dispatchMonitorCommand(controller, { type: "reset" }),
            );
          }
          if (action === "cancel-edit") {
            state = {
              ...state,
              editingWatchId: null,
              selection: { ...EMPTY_WATCH_SELECTION },
              lookupStores: [],
              hasLookupResult: false,
              savedStoreNumbers: [],
              selectedStoreNumbers: [],
              pollAnchorStoreNumber: "",
              lookupRequestGeneration: state.lookupRequestGeneration + 1,
              lookupPending: false,
              locationInput: "",
              pollIntervalSec: DEFAULT_UI_POLL_INTERVAL_SEC,
              deliveryChannels: { ...DEFAULT_CHANNELS },
            };
            rerender();
          }
          if (action === "lookup-stores") {
            if (
              !controller.lookupStores ||
              !state.selection.market ||
              !state.locationInput.trim()
            ) {
              state = {
                ...state,
                message:
                  "Enter a region and postal code before finding stores.",
                messageKind: "error",
              };
              rerender();
              return;
            }
            const input = {
              market: state.selection.market as LocalWatch["market"],
              userPostalInput: state.locationInput,
            };
            const lookupMarket = input.market;
            const lookupPostalInput = input.userPostalInput;
            const lookupRequestGeneration = state.lookupRequestGeneration + 1;
            state = {
              ...state,
              lookupRequestGeneration,
              lookupPending: true,
              busy: true,
              message: "",
            };
            rerender();
            const isCurrentLookup = () =>
              !destroyed &&
              state.lookupRequestGeneration === lookupRequestGeneration &&
              state.selection.market === lookupMarket &&
              state.locationInput === lookupPostalInput;
            void Promise.resolve()
              .then(() => controller.lookupStores!(input))
              .then(async (lookup) => {
                if (!isCurrentLookup()) return;
                if (lookup.kind !== "matches") {
                  // A transient lookup must not discard an editable watch's
                  // saved store IDs or a previous successful lookup.
                  state = {
                    ...state,
                    message:
                      lookup.kind === "throttled"
                        ? "Store lookup is temporarily paused. Try again later."
                        : lookup.kind === "unsupported"
                          ? "Store lookup is unavailable for this catalog."
                          : lookupFailureMessage(
                              state,
                              lookupFailureReason(lookup),
                            ),
                    messageKind: lookup.kind === "unknown" ? "error" : "info",
                    lookupPending: false,
                    busy: false,
                  };
                  rerender();
                  return;
                }
                const refreshedCatalog = await controller.getCatalog();
                if (!isCurrentLookup()) return;
                if (!refreshedCatalog) {
                  throw new Error("The current catalog is unavailable.");
                }
                const refreshedMarket = refreshedCatalog.markets.find(
                  (market) => market.code === lookupMarket,
                );
                const lookupStoreNumbers = lookup.stores.map(
                  (store) => store.storeNumber,
                );
                const uniqueStoreNumbers = new Set(lookupStoreNumbers);
                const storesAreCurrent =
                  refreshedMarket !== undefined &&
                  uniqueStoreNumbers.size === lookupStoreNumbers.length &&
                  lookupStoreNumbers.every((storeNumber) =>
                    refreshedMarket.stores.some(
                      (store) => store.storeNumber === storeNumber,
                    ),
                  );
                if (!storesAreCurrent || lookupStoreNumbers.length === 0) {
                  if (!isCurrentLookup()) return;
                  state = {
                    ...state,
                    catalog: refreshedCatalog,
                    // Invalid or empty results are not a replacement: keep an
                    // edit's saved store choices usable and untouched.
                    message: !storesAreCurrent
                      ? lookupFailureMessage(state, "invalid_response")
                      : visibleStoreChoices(state).length > 0
                        ? "No supported public stores matched this lookup. Existing store choices were kept."
                        : "No supported public stores matched this lookup.",
                    messageKind: !storesAreCurrent ? "error" : "info",
                    lookupPending: false,
                    busy: false,
                  };
                  rerender();
                  return;
                }
                const stores = lookupStoreNumbers.map(
                  (storeNumber) =>
                    refreshedMarket!.stores.find(
                      (store) => store.storeNumber === storeNumber,
                    )!,
                );
                state = {
                  ...state,
                  catalog: refreshedCatalog,
                  lookupStores: stores,
                  hasLookupResult: true,
                  selectedStoreNumbers: [],
                  pollAnchorStoreNumber: "",
                  message:
                    "Choose public stores returned by the latest lookup.",
                  messageKind: "info",
                  lookupPending: false,
                  busy: false,
                };
                rerender();
              })
              .catch(() => {
                if (!isCurrentLookup()) return;
                state = {
                  ...state,
                  message: lookupFailureMessage(state),
                  messageKind: "error",
                  lookupPending: false,
                  busy: false,
                };
                rerender();
              });
          }
        }),
      );
  };

  root.ownerDocument.defaultView?.addEventListener(
    "focus",
    checkPairingOnReturn,
  );
  root.ownerDocument.addEventListener("visibilitychange", checkPairingOnReturn);
  void refresh();
  return {
    refresh,
    destroy: () => {
      root.ownerDocument.defaultView?.removeEventListener(
        "focus",
        checkPairingOnReturn,
      );
      root.ownerDocument.removeEventListener(
        "visibilitychange",
        checkPairingOnReturn,
      );
      const tokenInput = root.querySelector<HTMLInputElement>(
        "[data-telegram-token]",
      );
      if (tokenInput) tokenInput.value = "";
      state = {
        ...state,
        lookupRequestGeneration: state.lookupRequestGeneration + 1,
        lookupPending: false,
      };
      destroyed = true;
      root.replaceChildren();
    },
  };
}

function isCycleReport(value: unknown): value is LocalMonitorCycleReport {
  return (
    value !== null &&
    typeof value === "object" &&
    "attemptedBatches" in value &&
    "kind" in value
  );
}
