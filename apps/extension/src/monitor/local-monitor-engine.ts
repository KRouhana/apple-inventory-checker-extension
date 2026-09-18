/**
 * Bounded, dependency-injected local monitoring engine.
 *
 * This module deliberately has no browser globals or entrypoint wiring. The
 * platform layer supplies alarms, storage, fetch, and notification adapters;
 * the engine owns only validated snapshot transitions and durable delivery
 * work. A worker can be terminated at any `await` without turning an upstream
 * failure into false out-of-stock data.
 */
import {
  ApplePickupFetchResponseSchema,
  capHistoryEvents,
  coalescePollBatches,
  createEmptySnapshot,
  DEFAULT_DELIVERY_COOLDOWN_MS,
  DEFAULT_LOCAL_POLL_INTERVAL_SEC,
  LocalAvailabilityEventSchema,
  MAX_DELIVERY_ATTEMPTS,
  MAX_PENDING_DELIVERY_EVENTS,
  MIN_LOCAL_POLL_INTERVAL_SEC,
  PENDING_DELIVERY_RETENTION_MS,
  parseLocalCatalogSnapshot,
  parseLocalDeliveryDispatchResult,
  parseLocalMonitorSnapshot,
  parseLocalWatch,
  reconcileWatchWithCatalog,
  type AppleFetchPort,
  type LocalAvailabilityEvent,
  type LocalCatalogSnapshot,
  type LocalDeliveryDispatchResult,
  type LocalDeliveryChannel,
  type LocalMonitorClock,
  type LocalMonitorSnapshot,
  type LocalSchedulerPort,
  type LocalStoragePort,
  type LocalWatch,
  type PendingDeliveryEvent,
  type WatchDeliveryState,
  type WatchHistoryEvent,
  type WatchItemState,
} from "../../../../packages/core/src/local-monitor-contracts.js";
import { parseApplePickupMessage } from "../../../../packages/core/src/apple-pickup.js";
import type {
  ApplePickupParseErrorCode,
  ApplePickupParseResult,
} from "../../../../packages/core/src/apple-pickup.js";
import { evaluateAvailabilityTransition } from "../../../../packages/core/src/transitions.js";
import type { AvailabilityStatus } from "../../../../packages/core/src/availability.js";

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const MAX_PICKUP_PARSE_DIAGNOSTIC_COUNT = 2_000;
const DEFAULT_DELIVERY_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 10 * 60 * 1_000;
const MAX_JITTER_MS = 5_000;
const MAX_PERSISTED_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const MAX_RECOVERABLE_PENDING_DEADLINE_MS =
  PENDING_DELIVERY_RETENTION_MS + MAX_PERSISTED_FUTURE_SKEW_MS;
const MAX_PUBLIC_IDENTITY_SKU_LENGTH = 32;
const MAX_PUBLIC_PRODUCT_TITLE_LENGTH = 200;
const PUBLIC_IDENTITY_SKU_PATTERN = /^[A-Z0-9]{1,30}\/[A-Z]$/;
const PUBLIC_PRODUCT_TITLE_PATTERN =
  /^iPhone[ \u00a0\u202f][A-Za-z0-9 .,'’()&+/\u00a0\u202f-]*$/;
const PUBLIC_PRODUCT_URL_PATTERN = /(?:https?:\/\/|www\.)/i;
const PUBLIC_PICKUP_DISPLAY_TOKEN_PATTERN =
  /^[A-Za-z][A-Za-z0-9 _-]{0,63}(?![\s\S])/;

type EngineDeliveryAttemptOutcome =
  | { kind: "delivered" }
  | { kind: "terminal" }
  | { kind: "retry" }
  | { kind: "retry_not_before"; retryNotBefore: string };

export interface PickupParseDiagnostic {
  readonly outcome: "success" | "failure" | "not_parsed";
  readonly reason: ApplePickupParseErrorCode | null;
  readonly storeCount: number;
  readonly observationCount: number;
  readonly targetStatus:
    | "available"
    | "unavailable"
    | "ineligible"
    | "unknown"
    | "missing"
    | "mixed"
    | "not_parsed";
  /**
   * A finite, worker-lifetime-only view of the one canary anchor observation.
   * It is deliberately absent for ambiguous anchor results so diagnostics
   * never pick an arbitrary observation.
   */
  readonly targetAvailability: {
    readonly pickupDisplay:
      | "available"
      | "unavailable"
      | "ineligible"
      | "other";
    readonly pickupDisplayToken: string | null;
    readonly storePickEligible: boolean;
    readonly isBuyable: boolean | null;
  } | null;
  readonly identityMismatch:
    | {
        readonly kind: "public_product";
        readonly requestedSku: string;
        readonly expectedTitle: string;
        readonly observedTitle: string;
      }
    | { readonly kind: "redacted" }
    | null;
}

function publicPickupDisplayToken(value: string): string | null {
  return PUBLIC_PICKUP_DISPLAY_TOKEN_PATTERN.test(value) ? value : null;
}

function targetAvailability(
  parsed: Extract<ApplePickupParseResult, { ok: true }>,
  anchorStoreNumber: string,
): PickupParseDiagnostic["targetAvailability"] {
  const observations = parsed.observations.filter(
    (entry) => entry.store.storeNumber === anchorStoreNumber,
  );
  if (observations.length !== 1) return null;
  const observation = observations[0]!;
  const pickupDisplay =
    observation.pickupDisplay === "available"
      ? "available"
      : observation.pickupDisplay === "unavailable"
        ? "unavailable"
        : observation.pickupDisplay === "ineligible"
          ? "ineligible"
          : "other";
  return {
    pickupDisplay,
    pickupDisplayToken:
      pickupDisplay === "other"
        ? publicPickupDisplayToken(observation.pickupDisplay)
        : null,
    storePickEligible: observation.storePickEligible,
    isBuyable: observation.isBuyable,
  };
}

function publicProductTitle(value: string | undefined): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PUBLIC_PRODUCT_TITLE_LENGTH &&
    PUBLIC_PRODUCT_TITLE_PATTERN.test(value) &&
    !PUBLIC_PRODUCT_URL_PATTERN.test(value)
    ? value
    : null;
}

function publicIdentityMismatch(
  requestedSku: string,
  expectedTitle: string | undefined,
  observedTitle: string | undefined,
): PickupParseDiagnostic["identityMismatch"] {
  const expected = publicProductTitle(expectedTitle);
  const observed = publicProductTitle(observedTitle);
  return requestedSku.length <= MAX_PUBLIC_IDENTITY_SKU_LENGTH &&
    PUBLIC_IDENTITY_SKU_PATTERN.test(requestedSku) &&
    expected !== null &&
    observed !== null
    ? {
        kind: "public_product",
        requestedSku,
        expectedTitle: expected,
        observedTitle: observed,
      }
    : { kind: "redacted" };
}

export interface LocalCatalogPort {
  getCatalog(): LocalCatalogSnapshot | null;
}

/** L10 supplies real browser/Telegram/relay adapters; this is DI-only here. */
export interface LocalDeliveryDispatcher {
  deliver(
    channel: LocalDeliveryChannel,
    event: LocalAvailabilityEvent,
    options?: { signal?: AbortSignal },
  ): Promise<void | LocalDeliveryDispatchResult>;
}

/** L14 supplies a catalog-validated manual Apple handoff URL. */
export interface LocalAvailabilityEventFactory {
  create(input: {
    watch: LocalWatch;
    sku: string;
    storeNumber: string;
    title: string;
    storeName: string;
    observedAt: string;
  }): LocalAvailabilityEvent | null;
}

export interface LocalMonitorEngineOptions {
  clock: LocalMonitorClock;
  storage: LocalStoragePort;
  scheduler: LocalSchedulerPort;
  fetch: AppleFetchPort;
  catalog: LocalCatalogPort;
  /** Optional until L10/L14 wire actual channels and manual handoffs. */
  deliveryDispatcher?: LocalDeliveryDispatcher;
  eventFactory?: LocalAvailabilityEventFactory;
  fetchTimeoutMs?: number;
  deliveryTimeoutMs?: number;
  /** Injectable deterministic jitter for fake-clock tests. Value is clamped. */
  jitterMs?: () => number;
  eventId?: () => string;
  /** Observational only; exceptions are ignored and cannot change polling. */
  onPickupParseDiagnostic?: (diagnostic: PickupParseDiagnostic) => void;
}

function emitPickupParseDiagnostic(
  callback: LocalMonitorEngineOptions["onPickupParseDiagnostic"],
  parsed: ApplePickupParseResult | null,
  anchorStoreNumber: string,
  identityMismatch: PickupParseDiagnostic["identityMismatch"],
): void {
  let diagnostic: PickupParseDiagnostic;
  if (parsed === null) {
    diagnostic = {
      outcome: "not_parsed",
      reason: null,
      storeCount: 0,
      observationCount: 0,
      targetStatus: "not_parsed",
      targetAvailability: null,
      identityMismatch: null,
    };
  } else if (!parsed.ok) {
    diagnostic = {
      outcome: "failure",
      reason: parsed.error.code,
      storeCount: 0,
      observationCount: 0,
      targetStatus: "not_parsed",
      targetAvailability: null,
      identityMismatch,
    };
  } else {
    const statuses = new Set(
      parsed.observations
        .filter((entry) => entry.store.storeNumber === anchorStoreNumber)
        .map((entry) => entry.status),
    );
    const targetStatus =
      statuses.size === 0
        ? "missing"
        : statuses.size === 1
          ? [...statuses][0]!
          : "mixed";
    diagnostic = {
      outcome: "success",
      reason: null,
      storeCount: Math.min(
        MAX_PICKUP_PARSE_DIAGNOSTIC_COUNT,
        parsed.storeCount,
      ),
      observationCount: Math.min(
        MAX_PICKUP_PARSE_DIAGNOSTIC_COUNT,
        parsed.observations.length,
      ),
      targetStatus,
      targetAvailability: targetAvailability(parsed, anchorStoreNumber),
      identityMismatch: null,
    };
  }
  try {
    callback?.(Object.freeze(diagnostic));
  } catch {
    // Diagnostics must not affect the existing unknown/failure semantics.
  }
}

export type LocalMonitorCycleKind =
  | "completed"
  | "busy"
  | "host_backoff"
  | "storage_error";

export interface LocalMonitorCycleReport {
  kind: LocalMonitorCycleKind;
  attemptedBatches: number;
  unsupportedWatchIds: readonly string[];
  queuedEvents: number;
  expiredDeliveryEvents: number;
  queueBackpressure: boolean;
}

interface WatchRevision {
  id: string;
  updatedAt: string;
  generation: number;
}

function isoAt(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function itemKey(watchId: string, sku: string, storeNumber: string): string {
  return `${watchId}\u0000${sku}\u0000${storeNumber}`;
}

function retiredWatchIds(
  snapshot: LocalMonitorSnapshot,
  catalog: LocalCatalogSnapshot,
): ReadonlySet<string> {
  return new Set(
    snapshot.watches
      .filter((watch) => reconcileWatchWithCatalog(watch, catalog).length > 0)
      .map((watch) => watch.id),
  );
}

/**
 * Read-only UI projection for a valid catalog replacement. It deliberately
 * changes no durable state, timing, history, or delivery work: the monitor
 * cycle owns those mutations. This prevents a popup from displaying a stale
 * available result while preserving `getSnapshot()` as a read-only API.
 */
function projectRetiredCatalogItems(
  snapshot: LocalMonitorSnapshot,
  catalog: LocalCatalogSnapshot,
): LocalMonitorSnapshot {
  const retired = retiredWatchIds(snapshot, catalog);
  if (retired.size === 0) return snapshot;
  return {
    ...snapshot,
    items: snapshot.items.map((item) => {
      if (item.status === "unknown" || !retired.has(item.watchId)) {
        return item;
      }
      return {
        ...item,
        status: "unknown",
        // This projection is not a pickup observation. Preserve every
        // persisted timing/last-known field so the UI cannot imply a fresh
        // Apple result.
        lastKnownStatus: item.lastKnownStatus,
        lastCheckedAt: item.lastCheckedAt,
        lastSuccessfulAt: item.lastSuccessfulAt,
        lastChangedAt: item.lastChangedAt,
        consecutiveUnknowns: item.consecutiveUnknowns + 1,
      };
    }),
  };
}

function clampJitter(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_JITTER_MS, Math.floor(value)));
}

function channelNames(watch: LocalWatch): LocalDeliveryChannel[] {
  const channels: LocalDeliveryChannel[] = [];
  if (watch.deliveryChannels.desktop) channels.push("desktop");
  if (watch.deliveryChannels.personalTelegram)
    channels.push("personalTelegram");
  if (watch.deliveryChannels.hostedRelay) channels.push("hostedRelay");
  return channels;
}

/**
 * The only stateful polling implementation. At most one cycle runs per
 * installation; Apple work is additionally serialized inside that cycle.
 */
export class LocalMonitorEngine {
  private snapshot: LocalMonitorSnapshot | null = null;
  private cycle: Promise<LocalMonitorCycleReport> | null = null;
  private snapshotLoad: Promise<void> | null = null;
  private persistQueue: Promise<void> = Promise.resolve();
  private readonly generations = new Map<string, number>();
  private readonly activeDeliveryControllers = new Map<
    string,
    Set<AbortController>
  >();
  private eventSequence = 0;

  public constructor(private readonly options: LocalMonitorEngineOptions) {}

  public async start(): Promise<LocalMonitorCycleReport> {
    try {
      await this.ensureSnapshot();
      this.refreshSchedule();
      this.options.scheduler.scheduleOneShot(
        clampJitter(this.options.jitterMs?.() ?? 0),
      );
    } catch {
      return this.emptyReport("storage_error");
    }
    return this.runCycle();
  }

  /** Called by one platform alarm, startup reconcile, or explicit check-now. */
  public wake(): Promise<LocalMonitorCycleReport> {
    return this.runCycle();
  }

  public checkNow(
    watchIds?: readonly string[],
  ): Promise<LocalMonitorCycleReport> {
    return this.runCycle(new Set(watchIds));
  }

  public async getSnapshot(): Promise<LocalMonitorSnapshot> {
    await this.ensureSnapshot();
    // Reading state must never contact Apple, but a newly bundled/replaced
    // valid catalog can retire a SKU before the next alarm fires. Reconcile
    // that local fact before projecting the snapshot so UI cannot surface a
    // stale available result for a retired product.
    const catalogCandidate = this.options.catalog.getCatalog();
    const catalogParsed =
      catalogCandidate === null
        ? null
        : parseLocalCatalogSnapshot(catalogCandidate);
    const snapshot = structuredClone(this.currentSnapshot());
    return catalogParsed?.success
      ? projectRetiredCatalogItems(snapshot, catalogParsed.data)
      : snapshot;
  }

  public async addWatch(watch: LocalWatch): Promise<boolean> {
    const parsed = parseLocalWatch(watch);
    if (!parsed.success) return false;
    await this.ensureSnapshot();
    const snapshot = this.currentSnapshot();
    if (
      snapshot.watches.length >= 20 ||
      snapshot.watches.some((entry) => entry.id === parsed.data.id)
    ) {
      return false;
    }
    snapshot.watches.push(parsed.data);
    this.bumpGeneration(parsed.data.id);
    await this.persist();
    this.refreshSchedule();
    return true;
  }

  /**
   * Replaces a validated watch revision. Removed SKU/store scopes are pruned;
   * pending work for retained scopes is terminally superseded or revoked so a
   * stale worker cannot deliver it after an edit.
   */
  public async replaceWatch(watch: LocalWatch): Promise<boolean> {
    const parsed = parseLocalWatch(watch);
    if (!parsed.success) return false;
    await this.ensureSnapshot();
    const snapshot = this.currentSnapshot();
    const index = snapshot.watches.findIndex((entry) => entry.id === watch.id);
    if (index < 0) return false;
    const existing = snapshot.watches[index]!;
    const revisionMs = Math.max(
      this.options.clock.now(),
      Date.parse(existing.updatedAt) + 1,
      Date.parse(parsed.data.updatedAt),
    );
    const replacement = { ...parsed.data, updatedAt: isoAt(revisionMs) };
    snapshot.watches[index] = replacement;
    this.bumpGeneration(replacement.id);
    this.pruneForWatchRevision(replacement);
    await this.persist();
    this.refreshSchedule();
    return true;
  }

  public async setWatchEnabled(id: string, enabled: boolean): Promise<boolean> {
    await this.ensureSnapshot();
    const existing = this.currentSnapshot().watches.find(
      (watch) => watch.id === id,
    );
    if (!existing) return false;
    return this.replaceWatch({
      ...existing,
      enabled,
      updatedAt: isoAt(
        Math.max(this.options.clock.now(), Date.parse(existing.updatedAt) + 1),
      ),
    });
  }

  /**
   * Revokes Personal Telegram on the current stored watch revisions only.
   * Unlike `replaceWatch`, this never accepts a page-supplied stale watch.
   */
  public async disablePersonalTelegramForAllWatches(): Promise<void> {
    await this.ensureSnapshot();
    const snapshot = this.currentSnapshot();
    let changed = false;
    for (let index = 0; index < snapshot.watches.length; index += 1) {
      const current = snapshot.watches[index]!;
      if (!current.deliveryChannels.personalTelegram) continue;
      const revisionMs = Math.max(
        this.options.clock.now(),
        Date.parse(current.updatedAt) + 1,
      );
      const replacement: LocalWatch = {
        ...current,
        deliveryChannels: {
          ...current.deliveryChannels,
          personalTelegram: false,
        },
        updatedAt: isoAt(revisionMs),
      };
      snapshot.watches[index] = replacement;
      this.bumpGeneration(replacement.id);
      this.pruneForWatchRevision(replacement);
      changed = true;
    }
    if (!changed) return;
    await this.persist();
    this.refreshSchedule();
  }

  public async deleteWatch(id: string): Promise<boolean> {
    await this.ensureSnapshot();
    const snapshot = this.currentSnapshot();
    if (!snapshot.watches.some((watch) => watch.id === id)) return false;
    snapshot.watches = snapshot.watches.filter((watch) => watch.id !== id);
    snapshot.items = snapshot.items.filter((item) => item.watchId !== id);
    snapshot.delivery = snapshot.delivery.filter(
      (delivery) => delivery.watchId !== id,
    );
    snapshot.history = snapshot.history.filter((event) => event.watchId !== id);
    // Deleted watches have no valid snapshot reference. Removing their queue
    // prevents a late worker from delivering a revoked configuration.
    snapshot.pendingDelivery = snapshot.pendingDelivery.filter(
      (pending) => pending.event.watchId !== id,
    );
    this.bumpGeneration(id);
    await this.persist();
    this.refreshSchedule();
    return true;
  }

  public async reset(): Promise<void> {
    this.abortAllActiveDeliveries();
    this.snapshot = createEmptySnapshot();
    this.generations.clear();
    this.options.scheduler.cancelAll();
    await this.persist();
  }

  private runCycle(
    forceWatchIds?: ReadonlySet<string>,
  ): Promise<LocalMonitorCycleReport> {
    if (this.cycle) return Promise.resolve(this.emptyReport("busy"));
    const cycle = this.runCycleInternal(forceWatchIds);
    this.cycle = cycle;
    void cycle.finally(() => {
      if (this.cycle === cycle) this.cycle = null;
    });
    return cycle;
  }

  private async runCycleInternal(
    forceWatchIds?: ReadonlySet<string>,
  ): Promise<LocalMonitorCycleReport> {
    let attemptedBatches = 0;
    let queuedEvents = 0;
    let expiredDeliveryEvents = 0;
    let queueBackpressure = false;
    const unsupportedWatchIds = new Set<string>();
    try {
      await this.ensureSnapshot();
      const nowMs = this.options.clock.now();
      const now = isoAt(nowMs);
      expiredDeliveryEvents += this.reconcileDurableDelivery(nowMs, now);

      const snapshot = this.currentSnapshot();
      const catalogCandidate = this.options.catalog.getCatalog();
      const catalogParsed =
        catalogCandidate === null
          ? null
          : parseLocalCatalogSnapshot(catalogCandidate);
      // Do this before every early return below. Apple backoff, a paused
      // watch, or a not-yet-due poll must not leave stale stock visible or
      // authorize delivery after a current valid catalog retires its SKU.
      if (catalogParsed?.success) {
        const reconciliation = this.reconcileRetiredCatalogState(
          catalogParsed.data,
          nowMs,
          now,
        );
        for (const id of reconciliation.unsupportedWatchIds) {
          unsupportedWatchIds.add(id);
        }
        expiredDeliveryEvents += reconciliation.terminalized;
      }
      const forced = forceWatchIds && forceWatchIds.size > 0;
      if (
        snapshot.runtime.nextEligibleAt !== null &&
        Date.parse(snapshot.runtime.nextEligibleAt) > nowMs
      ) {
        this.options.scheduler.scheduleOneShot(
          Date.parse(snapshot.runtime.nextEligibleAt) - nowMs,
        );
        await this.persist();
        await this.dispatchPending(nowMs);
        await this.persist();
        // Delivery channels are independent of Apple polling. A Telegram
        // provider deadline may be earlier than the persisted Apple
        // Retry-After, so recompute the earliest durable wake after dispatch.
        // `runtime.nextEligibleAt` remains intact: this never bypasses Apple
        // host backoff or starts another pickup request.
        this.refreshSchedule();
        return {
          kind: "host_backoff",
          attemptedBatches,
          unsupportedWatchIds: [...unsupportedWatchIds],
          queuedEvents,
          expiredDeliveryEvents,
          queueBackpressure,
        };
      }

      const selected = snapshot.watches.filter(
        (watch) =>
          watch.enabled &&
          (forced
            ? forceWatchIds!.has(watch.id)
            : this.isWatchDue(watch, nowMs)),
      );
      if (catalogParsed === null || !catalogParsed.success) {
        for (const watch of selected) {
          unsupportedWatchIds.add(watch.id);
          const result = this.recordUnknownWatch(watch, nowMs, now);
          queuedEvents += result.queuedEvents;
          queueBackpressure ||= result.queueBackpressure;
        }
        await this.persist();
        await this.dispatchPending(nowMs);
        await this.persist();
        this.refreshSchedule();
        return {
          kind: "completed",
          attemptedBatches,
          unsupportedWatchIds: [...unsupportedWatchIds],
          queuedEvents,
          expiredDeliveryEvents,
          queueBackpressure,
        };
      }
      const catalog = catalogParsed.data;
      const promoted = this.promoteDeferredAvailability(catalog, nowMs, now);
      queuedEvents += promoted.queuedEvents;
      queueBackpressure ||= promoted.queueBackpressure;
      if (selected.length === 0) {
        await this.persist();
        await this.dispatchPending(nowMs);
        await this.persist();
        this.refreshSchedule();
        return {
          kind: "completed",
          attemptedBatches,
          unsupportedWatchIds: [...unsupportedWatchIds],
          queuedEvents,
          expiredDeliveryEvents,
          queueBackpressure,
        };
      }
      const valid: LocalWatch[] = [];
      for (const watch of selected) {
        if (unsupportedWatchIds.has(watch.id)) continue;
        valid.push(watch);
      }

      let hadFetchFailure = false;
      let retryAfterMs = 0;
      const revisions = new Map(
        valid.map((watch) => [watch.id, this.watchRevision(watch)]),
      );
      for (const batch of coalescePollBatches(valid, catalog)) {
        for (const skus of batch.skuChunks) {
          attemptedBatches += 1;
          const response = await this.fetchWithTimeout({
            market: batch.market,
            anchorStoreNumber: batch.anchorStoreNumber,
            location: batch.location,
            skus,
          });
          let identityMismatch: PickupParseDiagnostic["identityMismatch"] =
            null;
          const parsed =
            response === null
              ? null
              : parseApplePickupMessage({
                  body: response.body,
                  httpStatus: response.httpStatus,
                  expectedSkus: skus,
                  validateProductIdentity: ({ requestedSku, title }) => {
                    const market = catalog.markets.find(
                      (entry) => entry.code === batch.market,
                    );
                    const expected = market?.variants.find(
                      (variant) => variant.sku === requestedSku,
                    )?.title;
                    if (expected !== title && identityMismatch === null) {
                      identityMismatch = publicIdentityMismatch(
                        requestedSku,
                        expected,
                        title,
                      );
                    }
                    return expected === title
                      ? { valid: true }
                      : { valid: false, reason: "Catalog title mismatch" };
                  },
                });
          emitPickupParseDiagnostic(
            this.options.onPickupParseDiagnostic,
            parsed,
            batch.anchorStoreNumber,
            identityMismatch,
          );
          if (response === null || parsed === null || !parsed.ok) {
            hadFetchFailure = true;
            retryAfterMs = Math.max(retryAfterMs, response?.retryAfterMs ?? 0);
          }
          for (const watchId of batch.watchIds) {
            const watch = this.currentSnapshot().watches.find(
              (entry) => entry.id === watchId,
            );
            const revision = revisions.get(watchId);
            if (!watch || !revision || !this.isCurrentRevision(revision))
              continue;
            for (const sku of skus) {
              if (!watch.skus.includes(sku)) continue;
              for (const storeNumber of watch.storeNumbers) {
                const observation =
                  parsed && parsed.ok
                    ? parsed.observations.find(
                        (entry) =>
                          entry.sku === sku &&
                          entry.store.storeNumber === storeNumber,
                      )
                    : undefined;
                const result = this.recordObservation({
                  watch,
                  sku,
                  storeNumber,
                  status: observation?.status ?? "unknown",
                  lastFailure:
                    response === null || response.httpStatus === 599
                      ? { reason: "request_failed" }
                      : response.httpStatus >= 300
                        ? {
                            reason: "http_error",
                            httpStatus: response.httpStatus,
                          }
                        : !parsed?.ok
                          ? {
                              reason:
                                parsed?.error.code ===
                                "identity_validation_failed"
                                  ? "identity_mismatch"
                                  : "invalid_response",
                            }
                          : !observation
                            ? { reason: "missing_result" }
                            : observation.status === "unknown"
                              ? { reason: "unrecognized_availability" }
                              : undefined,
                  title: observation?.title ?? null,
                  storeName: observation?.store.storeName ?? null,
                  nowMs,
                  now,
                });
                queuedEvents += result.queuedEvents;
                queueBackpressure ||= result.queueBackpressure;
              }
            }
          }
        }
      }
      // A marker preserved through an unknown gap may become eligible only
      // after this cycle records a fresh known available observation.
      const promotedAfterObservation = this.promoteDeferredAvailability(
        catalog,
        nowMs,
        now,
      );
      queuedEvents += promotedAfterObservation.queuedEvents;
      queueBackpressure ||= promotedAfterObservation.queueBackpressure;
      this.updateBackoff(hadFetchFailure, retryAfterMs, nowMs);
      this.currentSnapshot().history = capHistoryEvents(
        this.currentSnapshot().history,
        undefined,
        nowMs,
      );
      // Persist transitions and pending work before any channel call. This is
      // the crash boundary that gives retries at-least-once semantics.
      await this.persist();
      await this.dispatchPending(nowMs);
      await this.persist();
      this.refreshSchedule();
      return {
        kind: "completed",
        attemptedBatches,
        unsupportedWatchIds: [...unsupportedWatchIds],
        queuedEvents,
        expiredDeliveryEvents,
        queueBackpressure,
      };
    } catch {
      return {
        ...this.emptyReport("storage_error"),
        attemptedBatches,
        unsupportedWatchIds: [...unsupportedWatchIds],
        queuedEvents,
        expiredDeliveryEvents,
        queueBackpressure,
      };
    }
  }

  private async fetchWithTimeout(request: {
    market: LocalWatch["market"];
    anchorStoreNumber: string;
    location: string;
    skus: string[];
  }) {
    const controller = new AbortController();
    const timeoutMs = Math.max(
      1,
      Math.min(
        MAX_BACKOFF_MS,
        this.options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
      ),
    );
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, timeoutMs);
    });
    // The port is required to honour the signal, but race as a second line of
    // defense: an adapter that does not must not pin the worker forever. The
    // detached promise has no state-mutating callbacks, so a late resolution
    // cannot revive this obsolete polling cycle.
    const response = Promise.resolve()
      .then(() =>
        this.options.fetch.fetchPickup(request, { signal: controller.signal }),
      )
      .then((value) => {
        const validated = ApplePickupFetchResponseSchema.safeParse(value);
        return validated.success ? validated.data : null;
      })
      .catch(() => null);
    try {
      return await Promise.race([response, timedOut]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  private recordUnknownWatch(
    watch: LocalWatch,
    nowMs: number,
    now: string,
  ): { queuedEvents: number; queueBackpressure: boolean } {
    let queuedEvents = 0;
    let queueBackpressure = false;
    for (const sku of watch.skus) {
      for (const storeNumber of watch.storeNumbers) {
        const result = this.recordObservation({
          watch,
          sku,
          storeNumber,
          status: "unknown",
          lastFailure: { reason: "catalog_unavailable" },
          title: null,
          storeName: null,
          nowMs,
          now,
        });
        queuedEvents += result.queuedEvents;
        queueBackpressure ||= result.queueBackpressure;
      }
    }
    return { queuedEvents, queueBackpressure };
  }

  private recordObservation(input: {
    watch: LocalWatch;
    sku: string;
    storeNumber: string;
    status: AvailabilityStatus;
    lastFailure?: WatchItemState["lastFailure"];
    title: string | null;
    storeName: string | null;
    nowMs: number;
    now: string;
  }): { queuedEvents: number; queueBackpressure: boolean } {
    const snapshot = this.currentSnapshot();
    const key = itemKey(input.watch.id, input.sku, input.storeNumber);
    const previous = snapshot.items.find(
      (item) => itemKey(item.watchId, item.sku, item.storeNumber) === key,
    );
    const changed = previous?.status !== input.status;
    const state: WatchItemState = {
      watchId: input.watch.id,
      market: input.watch.market,
      sku: input.sku as WatchItemState["sku"],
      storeNumber: input.storeNumber as WatchItemState["storeNumber"],
      status: input.status,
      ...(input.status === "unknown" && input.lastFailure
        ? { lastFailure: input.lastFailure }
        : {}),
      lastKnownStatus:
        input.status === "unknown"
          ? (previous?.lastKnownStatus ?? null)
          : input.status,
      lastChangedAt:
        changed && input.status !== "unknown"
          ? input.now
          : (previous?.lastChangedAt ?? null),
      lastCheckedAt: input.now,
      lastSuccessfulAt:
        input.status === "unknown"
          ? (previous?.lastSuccessfulAt ?? null)
          : input.now,
      consecutiveUnknowns:
        input.status === "unknown"
          ? (previous?.consecutiveUnknowns ?? 0) + 1
          : 0,
    };
    if (previous) {
      snapshot.items[snapshot.items.indexOf(previous)] = state;
    } else {
      snapshot.items.push(state);
    }
    if (changed) {
      const history: WatchHistoryEvent = {
        watchId: input.watch.id,
        market: input.watch.market,
        sku: state.sku,
        storeNumber: state.storeNumber,
        from: previous?.status ?? null,
        to: input.status,
        at: input.now,
      };
      snapshot.history = capHistoryEvents(
        [history, ...snapshot.history],
        undefined,
        input.nowMs,
      );
    }
    const delivery = this.deliveryStateFor(
      input.watch,
      state.sku,
      state.storeNumber,
    );
    if (
      input.status !== "available" &&
      input.status !== "unknown" &&
      delivery.deferredAvailabilityState === "pending"
    ) {
      this.clearDeferredAvailability(delivery, "superseded");
    }
    const decision = evaluateAvailabilityTransition({
      previousStatus: previous?.status ?? null,
      lastKnownStatus: previous?.lastKnownStatus ?? null,
      currentStatus: input.status,
      now: input.nowMs,
      lastAlertedAt:
        delivery.lastAlertedAt === null
          ? null
          : Date.parse(delivery.lastAlertedAt),
      cooldownMs: delivery.cooldownMs,
    });
    if (
      !decision.shouldAlert ||
      input.title === null ||
      input.storeName === null
    ) {
      return { queuedEvents: 0, queueBackpressure: false };
    }
    const event = this.options.eventFactory?.create({
      watch: input.watch,
      sku: state.sku,
      storeNumber: state.storeNumber,
      title: input.title,
      storeName: input.storeName,
      observedAt: input.now,
    });
    const parsedEvent = event && LocalAvailabilityEventSchema.safeParse(event);
    if (
      !parsedEvent?.success ||
      parsedEvent.data.watchId !== input.watch.id ||
      parsedEvent.data.market !== input.watch.market ||
      parsedEvent.data.sku !== state.sku ||
      parsedEvent.data.storeNumber !== state.storeNumber
    ) {
      return { queuedEvents: 0, queueBackpressure: false };
    }
    const channels = channelNames(input.watch);
    if (channels.length === 0)
      return { queuedEvents: 0, queueBackpressure: false };
    if (!this.reserveDispatchCapacity()) {
      delivery.deferredAvailabilityAt = input.now;
      delivery.deferredWatchUpdatedAt = input.watch.updatedAt;
      delivery.deferredAvailabilityState = "pending";
      return { queuedEvents: 0, queueBackpressure: true };
    }
    this.enqueueDeliveryEvent(
      input.watch,
      parsedEvent.data,
      input.now,
      channels,
    );
    // A marker may have survived an unknown gap while capacity was full. The
    // newly durable event supersedes that marker atomically, so a later
    // promotion cannot emit a duplicate availability alert.
    if (delivery.deferredAvailabilityState === "pending") {
      this.clearDeferredAvailability(delivery, "none");
    }
    delivery.lastAlertedAt = input.now;
    return { queuedEvents: 1, queueBackpressure: false };
  }

  private deliveryStateFor(
    watch: LocalWatch,
    sku: WatchDeliveryState["sku"],
    storeNumber: WatchDeliveryState["storeNumber"],
  ): WatchDeliveryState {
    const snapshot = this.currentSnapshot();
    const existing = snapshot.delivery.find(
      (entry) =>
        entry.watchId === watch.id &&
        entry.sku === sku &&
        entry.storeNumber === storeNumber,
    );
    if (existing) return existing;
    const created: WatchDeliveryState = {
      watchId: watch.id,
      market: watch.market,
      sku,
      storeNumber,
      lastAlertedAt: null,
      cooldownMs: DEFAULT_DELIVERY_COOLDOWN_MS,
      deferredAvailabilityAt: null,
      deferredWatchUpdatedAt: null,
      deferredAvailabilityState: "none",
    };
    snapshot.delivery.push(created);
    return created;
  }

  private enqueueDeliveryEvent(
    watch: LocalWatch,
    event: LocalAvailabilityEvent,
    now: string,
    channels: readonly LocalDeliveryChannel[],
  ): void {
    const pending: PendingDeliveryEvent = {
      eventId: this.nextEventId(),
      watchUpdatedAt: watch.updatedAt,
      event,
      createdAt: now,
      channels: channels.map((channel) => ({
        channel,
        state: "pending",
        attempts: 0,
        nextAttemptAt: now,
        lastAttemptAt: null,
        completedAt: null,
      })),
    };
    this.currentSnapshot().pendingDelivery.push(pending);
  }

  /**
   * Terminal entries are audit data until capacity is needed. Evicting only
   * fully terminal entries prevents a completed channel from discarding a
   * sibling channel that still needs its at-least-once retry.
   */
  private reserveDispatchCapacity(): boolean {
    const snapshot = this.currentSnapshot();
    if (snapshot.pendingDelivery.length < MAX_PENDING_DELIVERY_EVENTS)
      return true;
    const terminal = snapshot.pendingDelivery
      .filter((pending) =>
        pending.channels.every((channel) => channel.state !== "pending"),
      )
      .sort((left, right) => {
        const leftAt = Math.min(
          ...left.channels.map((channel) =>
            Date.parse(channel.completedAt ?? left.createdAt),
          ),
        );
        const rightAt = Math.min(
          ...right.channels.map((channel) =>
            Date.parse(channel.completedAt ?? right.createdAt),
          ),
        );
        return leftAt - rightAt;
      });
    while (
      snapshot.pendingDelivery.length >= MAX_PENDING_DELIVERY_EVENTS &&
      terminal.length > 0
    ) {
      const candidate = terminal.shift();
      if (!candidate) break;
      snapshot.pendingDelivery = snapshot.pendingDelivery.filter(
        (pending) => pending.eventId !== candidate.eventId,
      );
    }
    return snapshot.pendingDelivery.length < MAX_PENDING_DELIVERY_EVENTS;
  }

  private clearDeferredAvailability(
    delivery: WatchDeliveryState,
    state: Exclude<WatchDeliveryState["deferredAvailabilityState"], "pending">,
  ): void {
    delivery.deferredAvailabilityAt = null;
    delivery.deferredWatchUpdatedAt = null;
    delivery.deferredAvailabilityState = state;
  }

  private promoteDeferredAvailability(
    catalog: LocalCatalogSnapshot,
    nowMs: number,
    now: string,
  ): { queuedEvents: number; queueBackpressure: boolean } {
    let queuedEvents = 0;
    let queueBackpressure = false;
    const snapshot = this.currentSnapshot();
    for (const delivery of snapshot.delivery) {
      if (delivery.deferredAvailabilityState !== "pending") continue;
      let markerAt = delivery.deferredAvailabilityAt;
      const revision = delivery.deferredWatchUpdatedAt;
      const watch = snapshot.watches.find(
        (entry) => entry.id === delivery.watchId,
      );
      const item = snapshot.items.find(
        (entry) =>
          entry.watchId === delivery.watchId &&
          entry.sku === delivery.sku &&
          entry.storeNumber === delivery.storeNumber,
      );
      let markerMs = markerAt === null ? Number.NaN : Date.parse(markerAt);
      if (markerAt !== null && Number.isFinite(markerMs) && markerMs > nowMs) {
        markerAt = now;
        markerMs = nowMs;
        delivery.deferredAvailabilityAt = now;
      }
      if (
        markerAt === null ||
        !Number.isFinite(markerMs) ||
        markerMs > nowMs + MAX_PERSISTED_FUTURE_SKEW_MS ||
        nowMs - markerMs > PENDING_DELIVERY_RETENTION_MS
      ) {
        this.clearDeferredAvailability(delivery, "expired");
        continue;
      }
      if (!watch || watch.updatedAt !== revision || !watch.enabled) {
        this.clearDeferredAvailability(delivery, "superseded");
        continue;
      }
      if (!item || (item.status !== "available" && item.status !== "unknown")) {
        this.clearDeferredAvailability(delivery, "superseded");
        continue;
      }
      // An unknown gap must not erase a fresh previously-observed available
      // transition; wait for a later known result or the ten-minute TTL.
      if (item.status === "unknown") continue;
      const channels = channelNames(watch);
      if (channels.length === 0) {
        this.clearDeferredAvailability(delivery, "revoked");
        continue;
      }
      const market = catalog.markets.find(
        (entry) => entry.code === watch.market,
      );
      const variant = market?.variants.find(
        (entry) => entry.sku === delivery.sku,
      );
      const store = market?.stores.find(
        (entry) => entry.storeNumber === delivery.storeNumber,
      );
      if (
        !market ||
        !variant ||
        !store ||
        reconcileWatchWithCatalog(watch, catalog).length > 0
      ) {
        continue;
      }
      const event = this.options.eventFactory?.create({
        watch,
        sku: delivery.sku,
        storeNumber: delivery.storeNumber,
        title: variant.title,
        storeName: store.name,
        observedAt: markerAt,
      });
      const parsedEvent =
        event && LocalAvailabilityEventSchema.safeParse(event);
      if (
        !parsedEvent?.success ||
        parsedEvent.data.watchId !== watch.id ||
        parsedEvent.data.market !== watch.market ||
        parsedEvent.data.sku !== delivery.sku ||
        parsedEvent.data.storeNumber !== delivery.storeNumber
      ) {
        continue;
      }
      if (!this.reserveDispatchCapacity()) {
        queueBackpressure = true;
        continue;
      }
      this.enqueueDeliveryEvent(watch, parsedEvent.data, now, channels);
      delivery.lastAlertedAt = now;
      this.clearDeferredAvailability(delivery, "none");
      queuedEvents += 1;
    }
    return { queuedEvents, queueBackpressure };
  }

  private async dispatchPending(nowMs: number): Promise<void> {
    const snapshot = this.currentSnapshot();
    const now = isoAt(nowMs);
    this.reconcileDurableDelivery(nowMs, now);
    const dispatcher = this.options.deliveryDispatcher;
    if (!dispatcher) return;
    for (const candidate of [...snapshot.pendingDelivery]) {
      for (const candidateChannel of [...candidate.channels]) {
        let current = this.findDispatchableChannel(
          candidate.eventId,
          candidateChannel.channel,
          nowMs,
        );
        if (!current) continue;
        if (current.channel.attempts >= MAX_DELIVERY_ATTEMPTS) {
          current.channel.state = "failed";
          current.channel.completedAt = now;
          current.channel.nextAttemptAt = null;
          await this.persist();
          continue;
        }
        // Save the attempt *before* delivery. A crash after a provider accepts
        // it may retry, which is the documented at-least-once trade-off.
        current.channel.attempts += 1;
        current.channel.lastAttemptAt = now;
        current.channel.nextAttemptAt = isoAt(
          nowMs + this.retryDelayMs(current.channel.attempts),
        );
        await this.persist();

        // A pause/edit/delete/channel change can occur while the durable
        // attempt write is pending. Re-resolve by id immediately before the
        // external side effect; stale references never dispatch.
        const rechecked = this.findPendingChannel(
          candidate.eventId,
          candidateChannel.channel,
        );
        if (
          !rechecked ||
          !this.isCurrentPendingChannel(rechecked.pending, rechecked.channel)
        ) {
          continue;
        }
        const outcome = await this.deliverWithTimeout(
          dispatcher,
          rechecked.channel.channel,
          rechecked.pending.event,
        );
        // Never let a late provider settlement write into a replaced/deleted
        // watch or a channel that was revoked during the attempt.
        const after = this.findPendingChannel(
          candidate.eventId,
          candidateChannel.channel,
        );
        if (
          !after ||
          !this.isCurrentPendingChannel(after.pending, after.channel)
        ) {
          continue;
        }
        const completedAt = isoAt(this.options.clock.now());
        if (outcome.kind === "delivered") {
          after.channel.state = "delivered";
          after.channel.completedAt = completedAt;
          after.channel.nextAttemptAt = null;
        } else if (outcome.kind === "terminal") {
          after.channel.state = "failed";
          after.channel.completedAt = completedAt;
          after.channel.nextAttemptAt = null;
        } else if (outcome.kind === "retry_not_before") {
          const retryNotBeforeMs = Date.parse(outcome.retryNotBefore);
          const expiresAt =
            Date.parse(after.pending.event.observedAt) +
            PENDING_DELIVERY_RETENTION_MS;
          if (
            !Number.isFinite(retryNotBeforeMs) ||
            !Number.isFinite(expiresAt) ||
            retryNotBeforeMs <= this.options.clock.now()
          ) {
            after.channel.state = "failed";
            after.channel.completedAt = completedAt;
            after.channel.nextAttemptAt = null;
          } else if (retryNotBeforeMs > expiresAt) {
            after.channel.state = "expired";
            after.channel.completedAt = completedAt;
            after.channel.nextAttemptAt = null;
          } else {
            // Preserve the provider's absolute delay verbatim. The scheduler
            // owns waiting; no adapter sleep or shortened retry is allowed.
            after.channel.nextAttemptAt = outcome.retryNotBefore;
          }
        } else if (after.channel.attempts >= MAX_DELIVERY_ATTEMPTS) {
          after.channel.state = "failed";
          after.channel.completedAt = completedAt;
          after.channel.nextAttemptAt = null;
        } else {
          after.channel.nextAttemptAt = isoAt(
            this.options.clock.now() +
              this.retryDelayMs(after.channel.attempts),
          );
        }
        await this.persist();
      }
    }
  }

  private findPendingChannel(
    eventId: string,
    channelName: LocalDeliveryChannel,
  ): {
    pending: PendingDeliveryEvent;
    channel: PendingDeliveryEvent["channels"][number];
  } | null {
    const pending = this.currentSnapshot().pendingDelivery.find(
      (entry) => entry.eventId === eventId,
    );
    const channel = pending?.channels.find(
      (entry) => entry.channel === channelName,
    );
    return pending && channel ? { pending, channel } : null;
  }

  private isCurrentPendingChannel(
    pending: PendingDeliveryEvent,
    channel: PendingDeliveryEvent["channels"][number],
  ): boolean {
    const watch = this.currentSnapshot().watches.find(
      (entry) => entry.id === pending.event.watchId,
    );
    return (
      channel.state === "pending" &&
      watch !== undefined &&
      watch.enabled &&
      watch.updatedAt === pending.watchUpdatedAt &&
      watch.deliveryChannels[channel.channel]
    );
  }

  private findDispatchableChannel(
    eventId: string,
    channelName: LocalDeliveryChannel,
    nowMs: number,
  ): {
    pending: PendingDeliveryEvent;
    channel: PendingDeliveryEvent["channels"][number];
  } | null {
    const current = this.findPendingChannel(eventId, channelName);
    if (
      !current ||
      !this.isCurrentPendingChannel(current.pending, current.channel)
    ) {
      return null;
    }
    if (
      current.channel.nextAttemptAt !== null &&
      Date.parse(current.channel.nextAttemptAt) > nowMs
    ) {
      return null;
    }
    return current;
  }

  private async deliverWithTimeout(
    dispatcher: LocalDeliveryDispatcher,
    channel: LocalDeliveryChannel,
    event: LocalAvailabilityEvent,
  ): Promise<EngineDeliveryAttemptOutcome> {
    const controller = new AbortController();
    this.trackActiveDelivery(event.watchId, controller);
    const timeoutMs = Math.max(
      1,
      Math.min(
        MAX_BACKOFF_MS,
        this.options.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS,
      ),
    );
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<EngineDeliveryAttemptOutcome>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ kind: "retry" });
      }, timeoutMs);
    });
    // A mutation can revoke the watch while an adapter is waiting on browser
    // permission or a network promise. Resolve this engine wait immediately;
    // adapters receive the same signal and must check it before any side
    // effect. A late settlement can never mutate the replaced queue below.
    const aborted = new Promise<EngineDeliveryAttemptOutcome>((resolve) => {
      controller.signal.addEventListener(
        "abort",
        () => resolve({ kind: "retry" }),
        { once: true },
      );
    });
    const delivered = Promise.resolve()
      .then(() =>
        dispatcher.deliver(channel, event, { signal: controller.signal }),
      )
      .then((result): EngineDeliveryAttemptOutcome => {
        if (result === undefined) return { kind: "delivered" };
        const parsed = parseLocalDeliveryDispatchResult(result);
        return parsed ?? { kind: "terminal" };
      })
      .catch((): EngineDeliveryAttemptOutcome => ({ kind: "retry" }));
    try {
      return await Promise.race([delivered, timedOut, aborted]);
    } finally {
      if (timer !== null) clearTimeout(timer);
      this.untrackActiveDelivery(event.watchId, controller);
    }
  }

  /** Marks stale/revoked work visibly terminal; it never sends it later. */
  private reconcileDurableDelivery(nowMs: number, now: string): number {
    let terminalized = 0;
    const snapshot = this.currentSnapshot();
    for (const pending of snapshot.pendingDelivery) {
      const watch = snapshot.watches.find(
        (entry) => entry.id === pending.event.watchId,
      );
      const expired =
        nowMs - Date.parse(pending.createdAt) > PENDING_DELIVERY_RETENTION_MS ||
        nowMs - Date.parse(pending.event.observedAt) >
          PENDING_DELIVERY_RETENTION_MS;
      for (const channel of pending.channels) {
        if (channel.state !== "pending") continue;
        if (!watch) {
          channel.state = "revoked";
        } else if (watch.updatedAt !== pending.watchUpdatedAt) {
          channel.state = "superseded";
        } else if (!watch.deliveryChannels[channel.channel]) {
          channel.state = "revoked";
        } else if (expired) {
          channel.state = "expired";
        } else {
          continue;
        }
        channel.completedAt = now;
        channel.nextAttemptAt = null;
        terminalized += 1;
      }
    }
    return terminalized;
  }

  /**
   * A valid replacement catalog is authoritative for active watch scope.
   * Retired watches and their historical state remain persisted for recovery,
   * but known stock is changed to `unknown` locally without forging an Apple
   * observation or changing its last-check/success timestamps. Pending and
   * deferred availability work is terminalized before it can notify. A
   * missing or invalid catalog must never call this method: that is unknown
   * provider/catalog state, not proof that a product has retired.
   */
  private reconcileRetiredCatalogState(
    catalog: LocalCatalogSnapshot,
    nowMs: number,
    now: string,
  ): {
    unsupportedWatchIds: ReadonlySet<string>;
    terminalized: number;
    changed: boolean;
  } {
    const snapshot = this.currentSnapshot();
    const unsupportedWatchIds = retiredWatchIds(snapshot, catalog);
    if (unsupportedWatchIds.size === 0) {
      return { unsupportedWatchIds, terminalized: 0, changed: false };
    }
    let terminalized = 0;
    let changed = false;
    const history: WatchHistoryEvent[] = [];
    for (const [index, item] of snapshot.items.entries()) {
      if (item.status === "unknown" || !unsupportedWatchIds.has(item.watchId)) {
        continue;
      }
      snapshot.items[index] = {
        ...item,
        status: "unknown",
        // This is catalog reconciliation, not an upstream pickup result.
        // Keep all historical receipt/check timing exactly as persisted.
        lastKnownStatus: item.lastKnownStatus,
        lastCheckedAt: item.lastCheckedAt,
        lastSuccessfulAt: item.lastSuccessfulAt,
        lastChangedAt: item.lastChangedAt,
        consecutiveUnknowns: item.consecutiveUnknowns + 1,
      };
      history.push({
        watchId: item.watchId,
        market: item.market,
        sku: item.sku,
        storeNumber: item.storeNumber,
        from: item.status,
        to: "unknown",
        at: now,
      });
      changed = true;
    }
    if (history.length > 0) {
      snapshot.history = capHistoryEvents(
        [...history, ...snapshot.history],
        undefined,
        nowMs,
      );
    }
    for (const delivery of snapshot.delivery) {
      if (
        unsupportedWatchIds.has(delivery.watchId) &&
        delivery.deferredAvailabilityState === "pending"
      ) {
        this.clearDeferredAvailability(delivery, "superseded");
        changed = true;
      }
    }
    for (const pending of snapshot.pendingDelivery) {
      if (!unsupportedWatchIds.has(pending.event.watchId)) {
        continue;
      }
      for (const channel of pending.channels) {
        if (channel.state !== "pending") continue;
        channel.state = "superseded";
        channel.completedAt = now;
        channel.nextAttemptAt = null;
        terminalized += 1;
        changed = true;
      }
    }
    return { unsupportedWatchIds, terminalized, changed };
  }

  private pruneForWatchRevision(watch: LocalWatch): void {
    const snapshot = this.currentSnapshot();
    const validScopes = new Set<string>();
    for (const sku of watch.skus) {
      for (const storeNumber of watch.storeNumbers) {
        validScopes.add(itemKey(watch.id, sku, storeNumber));
      }
    }
    snapshot.items = snapshot.items.filter(
      (item) =>
        item.watchId !== watch.id ||
        validScopes.has(itemKey(item.watchId, item.sku, item.storeNumber)),
    );
    for (const delivery of snapshot.delivery) {
      if (
        delivery.watchId !== watch.id ||
        delivery.deferredAvailabilityState !== "pending"
      ) {
        continue;
      }
      if (
        !validScopes.has(
          itemKey(delivery.watchId, delivery.sku, delivery.storeNumber),
        )
      ) {
        continue;
      }
      if (!channelNames(watch).length) {
        this.clearDeferredAvailability(delivery, "revoked");
      } else if (delivery.deferredWatchUpdatedAt !== watch.updatedAt) {
        this.clearDeferredAvailability(delivery, "superseded");
      }
    }
    snapshot.delivery = snapshot.delivery.filter(
      (delivery) =>
        delivery.watchId !== watch.id ||
        validScopes.has(
          itemKey(delivery.watchId, delivery.sku, delivery.storeNumber),
        ),
    );
    snapshot.history = snapshot.history.filter(
      (event) =>
        event.watchId !== watch.id ||
        validScopes.has(itemKey(event.watchId, event.sku, event.storeNumber)),
    );
    const now = isoAt(this.options.clock.now());
    snapshot.pendingDelivery = snapshot.pendingDelivery.filter((pending) => {
      if (pending.event.watchId !== watch.id) return true;
      if (
        !validScopes.has(
          itemKey(
            pending.event.watchId,
            pending.event.sku,
            pending.event.storeNumber,
          ),
        )
      ) {
        return false;
      }
      for (const channel of pending.channels) {
        if (channel.state !== "pending") continue;
        if (!watch.deliveryChannels[channel.channel]) {
          channel.state = "revoked";
          channel.completedAt = now;
          channel.nextAttemptAt = null;
        } else if (pending.watchUpdatedAt !== watch.updatedAt) {
          channel.state = "superseded";
          channel.completedAt = now;
          channel.nextAttemptAt = null;
        }
      }
      return true;
    });
  }

  private updateBackoff(
    hadFetchFailure: boolean,
    retryAfterMs: number,
    nowMs: number,
  ): void {
    const runtime = this.currentSnapshot().runtime;
    if (!hadFetchFailure) {
      runtime.consecutiveFetchFailures = 0;
      runtime.nextEligibleAt = null;
      return;
    }
    runtime.consecutiveFetchFailures = Math.min(
      16,
      runtime.consecutiveFetchFailures + 1,
    );
    const exponential = Math.min(
      MAX_BACKOFF_MS,
      MIN_LOCAL_POLL_INTERVAL_SEC *
        1_000 *
        2 ** (runtime.consecutiveFetchFailures - 1),
    );
    runtime.nextEligibleAt = isoAt(nowMs + Math.max(exponential, retryAfterMs));
    this.options.scheduler.scheduleOneShot(Math.max(exponential, retryAfterMs));
  }

  private isWatchDue(watch: LocalWatch, nowMs: number): boolean {
    const expected = watch.skus.length * watch.storeNumbers.length;
    const items = this.currentSnapshot().items.filter(
      (item) => item.watchId === watch.id,
    );
    if (items.length < expected) return true;
    const oldestAttempt = Math.min(
      ...items.map((item) => Date.parse(item.lastCheckedAt)),
    );
    return nowMs - oldestAttempt >= watch.pollIntervalSec * 1_000;
  }

  private watchRevision(watch: LocalWatch): WatchRevision {
    return {
      id: watch.id,
      updatedAt: watch.updatedAt,
      generation: this.generations.get(watch.id) ?? 0,
    };
  }

  private isCurrentRevision(revision: WatchRevision): boolean {
    const watch = this.currentSnapshot().watches.find(
      (entry) => entry.id === revision.id,
    );
    return (
      watch?.updatedAt === revision.updatedAt &&
      (this.generations.get(revision.id) ?? 0) === revision.generation
    );
  }

  private bumpGeneration(id: string): void {
    this.abortActiveDeliveries(id);
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
  }

  /** Watch revisions revoke permission/network work before it can notify. */
  private trackActiveDelivery(id: string, controller: AbortController): void {
    const controllers = this.activeDeliveryControllers.get(id) ?? new Set();
    controllers.add(controller);
    this.activeDeliveryControllers.set(id, controllers);
  }

  private untrackActiveDelivery(id: string, controller: AbortController): void {
    const controllers = this.activeDeliveryControllers.get(id);
    if (!controllers) return;
    controllers.delete(controller);
    if (controllers.size === 0) this.activeDeliveryControllers.delete(id);
  }

  private abortActiveDeliveries(id: string): void {
    const controllers = this.activeDeliveryControllers.get(id);
    if (!controllers) return;
    for (const controller of controllers) controller.abort();
    this.activeDeliveryControllers.delete(id);
  }

  private abortAllActiveDeliveries(): void {
    for (const controllers of this.activeDeliveryControllers.values()) {
      for (const controller of controllers) controller.abort();
    }
    this.activeDeliveryControllers.clear();
  }

  private nextEventId(): string {
    const candidate = this.options.eventId?.();
    if (candidate && /^[A-Za-z0-9_-]{1,64}$/.test(candidate)) return candidate;
    this.eventSequence += 1;
    return `event_${this.options.clock.now().toString(36)}_${this.eventSequence.toString(36)}`;
  }

  private retryDelayMs(attempt: number): number {
    return Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.max(0, attempt - 1));
  }

  private refreshSchedule(): void {
    const snapshot = this.currentSnapshot();
    const enabled = snapshot.watches.some((watch) => watch.enabled);
    this.options.scheduler.cancelAll();
    if (enabled) {
      this.options.scheduler.schedulePeriodic(DEFAULT_LOCAL_POLL_INTERVAL_SEC);
      const nowMs = this.options.clock.now();
      const candidates = [
        snapshot.runtime.nextEligibleAt,
        this.nextPendingDeliveryDeadline(nowMs),
      ].flatMap((timestamp) => {
        if (timestamp === null) return [];
        const delayMs = Date.parse(timestamp) - nowMs;
        return Number.isFinite(delayMs) && delayMs > 0 ? [delayMs] : [];
      });
      const earliestDelayMs = Math.min(...candidates);
      if (Number.isFinite(earliestDelayMs)) {
        this.options.scheduler.scheduleOneShot(earliestDelayMs);
      }
    }
  }

  /** The periodic two-minute fallback remains active; this is only precision. */
  private nextPendingDeliveryDeadline(nowMs: number): string | null {
    const snapshot = this.currentSnapshot();
    let earliest: string | null = null;
    for (const pending of snapshot.pendingDelivery) {
      for (const channel of pending.channels) {
        if (!this.isCurrentPendingChannel(pending, channel)) continue;
        if (channel.nextAttemptAt === null) continue;
        const deadlineMs = Date.parse(channel.nextAttemptAt);
        if (!Number.isFinite(deadlineMs) || deadlineMs <= nowMs) continue;
        if (earliest === null || deadlineMs < Date.parse(earliest)) {
          earliest = channel.nextAttemptAt;
        }
      }
    }
    return earliest;
  }

  private async ensureSnapshot(): Promise<void> {
    if (this.snapshot) return;
    if (this.snapshotLoad) {
      await this.snapshotLoad;
      return;
    }
    const loading = (async () => {
      const loaded = await this.options.storage.load();
      if (loaded === null) {
        this.snapshot = createEmptySnapshot();
        return;
      }
      const parsed = parseLocalMonitorSnapshot(loaded);
      this.snapshot = parsed.success ? parsed.data : createEmptySnapshot();
      this.normalizePersistedClockSkew();
    })();
    this.snapshotLoad = loading;
    try {
      await loading;
    } finally {
      if (this.snapshotLoad === loading) this.snapshotLoad = null;
    }
  }

  /**
   * A syntactically valid future timestamp must not suppress monitoring or
   * cooldown forever when the system clock was wrong at a prior save.
   */
  private normalizePersistedClockSkew(): void {
    const snapshot = this.currentSnapshot();
    const nowMs = this.options.clock.now();
    const now = isoAt(nowMs);
    const watches = new Map(snapshot.watches.map((watch) => [watch.id, watch]));
    for (const item of snapshot.items) {
      const watch = watches.get(item.watchId);
      if (
        Date.parse(item.lastCheckedAt) >
        nowMs + MAX_PERSISTED_FUTURE_SKEW_MS
      ) {
        item.lastCheckedAt = isoAt(
          nowMs -
            (watch?.pollIntervalSec ?? DEFAULT_LOCAL_POLL_INTERVAL_SEC) * 1_000,
        );
      }
      if (
        item.lastSuccessfulAt !== null &&
        Date.parse(item.lastSuccessfulAt) > nowMs + MAX_PERSISTED_FUTURE_SKEW_MS
      ) {
        item.lastSuccessfulAt = now;
      }
      if (
        item.lastChangedAt !== null &&
        Date.parse(item.lastChangedAt) > nowMs + MAX_PERSISTED_FUTURE_SKEW_MS
      ) {
        item.lastChangedAt = now;
      }
    }
    for (const delivery of snapshot.delivery) {
      if (
        delivery.lastAlertedAt !== null &&
        Date.parse(delivery.lastAlertedAt) >
          nowMs + MAX_PERSISTED_FUTURE_SKEW_MS
      ) {
        delivery.lastAlertedAt = isoAt(nowMs - delivery.cooldownMs);
      }
      if (
        delivery.deferredAvailabilityAt !== null &&
        Date.parse(delivery.deferredAvailabilityAt) > nowMs
      ) {
        // A future observation would make a promoted event fail the strict
        // createdAt >= observedAt invariant. Recover it to the current clock
        // rather than resetting a bounded marker or inventing stock state.
        delivery.deferredAvailabilityAt = now;
      }
    }
    for (const pending of snapshot.pendingDelivery) {
      const preservedProviderDeadline = this.hasPlausibleFutureProviderDeadline(
        pending,
        nowMs,
      );
      let recoveredEventClock = false;
      if (!preservedProviderDeadline) {
        if (Date.parse(pending.createdAt) > nowMs) {
          pending.createdAt = now;
          recoveredEventClock = true;
        }
        if (Date.parse(pending.event.observedAt) > nowMs) {
          pending.event.observedAt = now;
          recoveredEventClock = true;
        }
      }
      // Keep the event ordering valid after independent timestamp recovery.
      if (
        Date.parse(pending.createdAt) < Date.parse(pending.event.observedAt)
      ) {
        pending.createdAt = pending.event.observedAt;
      }
      for (const channel of pending.channels) {
        const expiresAt =
          Date.parse(pending.event.observedAt) + PENDING_DELIVERY_RETENTION_MS;
        if (
          channel.nextAttemptAt !== null &&
          Date.parse(channel.nextAttemptAt) > expiresAt
        ) {
          if (recoveredEventClock && channel.attempts === 0) {
            // This never reached a provider, so an implausible pre-dispatch
            // timestamp can recover with the event clock without shortening
            // an externally supplied deadline.
            channel.nextAttemptAt = now;
          } else {
            // A provider deferral beyond the event's hard TTL must never be
            // shortened into an early retry. Mark it terminal/expired.
            channel.state = "expired";
            channel.completedAt = now;
            channel.nextAttemptAt = null;
          }
        }
        if (
          channel.lastAttemptAt !== null &&
          !preservedProviderDeadline &&
          Date.parse(channel.lastAttemptAt) > nowMs
        ) {
          channel.lastAttemptAt = now;
        }
        if (
          channel.completedAt !== null &&
          Date.parse(channel.completedAt) > nowMs
        ) {
          channel.completedAt = now;
        }
      }
    }
    if (
      snapshot.runtime.nextEligibleAt !== null &&
      Date.parse(snapshot.runtime.nextEligibleAt) >
        nowMs + MAX_PERSISTED_FUTURE_SKEW_MS
    ) {
      snapshot.runtime.nextEligibleAt = null;
      snapshot.runtime.consecutiveFetchFailures = 0;
    }
  }

  /**
   * Keep a bounded, already-attempted provider deadline intact when the
   * event's own clock is ahead. Rewriting it to `now` would violate an
   * upstream Retry-After. Impossible or unattempted future work uses the
   * normal clock-recovery path instead.
   */
  private hasPlausibleFutureProviderDeadline(
    pending: PendingDeliveryEvent,
    nowMs: number,
  ): boolean {
    const observedAtMs = Date.parse(pending.event.observedAt);
    return pending.channels.some((channel) => {
      if (
        channel.state !== "pending" ||
        channel.attempts === 0 ||
        channel.nextAttemptAt === null
      ) {
        return false;
      }
      const nextAttemptAtMs = Date.parse(channel.nextAttemptAt);
      return (
        Number.isFinite(observedAtMs) &&
        Number.isFinite(nextAttemptAtMs) &&
        observedAtMs > nowMs &&
        nextAttemptAtMs > nowMs &&
        nextAttemptAtMs >= observedAtMs &&
        nextAttemptAtMs <= observedAtMs + PENDING_DELIVERY_RETENTION_MS &&
        nextAttemptAtMs <= nowMs + MAX_RECOVERABLE_PENDING_DEADLINE_MS
      );
    });
  }

  private currentSnapshot(): LocalMonitorSnapshot {
    if (!this.snapshot)
      throw new Error("Local monitor snapshot is not initialized");
    return this.snapshot;
  }

  private async persist(): Promise<void> {
    const snapshot = structuredClone(this.currentSnapshot());
    const write = this.persistQueue.then(async () => {
      await this.options.storage.save(snapshot);
    });
    this.persistQueue = write.catch(() => undefined);
    await write;
  }

  private emptyReport(kind: LocalMonitorCycleKind): LocalMonitorCycleReport {
    return {
      kind,
      attemptedBatches: 0,
      unsupportedWatchIds: [],
      queuedEvents: 0,
      expiredDeliveryEvents: 0,
      queueBackpressure: false,
    };
  }
}
