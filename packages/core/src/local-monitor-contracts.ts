/**
 * Local-monitor contracts (issue #10 / L01).
 *
 * This module is the integration contract for the free standalone
 * Chrome/Firefox/Safari (macOS desktop) monitor. It defines small,
 * browser-independent types only:
 *
 * - watch configuration (`LocalWatch`),
 * - persisted observation and delivery state (`LocalMonitorSnapshot`),
 * - catalog shape and reconciliation rules,
 * - platform ports (storage, scheduling, fetch, notifications) that each
 *   browser adapter implements.
 *
 * It deliberately contains NO polling loop, NO UI code, NO DOM/Node/browser
 * imports, and NO secrets. Polling/scheduling (L08), full-tab UI (L09), and
 * installed-browser proof (L02/L22) are separate work items that consume
 * these contracts.
 *
 * Ownership rule: the extension installation is the sole owner of each local
 * watch. No server poller is ever started for a local watch. The retained
 * hosted (cloud) mode keeps its own shared `poll_group` coalescing for
 * server-side alerts only; see `docs/architecture.md`.
 *
 * Privacy rule: personal postal/location input is transient. It is used once
 * to resolve public Apple store numbers and is never persisted, logged, or
 * exported. Persisted watches retain public store numbers only. Poll-time
 * `location` values are resolved from the validated catalog store record
 * via `resolveWatchPollLocation`, never from stored user input.
 */
import { z } from "./local-zod-mini.js";
import { isAppleSelectedDevicePath } from "./apple-selected-device-path.js";

import { chunkPartNumbers, MAX_PARTS_PER_REQUEST } from "./apple-url.js";
import type { AvailabilityStatus } from "./availability.js";

// ---------------------------------------------------------------------------
// Markets
// ---------------------------------------------------------------------------

/** Desktop release markets. Lowercase codes match `catalog/iphone17.json`. */
export const LOCAL_MARKETS = ["us", "ca", "uk"] as const;
export type LocalMarketCode = (typeof LOCAL_MARKETS)[number];

export const LocalMarketCodeSchema = z.enum(LOCAL_MARKETS);
export type LocalMarketCodeInput = z.infer<typeof LocalMarketCodeSchema>;

/** Apple storefront path per local market ("" is the US storefront root). */
export const APPLE_STOREFRONT_PATHS: Readonly<Record<LocalMarketCode, string>> =
  {
    us: "",
    ca: "/ca",
    uk: "/uk",
  };

/**
 * Retained hosted API uses uppercase market codes (for example "US").
 * This mapping keeps the two modes interoperable without aliasing catalogs.
 */
export function toCloudMarketCode(market: LocalMarketCode): string {
  return market.toUpperCase();
}

// ---------------------------------------------------------------------------
// Bounds (lightweight budgets; measured per browser in L18)
// ---------------------------------------------------------------------------

/** Minimum poll interval protects Apple endpoints and idle CPU. */
export const MIN_LOCAL_POLL_INTERVAL_SEC = 120;
export const MAX_LOCAL_POLL_INTERVAL_SEC = 3_600;
export const DEFAULT_LOCAL_POLL_INTERVAL_SEC = 120;
/**
 * The v1 lower bound accepted before the two-minute policy. This exists only
 * so storage can recognize and safely migrate persisted v1 watches; callers
 * must use `MIN_LOCAL_POLL_INTERVAL_SEC` for all new runtime input.
 */
export const LEGACY_MIN_LOCAL_POLL_INTERVAL_SEC = 60;
/** One watch is capped by the Apple `parts.*` batch limit. */
export const MAX_SKUS_PER_WATCH = MAX_PARTS_PER_REQUEST;
export const MAX_STORES_PER_WATCH = 10;
export const MAX_WATCHES_PER_INSTALLATION = 20;
export const MAX_HISTORY_EVENTS_PER_WATCH = 100;
export const HISTORY_RETENTION_DAYS = 30;
/** Millisecond budget matching `HISTORY_RETENTION_DAYS`. */
export const HISTORY_RETENTION_MS =
  HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
export const DEFAULT_DELIVERY_COOLDOWN_MS = 30 * 60 * 1_000;
export const MAX_DELIVERY_COOLDOWN_MS = 24 * 60 * 60 * 1_000;
/** Durable local delivery work is deliberately bounded and visible to the UI. */
export const MAX_PENDING_DELIVERY_EVENTS = 200;
export const MAX_DELIVERY_ATTEMPTS = 8;
/** Do not deliver stale stock after a suspended browser wakes up. */
export const PENDING_DELIVERY_RETENTION_MS = 10 * 60 * 1_000;

/** Extension-local storage key for the whole snapshot. Versioned. */
export const LOCAL_MONITOR_STORAGE_KEY = "inventorySignal.localMonitor.v1";
export const LOCAL_STORAGE_SCHEMA_VERSION = 1;

/** Bundled/remote catalog schema version this core understands. */
export const SUPPORTED_LOCAL_CATALOG_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Watch configuration
// ---------------------------------------------------------------------------

export const LocalWatchIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "Watch id must be 1-64 URL-safe characters");
export type LocalWatchId = z.infer<typeof LocalWatchIdSchema>;

/** Apple part number, for example "MG464LL/A". */
export const LocalSkuSchema = z
  .string()
  .regex(
    /^[A-Z0-9]+\/[A-Z]$/,
    "SKU must be an Apple part number like MG464LL/A",
  );
export type LocalSku = z.infer<typeof LocalSkuSchema>;

/** Apple public store number as reported by the pickup endpoint. */
export const LocalStoreNumberSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9-]{1,16}$/,
    "Store number must be 1-16 alphanumeric characters",
  );
export type LocalStoreNumber = z.infer<typeof LocalStoreNumberSchema>;

const UniqueSkusSchema = z
  .array(LocalSkuSchema)
  .min(1)
  .max(MAX_SKUS_PER_WATCH)
  .refine(
    (skus) => new Set(skus).size === skus.length,
    "Watch SKUs must not contain duplicates",
  );

const UniqueStoresSchema = z
  .array(LocalStoreNumberSchema)
  .min(1)
  .max(MAX_STORES_PER_WATCH)
  .refine(
    (stores) => new Set(stores).size === stores.length,
    "Watch stores must not contain duplicates",
  );

/**
 * Opaque catalog anchor reference for a watch's pickup-location lookup.
 * It persists only a public Apple store number. The qualified public lookup
 * string lives in the validated catalog store record
 * (`LocalCatalogStore.pollLocation`, curated only after a real
 * pickup-endpoint validation) and is resolved at poll request construction
 * via {@link resolveWatchPollLocation} - never from persisted
 * caller-supplied location text. There is no persisted free-text field on
 * the watch: display names derive from the public catalog selections.
 */
export const WatchPollAnchorSchema = z.strictObject({
  storeNumber: LocalStoreNumberSchema,
});
export type WatchPollAnchor = z.infer<typeof WatchPollAnchorSchema>;

/**
 * Delivery preferences are public configuration only. Telegram credentials and
 * relay session data deliberately live outside the local-monitor snapshot.
 * Defaults are also the explicit v1 migration for snapshots created before
 * this field existed: local desktop delivery stays enabled; network channels
 * stay opt-in.
 */
export const WatchDeliveryChannelsSchema = z
  .strictObject({
    desktop: z.boolean().default(true),
    personalTelegram: z.boolean().default(false),
    hostedRelay: z.boolean().default(false),
  })
  .default({ desktop: true, personalTelegram: false, hostedRelay: false });
export type WatchDeliveryChannels = z.infer<typeof WatchDeliveryChannelsSchema>;

export const LOCAL_DELIVERY_CHANNELS = [
  "desktop",
  "personalTelegram",
  "hostedRelay",
] as const;
export type LocalDeliveryChannel = (typeof LOCAL_DELIVERY_CHANNELS)[number];
export const LocalDeliveryChannelSchema = z.enum(LOCAL_DELIVERY_CHANNELS);

export const LocalWatchSchema = z
  .strictObject({
    id: LocalWatchIdSchema,
    market: LocalMarketCodeSchema,
    skus: UniqueSkusSchema,
    /** Public Apple store numbers only. Never postal input. */
    storeNumbers: UniqueStoresSchema,
    /** Opaque public-store anchor; resolved against the catalog at poll time. */
    pollAnchor: WatchPollAnchorSchema,
    pollIntervalSec: z
      .number()
      .int()
      .min(MIN_LOCAL_POLL_INTERVAL_SEC)
      .max(MAX_LOCAL_POLL_INTERVAL_SEC)
      .default(DEFAULT_LOCAL_POLL_INTERVAL_SEC),
    enabled: z.boolean().default(true),
    /** Explicit opt-in configuration; credentials never enter this snapshot. */
    deliveryChannels: WatchDeliveryChannelsSchema,
    /** Catalog release this watch was created/validated against. */
    catalogSchemaVersion: z
      .number()
      .int()
      .min(1)
      .default(SUPPORTED_LOCAL_CATALOG_SCHEMA_VERSION),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .superRefine((watch, context) => {
    if (!watch.storeNumbers.includes(watch.pollAnchor.storeNumber)) {
      context.addIssue({
        code: "custom",
        path: ["pollAnchor", "storeNumber"],
        message: "Poll anchor must be one of the watch's selected stores",
      });
    }
  });
export type LocalWatch = z.infer<typeof LocalWatchSchema>;

export interface LocalWatchValidationIssue {
  path: string;
  message: string;
}

export type LocalWatchParseResult =
  | { success: true; data: LocalWatch }
  | { success: false; issues: readonly LocalWatchValidationIssue[] };

export function parseLocalWatch(input: unknown): LocalWatchParseResult {
  const result = LocalWatchSchema.safeParse(input);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    })),
  };
}

// ---------------------------------------------------------------------------
// Transient lookup vs persisted state (privacy boundary)
// ---------------------------------------------------------------------------

/**
 * Transient input for the one-time store-resolution step. The UI holds this
 * in memory only: the user types a postal/location string, the extension
 * makes a bounded Apple lookup, and only the chosen PUBLIC store numbers
 * are persisted. This object must never be written to storage, logs, or
 * exports.
 */
export interface StoreLookupInput {
  market: LocalMarketCode;
  /** Raw personal location input. Transient; never persisted. */
  userPostalInput: string;
}

/** Safe, closed explanations for a transient local store lookup failure. */
export const LOCAL_STORE_LOOKUP_UNKNOWN_REASONS = [
  "invalid_postal_code",
  "apple_blocked",
  "network_error",
  "timeout",
  "invalid_response",
  "storage_error",
] as const;
export type LocalStoreLookupUnknownReason =
  (typeof LOCAL_STORE_LOOKUP_UNKNOWN_REASONS)[number];

/** `reason` is optional so existing reason-less `unknown` results stay valid. */
export interface LocalStoreLookupUnknownResult {
  readonly kind: "unknown";
  readonly reason?: LocalStoreLookupUnknownReason;
}

/**
 * Narrows a transient lookup plus the user's chosen public stores down to
 * the persistable store list. Returns a failure when nothing public was
 * chosen, so callers can never fall back to persisting the postal input.
 */
export type PersistableWatchStoresResult =
  | { success: true; storeNumbers: LocalStoreNumber[] }
  | { success: false; reason: string };

export function extractPersistableWatchStores(
  lookup: StoreLookupInput,
  chosenStoreNumbers: readonly string[],
): PersistableWatchStoresResult {
  if (lookup.userPostalInput.trim().length === 0) {
    return { success: false, reason: "A location is required for lookup" };
  }
  const parsed = UniqueStoresSchema.safeParse(chosenStoreNumbers);
  if (!parsed.success) {
    return {
      success: false,
      reason: parsed.error.issues[0]?.message ?? "Invalid store selection",
    };
  }
  return { success: true, storeNumbers: [...parsed.data] };
}

// ---------------------------------------------------------------------------
// Persisted observation and delivery state
// ---------------------------------------------------------------------------

export type WatchItemStatus = AvailabilityStatus;

const KnownItemStatusSchema = z.enum([
  "available",
  "unavailable",
  "ineligible",
]);
const AnyItemStatusSchema = z.enum([
  "available",
  "unavailable",
  "ineligible",
  "unknown",
]);

/** Closed, credential-free check diagnostics; never persist provider text. */
export const LocalCheckFailureSchema = z.strictObject({
  reason: z.enum([
    "request_failed",
    "http_error",
    "identity_mismatch",
    "invalid_response",
    "missing_result",
    "unrecognized_availability",
    "catalog_unavailable",
  ]),
  httpStatus: z.number().int().min(300).max(599).optional(),
});
export type LocalCheckFailure = z.infer<typeof LocalCheckFailureSchema>;

export const WatchItemStateSchema = z
  .strictObject({
    watchId: LocalWatchIdSchema,
    market: LocalMarketCodeSchema,
    sku: LocalSkuSchema,
    storeNumber: LocalStoreNumberSchema,
    /** Current status; every parse/transport failure is `unknown`. */
    status: AnyItemStatusSchema,
    /**
     * Last non-unknown status; preserved across outages for transition
     * logic. When `status` is known it must equal `status`; when `status`
     * is `unknown` it preserves the actual prior known status (or null
     * when no check has ever succeeded).
     */
    lastKnownStatus: KnownItemStatusSchema.nullable(),
    lastChangedAt: z.string().datetime({ offset: true }).nullable(),
    lastCheckedAt: z.string().datetime({ offset: true }),
    /**
     * Timestamp of the last successful (non-unknown) observation. Known
     * observations must carry a non-null value; `unknown` preserves the
     * prior value, which may still be null before the first success.
     */
    lastSuccessfulAt: z.string().datetime({ offset: true }).nullable(),
    consecutiveUnknowns: z.number().int().min(0).default(0),
    lastFailure: LocalCheckFailureSchema.optional(),
  })
  .superRefine((item, context) => {
    if (item.status === "unknown") return;
    if (item.lastFailure !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["lastFailure"],
        message: "Successful observations must not retain a check failure",
      });
    }
    if (item.lastKnownStatus !== item.status) {
      context.addIssue({
        code: "custom",
        path: ["lastKnownStatus"],
        message: "Known observations must carry a matching lastKnownStatus",
      });
    }
    if (item.lastSuccessfulAt === null) {
      context.addIssue({
        code: "custom",
        path: ["lastSuccessfulAt"],
        message: "Known observations must carry a non-null lastSuccessfulAt",
      });
    }
  });
export type WatchItemState = z.infer<typeof WatchItemStateSchema>;

export const WatchDeliveryStateSchema = z
  .strictObject({
    watchId: LocalWatchIdSchema,
    market: LocalMarketCodeSchema,
    sku: LocalSkuSchema,
    storeNumber: LocalStoreNumberSchema,
    lastAlertedAt: z.string().datetime({ offset: true }).nullable(),
    cooldownMs: z
      .number()
      .int()
      .min(0)
      .max(MAX_DELIVERY_COOLDOWN_MS)
      .default(DEFAULT_DELIVERY_COOLDOWN_MS),
    /**
     * Bounded per-item deferred availability marker. It preserves an alertable
     * availability transition when the separate 200-event dispatch ledger is
     * full, without growing another queue. The engine reconstructs the public
     * event only while this marker is fresh and its watch revision still agrees.
     */
    deferredAvailabilityAt: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .default(null),
    deferredWatchUpdatedAt: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .default(null),
    deferredAvailabilityState: z
      .enum(["none", "pending", "expired", "superseded", "revoked"])
      .default("none"),
  })
  .superRefine((delivery, context) => {
    const hasMarker =
      delivery.deferredAvailabilityAt !== null ||
      delivery.deferredWatchUpdatedAt !== null;
    if (delivery.deferredAvailabilityState === "pending" && !hasMarker) {
      context.addIssue({
        code: "custom",
        path: ["deferredAvailabilityAt"],
        message:
          "Pending deferred availability requires a timestamp and watch revision",
      });
    }
    if (
      delivery.deferredAvailabilityState === "pending" &&
      (delivery.deferredAvailabilityAt === null ||
        delivery.deferredWatchUpdatedAt === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["deferredWatchUpdatedAt"],
        message:
          "Pending deferred availability requires a timestamp and watch revision",
      });
    }
    if (delivery.deferredAvailabilityState !== "pending" && hasMarker) {
      context.addIssue({
        code: "custom",
        path: ["deferredAvailabilityState"],
        message:
          "Terminal deferred availability must not retain a promotable marker",
      });
    }
  });
export type WatchDeliveryState = z.infer<typeof WatchDeliveryStateSchema>;

export const WatchHistoryEventSchema = z.strictObject({
  watchId: LocalWatchIdSchema,
  market: LocalMarketCodeSchema,
  sku: LocalSkuSchema,
  storeNumber: LocalStoreNumberSchema,
  from: AnyItemStatusSchema.nullable(),
  to: AnyItemStatusSchema,
  at: z.string().datetime({ offset: true }),
});
export type WatchHistoryEvent = z.infer<typeof WatchHistoryEventSchema>;

/**
 * Event payload stored before channel dispatch. It contains only validated
 * public catalog/Apple identifiers; no credentials, personal location input,
 * raw upstream body, or provider error can be represented here.
 */
export const LocalAvailabilityEventSchema = z.strictObject({
  watchId: LocalWatchIdSchema,
  market: LocalMarketCodeSchema,
  sku: LocalSkuSchema,
  title: z.string().trim().min(1).max(200),
  storeNumber: LocalStoreNumberSchema,
  storeName: z.string().trim().min(1).max(160),
  observedAt: z.string().datetime({ offset: true }),
  purchaseUrl: z.url().refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "www.apple.com" &&
      url.username === "" &&
      url.password === "" &&
      (url.port === "" || url.port === "443")
    );
  }, "Purchase URL must be HTTPS on www.apple.com without credentials"),
});
export type LocalAvailabilityEvent = z.infer<
  typeof LocalAvailabilityEventSchema
>;

/**
 * Optional provider outcome for a delivery attempt. `void` remains a success
 * for existing adapters; retry timing contains only a validated absolute
 * timestamp, never a provider body/header/error. The engine owns waiting and
 * durable retry state so adapters never sleep in a worker callback.
 */
export const LocalDeliveryDispatchResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("delivered") }),
  z.strictObject({
    kind: z.literal("retry_not_before"),
    retryNotBefore: z.string().datetime({ offset: true }),
  }),
  z.strictObject({ kind: z.literal("terminal") }),
]);
export type LocalDeliveryDispatchResult = z.infer<
  typeof LocalDeliveryDispatchResultSchema
>;

export function parseLocalDeliveryDispatchResult(
  input: unknown,
): LocalDeliveryDispatchResult | null {
  const parsed = LocalDeliveryDispatchResultSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export const PendingDeliveryEventIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "Event id must be 1-64 URL-safe characters");
export type PendingDeliveryEventId = z.infer<
  typeof PendingDeliveryEventIdSchema
>;

export const DeliveryAttemptStateSchema = z.enum([
  "pending",
  "delivered",
  "failed",
  "revoked",
  "expired",
  "superseded",
]);
export type DeliveryAttemptState = z.infer<typeof DeliveryAttemptStateSchema>;

export const PendingDeliveryChannelStateSchema = z.strictObject({
  channel: LocalDeliveryChannelSchema,
  state: DeliveryAttemptStateSchema,
  attempts: z.number().int().min(0).max(MAX_DELIVERY_ATTEMPTS),
  nextAttemptAt: z.string().datetime({ offset: true }).nullable(),
  lastAttemptAt: z.string().datetime({ offset: true }).nullable(),
  completedAt: z.string().datetime({ offset: true }).nullable(),
});
export type PendingDeliveryChannelState = z.infer<
  typeof PendingDeliveryChannelStateSchema
>;

export const PendingDeliveryEventSchema = z
  .strictObject({
    eventId: PendingDeliveryEventIdSchema,
    /** The exact watch revision that authorized this event. */
    watchUpdatedAt: z.string().datetime({ offset: true }),
    event: LocalAvailabilityEventSchema,
    createdAt: z.string().datetime({ offset: true }),
    channels: z.array(PendingDeliveryChannelStateSchema).min(1).max(3),
  })
  .superRefine((pending, context) => {
    if (Date.parse(pending.createdAt) < Date.parse(pending.event.observedAt)) {
      context.addIssue({
        code: "custom",
        path: ["createdAt"],
        message: "Delivery work cannot be created before its observation",
      });
    }
    const seenChannels = new Set<string>();
    for (const [index, channel] of pending.channels.entries()) {
      if (seenChannels.has(channel.channel)) {
        context.addIssue({
          code: "custom",
          path: ["channels", index, "channel"],
          message: "One delivery state is allowed per channel and event",
        });
      }
      seenChannels.add(channel.channel);
      if (channel.state === "pending" && channel.completedAt !== null) {
        context.addIssue({
          code: "custom",
          path: ["channels", index, "completedAt"],
          message: "Pending channel work cannot be completed",
        });
      }
      if (channel.state !== "pending" && channel.completedAt === null) {
        context.addIssue({
          code: "custom",
          path: ["channels", index, "completedAt"],
          message: "Terminal channel work records its completion time",
        });
      }
    }
  });
export type PendingDeliveryEvent = z.infer<typeof PendingDeliveryEventSchema>;

/** Persisted, non-secret scheduling state shared across worker restarts. */
export const LocalMonitorRuntimeStateSchema = z
  .strictObject({
    /** Global conservative host backoff; null means immediately eligible. */
    nextEligibleAt: z.string().datetime({ offset: true }).nullable(),
    consecutiveFetchFailures: z.number().int().min(0).max(16).default(0),
  })
  .default({ nextEligibleAt: null, consecutiveFetchFailures: 0 });
export type LocalMonitorRuntimeState = z.infer<
  typeof LocalMonitorRuntimeStateSchema
>;

const SnapshotScopeSchema = z.strictObject({
  watchId: LocalWatchIdSchema,
  market: LocalMarketCodeSchema,
  sku: LocalSkuSchema,
  storeNumber: LocalStoreNumberSchema,
});

function snapshotScopeKey(scope: z.infer<typeof SnapshotScopeSchema>): string {
  return `${scope.watchId}\u0000${scope.market}\u0000${scope.sku}\u0000${scope.storeNumber}`;
}

function addSnapshotReferenceIssues(
  context: z.RefinementCtx,
  entries: readonly z.infer<typeof SnapshotScopeSchema>[],
  watches: readonly LocalWatch[],
  path: "items" | "delivery" | "history",
  requireUnique: boolean,
): void {
  const watchesById = new Map(watches.map((watch) => [watch.id, watch]));
  const entryIndexes = new Map<string, number>();
  for (const [index, entry] of entries.entries()) {
    const watch = watchesById.get(entry.watchId);
    if (!watch) {
      context.addIssue({
        code: "custom",
        path: [path, index, "watchId"],
        message: "Snapshot state must reference an existing watch",
      });
      continue;
    }
    if (watch.market !== entry.market) {
      context.addIssue({
        code: "custom",
        path: [path, index, "market"],
        message: "Snapshot state market must match its watch",
      });
    }
    if (!watch.skus.includes(entry.sku)) {
      context.addIssue({
        code: "custom",
        path: [path, index, "sku"],
        message: "Snapshot state SKU must belong to its watch",
      });
    }
    if (!watch.storeNumbers.includes(entry.storeNumber)) {
      context.addIssue({
        code: "custom",
        path: [path, index, "storeNumber"],
        message: "Snapshot state store must belong to its watch",
      });
    }
    if (requireUnique) {
      const key = snapshotScopeKey(entry);
      if (entryIndexes.has(key)) {
        context.addIssue({
          code: "custom",
          path: [path, index],
          message: `Duplicate ${path} state for one watch SKU/store scope`,
        });
      } else {
        entryIndexes.set(key, index);
      }
    }
  }
}

export const LocalMonitorSnapshotSchema = z
  .strictObject({
    version: z.literal(LOCAL_STORAGE_SCHEMA_VERSION),
    watches: z.array(LocalWatchSchema).max(MAX_WATCHES_PER_INSTALLATION),
    items: z
      .array(WatchItemStateSchema)
      .max(
        MAX_WATCHES_PER_INSTALLATION *
          MAX_SKUS_PER_WATCH *
          MAX_STORES_PER_WATCH,
      ),
    delivery: z
      .array(WatchDeliveryStateSchema)
      .max(
        MAX_WATCHES_PER_INSTALLATION *
          MAX_SKUS_PER_WATCH *
          MAX_STORES_PER_WATCH,
      ),
    history: z
      .array(WatchHistoryEventSchema)
      .max(MAX_WATCHES_PER_INSTALLATION * MAX_HISTORY_EVENTS_PER_WATCH),
    /** Durable at-least-once delivery ledger; terminal entries are audit data. */
    pendingDelivery: z
      .array(PendingDeliveryEventSchema)
      .max(MAX_PENDING_DELIVERY_EVENTS)
      .default([]),
    /** Legacy v1 snapshots default safely instead of being discarded. */
    runtime: LocalMonitorRuntimeStateSchema,
  })
  .superRefine((snapshot, context) => {
    const watchIds = new Set<string>();
    for (const [index, watch] of snapshot.watches.entries()) {
      if (watchIds.has(watch.id)) {
        context.addIssue({
          code: "custom",
          path: ["watches", index, "id"],
          message: "Snapshot watches must have unique ids",
        });
      }
      watchIds.add(watch.id);
    }
    addSnapshotReferenceIssues(
      context,
      snapshot.items,
      snapshot.watches,
      "items",
      true,
    );
    addSnapshotReferenceIssues(
      context,
      snapshot.delivery,
      snapshot.watches,
      "delivery",
      true,
    );
    addSnapshotReferenceIssues(
      context,
      snapshot.history,
      snapshot.watches,
      "history",
      false,
    );
    const watchesById = new Map(
      snapshot.watches.map((watch) => [watch.id, watch]),
    );
    const pendingEventIds = new Set<string>();
    for (const [index, pending] of snapshot.pendingDelivery.entries()) {
      if (pendingEventIds.has(pending.eventId)) {
        context.addIssue({
          code: "custom",
          path: ["pendingDelivery", index, "eventId"],
          message: "Pending delivery event ids must be unique",
        });
      }
      pendingEventIds.add(pending.eventId);
      const watch = watchesById.get(pending.event.watchId);
      if (!watch) {
        context.addIssue({
          code: "custom",
          path: ["pendingDelivery", index, "event", "watchId"],
          message: "Pending delivery must reference an existing watch",
        });
      } else if (
        watch.market !== pending.event.market ||
        !watch.skus.includes(pending.event.sku) ||
        !watch.storeNumbers.includes(pending.event.storeNumber)
      ) {
        context.addIssue({
          code: "custom",
          path: ["pendingDelivery", index, "event"],
          message: "Pending delivery scope must belong to its watch",
        });
      }
    }
    const historyCounts = new Map<string, number>();
    for (const [index, event] of snapshot.history.entries()) {
      const count = (historyCounts.get(event.watchId) ?? 0) + 1;
      historyCounts.set(event.watchId, count);
      if (count > MAX_HISTORY_EVENTS_PER_WATCH) {
        context.addIssue({
          code: "custom",
          path: ["history", index],
          message: "History is limited to 100 events per watch",
        });
      }
    }
  });
export type LocalMonitorSnapshot = z.infer<typeof LocalMonitorSnapshotSchema>;

export function createEmptySnapshot(): LocalMonitorSnapshot {
  return {
    version: LOCAL_STORAGE_SCHEMA_VERSION,
    watches: [],
    items: [],
    delivery: [],
    history: [],
    pendingDelivery: [],
    runtime: { nextEligibleAt: null, consecutiveFetchFailures: 0 },
  };
}

export function parseLocalMonitorSnapshot(
  input: unknown,
):
  | { success: true; data: LocalMonitorSnapshot }
  | { success: false; issues: readonly LocalWatchValidationIssue[] } {
  const result = LocalMonitorSnapshotSchema.safeParse(input);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    })),
  };
}

/**
 * Canonical history ordering is newest-first, sorted by `at` descending.
 * This helper discards entries older than `HISTORY_RETENTION_DAYS` relative
 * to the injectable `nowMs`, then caps each watch independently to the
 * newest `maxEvents` events. It is pure so adapters (L08) cannot accumulate
 * unbounded queues. Callers pass an explicit `nowMs` in tests to avoid
 * wall-clock flakiness; the default is `Date.now()`.
 */
export function capHistoryEvents(
  events: readonly WatchHistoryEvent[],
  maxEvents = MAX_HISTORY_EVENTS_PER_WATCH,
  nowMs: number = Date.now(),
): WatchHistoryEvent[] {
  if (!Number.isInteger(maxEvents) || maxEvents < 1) return [];
  if (!Number.isFinite(nowMs)) return [];
  const live = events.filter((event) => {
    const atMs = Date.parse(event.at);
    if (!Number.isFinite(atMs)) return false;
    return nowMs - atMs <= HISTORY_RETENTION_MS;
  });
  live.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const keptPerWatch = new Map<string, number>();
  const capped: WatchHistoryEvent[] = [];
  for (const event of live) {
    const kept = keptPerWatch.get(event.watchId) ?? 0;
    if (kept >= maxEvents) continue;
    keptPerWatch.set(event.watchId, kept + 1);
    capped.push(event);
  }
  return capped;
}

// ---------------------------------------------------------------------------
// Local catalog (data-only; never executable)
// ---------------------------------------------------------------------------

export const LocalCatalogVariantSchema = z.strictObject({
  sku: LocalSkuSchema,
  title: z.string().trim().min(1).max(200),
  familySlug: z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/)
    .optional(),
  /**
   * Optional, catalog-owned Apple selected-device path. It is never supplied
   * by a watch, notification, web page, or caller. Runtime code must still
   * bind it to this exact catalog SKU before opening it.
   */
  buyPath: z
    .string()
    .min(1)
    .max(240)
    .regex(/^\/[a-z0-9./-]+$/)
    .refine(
      (value) =>
        !value.startsWith("//") &&
        !value.includes("..") &&
        !value.includes("//"),
      "Catalog buy path must be a canonical relative path",
    )
    .refine(
      isAppleSelectedDevicePath,
      "Catalog buy path must be a reviewed Apple selected-device path",
    )
    .optional(),
});
export type LocalCatalogVariant = z.infer<typeof LocalCatalogVariantSchema>;

/**
 * Qualified public pickup lookup string for one catalog store. Curated only
 * after a real pickup-endpoint validation (L02); never copied from user
 * postal input or inferred from a city. This is the sole source for
 * poll-time Apple `location` values via {@link resolveWatchPollLocation}.
 */
export const CatalogPollLocationSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/.test(value),
    "Catalog poll location must not contain control characters",
  );
export type CatalogPollLocation = z.infer<typeof CatalogPollLocationSchema>;

export const LocalCatalogStoreSchema = z.strictObject({
  storeNumber: LocalStoreNumberSchema,
  name: z.string().trim().min(1).max(160),
  city: z.string().trim().min(1).max(120).nullable().default(null),
  region: z.string().trim().min(1).max(120).nullable().default(null),
  /** Qualified public lookup string for Apple pickup requests. */
  pollLocation: CatalogPollLocationSchema,
});
export type LocalCatalogStore = z.infer<typeof LocalCatalogStoreSchema>;

export const LocalCatalogMarketSchema = z
  .strictObject({
    code: LocalMarketCodeSchema,
    name: z.string().trim().min(1).max(80),
    storefrontPath: z.string().max(16),
    variants: z.array(LocalCatalogVariantSchema).min(1),
    stores: z.array(LocalCatalogStoreSchema),
  })
  .superRefine((market, context) => {
    const seenSkus = new Set<string>();
    for (const [index, variant] of market.variants.entries()) {
      if (seenSkus.has(variant.sku)) {
        context.addIssue({
          code: "custom",
          path: ["variants", index, "sku"],
          message: `Duplicate variant SKU ${variant.sku} in market ${market.code}`,
        });
      }
      seenSkus.add(variant.sku);
    }
    const seenStores = new Set<string>();
    for (const [index, store] of market.stores.entries()) {
      if (seenStores.has(store.storeNumber)) {
        context.addIssue({
          code: "custom",
          path: ["stores", index, "storeNumber"],
          message: `Duplicate store ${store.storeNumber} in market ${market.code}`,
        });
      }
      seenStores.add(store.storeNumber);
    }
  });
export type LocalCatalogMarket = z.infer<typeof LocalCatalogMarketSchema>;

export const LocalCatalogSnapshotSchema = z
  .strictObject({
    schemaVersion: z.literal(SUPPORTED_LOCAL_CATALOG_SCHEMA_VERSION),
    generatedAt: z.string().datetime({ offset: true }),
    markets: z.array(LocalCatalogMarketSchema).min(1).max(3),
  })
  .superRefine((snapshot, context) => {
    const seenCodes = new Set<string>();
    for (const [index, market] of snapshot.markets.entries()) {
      if (seenCodes.has(market.code)) {
        context.addIssue({
          code: "custom",
          path: ["markets", index, "code"],
          message: `Duplicate market code ${market.code}`,
        });
      }
      seenCodes.add(market.code);
    }
  });
export type LocalCatalogSnapshot = z.infer<typeof LocalCatalogSnapshotSchema>;

export function parseLocalCatalogSnapshot(
  input: unknown,
):
  | { success: true; data: LocalCatalogSnapshot }
  | { success: false; issues: readonly LocalWatchValidationIssue[] } {
  const result = LocalCatalogSnapshotSchema.safeParse(input);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    })),
  };
}

export type CatalogFreshness =
  | { kind: "current" }
  | { kind: "newer_available" }
  | { kind: "rollback_rejected"; reason: string }
  | { kind: "unsupported_version"; reason: string };

/**
 * Guards data-only catalog updates: newer timestamps may replace the
 * bundled fallback; older ones are rejected as rollbacks; unknown schema
 * versions are rejected outright. A rejected update must keep the
 * last-known-good catalog and must never touch watches.
 */
export function compareCatalogFreshness(
  current: Pick<LocalCatalogSnapshot, "schemaVersion" | "generatedAt">,
  candidate: { schemaVersion: number; generatedAt: string },
): CatalogFreshness {
  if (candidate.schemaVersion !== SUPPORTED_LOCAL_CATALOG_SCHEMA_VERSION) {
    return {
      kind: "unsupported_version",
      reason: `Unsupported catalog schema version ${candidate.schemaVersion}`,
    };
  }
  const currentTime = Date.parse(current.generatedAt);
  const candidateTime = Date.parse(candidate.generatedAt);
  if (!Number.isFinite(candidateTime)) {
    return {
      kind: "rollback_rejected",
      reason: "Candidate catalog timestamp is not a valid date",
    };
  }
  if (candidateTime < currentTime) {
    return {
      kind: "rollback_rejected",
      reason: "Candidate catalog is older than the active catalog",
    };
  }
  if (candidateTime === currentTime) return { kind: "current" };
  return { kind: "newer_available" };
}

/**
 * Remote catalog updates may only come from one fixed project-controlled
 * HTTPS origin (L06 wires the concrete value). Arbitrary URLs are rejected
 * so a refresh can never be redirected at an attacker host.
 */
export function isAllowedCatalogUrl(
  candidateUrl: string,
  allowedOrigin: string,
): boolean {
  let candidate: URL;
  let allowed: URL;
  try {
    candidate = new URL(candidateUrl);
    allowed = new URL(allowedOrigin);
  } catch {
    return false;
  }
  return (
    candidate.protocol === "https:" &&
    allowed.protocol === "https:" &&
    candidate.origin === allowed.origin
  );
}

export interface WatchCatalogIssue {
  kind:
    | "unknown_sku"
    | "unknown_store"
    | "title_mismatch"
    | "ambiguous_catalog";
  sku?: string;
  storeNumber?: string;
  message: string;
}

/**
 * Resolves a watch's poll-time Apple `location` from the validated catalog.
 * Returns the catalog store's qualified public lookup string for the
 * watch's anchor store, or null when the market/store is absent or the
 * catalog is ambiguous (duplicate store rows). Adapters (L08) must call
 * this at poll request construction; the persisted watch carries no
 * location text to read. Pure lookup - no network fetching.
 */
export function resolveWatchPollLocation(
  watch: Pick<LocalWatch, "market" | "pollAnchor">,
  catalog: LocalCatalogSnapshot,
): string | null {
  const market = catalog.markets.find((entry) => entry.code === watch.market);
  if (!market) return null;
  const matches = market.stores.filter(
    (store) => store.storeNumber === watch.pollAnchor.storeNumber,
  );
  if (matches.length !== 1) return null;
  return matches[0]?.pollLocation ?? null;
}

/**
 * Reconciles a watch against a catalog snapshot. Retired/unknown SKUs and
 * stores are REPORTED so the UI can mark them honestly; they are never
 * deleted or converted to unavailable here. Duplicate catalog rows for a
 * referenced SKU/store are reported as `ambiguous_catalog` instead of
 * silently first-matching. Catalog refresh failure must keep working
 * watches untouched (callers keep last-known-good). Callers must pass a
 * catalog accepted by `parseLocalCatalogSnapshot`, which already rejects
 * duplicates; the runtime duplicate guards below are defense-in-depth for
 * programmatically constructed snapshots.
 */
export function reconcileWatchWithCatalog(
  watch: Pick<LocalWatch, "market" | "skus" | "storeNumbers" | "pollAnchor">,
  catalog: LocalCatalogSnapshot,
  expectedTitles: Readonly<Record<string, string>> = {},
): readonly WatchCatalogIssue[] {
  const market = catalog.markets.find((entry) => entry.code === watch.market);
  if (!market) {
    return [
      {
        kind: "unknown_sku",
        message: `Market ${watch.market} is not in the catalog`,
      },
    ];
  }
  const issues: WatchCatalogIssue[] = [];
  const skuCounts = new Map<string, number>();
  for (const variant of market.variants) {
    skuCounts.set(variant.sku, (skuCounts.get(variant.sku) ?? 0) + 1);
  }
  const storeCounts = new Map<string, number>();
  for (const store of market.stores) {
    storeCounts.set(
      store.storeNumber,
      (storeCounts.get(store.storeNumber) ?? 0) + 1,
    );
  }
  const catalogSkus = new Set(skuCounts.keys());
  const catalogStores = new Set(
    market.stores.map((store) => store.storeNumber),
  );
  const titlesBySku = new Map(
    market.variants.map((variant) => [variant.sku, variant.title] as const),
  );
  for (const sku of watch.skus) {
    if ((skuCounts.get(sku) ?? 0) > 1) {
      issues.push({
        kind: "ambiguous_catalog",
        sku,
        message: `SKU ${sku} appears more than once in the ${watch.market} catalog; refusing to match`,
      });
      continue;
    }
    if (!catalogSkus.has(sku)) {
      issues.push({
        kind: "unknown_sku",
        sku,
        message: `SKU ${sku} is not in the ${watch.market} catalog`,
      });
      continue;
    }
    const expected = expectedTitles[sku];
    const actual = titlesBySku.get(sku);
    if (expected !== undefined && actual !== undefined && expected !== actual) {
      issues.push({
        kind: "title_mismatch",
        sku,
        message: `Title changed for ${sku}; revalidate before trusting stock`,
      });
    }
  }
  for (const storeNumber of watch.storeNumbers) {
    if ((storeCounts.get(storeNumber) ?? 0) > 1) {
      issues.push({
        kind: "ambiguous_catalog",
        storeNumber,
        message: `Store ${storeNumber} appears more than once in the ${watch.market} catalog; refusing to match`,
      });
      continue;
    }
    if (!catalogStores.has(storeNumber)) {
      issues.push({
        kind: "unknown_store",
        storeNumber,
        message: `Store ${storeNumber} is not in the ${watch.market} catalog`,
      });
    }
  }
  if (!watch.storeNumbers.includes(watch.pollAnchor.storeNumber)) {
    issues.push({
      kind: "unknown_store",
      storeNumber: watch.pollAnchor.storeNumber,
      message: `Poll anchor store ${watch.pollAnchor.storeNumber} is not one of the watch's selected stores`,
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Request coalescing within one installation
// ---------------------------------------------------------------------------

export interface LocalPollBatch {
  market: LocalMarketCode;
  storefrontPath: string;
  /** Public anchor store scoping one pickup-location lookup. */
  anchorStoreNumber: LocalStoreNumber;
  /**
   * Catalog-resolved qualified public lookup string for this batch
   * (see {@link resolveWatchPollLocation}). Never persisted caller text.
   */
  location: string;
  /** SKU chunks of at most MAX_PARTS_PER_REQUEST for one Apple request each. */
  skuChunks: LocalSku[][];
  /** Watch ids covered by this batch (for fanning results back out). */
  watchIds: readonly string[];
}

/**
 * Coalesces enabled watches sharing one market AND one catalog-resolved
 * public polling location. Each watch's `location` is resolved from the
 * validated catalog via {@link resolveWatchPollLocation} - never from
 * persisted caller-supplied text. An Apple pickup response's store coverage
 * is location-scoped, so market-only batching could assign an incomplete
 * store result to another watch. Watches whose anchor cannot be resolved
 * against the catalog are excluded (callers must reconcile first). The
 * retained hosted mode keeps its own server-side poll-group coalescing;
 * the two scopes never mix.
 */
export function coalescePollBatches(
  watches: readonly Pick<
    LocalWatch,
    "id" | "market" | "skus" | "pollAnchor" | "enabled"
  >[],
  catalog: LocalCatalogSnapshot,
): LocalPollBatch[] {
  interface PollScopeAccumulator {
    market: LocalMarketCode;
    anchorStoreNumber: LocalStoreNumber;
    location: string;
    skus: LocalSku[];
    watchIds: string[];
  }
  const byPollScope = new Map<string, PollScopeAccumulator>();
  for (const watch of watches) {
    if (!watch.enabled) continue;
    const location = resolveWatchPollLocation(watch, catalog);
    if (location === null) continue;
    const scope = `${watch.market}\u0000${watch.pollAnchor.storeNumber}`;
    let entry = byPollScope.get(scope);
    if (!entry) {
      entry = {
        market: watch.market,
        anchorStoreNumber: watch.pollAnchor.storeNumber,
        location,
        skus: [],
        watchIds: [],
      };
      byPollScope.set(scope, entry);
    }
    entry.watchIds.push(watch.id);
    for (const sku of watch.skus) {
      if (!entry.skus.includes(sku)) entry.skus.push(sku);
    }
  }
  return [...byPollScope.values()].map((entry) => ({
    market: entry.market,
    storefrontPath: APPLE_STOREFRONT_PATHS[entry.market],
    anchorStoreNumber: entry.anchorStoreNumber,
    location: entry.location,
    skuChunks: chunkPartNumbers(entry.skus),
    watchIds: entry.watchIds,
  }));
}

// ---------------------------------------------------------------------------
// Failure model: everything not explicitly available is never "unavailable"
// ---------------------------------------------------------------------------

/**
 * Local check failure codes. Every one maps to an `unknown` observation;
 * none may be rewritten as `unavailable`. Mirrors the parser fail-closed
 * invariant in `apple-pickup.ts` for the transport layer.
 */
export const LOCAL_UNKNOWN_ERROR_CODES = [
  "http_error",
  "timeout",
  "offline",
  "blocked",
  "malformed",
  "denied_permission",
] as const;
export type LocalCheckErrorCode = (typeof LOCAL_UNKNOWN_ERROR_CODES)[number];

export function toObservedStatusFromError(
  _code: LocalCheckErrorCode,
): Extract<AvailabilityStatus, "unknown"> {
  return "unknown";
}

// ---------------------------------------------------------------------------
// Platform ports (interfaces only; browser adapters implement these in L05)
// ---------------------------------------------------------------------------

/** Minimal clock so scheduling logic stays testable without timers. */
export interface LocalMonitorClock {
  now(): number;
}

/** Versioned async key-value storage (chrome.storage / browser.storage). */
export interface LocalStoragePort {
  load(): Promise<LocalMonitorSnapshot | null>;
  save(snapshot: LocalMonitorSnapshot): Promise<void>;
}

/** Alarm/timer scheduling (chrome.alarms / browser.alarms). */
export interface LocalSchedulerPort {
  /** Best-effort periodic wake-up; the OS/browser may delay it. */
  schedulePeriodic(intervalSec: number): void;
  /** One-shot wake-up, for check-now and backoff retries. */
  scheduleOneShot(delayMs: number): void;
  cancelAll(): void;
}

export const ApplePickupFetchRequestSchema = z.strictObject({
  market: LocalMarketCodeSchema,
  /** Public anchor store scoping this lookup. */
  anchorStoreNumber: LocalStoreNumberSchema,
  /**
   * Catalog-resolved qualified public lookup string
   * (see {@link resolveWatchPollLocation}). Adapters must never substitute
   * persisted caller-supplied location text here.
   */
  location: CatalogPollLocationSchema,
  skus: z.array(LocalSkuSchema).min(1).max(MAX_PARTS_PER_REQUEST),
});
export type ApplePickupFetchRequest = z.infer<
  typeof ApplePickupFetchRequestSchema
>;

export const ApplePickupFetchResponseSchema = z.strictObject({
  httpStatus: z.number().int().min(100).max(599),
  /** Parsed JSON body or raw text when the payload is not JSON. */
  body: z.unknown(),
  /** Parsed bounded Retry-After hint; adapters never persist raw headers. */
  retryAfterMs: z
    .number()
    .int()
    .min(0)
    .max(10 * 60 * 1_000)
    .optional(),
});
export type ApplePickupFetchResponse = z.infer<
  typeof ApplePickupFetchResponseSchema
>;

/**
 * Narrow Apple fetch. Implementations request only
 * `https://www.apple.com/*` pickup-message URLs, never blanket hosts, and
 * must use the catalog-resolved `location` unchanged (see
 * {@link resolveWatchPollLocation}).
 * Raw bodies go straight to the strict parser; they must not be logged.
 */
export interface AppleFetchPort {
  fetchPickup(
    request: ApplePickupFetchRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ApplePickupFetchResponse>;
}

/** Desktop notification + badge/history surface. No account required. */
export interface DesktopNotificationPort {
  permissionState(): Promise<"granted" | "denied" | "prompt">;
  requestPermission(): Promise<"granted" | "denied">;
  notifyAvailable(event: LocalAvailabilityEvent): Promise<void>;
}

/**
 * Optional personal-Telegram delivery. The bot token and chat id are passed
 * at call time from extension-local storage and must never enter the
 * persisted snapshot, logs, or exports.
 */
export interface PersonalTelegramPort {
  sendAvailable(
    credentials: { botToken: string; chatId: string },
    event: LocalAvailabilityEvent,
  ): Promise<void | LocalDeliveryDispatchResult>;
}

/**
 * Optional relay to the retained hosted service (email/Web Push/shared bot).
 * Strictly opt-in per watch; local monitoring works fully without it, and
 * enabling it must never start server-side polling for the local watch.
 */
export interface HostedRelayPort {
  readonly enabled: boolean;
  forwardAvailable(event: LocalAvailabilityEvent): Promise<void>;
}
