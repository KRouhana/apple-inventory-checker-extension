/**
 * Narrow Safari-only bridge for the containing macOS app. This is source
 * wiring, not installed-wrapper qualification: Safari ignores the application
 * ID and routes messages only to its containing native extension.
 */
import type { LocalAvailabilityEvent } from "../../../../packages/core/src/local-monitor-contracts.js";
import { isSafeApplePurchaseUrl } from "../protocol.js";
import type { ExtensionApi, ExtensionRuntime } from "../platform/api.js";
import type {
  DesktopAlertNativePort,
  NativeDesktopScheduleRequest,
  NativeDesktopScheduleResult,
} from "./desktop.js";

export const SAFARI_NATIVE_APPLICATION_ID = "com.inventorysignal.monitor";
export const SAFARI_NATIVE_NOTIFICATION_KIND =
  "inventory-signal.desktop-notification";
export const SAFARI_NATIVE_DIAGNOSTIC_KIND =
  "inventory-signal.desktop-test-notification";
export const SAFARI_NATIVE_CLICK_MARKER = "inventory-signal-native-click-v1";
const SAFARI_NATIVE_CLICK_KIND = "inventory-signal.native-click";
const NATIVE_RESPONSE_TIMEOUT_MS = 5_000;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const EXACT_ISO_UTC_MILLISECONDS =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type NativeCode =
  | "scheduled"
  | "invalid"
  | "duplicate"
  | "unavailable"
  | "denied";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function validText(value: string, maximumLength: number): boolean {
  return (
    value.length > 0 &&
    value.length <= maximumLength &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
  );
}

function exactIso(value: string): boolean {
  if (!EXACT_ISO_UTC_MILLISECONDS.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validScheduleRequest(
  request: NativeDesktopScheduleRequest,
): request is NativeDesktopScheduleRequest {
  const event = request.event;
  return (
    FINGERPRINT_PATTERN.test(request.eventFingerprint) &&
    validText(event.title, 120) &&
    validText(event.storeName, 160) &&
    exactIso(event.observedAt) &&
    exactIso(request.expiresAt) &&
    Date.parse(request.expiresAt) > Date.parse(event.observedAt) &&
    Date.parse(request.expiresAt) - Date.parse(event.observedAt) <=
      10 * 60_000 &&
    isSafeApplePurchaseUrl(event.purchaseUrl)
  );
}

function nativeEnvelope(
  request: NativeDesktopScheduleRequest,
): Record<string, unknown> {
  return {
    v: 1,
    kind: SAFARI_NATIVE_NOTIFICATION_KIND,
    event: {
      eventId: request.eventFingerprint,
      model: request.event.title,
      store: request.event.storeName,
      url: request.event.purchaseUrl,
      observedAt: request.event.observedAt,
      expiresAt: request.expiresAt,
    },
  };
}

function nativeDiagnosticEnvelope(): Record<string, unknown> {
  return { v: 1, kind: SAFARI_NATIVE_DIAGNOSTIC_KIND };
}

function parseNativeResponse(value: unknown): NativeDesktopScheduleResult {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["v", "ok", "code"]) ||
    value.v !== 1
  ) {
    return "invalid";
  }
  const code = value.code;
  if (
    typeof value.ok !== "boolean" ||
    typeof code !== "string" ||
    !(
      ["scheduled", "invalid", "duplicate", "unavailable", "denied"] as const
    ).includes(code as NativeCode) ||
    value.ok !== (code === "scheduled")
  ) {
    return "invalid";
  }
  switch (code) {
    case "scheduled":
      return "scheduled";
    case "duplicate":
      return "duplicate";
    case "denied":
      return "denied";
    case "unavailable":
      return "unavailable";
    case "invalid":
      return "invalid";
  }
  return "invalid";
}

function parseNativeClick(value: unknown): string | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["v", "marker", "eventId"]) ||
    value.v !== 1 ||
    value.marker !== SAFARI_NATIVE_CLICK_MARKER ||
    typeof value.eventId !== "string" ||
    !FINGERPRINT_PATTERN.test(value.eventId)
  ) {
    return null;
  }
  return value.eventId;
}

function sendBoundedNativeMessage(
  runtime: ExtensionRuntime,
  message: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const sendNativeMessage = runtime.sendNativeMessage;
  if (!sendNativeMessage || signal?.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(null);
    const timeout = setTimeout(() => finish(null), NATIVE_RESPONSE_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const result = sendNativeMessage(
        SAFARI_NATIVE_APPLICATION_ID,
        message,
        (response) => finish(runtime.lastError ? null : response),
      );
      if (
        result &&
        typeof (result as PromiseLike<unknown>).then === "function"
      ) {
        void (result as PromiseLike<unknown>).then(
          (response) => finish(runtime.lastError ? null : response),
          () => finish(null),
        );
      }
    } catch {
      finish(null);
    }
  });
}

export class SafariNativeDesktopAlertPort implements DesktopAlertNativePort {
  private clickListenerInstalled = false;

  public constructor(private readonly api: ExtensionApi) {}

  public async schedule(
    request: NativeDesktopScheduleRequest,
  ): Promise<NativeDesktopScheduleResult> {
    if (request.signal?.aborted) return "aborted";
    if (!validScheduleRequest(request)) return "invalid";
    const response = await sendBoundedNativeMessage(
      this.api.runtime,
      nativeEnvelope(request),
      request.signal,
    );
    return request.signal?.aborted ? "aborted" : parseNativeResponse(response);
  }

  public async scheduleDiagnostic(options?: {
    signal?: AbortSignal;
  }): Promise<NativeDesktopScheduleResult> {
    if (options?.signal?.aborted) return "aborted";
    const response = await sendBoundedNativeMessage(
      this.api.runtime,
      nativeDiagnosticEnvelope(),
      options?.signal,
    );
    return options?.signal?.aborted ? "aborted" : parseNativeResponse(response);
  }

  public installClickListener(
    listener: (eventFingerprint: string) => void,
  ): boolean {
    if (this.clickListenerInstalled || !this.api.runtime.connectNative)
      return false;
    try {
      const port = this.api.runtime.connectNative(SAFARI_NATIVE_APPLICATION_ID);
      port.onMessage.addListener((message) => {
        const eventFingerprint = parseNativeClick(message);
        if (eventFingerprint !== null) listener(eventFingerprint);
      });
      this.clickListenerInstalled = true;
      return true;
    } catch {
      return false;
    }
  }
}

export function createSafariNativeDesktopAlertPort(
  api: ExtensionApi,
): DesktopAlertNativePort {
  return new SafariNativeDesktopAlertPort(api);
}

export function nativeClickMessageForTest(
  eventFingerprint: string,
): Record<string, unknown> {
  return {
    v: 1,
    marker: SAFARI_NATIVE_CLICK_MARKER,
    eventId: eventFingerprint,
  };
}

export function nativeEnvelopeForTest(
  event: LocalAvailabilityEvent,
  eventFingerprint: string,
  expiresAt: string,
): Record<string, unknown> {
  return nativeEnvelope({ event, eventFingerprint, expiresAt });
}

export function nativeDiagnosticEnvelopeForTest(): Record<string, unknown> {
  return nativeDiagnosticEnvelope();
}

export const SAFARI_NATIVE_CLICK_MESSAGE_NAME = SAFARI_NATIVE_CLICK_KIND;
