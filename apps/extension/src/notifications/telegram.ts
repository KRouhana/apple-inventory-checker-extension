/**
 * Personal Telegram delivery for the local monitor.
 *
 * This is deliberately an extension-local adapter. It never uses the shared
 * project bot, never accepts a destination from an incoming message, and
 * never persists a delivery queue. The monitoring engine remains responsible
 * for event durability and channel-level deduplication.
 */
import type {
  LocalDeliveryDispatchResult,
  LocalAvailabilityEvent,
  PersonalTelegramPort,
} from "../../../../packages/core/src/local-monitor-contracts";

const STORAGE_KEY = "inventorySignal.personalTelegram.v1";
const PAIRING_TTL_MS = 10 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_SEND_ATTEMPTS = 2;
const MAX_DELIVERY_DEFERRAL_MS = 10 * 60 * 1_000;
const TELEGRAM_ORIGIN = "https://api.telegram.org";
const PAIRING_PREFIX = "INVENTORY SIGNAL ";

export type TelegramErrorCode =
  | "cancelled"
  | "delivery_failed"
  | "invalid_configuration"
  | "invalid_token_format"
  | "token_rejected"
  | "bot_validation_failed"
  | "webhook_check_failed"
  | "invalid_event"
  | "not_connected"
  | "pairing_ambiguous"
  | "pairing_expired"
  | "pairing_pending"
  | "permission_required"
  | "storage_unavailable"
  | "unsupported"
  | "webhook_conflict";

/** Public, token-free error suitable for UI copy. Never expose provider text. */
export class PersonalTelegramError extends Error {
  constructor(readonly code: TelegramErrorCode) {
    super(code.replaceAll("_", " "));
    this.name = "PersonalTelegramError";
  }
}

export interface TelegramStoragePort {
  read(key: string): Promise<unknown | null>;
  write(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface TelegramResponse {
  readonly httpStatus: number;
  /** Must be false; redirect following could disclose a token-bearing URL. */
  readonly redirected: boolean;
  /** The final URL, checked but never surfaced in an error. */
  readonly url: string;
  /** Parsed `Retry-After` header when the platform fetch adapter exposes it. */
  readonly retryAfterSeconds?: unknown;
  json(): Promise<unknown>;
}

export interface TelegramFetchPort {
  fetch(
    url: string,
    init: {
      method: "GET" | "POST";
      headers?: Record<string, string>;
      body?: string;
      redirect: "error";
      signal: AbortSignal;
    },
  ): Promise<TelegramResponse>;
}

export interface TelegramClock {
  nowMs(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  sleep(delayMs: number): Promise<void>;
}

export interface TelegramRandomPort {
  /** Cryptographically random bytes. The default uses WebCrypto. */
  bytes(length: number): Uint8Array;
}

/** Caller cancellation is owned by the monitor engine's event deadline. */
export interface PersonalTelegramDeliveryOptions {
  readonly signal?: AbortSignal;
}

export interface PersonalTelegramDeps {
  storage: TelegramStoragePort;
  fetchPort: TelegramFetchPort;
  clock?: TelegramClock;
  random?: TelegramRandomPort;
  /** The UI checks this after a direct user gesture before it calls setup. */
  isSupported?: () => boolean;
  /**
   * The platform rechecks optional-host and Firefox data-collection consent
   * immediately before every provider request. A missing or failed check is
   * denied; this adapter never assumes a prior setup prompt is still valid.
   */
  checkPermission?: () => Promise<boolean>;
}

export type PersonalTelegramStatus =
  | { kind: "disconnected" }
  | {
      kind: "pairing";
      pairingCommand: string;
      expiresAt: string;
      /** Present only when Telegram returned a validated bot username. */
      pairingUrl?: string;
    }
  | { kind: "connected"; botUsername: string | null };

interface Credentials {
  readonly botToken: string;
  readonly chatId: string;
}

interface PendingPairing {
  readonly botToken: string;
  readonly nonce: string;
  readonly expiresAtMs: number;
  readonly botUsername: string | null;
}

interface StoredTelegramState {
  readonly version: 1;
  readonly active?: Credentials;
  readonly botUsername?: string | null;
  readonly pending?: PendingPairing;
}

function sameStoredState(
  left: StoredTelegramState | null,
  right: StoredTelegramState | null,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.botUsername !== right.botUsername) return false;
  if (
    left.active?.botToken !== right.active?.botToken ||
    left.active?.chatId !== right.active?.chatId
  ) {
    return false;
  }
  return (
    left.pending?.botToken === right.pending?.botToken &&
    left.pending?.nonce === right.pending?.nonce &&
    left.pending?.expiresAtMs === right.pending?.expiresAtMs &&
    left.pending?.botUsername === right.pending?.botUsername
  );
}

interface TelegramApiSuccess<T> {
  readonly ok: true;
  readonly result: T;
}

interface TelegramApiFailure {
  readonly ok: false;
  readonly error_code?: unknown;
  readonly parameters?: { readonly retry_after?: unknown };
  readonly retryAfterSeconds?: unknown;
}

type TelegramApiResult<T> = TelegramApiSuccess<T> | TelegramApiFailure;

interface TelegramBotProfile {
  readonly is_bot: true;
  readonly username?: string;
}

interface TelegramWebhookInfo {
  readonly url?: unknown;
}

interface TelegramUpdate {
  readonly message?: {
    readonly text?: unknown;
    readonly chat?: { readonly id?: unknown; readonly type?: unknown };
  };
}

function defaultClock(): TelegramClock {
  return {
    nowMs: () => Date.now(),
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
    sleep: (delayMs) =>
      new Promise((resolve) => {
        globalThis.setTimeout(resolve, delayMs);
      }),
  };
}

function defaultRandom(): TelegramRandomPort {
  return {
    bytes(length) {
      if (!Number.isSafeInteger(length) || length < 16 || length > 64) {
        throw new PersonalTelegramError("invalid_configuration");
      }
      const bytes = new Uint8Array(length);
      if (!globalThis.crypto?.getRandomValues) {
        throw new PersonalTelegramError("unsupported");
      }
      return globalThis.crypto.getRandomValues(bytes);
    },
  };
}

function tokenIsValid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{5,20}:[A-Za-z0-9_-]{20,256}$/.test(value) &&
    value.length <= 277
  );
}

function chatIdIsValid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[1-9]\d{0,15}$/.test(value) &&
    Number.isSafeInteger(Number(value))
  );
}

function nonceFromBytes(bytes: Uint8Array): string {
  if (bytes.byteLength !== 32) {
    throw new PersonalTelegramError("invalid_configuration");
  }
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

function safeBotUsername(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_]{5,32}$/.test(value)
    ? value
    : null;
}

function parseStoredState(value: unknown): StoredTelegramState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1) return null;
  const activeValue = candidate.active;
  const pendingValue = candidate.pending;
  let active: Credentials | undefined;
  let pending: PendingPairing | undefined;
  if (activeValue !== undefined) {
    if (!activeValue || typeof activeValue !== "object") return null;
    const parsed = activeValue as Record<string, unknown>;
    if (!tokenIsValid(parsed.botToken) || !chatIdIsValid(parsed.chatId))
      return null;
    active = { botToken: parsed.botToken, chatId: parsed.chatId };
  }
  if (pendingValue !== undefined) {
    if (!pendingValue || typeof pendingValue !== "object") return null;
    const parsed = pendingValue as Record<string, unknown>;
    const expiresAtMs = parsed.expiresAtMs;
    if (
      !tokenIsValid(parsed.botToken) ||
      typeof parsed.nonce !== "string" ||
      !/^[a-f0-9]{64}$/.test(parsed.nonce) ||
      typeof expiresAtMs !== "number" ||
      !Number.isSafeInteger(expiresAtMs) ||
      expiresAtMs <= 0
    ) {
      return null;
    }
    pending = {
      botToken: parsed.botToken,
      nonce: parsed.nonce,
      expiresAtMs,
      botUsername: safeBotUsername(parsed.botUsername),
    };
  }
  if (!active && !pending) return null;
  return {
    version: 1,
    ...(active ? { active } : {}),
    ...(pending ? { pending } : {}),
    botUsername: safeBotUsername(candidate.botUsername),
  };
}

function canonicalApplePurchaseUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      url.origin !== "https://www.apple.com" ||
      url.protocol !== "https:" ||
      url.hostname !== "www.apple.com" ||
      url.username !== "" ||
      url.password !== "" ||
      value !== url.toString()
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function isCanonicalAvailabilityEvent(
  event: LocalAvailabilityEvent,
): event is LocalAvailabilityEvent {
  if (
    !event ||
    typeof event !== "object" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(event.watchId) ||
    !["us", "ca", "uk"].includes(event.market) ||
    !/^[A-Z0-9]+\/[A-Z]$/.test(event.sku) ||
    !/^[A-Za-z0-9-]{1,16}$/.test(event.storeNumber) ||
    typeof event.title !== "string" ||
    event.title.trim().length === 0 ||
    event.title.length > 200 ||
    typeof event.storeName !== "string" ||
    event.storeName.trim().length === 0 ||
    event.storeName.length > 160 ||
    typeof event.observedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(event.observedAt) ||
    Number.isNaN(Date.parse(event.observedAt))
  ) {
    return false;
  }
  return canonicalApplePurchaseUrl(event.purchaseUrl) !== null;
}

export function formatPersonalTelegramAvailability(
  event: LocalAvailabilityEvent,
): string {
  if (!isCanonicalAvailabilityEvent(event)) {
    throw new PersonalTelegramError("invalid_event");
  }
  const purchaseUrl = canonicalApplePurchaseUrl(event.purchaseUrl);
  if (!purchaseUrl) throw new PersonalTelegramError("invalid_event");
  return [
    "iPhone available",
    event.title.trim(),
    `${event.storeName.trim()} (store ${event.storeNumber})`,
    purchaseUrl,
  ].join("\n");
}

function responseLooksSafe(response: TelegramResponse): boolean {
  if (response.redirected) return false;
  try {
    const url = new URL(response.url);
    return url.protocol === "https:" && url.origin === TELEGRAM_ORIGIN;
  } catch {
    return false;
  }
}

function parseApiResult<T>(
  value: unknown,
  retryAfterSeconds?: unknown,
): TelegramApiResult<T> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.ok === true && "result" in record) {
    return { ok: true, result: record.result as T };
  }
  if (record.ok === false) {
    return {
      ok: false,
      error_code: record.error_code,
      parameters:
        record.parameters && typeof record.parameters === "object"
          ? (record.parameters as { retry_after?: unknown })
          : undefined,
      retryAfterSeconds,
    };
  }
  return null;
}

function retryDelayMs(result: TelegramApiFailure | null): number | null {
  if (!result) return null;
  return result.error_code === 500 ||
    result.error_code === 502 ||
    result.error_code === 503
    ? 250
    : null;
}

function retryAfterSeconds(result: TelegramApiFailure): number | null {
  const fromBody = result.parameters?.retry_after;
  const fromHeader = result.retryAfterSeconds;
  const parseSeconds = (value: unknown): number | null => {
    if (typeof value === "number") {
      return Number.isSafeInteger(value) && value > 0 ? value : null;
    }
    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      const parsed = Number(value.trim());
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    }
    return null;
  };
  const bodySeconds = parseSeconds(fromBody);
  const headerSeconds =
    fromHeader === undefined ? null : parseSeconds(fromHeader);
  if (fromBody === undefined && fromHeader === undefined) return null;
  if (
    (fromBody !== undefined && bodySeconds === null) ||
    (fromHeader !== undefined && headerSeconds === null) ||
    (bodySeconds !== null &&
      headerSeconds !== null &&
      bodySeconds !== headerSeconds)
  ) {
    return null;
  }
  return bodySeconds ?? headerSeconds;
}

function pairingCommand(nonce: string): string {
  return `${PAIRING_PREFIX}${nonce}`;
}

function pairingUrl(botUsername: string | null, nonce: string): string | null {
  return botUsername === null
    ? null
    : `https://t.me/${botUsername}?start=${nonce}`;
}

function isPairingConfirmation(text: unknown, nonce: string): boolean {
  return text === pairingCommand(nonce) || text === `/start ${nonce}`;
}

/**
 * Controls the optional personal channel. A caller must request the optional
 * host permission from a visible user gesture before `startPairing`; this
 * controller deliberately has no browser-permission API.
 */
export interface PersonalTelegramController extends PersonalTelegramPort {
  status(): Promise<PersonalTelegramStatus>;
  startPairing(botToken: string): Promise<PersonalTelegramStatus>;
  confirmPairing(): Promise<PersonalTelegramStatus>;
  sendTest(options?: PersonalTelegramDeliveryOptions): Promise<void>;
  /** Reads active credentials locally. Use this from the engine adapter only. */
  sendStoredAvailable(
    event: LocalAvailabilityEvent,
    options?: PersonalTelegramDeliveryOptions,
  ): Promise<LocalDeliveryDispatchResult>;
  sendAvailable(
    credentials: { botToken: string; chatId: string },
    event: LocalAvailabilityEvent,
    options?: PersonalTelegramDeliveryOptions,
  ): Promise<void | LocalDeliveryDispatchResult>;
  /** Removes active/pending credentials and invalidates in-flight delivery. */
  disconnect(): Promise<void>;
}

export function createPersonalTelegramController(
  deps: PersonalTelegramDeps,
): PersonalTelegramController {
  const clock = deps.clock ?? defaultClock();
  const random = deps.random ?? defaultRandom();
  let generation = 0;
  const activeRequests = new Map<number, Set<AbortController>>();
  // Storage operations are serialized so that a disconnect always removes a
  // stale setup write that was already in progress. A later, deliberate setup
  // may enqueue after it, which is the only allowed way credentials return.
  let storageTail: Promise<void> = Promise.resolve();

  const trackRequest = (
    capturedGeneration: number,
    controller: AbortController,
  ) => {
    const controllers = activeRequests.get(capturedGeneration) ?? new Set();
    controllers.add(controller);
    activeRequests.set(capturedGeneration, controllers);
  };
  const untrackRequest = (
    capturedGeneration: number,
    controller: AbortController,
  ) => {
    const controllers = activeRequests.get(capturedGeneration);
    if (!controllers) return;
    controllers.delete(controller);
    if (controllers.size === 0) activeRequests.delete(capturedGeneration);
  };
  const advanceGeneration = () => {
    generation += 1;
    for (const controllers of activeRequests.values()) {
      for (const controller of controllers) controller.abort();
    }
    activeRequests.clear();
    return generation;
  };

  const ensureSupported = (): void => {
    if (deps.isSupported && !deps.isSupported()) {
      throw new PersonalTelegramError("unsupported");
    }
  };
  const isCurrent = (captured: number): boolean => generation === captured;
  const assertCurrent = (captured: number): void => {
    if (!isCurrent(captured)) throw new PersonalTelegramError("cancelled");
  };
  const readState = async (): Promise<StoredTelegramState | null> => {
    try {
      return parseStoredState(await deps.storage.read(STORAGE_KEY));
    } catch {
      throw new PersonalTelegramError("storage_unavailable");
    }
  };
  const enqueueStorageMutation = <T>(
    capturedGeneration: number | null,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const scheduled = storageTail.then(async () => {
      if (capturedGeneration !== null) assertCurrent(capturedGeneration);
      return operation();
    });
    storageTail = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  };
  const writeState = async (
    state: StoredTelegramState,
    capturedGeneration: number,
    expectedState: StoredTelegramState | null,
  ): Promise<void> => {
    try {
      await enqueueStorageMutation(capturedGeneration, async () => {
        const actual = parseStoredState(await deps.storage.read(STORAGE_KEY));
        if (!sameStoredState(actual, expectedState)) {
          throw new PersonalTelegramError("cancelled");
        }
        await deps.storage.write(STORAGE_KEY, state);
      });
    } catch (error) {
      if (error instanceof PersonalTelegramError) throw error;
      throw new PersonalTelegramError("storage_unavailable");
    }
  };
  const removeState = async (
    capturedGeneration: number | null,
    expectedState?: StoredTelegramState | null,
  ): Promise<void> => {
    try {
      await enqueueStorageMutation(capturedGeneration, async () => {
        if (capturedGeneration !== null) {
          const actual = parseStoredState(await deps.storage.read(STORAGE_KEY));
          if (!sameStoredState(actual, expectedState ?? null)) {
            throw new PersonalTelegramError("cancelled");
          }
        }
        await deps.storage.remove(STORAGE_KEY);
      });
    } catch (error) {
      if (error instanceof PersonalTelegramError) throw error;
      throw new PersonalTelegramError("storage_unavailable");
    }
  };
  const requireCurrentPermission = async (
    capturedGeneration: number,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!deps.checkPermission) return;
    if (signal.aborted) throw new PersonalTelegramError("cancelled");
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: PersonalTelegramError): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = (): void =>
        finish(new PersonalTelegramError("cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
      void Promise.resolve()
        .then(() => deps.checkPermission!())
        .then(
          (granted) => {
            try {
              assertCurrent(capturedGeneration);
              finish(
                granted
                  ? undefined
                  : new PersonalTelegramError("permission_required"),
              );
            } catch (error) {
              finish(
                error instanceof PersonalTelegramError
                  ? error
                  : new PersonalTelegramError("permission_required"),
              );
            }
          },
          () => finish(new PersonalTelegramError("permission_required")),
        );
    });
  };
  const request = async <T>(
    token: string,
    method: "getMe" | "getWebhookInfo" | "getUpdates" | "sendMessage",
    capturedGeneration: number,
    body?: string,
    callerSignal?: AbortSignal,
  ): Promise<TelegramApiResult<T>> => {
    assertCurrent(capturedGeneration);
    if (callerSignal?.aborted) throw new PersonalTelegramError("cancelled");
    const controller = new AbortController();
    trackRequest(capturedGeneration, controller);
    return new Promise<TelegramApiResult<T>>((resolve, reject) => {
      let settled = false;
      let timer: unknown;
      let timerInstalled = false;
      const cleanup = (): void => {
        if (timerInstalled) clock.clearTimeout(timer);
        callerSignal?.removeEventListener("abort", onCallerAbort);
        controller.signal.removeEventListener("abort", onGenerationAbort);
        untrackRequest(capturedGeneration, controller);
      };
      const finish = (
        result: TelegramApiResult<T> | PersonalTelegramError,
      ): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (result instanceof PersonalTelegramError) reject(result);
        else resolve(result);
      };
      const onCallerAbort = (): void => {
        finish(new PersonalTelegramError("cancelled"));
        controller.abort();
      };
      const onGenerationAbort = (): void => {
        finish(new PersonalTelegramError("cancelled"));
      };
      callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
      controller.signal.addEventListener("abort", onGenerationAbort, {
        once: true,
      });
      timer = clock.setTimeout(() => {
        finish(new PersonalTelegramError("delivery_failed"));
        controller.abort();
      }, REQUEST_TIMEOUT_MS);
      timerInstalled = true;
      if (settled) return;
      let requestPromise: Promise<TelegramApiResult<T>>;
      try {
        requestPromise = requireCurrentPermission(
          capturedGeneration,
          controller.signal,
        )
          .then(() =>
            deps.fetchPort.fetch(
              `${TELEGRAM_ORIGIN}/bot${token}/${method}${
                method === "getUpdates" ? "?timeout=0&limit=100" : ""
              }`,
              {
                method: body === undefined ? "GET" : "POST",
                ...(body === undefined
                  ? {}
                  : {
                      headers: { "content-type": "application/json" },
                      body,
                    }),
                redirect: "error",
                signal: controller.signal,
              },
            ),
          )
          .then(async (response) => {
            assertCurrent(capturedGeneration);
            if (
              !responseLooksSafe(response) ||
              response.httpStatus < 200 ||
              response.httpStatus > 599
            ) {
              throw new PersonalTelegramError("delivery_failed");
            }
            const parsed = parseApiResult<T>(
              await response.json(),
              response.retryAfterSeconds,
            );
            assertCurrent(capturedGeneration);
            if (!parsed) throw new PersonalTelegramError("delivery_failed");
            // Telegram errors can arrive with a non-2xx status. Preserve only
            // a valid error result for bounded retry logic; never accept a
            // claimed success from a non-2xx response.
            if (response.httpStatus >= 300 && parsed.ok) {
              throw new PersonalTelegramError("delivery_failed");
            }
            return parsed;
          });
      } catch (error) {
        finish(
          error instanceof PersonalTelegramError
            ? error
            : new PersonalTelegramError("delivery_failed"),
        );
        return;
      }
      void requestPromise.then(
        (result) => {
          try {
            assertCurrent(capturedGeneration);
            finish(result);
          } catch (error) {
            finish(
              error instanceof PersonalTelegramError
                ? error
                : new PersonalTelegramError("delivery_failed"),
            );
          }
        },
        (error: unknown) => {
          // Browser/provider exceptions may contain a token-bearing request
          // URL. Map them to a public typed error and ignore late settlement.
          finish(
            error instanceof PersonalTelegramError
              ? error
              : new PersonalTelegramError("delivery_failed"),
          );
        },
      );
    });
  };
  const deliver = async (
    credentials: Credentials,
    text: string,
    event: LocalAvailabilityEvent | null,
    capturedGeneration: number,
    options?: PersonalTelegramDeliveryOptions,
  ): Promise<LocalDeliveryDispatchResult> => {
    if (options?.signal?.aborted) throw new PersonalTelegramError("cancelled");
    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
      const result = await request<unknown>(
        credentials.botToken,
        "sendMessage",
        capturedGeneration,
        JSON.stringify({
          chat_id: credentials.chatId,
          text,
          // Plain text deliberately has no entity parser. The canonical Apple
          // URL remains visible and Telegram's documented preview option
          // keeps the notification compact without changing its destination.
          link_preview_options: { is_disabled: true },
        }),
        options?.signal,
      );
      if (
        result.ok &&
        (!result.result ||
          typeof result.result !== "object" ||
          !Number.isSafeInteger(
            (result.result as { message_id?: unknown }).message_id,
          ))
      ) {
        throw new PersonalTelegramError("delivery_failed");
      }
      if (result.ok) return { kind: "delivered" };
      if (result.error_code === 429) {
        const seconds = retryAfterSeconds(result);
        const observedAtMs =
          event === null ? Number.NaN : Date.parse(event.observedAt);
        const nowMs = clock.nowMs();
        if (
          seconds === null ||
          !Number.isSafeInteger(observedAtMs) ||
          !Number.isSafeInteger(nowMs) ||
          seconds > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)
        ) {
          return { kind: "terminal" };
        }
        const retryAtMs = nowMs + seconds * 1_000;
        if (
          !Number.isSafeInteger(retryAtMs) ||
          retryAtMs <= nowMs ||
          retryAtMs > observedAtMs + MAX_DELIVERY_DEFERRAL_MS
        ) {
          return { kind: "terminal" };
        }
        return {
          kind: "retry_not_before",
          retryNotBefore: new Date(retryAtMs).toISOString(),
        };
      }
      const delay = retryDelayMs(result);
      if (delay === null || attempt === MAX_SEND_ATTEMPTS) {
        throw new PersonalTelegramError("delivery_failed");
      }
      await new Promise<void>((resolve, reject) => {
        if (options?.signal?.aborted) {
          reject(new PersonalTelegramError("cancelled"));
          return;
        }
        const onAbort = (): void => {
          options?.signal?.removeEventListener("abort", onAbort);
          reject(new PersonalTelegramError("cancelled"));
        };
        options?.signal?.addEventListener("abort", onAbort, { once: true });
        void clock.sleep(delay).then(
          () => {
            options?.signal?.removeEventListener("abort", onAbort);
            resolve();
          },
          () => {
            options?.signal?.removeEventListener("abort", onAbort);
            reject(new PersonalTelegramError("delivery_failed"));
          },
        );
      });
      assertCurrent(capturedGeneration);
    }
    throw new PersonalTelegramError("delivery_failed");
  };
  const toPublicStatus = (
    state: StoredTelegramState | null,
  ): PersonalTelegramStatus => {
    if (state?.pending) {
      const url = pairingUrl(state.pending.botUsername, state.pending.nonce);
      return {
        kind: "pairing",
        pairingCommand: pairingCommand(state.pending.nonce),
        expiresAt: new Date(state.pending.expiresAtMs).toISOString(),
        ...(url === null ? {} : { pairingUrl: url }),
      };
    }
    if (state?.active) {
      return { kind: "connected", botUsername: state.botUsername ?? null };
    }
    return { kind: "disconnected" };
  };

  return {
    async status() {
      return toPublicStatus(await readState());
    },
    async startPairing(botToken) {
      ensureSupported();
      // Beginning a replacement setup, including one rejected at validation,
      // invalidates every earlier setup/delivery generation.
      const captured = advanceGeneration();
      if (!tokenIsValid(botToken)) {
        throw new PersonalTelegramError("invalid_configuration");
      }
      const profile = await request<TelegramBotProfile>(
        botToken,
        "getMe",
        captured,
      );
      if (!profile.ok || !profile.result || profile.result.is_bot !== true) {
        throw new PersonalTelegramError(
          !profile.ok && profile.error_code === 401
            ? "token_rejected"
            : "bot_validation_failed",
        );
      }
      const webhook = await request<TelegramWebhookInfo>(
        botToken,
        "getWebhookInfo",
        captured,
      );
      if (
        !webhook.ok ||
        !webhook.result ||
        typeof webhook.result !== "object"
      ) {
        throw new PersonalTelegramError(
          !webhook.ok && webhook.error_code === 401
            ? "token_rejected"
            : "webhook_check_failed",
        );
      }
      if (typeof webhook.result.url !== "string") {
        throw new PersonalTelegramError("webhook_check_failed");
      }
      if (webhook.result.url.trim() !== "") {
        throw new PersonalTelegramError("webhook_conflict");
      }
      const existing = await readState();
      assertCurrent(captured);
      const pending: PendingPairing = {
        botToken,
        nonce: nonceFromBytes(random.bytes(32)),
        expiresAtMs: clock.nowMs() + PAIRING_TTL_MS,
        botUsername: safeBotUsername(profile.result.username),
      };
      const next: StoredTelegramState = {
        version: 1,
        ...(existing?.active ? { active: existing.active } : {}),
        botUsername: existing?.botUsername ?? pending.botUsername,
        pending,
      };
      await writeState(next, captured, existing);
      assertCurrent(captured);
      return toPublicStatus(next);
    },
    async confirmPairing() {
      ensureSupported();
      const captured = generation;
      const current = await readState();
      const pending = current?.pending;
      if (!pending) throw new PersonalTelegramError("pairing_pending");
      if (pending.expiresAtMs <= clock.nowMs()) {
        const next: StoredTelegramState | null = current.active
          ? {
              version: 1,
              active: current.active,
              botUsername: current.botUsername,
            }
          : null;
        try {
          if (next) await writeState(next, captured, current);
          else await removeState(captured, current);
        } catch (error) {
          if (error instanceof PersonalTelegramError) throw error;
          throw new PersonalTelegramError("storage_unavailable");
        }
        throw new PersonalTelegramError("pairing_expired");
      }
      const updates = await request<TelegramUpdate[]>(
        pending.botToken,
        "getUpdates",
        captured,
      );
      if (!updates.ok || !Array.isArray(updates.result)) {
        throw new PersonalTelegramError("pairing_pending");
      }
      const matchingChatIds = new Set<string>();
      for (const update of updates.result) {
        const message = update?.message;
        const chat = message?.chat;
        if (
          isPairingConfirmation(message?.text, pending.nonce) &&
          chat?.type === "private" &&
          ((typeof chat.id === "string" && chatIdIsValid(chat.id)) ||
            (typeof chat.id === "number" &&
              Number.isSafeInteger(chat.id) &&
              chatIdIsValid(String(chat.id))))
        ) {
          matchingChatIds.add(String(chat.id));
        }
      }
      if (matchingChatIds.size !== 1) {
        throw new PersonalTelegramError(
          matchingChatIds.size > 1 ? "pairing_ambiguous" : "pairing_pending",
        );
      }
      assertCurrent(captured);
      const next: StoredTelegramState = {
        version: 1,
        active: { botToken: pending.botToken, chatId: [...matchingChatIds][0] },
        botUsername: pending.botUsername,
      };
      await writeState(next, captured, current);
      assertCurrent(captured);
      return toPublicStatus(next);
    },
    async sendTest(options) {
      ensureSupported();
      const captured = generation;
      const state = await readState();
      if (!state?.active) throw new PersonalTelegramError("not_connected");
      await deliver(
        state.active,
        "Inventory Signal test\nPersonal Telegram alerts are connected.",
        null,
        captured,
        options,
      );
    },
    async sendStoredAvailable(event, options) {
      ensureSupported();
      const captured = generation;
      const state = await readState();
      if (!state?.active) throw new PersonalTelegramError("not_connected");
      return deliver(
        state.active,
        formatPersonalTelegramAvailability(event),
        event,
        captured,
        options,
      );
    },
    async sendAvailable(credentials, event, options) {
      ensureSupported();
      if (
        !tokenIsValid(credentials?.botToken) ||
        !chatIdIsValid(credentials?.chatId)
      ) {
        throw new PersonalTelegramError("invalid_configuration");
      }
      return deliver(
        { botToken: credentials.botToken, chatId: credentials.chatId },
        formatPersonalTelegramAvailability(event),
        event,
        generation,
        options,
      );
    },
    async disconnect() {
      advanceGeneration();
      await removeState(null);
    },
  };
}

export const PERSONAL_TELEGRAM_STORAGE_KEY = STORAGE_KEY;
export const PERSONAL_TELEGRAM_STORAGE_NOTICE =
  "Your personal bot token and paired chat stay only in this browser extension's local storage. Browser storage is not a secure vault; disconnect to remove them.";
