/**
 * Local desktop-alert adapter (L10).
 *
 * This deliberately does not own a retry queue: the monitor engine persists
 * and retries the per-channel delivery work.  The only durable data here is a
 * small, public click-reference/read-state ledger so a browser notification
 * can be resolved safely after a worker restart.
 */
import {
  LocalAvailabilityEventSchema,
  type LocalAvailabilityEvent,
} from "../../../../packages/core/src/local-monitor-contracts.js";
import { isSafeApplePurchaseUrl } from "../protocol";
import type { ExtensionApi } from "../platform/api";
import type { ExtensionPlatform } from "../platform/adapters";
import { callExtensionVoid } from "../platform/async";

const STORAGE_KEY = "desktop-alert-state-v1";
const STATE_VERSION = 1;
const MAX_REFERENCES = 100;
const REFERENCE_TTL_MS = 10 * 60_000;
const MAX_CLOCK_SKEW_MS = 60_000;
const NOTIFICATION_ID_PREFIX = "inventory-signal-available-";
const DIAGNOSTIC_NOTIFICATION_ID = "inventory-signal-diagnostic-v1";
const DIAGNOSTIC_TITLE = "Inventory Signal test notification";
const DIAGNOSTIC_MESSAGE =
  "This is a test notification. It does not report Apple availability.";
const DIAGNOSTIC_COOLDOWN_MS = 30_000;
const DIAGNOSTIC_TIMEOUT_MS = 5_000;

export type DesktopAlertDeliveryKind =
  | "scheduled"
  | "deduplicated"
  | "permission-denied"
  | "unsupported"
  | "invalid"
  | "stale"
  | "aborted";

export type DesktopAlertSoundStatus =
  | "disabled"
  | "unsupported"
  | "played"
  | "blocked";

export interface DesktopAlertDeliveryResult {
  readonly kind: DesktopAlertDeliveryKind;
  /** Browser scheduling is not proof of an OS receipt (Focus may suppress it). */
  readonly sound: DesktopAlertSoundStatus;
}

export type DesktopAlertDiagnosticKind =
  | "scheduled"
  | "permission-denied"
  | "unsupported"
  | "cooldown"
  | "in-flight"
  | "unavailable";

export interface DesktopAlertDiagnosticResult {
  readonly kind: DesktopAlertDiagnosticKind;
}

export type DesktopAlertClickResult =
  | { readonly kind: "opened-apple" }
  | { readonly kind: "local-result" }
  | { readonly kind: "denied"; readonly reason: string }
  | { readonly kind: "ignored" };

/**
 * Clicks are revalidated against the *current* watch, current catalog, and
 * current availability state.  A notification is only a stale public hint;
 * it never authorizes a purchase link by itself.
 */
export interface DesktopAlertCurrentStateValidator {
  /**
   * Re-check immediately before browser notification scheduling. This narrows
   * stale-watch delivery; engine-owned generation AbortSignals are still
   * needed because the browser API cannot be made atomic.
   */
  canDeliver(event: LocalAvailabilityEvent): Promise<boolean>;
  resolveClick(
    event: LocalAvailabilityEvent,
  ): Promise<"open-apple" | "show-local-result" | "deny">;
}

/** Optional and intentionally injected: no hidden audio page or daemon. */
export interface DesktopAlertSoundPort {
  readonly enabled: boolean;
  play(options?: { signal?: AbortSignal }): Promise<void>;
}

export type NativeDesktopScheduleResult =
  | "scheduled"
  | "duplicate"
  | "denied"
  | "unavailable"
  | "invalid"
  | "aborted";

export interface NativeDesktopScheduleRequest {
  readonly event: LocalAvailabilityEvent;
  readonly eventFingerprint: string;
  readonly expiresAt: string;
  readonly signal?: AbortSignal;
}

/** Safari-only native scheduling/click bridge, injected at composition. */
export interface DesktopAlertNativePort {
  schedule(
    request: NativeDesktopScheduleRequest,
  ): Promise<NativeDesktopScheduleResult>;
  installClickListener(listener: (eventFingerprint: string) => void): boolean;
  scheduleDiagnostic(options?: {
    signal?: AbortSignal;
  }): Promise<NativeDesktopScheduleResult>;
}

export interface DesktopAlertOptions {
  readonly platform: ExtensionPlatform;
  readonly api: ExtensionApi;
  readonly currentState: DesktopAlertCurrentStateValidator;
  /** A local UI route callback, never a caller-provided website URL. */
  readonly showLocalResult?: (event: LocalAvailabilityEvent) => Promise<void>;
  readonly sound?: DesktopAlertSoundPort;
  readonly native?: DesktopAlertNativePort;
  readonly now?: () => number;
  /** Test seam only; production keeps the fixed five-second bound. */
  readonly diagnosticTimeoutMs?: number;
}

interface AlertReference {
  readonly notificationId: string;
  readonly eventFingerprint: string;
  readonly event: LocalAvailabilityEvent;
  readonly expiresAt: string;
  readonly readAt: string | null;
}

interface AlertState {
  readonly version: typeof STATE_VERSION;
  readonly references: readonly AlertReference[];
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function exactIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validNotificationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    new RegExp(`^${NOTIFICATION_ID_PREFIX}[a-f0-9]{64}$`).test(value)
  );
}

function canonicalEvent(input: unknown): LocalAvailabilityEvent | null {
  const parsed = LocalAvailabilityEventSchema.safeParse(input);
  if (!parsed.success) return null;
  const event = parsed.data;
  if (!isSafeApplePurchaseUrl(event.purchaseUrl)) {
    return null;
  }
  return event;
}

function isFreshEvent(event: LocalAvailabilityEvent, nowMs: number): boolean {
  const observedAt = Date.parse(event.observedAt);
  return (
    Number.isFinite(observedAt) &&
    observedAt <= nowMs + MAX_CLOCK_SKEW_MS &&
    observedAt >= nowMs - REFERENCE_TTL_MS
  );
}

function expiryFor(event: LocalAvailabilityEvent): string | null {
  const observedAt = Date.parse(event.observedAt);
  if (!Number.isFinite(observedAt)) return null;
  return new Date(observedAt + REFERENCE_TTL_MS).toISOString();
}

async function parseState(input: unknown, nowMs: number): Promise<AlertState> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { version: STATE_VERSION, references: [] };
  }
  const candidate = input as { version?: unknown; references?: unknown };
  if (
    candidate.version !== STATE_VERSION ||
    !Array.isArray(candidate.references)
  ) {
    return { version: STATE_VERSION, references: [] };
  }
  const references: AlertReference[] = [];
  // Never let corrupted extension-local storage turn startup reconciliation
  // into unbounded hashing work.
  for (const raw of candidate.references.slice(0, MAX_REFERENCES)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const reference = raw as Record<string, unknown>;
    const event = canonicalEvent(reference.event);
    const expectedExpiry = event ? expiryFor(event) : null;
    let expectedFingerprint: string | null = null;
    if (event) {
      try {
        expectedFingerprint = await fingerprint(event);
      } catch {
        expectedFingerprint = null;
      }
    }
    if (
      !event ||
      !isFreshEvent(event, nowMs) ||
      !expectedExpiry ||
      !validNotificationId(reference.notificationId) ||
      typeof reference.eventFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(reference.eventFingerprint) ||
      expectedFingerprint === null ||
      reference.eventFingerprint !== expectedFingerprint ||
      reference.notificationId !==
        `${NOTIFICATION_ID_PREFIX}${expectedFingerprint}` ||
      !exactIso(reference.expiresAt) ||
      reference.expiresAt !== expectedExpiry ||
      (reference.readAt !== null && !exactIso(reference.readAt)) ||
      Date.parse(reference.expiresAt) <= nowMs
    ) {
      continue;
    }
    references.push({
      notificationId: reference.notificationId,
      eventFingerprint: reference.eventFingerprint,
      event,
      expiresAt: reference.expiresAt,
      readAt: reference.readAt as string | null,
    });
  }
  return {
    version: STATE_VERSION,
    // Keep newest entries after parsing untrusted extension-local data.
    references: references
      .sort(
        (left, right) =>
          Date.parse(right.expiresAt) - Date.parse(left.expiresAt),
      )
      .slice(0, MAX_REFERENCES),
  };
}

function publicEventTuple(event: LocalAvailabilityEvent): string {
  // JSON makes tuple boundaries unambiguous; fields are all public catalog /
  // Apple identifiers and never location input, credentials, or response body.
  return JSON.stringify([
    event.watchId,
    event.market,
    event.sku,
    event.title,
    event.storeNumber,
    event.storeName,
    event.observedAt,
    event.purchaseUrl,
  ]);
}

async function fingerprint(event: LocalAvailabilityEvent): Promise<string> {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) {
    throw new Error("Secure event fingerprinting is unavailable");
  }
  const bytes = new TextEncoder().encode(publicEventTuple(event));
  const digest = await cryptoApi.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function notificationText(event: LocalAvailabilityEvent): {
  title: string;
  message: string;
} {
  const clean = (value: string, maximum: number) =>
    value
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .slice(0, maximum)
      .trim();
  return {
    title: "Apple pickup available",
    message: `${clean(event.title, 160)} at ${clean(event.storeName, 120)}. Open Apple to continue manually.`,
  };
}

/**
 * A small delivery adapter.  Its `notifyAvailable` result is intentionally
 * richer than the engine dispatcher: integration should resolve only
 * `scheduled`/`deduplicated`; denied and unsupported results must remain
 * visible to the UI rather than being misreported as an OS delivery.
 */
export class DesktopAlertService {
  private readonly inFlight = new Map<
    string,
    Promise<DesktopAlertDeliveryResult>
  >();
  private clickListenerInstalled = false;
  private diagnosticInFlight: Promise<DesktopAlertDiagnosticResult> | null =
    null;
  private diagnosticCooldownUntil = 0;
  /** Serialize small ledger mutations across UI and background wakeups. */
  private stateTail: Promise<void> = Promise.resolve();

  public constructor(private readonly options: DesktopAlertOptions) {}

  public async permissionState(): Promise<
    "granted" | "denied" | "unsupported"
  > {
    return this.options.platform.notifications.permissionState();
  }

  public async notifyAvailable(
    input: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<DesktopAlertDeliveryResult> {
    if (isAborted(options?.signal))
      return { kind: "aborted", sound: "disabled" };
    const event = canonicalEvent(input);
    if (!event) return { kind: "invalid", sound: "disabled" };

    let eventFingerprint: string;
    try {
      eventFingerprint = await fingerprint(event);
    } catch {
      return { kind: "unsupported", sound: "disabled" };
    }
    if (isAborted(options?.signal))
      return { kind: "aborted", sound: "disabled" };

    const existing = this.inFlight.get(eventFingerprint);
    if (existing) return existing;
    const task = this.notifyPrepared(event, eventFingerprint, options?.signal);
    this.inFlight.set(eventFingerprint, task);
    try {
      return await task;
    } finally {
      if (this.inFlight.get(eventFingerprint) === task) {
        this.inFlight.delete(eventFingerprint);
      }
    }
  }

  /**
   * A trusted app-only diagnostic. It deliberately has no watch, catalog,
   * Apple URL, click metadata, ledger entry, or provider side effect.
   * Browser scheduling is not proof of an OS receipt.
   */
  public async sendUserInitiatedTest(): Promise<DesktopAlertDiagnosticResult> {
    if (this.diagnosticInFlight) return { kind: "in-flight" };
    if (this.now() < this.diagnosticCooldownUntil) return { kind: "cooldown" };
    const task = this.scheduleDiagnostic();
    this.diagnosticInFlight = task;
    try {
      return await task;
    } finally {
      if (this.diagnosticInFlight === task) this.diagnosticInFlight = null;
    }
  }

  private async scheduleDiagnostic(): Promise<DesktopAlertDiagnosticResult> {
    const browserNotifications =
      this.options.platform.notifications.capability() === "browser-api";
    const native = this.options.native;
    if (!browserNotifications && !native) return { kind: "unsupported" };
    const timeoutMs = this.options.diagnosticTimeoutMs ?? DIAGNOSTIC_TIMEOUT_MS;
    const controller = new AbortController();
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operation = async (): Promise<DesktopAlertDiagnosticKind> => {
      if (browserNotifications) {
        const permission = await this.permissionState();
        if (expired) return "unavailable";
        if (permission === "unsupported") return "unsupported";
        if (permission !== "granted") return "permission-denied";
      }
      if (expired) return "unavailable";
      // A browser API has no cancellation primitive once invoked. Cool down
      // before that boundary so a timed-out ambiguous request is not retried.
      this.diagnosticCooldownUntil = this.now() + DIAGNOSTIC_COOLDOWN_MS;
      return browserNotifications
        ? this.options.platform.notifications
            .notify(
              DIAGNOSTIC_NOTIFICATION_ID,
              DIAGNOSTIC_TITLE,
              DIAGNOSTIC_MESSAGE,
            )
            .then(() => "scheduled" as const)
        : native!
            .scheduleDiagnostic({ signal: controller.signal })
            .then((result) =>
              result === "scheduled"
                ? "scheduled"
                : result === "denied"
                  ? "permission-denied"
                  : result === "unavailable"
                    ? "unavailable"
                    : "unavailable",
            );
    };
    try {
      const outcome = await Promise.race([
        operation().catch(() => "unavailable" as const),
        new Promise<DesktopAlertDiagnosticKind>((resolve) => {
          timer = setTimeout(() => {
            expired = true;
            controller.abort();
            resolve("unavailable");
          }, timeoutMs);
        }),
      ]);
      return { kind: outcome };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Explicit UI action only; notification clicks intentionally do not read it. */
  public async markRead(notificationId: string): Promise<boolean> {
    if (!validNotificationId(notificationId)) return false;
    const now = this.now();
    return this.mutateState(async (state) => {
      const reference = state.references.find(
        (candidate) => candidate.notificationId === notificationId,
      );
      if (!reference) return false;
      const next: AlertState = {
        version: STATE_VERSION,
        references: state.references.map((candidate) =>
          candidate.notificationId === notificationId
            ? { ...candidate, readAt: new Date(now).toISOString() }
            : candidate,
        ),
      };
      await this.writeState(next);
      await this.updateBadge(next);
      return true;
    });
  }

  public async unreadCount(): Promise<number> {
    return this.reconcile();
  }

  /**
   * Call on worker startup and after a UI resumes. It rewrites only the
   * validated bounded ledger and clears a stale toolbar badge after TTL expiry.
   */
  public reconcile(): Promise<number> {
    return this.mutateState(async (state) => {
      await this.writeState(state);
      await this.updateBadge(state);
      return state.references.filter((reference) => reference.readAt === null)
        .length;
    });
  }

  /** Explicit worker-start hook; no hidden persistent runtime is created. */
  public start(): Promise<number> {
    return this.reconcile();
  }

  /** Install once per worker lifetime; the browser supplies notification ids. */
  public installClickHandler(): boolean {
    if (
      this.clickListenerInstalled ||
      !this.options.api.notifications?.onClicked
    ) {
      return false;
    }
    this.options.api.notifications.onClicked.addListener((notificationId) => {
      void this.handleClick(notificationId).catch(() => undefined);
    });
    this.clickListenerInstalled = true;
    return true;
  }

  /** Registers the Safari port before asynchronous monitor bootstrap. */
  public installNativeClickHandler(): boolean {
    return (
      this.options.native?.installClickListener((eventFingerprint) => {
        void this.handleNativeClick(eventFingerprint).catch(() => undefined);
      }) ?? false
    );
  }

  public handleNativeClick(
    eventFingerprint: string,
    options?: { signal?: AbortSignal },
  ): Promise<DesktopAlertClickResult> {
    if (!/^[a-f0-9]{64}$/.test(eventFingerprint)) {
      return Promise.resolve({
        kind: "denied",
        reason: "unknown-notification",
      });
    }
    return this.handleClick(
      `${NOTIFICATION_ID_PREFIX}${eventFingerprint}`,
      options,
    );
  }

  public async handleClick(
    notificationId: string,
    options?: { signal?: AbortSignal },
  ): Promise<DesktopAlertClickResult> {
    if (isAborted(options?.signal)) return { kind: "ignored" };
    if (!validNotificationId(notificationId)) {
      return { kind: "denied", reason: "unknown-notification" };
    }
    const state = await this.readState();
    const reference = state.references.find(
      (candidate) => candidate.notificationId === notificationId,
    );
    if (!reference) return { kind: "denied", reason: "expired-or-unknown" };
    if (isAborted(options?.signal)) return { kind: "ignored" };

    const decision = await this.options.currentState.resolveClick(
      reference.event,
    );
    if (isAborted(options?.signal)) return { kind: "ignored" };
    if (decision === "deny")
      return { kind: "denied", reason: "stale-watch-or-stock" };
    if (decision === "show-local-result") {
      if (!this.options.showLocalResult) {
        return { kind: "denied", reason: "local-result-unavailable" };
      }
      await this.options.showLocalResult(reference.event);
      return { kind: "local-result" };
    }
    // The canonical check is repeated at the side-effect boundary even though
    // parsing/ledger validation already performed it.
    if (!isSafeApplePurchaseUrl(reference.event.purchaseUrl)) {
      return { kind: "denied", reason: "invalid-apple-url" };
    }
    await this.options.platform.tabs.openApplePurchase(
      reference.event.purchaseUrl,
    );
    return { kind: "opened-apple" };
  }

  private async notifyPrepared(
    event: LocalAvailabilityEvent,
    eventFingerprint: string,
    signal?: AbortSignal,
  ): Promise<DesktopAlertDeliveryResult> {
    if (isAborted(signal)) return { kind: "aborted", sound: "disabled" };
    const browserNotifications =
      this.options.platform.notifications.capability() === "browser-api";
    const native = this.options.native;
    if (!browserNotifications && !native) {
      return { kind: "unsupported", sound: "unsupported" };
    }
    if (browserNotifications) {
      const permission = await this.permissionState();
      if (isAborted(signal)) return { kind: "aborted", sound: "disabled" };
      if (permission === "unsupported")
        return { kind: "unsupported", sound: "unsupported" };
      if (permission !== "granted")
        return { kind: "permission-denied", sound: "disabled" };
    }

    if (!isFreshEvent(event, this.now())) {
      return { kind: "stale", sound: "disabled" };
    }
    if (!(await this.options.currentState.canDeliver(event))) {
      return { kind: "stale", sound: "disabled" };
    }
    if (isAborted(signal)) return { kind: "aborted", sound: "disabled" };
    if (await this.hasEventFingerprint(eventFingerprint)) {
      return { kind: "deduplicated", sound: "disabled" };
    }
    if (isAborted(signal)) return { kind: "aborted", sound: "disabled" };

    const notificationId = `${NOTIFICATION_ID_PREFIX}${eventFingerprint}`;
    const text = notificationText(event);
    // Once browser notification scheduling begins it cannot reliably be
    // cancelled by AbortSignal. Persisting the reference afterward prevents a
    // late cancellation from causing an avoidable duplicate on the next wake.
    const expiresAt = expiryFor(event);
    if (!expiresAt) return { kind: "invalid", sound: "disabled" };
    if (browserNotifications) {
      await this.options.platform.notifications.notify(
        notificationId,
        text.title,
        text.message,
      );
    } else {
      const nativeResult = await native!.schedule({
        event,
        eventFingerprint,
        expiresAt,
        signal,
      });
      if (nativeResult === "aborted")
        return { kind: "aborted", sound: "disabled" };
      if (nativeResult === "duplicate")
        return { kind: "deduplicated", sound: "disabled" };
      if (nativeResult === "denied")
        return { kind: "permission-denied", sound: "disabled" };
      if (nativeResult === "unavailable")
        return { kind: "unsupported", sound: "unsupported" };
      if (nativeResult !== "scheduled")
        return { kind: "invalid", sound: "disabled" };
    }
    await this.mutateState(async (state) => {
      // Another wake can only reach this branch for a different in-flight
      // event. Preserve both references instead of last-writer-wins storage.
      if (
        state.references.some(
          (entry) => entry.eventFingerprint === eventFingerprint,
        )
      ) {
        return;
      }
      const next: AlertState = {
        version: STATE_VERSION,
        references: [
          {
            notificationId,
            eventFingerprint,
            event,
            expiresAt,
            readAt: null,
          },
          ...state.references,
        ].slice(0, MAX_REFERENCES),
      };
      await this.writeState(next);
      await this.updateBadge(next);
    });
    const sound = await this.playOptionalSound(signal);
    return { kind: "scheduled", sound };
  }

  private async playOptionalSound(
    signal?: AbortSignal,
  ): Promise<DesktopAlertSoundStatus> {
    const sound = this.options.sound;
    if (!sound?.enabled) return "disabled";
    if (isAborted(signal)) return "blocked";
    try {
      await sound.play({ signal });
      return isAborted(signal) ? "blocked" : "played";
    } catch {
      // Audio policies and Focus are not observable as a reliable receipt.
      return "blocked";
    }
  }

  private async readState(): Promise<AlertState> {
    return await parseState(
      await this.options.platform.storage.read<unknown>(STORAGE_KEY),
      this.now(),
    );
  }

  private writeState(state: AlertState): Promise<void> {
    return this.options.platform.storage.write(STORAGE_KEY, state);
  }

  private async hasEventFingerprint(
    eventFingerprint: string,
  ): Promise<boolean> {
    const state = await this.readState();
    return state.references.some(
      (reference) => reference.eventFingerprint === eventFingerprint,
    );
  }

  private mutateState<T>(
    operation: (state: AlertState) => Promise<T>,
  ): Promise<T> {
    const task = this.stateTail.then(
      async () => operation(await this.readState()),
      async () => operation(await this.readState()),
    );
    this.stateTail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async updateBadge(state: AlertState): Promise<void> {
    const action = this.options.api.action;
    if (!action) return;
    const unread = Math.min(
      MAX_REFERENCES,
      state.references.filter((reference) => reference.readAt === null).length,
    );
    try {
      await callExtensionVoid(
        this.options.api.runtime,
        (callback, usePromiseApi) =>
          usePromiseApi
            ? action.setBadgeText({ text: unread === 0 ? "" : String(unread) })
            : action.setBadgeText(
                { text: unread === 0 ? "" : String(unread) },
                callback,
              ),
      );
    } catch {
      // Toolbar badges are best-effort and must not make desktop delivery fail.
    }
  }

  private now(): number {
    const value = this.options.now?.() ?? Date.now();
    return Number.isFinite(value) ? value : Date.now();
  }
}
