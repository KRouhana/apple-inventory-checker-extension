/**
 * Browser transport for the narrow local Apple pickup contract.
 *
 * The engine owns retries and timeouts. This adapter only builds an exact
 * `www.apple.com` pickup URL and bounds response bytes before handing an
 * unlogged value to the strict core parser. It defaults to omitting browser
 * credentials; Chrome's runtime composition may explicitly use the browser's
 * managed Apple session without exposing any cookie values.
 */
import {
  APPLE_ORIGIN,
  buildApplePickupMessageUrl,
} from "../../../../packages/core/src/apple-url.js";
import {
  ApplePickupFetchRequestSchema,
  type AppleFetchPort,
  type ApplePickupFetchRequest,
  type ApplePickupFetchResponse,
} from "../../../../packages/core/src/local-monitor-contracts.js";

const MAX_PICKUP_BODY_BYTES = 512 * 1024;
const MAX_RETRY_AFTER_MS = 10 * 60 * 1_000;

export const PICKUP_DIAGNOSTIC_PHASES = [
  "request_invalid",
  "network_failure",
  "http_rejected",
  "url_mismatch",
  "content_length_rejected",
  "body_missing",
  "body_non_bytes",
  "body_too_large",
  "body_read_failed",
  "invalid_json",
  "json_parsed",
] as const;

export type PickupDiagnosticPhase = (typeof PICKUP_DIAGNOSTIC_PHASES)[number];

export const APPLE_PICKUP_CREDENTIALS = ["omit", "include"] as const;
export type ApplePickupCredentials = (typeof APPLE_PICKUP_CREDENTIALS)[number];

/** Volatile, bounded adapter outcome; it intentionally contains no payload. */
export interface PickupDiagnostic {
  readonly phase: PickupDiagnosticPhase;
  readonly byteCount: number;
  readonly httpStatus: number | null;
}

export interface PickupNetworkResponse {
  readonly status: number;
  readonly url: string;
  readonly redirected: boolean;
  readonly headers: { get(name: string): string | null };
  readonly body: ReadableStream<Uint8Array> | null;
}

export type PickupNetworkFetch = (
  input: string,
  init: RequestInit,
) => Promise<PickupNetworkResponse>;

export interface ApplePickupFetchOptions {
  readonly fetch?: PickupNetworkFetch;
  /** Closed transport policy; invalid runtime values fail closed to `omit`. */
  readonly credentials?: ApplePickupCredentials;
  readonly maxBodyBytes?: number;
  readonly nowMs?: () => number;
  /** Observational only; exceptions are ignored and never change fetch output. */
  readonly onDiagnostic?: (diagnostic: PickupDiagnostic) => void;
}

function emitDiagnostic(
  callback: ApplePickupFetchOptions["onDiagnostic"],
  phase: PickupDiagnosticPhase,
  byteCount: number,
  httpStatus: number | null,
): void {
  const diagnostic: PickupDiagnostic = Object.freeze({
    phase,
    byteCount: Math.max(
      0,
      Math.min(MAX_PICKUP_BODY_BYTES, Math.floor(byteCount)),
    ),
    httpStatus:
      typeof httpStatus === "number" &&
      Number.isInteger(httpStatus) &&
      httpStatus >= 100 &&
      httpStatus <= 599
        ? httpStatus
        : null,
  });
  try {
    callback?.(diagnostic);
  } catch {
    // Diagnostics must never alter the adapter's parser-neutral behavior.
  }
}

function storefrontPath(market: ApplePickupFetchRequest["market"]): string {
  return market === "us" ? "" : market;
}

function validByteLimit(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || value === undefined || value < 1) {
    return MAX_PICKUP_BODY_BYTES;
  }
  return Math.min(value, MAX_PICKUP_BODY_BYTES);
}

function pickupCredentials(value: unknown): ApplePickupCredentials {
  return value === "include" ? "include" : "omit";
}

function exactPickupUrl(value: string, expected: string): boolean {
  if (value !== expected) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "www.apple.com" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.hash === "" &&
      url.origin === APPLE_ORIGIN
    );
  } catch {
    return false;
  }
}

function normalizedStatus(value: unknown): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : 599;
}

function retryAfterMs(value: string | null, nowMs: number): number | undefined {
  if (!value || value.length > 128) return undefined;
  const seconds = /^\s*(\d{1,6})\s*$/.exec(value);
  if (seconds) {
    const parsed = Number(seconds[1]);
    if (!Number.isSafeInteger(parsed)) return undefined;
    return Math.min(parsed * 1_000, MAX_RETRY_AFTER_MS);
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date) || !Number.isFinite(nowMs)) return undefined;
  return Math.min(Math.max(0, date - nowMs), MAX_RETRY_AFTER_MS);
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  void reader.cancel("bounded pickup response").catch(() => undefined);
  try {
    reader.releaseLock();
  } catch {
    // A completed reader may already have released the lock.
  }
}

async function readBoundedJson(
  body: ReadableStream<Uint8Array> | null,
  maximum: number,
  signal?: AbortSignal,
  diagnostic?: ApplePickupFetchOptions["onDiagnostic"],
  httpStatus: number | null = null,
): Promise<unknown | null> {
  if (body === null) {
    emitDiagnostic(diagnostic, "body_missing", 0, httpStatus);
    return null;
  }
  if (signal?.aborted) {
    emitDiagnostic(diagnostic, "body_read_failed", 0, httpStatus);
    return null;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal?.aborted) {
        cancelReader(reader);
        emitDiagnostic(diagnostic, "body_read_failed", total, httpStatus);
        return null;
      }
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) {
        cancelReader(reader);
        emitDiagnostic(diagnostic, "body_non_bytes", total, httpStatus);
        return null;
      }
      total += result.value.byteLength;
      if (total > maximum) {
        cancelReader(reader);
        emitDiagnostic(diagnostic, "body_too_large", total, httpStatus);
        return null;
      }
      chunks.push(result.value);
    }
  } catch {
    emitDiagnostic(diagnostic, "body_read_failed", total, httpStatus);
    return null;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore a prior cancellation/release.
    }
  }
  if (signal?.aborted) {
    emitDiagnostic(diagnostic, "body_read_failed", total, httpStatus);
    return null;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    emitDiagnostic(diagnostic, "json_parsed", total, httpStatus);
    return parsed;
  } catch {
    emitDiagnostic(diagnostic, "invalid_json", total, httpStatus);
    return null;
  }
}

/**
 * Creates a credential-omitting fetch port by default. Chrome may explicitly
 * opt into browser-managed credentials; this port never reads, exports, or
 * constructs cookie values. It returns a parse-neutral body on every
 * transport ambiguity, allowing the core to classify it as `unknown` rather
 * than manufacture an unavailable observation.
 */
export function createApplePickupFetchPort(
  options: ApplePickupFetchOptions = {},
): AppleFetchPort {
  const networkFetch =
    options.fetch ?? (globalThis.fetch as PickupNetworkFetch);
  const maxBodyBytes = validByteLimit(options.maxBodyBytes);
  const credentials = pickupCredentials(options.credentials);
  return {
    async fetchPickup(
      request,
      requestOptions,
    ): Promise<ApplePickupFetchResponse> {
      const parsed = ApplePickupFetchRequestSchema.safeParse(request);
      if (!parsed.success || requestOptions?.signal?.aborted) {
        emitDiagnostic(options.onDiagnostic, "request_invalid", 0, null);
        return { httpStatus: 599, body: null };
      }
      let url: string;
      try {
        url = buildApplePickupMessageUrl({
          origin: APPLE_ORIGIN,
          marketPath: storefrontPath(parsed.data.market),
          location: parsed.data.location,
          partNumbers: parsed.data.skus,
        });
      } catch {
        emitDiagnostic(options.onDiagnostic, "request_invalid", 0, null);
        return { httpStatus: 599, body: null };
      }
      try {
        const response = await networkFetch(url, {
          method: "GET",
          credentials,
          cache: "no-store",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: requestOptions?.signal,
        });
        const httpStatus = normalizedStatus(response.status);
        const retry = retryAfterMs(
          response.headers.get("retry-after"),
          options.nowMs?.() ?? Date.now(),
        );
        if (response.redirected || !exactPickupUrl(response.url, url)) {
          emitDiagnostic(options.onDiagnostic, "url_mismatch", 0, httpStatus);
          return {
            httpStatus,
            body: null,
            ...(retry === undefined ? {} : { retryAfterMs: retry }),
          };
        }
        if (httpStatus < 200 || httpStatus >= 300) {
          emitDiagnostic(options.onDiagnostic, "http_rejected", 0, httpStatus);
          return {
            httpStatus,
            body: null,
            ...(retry === undefined ? {} : { retryAfterMs: retry }),
          };
        }
        const contentLength = response.headers.get("content-length");
        if (
          contentLength !== null &&
          (!/^\d{1,9}$/.test(contentLength) ||
            Number(contentLength) > maxBodyBytes)
        ) {
          emitDiagnostic(
            options.onDiagnostic,
            "content_length_rejected",
            0,
            httpStatus,
          );
          return {
            httpStatus,
            body: null,
            ...(retry === undefined ? {} : { retryAfterMs: retry }),
          };
        }
        const body = await readBoundedJson(
          response.body,
          maxBodyBytes,
          requestOptions?.signal,
          options.onDiagnostic,
          httpStatus,
        );
        return {
          httpStatus,
          body,
          ...(retry === undefined ? {} : { retryAfterMs: retry }),
        };
      } catch {
        emitDiagnostic(options.onDiagnostic, "network_failure", 0, null);
        return { httpStatus: 599, body: null };
      }
    },
  };
}
