/**
 * Safe, data-only catalog refresh client (L06 / issue #15).
 *
 * Remote refresh is disabled by default. When a future platform adapter enables
 * it, this client accepts exactly one project-controlled HTTPS origin, reads a
 * bounded byte stream, validates the canonical core schema, and keeps only a
 * validated last-known-good snapshot. It never receives watches or stock.
 */
import {
  compareCatalogFreshness,
  isAllowedCatalogUrl,
  MAX_CATALOG_BYTES,
  parsePortableCatalogSnapshot,
  type PortableCatalogSnapshot,
} from "./portableCatalog";

/** A response body remains streaming until this client enforces its byte cap. */
export interface CatalogFetchResponse {
  /** Final response URL after any redirect handling. */
  url: string;
  /** True when the transport followed a redirect to reach `url`. */
  redirected: boolean;
  httpStatus: number;
  /** Header hint only; streamed bytes remain the enforcement point. */
  contentLength?: number | null;
  body: ReadableStream<Uint8Array> | null;
}

export interface CatalogFetchPort {
  fetchCatalog(
    url: string,
    init: { redirect: "error"; signal: AbortSignal },
  ): Promise<CatalogFetchResponse>;
}

/** Last-known-good retention across refresh failures. Loaded values are untrusted. */
export interface CatalogStoragePort {
  loadLastGood(): Promise<unknown>;
  saveLastGood(snapshot: PortableCatalogSnapshot): Promise<void>;
}

export interface CatalogRefreshConfig {
  /** False means no network access; this is the default. */
  remoteUpdatesEnabled: boolean;
  /** Fixed project-controlled HTTPS origin; never catalog/user supplied. */
  trustedOrigin: string;
  /** Full catalog document URL under `trustedOrigin`. */
  catalogUrl: string;
  /** Optional stricter payload cap; it cannot exceed `MAX_CATALOG_BYTES`. */
  maxBytes?: number;
  /** Optional pinned SHA-256 hex of the expected document. */
  expectedSha256?: string;
  /** Fetch and body-read timeout in milliseconds. */
  timeoutMs?: number;
}

export const DEFAULT_CATALOG_REFRESH_CONFIG: Readonly<CatalogRefreshConfig> = {
  remoteUpdatesEnabled: false,
  trustedOrigin: "",
  catalogUrl: "",
};

export const DEFAULT_CATALOG_FETCH_TIMEOUT_MS = 20_000;
export const MIN_CATALOG_FETCH_TIMEOUT_MS = 1_000;
export const MAX_CATALOG_FETCH_TIMEOUT_MS = 30_000;
/** Reject catalog clocks more than five minutes ahead of the trusted runtime. */
export const MAX_CATALOG_FUTURE_SKEW_MS = 5 * 60 * 1_000;

export type CatalogRefreshResult =
  | { status: "disabled"; catalog: PortableCatalogSnapshot; reason: string }
  | { status: "current"; catalog: PortableCatalogSnapshot; sha256: string }
  | {
      status: "updated";
      catalog: PortableCatalogSnapshot;
      sha256: string;
      previousGeneratedAt: string;
    }
  | { status: "rejected"; catalog: PortableCatalogSnapshot; reason: string }
  | { status: "failed"; catalog: PortableCatalogSnapshot; reason: string }
  | { status: "unavailable"; catalog: null; reason: string };

export interface CatalogRefreshDeps {
  fetchPort: CatalogFetchPort;
  storagePort: CatalogStoragePort;
  sha256Hex: (utf8Text: string) => Promise<string> | string;
  /** Bundled candidate; validated before every use. */
  bundledFallback: unknown;
  /** Injectable trusted clock for deterministic future-skew tests. */
  nowMs?: () => number;
}

interface RefreshLimits {
  maxBytes: number;
  timeoutMs: number;
  expectedSha256: string | null;
}

class CatalogPayloadTooLargeError extends Error {}
class CatalogPayloadInvalidError extends Error {}
class CatalogTimeoutError extends Error {}

function isSafeIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function normalizeSha256(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function validateRefreshLimits(
  config: CatalogRefreshConfig,
): { success: true; data: RefreshLimits } | { success: false; reason: string } {
  const maxBytes = config.maxBytes ?? MAX_CATALOG_BYTES;
  if (!isSafeIntegerInRange(maxBytes, 1, MAX_CATALOG_BYTES)) {
    return {
      success: false,
      reason: `Catalog byte cap must be a finite integer from 1 to ${MAX_CATALOG_BYTES}`,
    };
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_CATALOG_FETCH_TIMEOUT_MS;
  if (
    !isSafeIntegerInRange(
      timeoutMs,
      MIN_CATALOG_FETCH_TIMEOUT_MS,
      MAX_CATALOG_FETCH_TIMEOUT_MS,
    )
  ) {
    return {
      success: false,
      reason: `Catalog timeout must be a finite integer from ${MIN_CATALOG_FETCH_TIMEOUT_MS} to ${MAX_CATALOG_FETCH_TIMEOUT_MS}`,
    };
  }
  if (
    config.expectedSha256 !== undefined &&
    normalizeSha256(config.expectedSha256) === null
  ) {
    return {
      success: false,
      reason: "Pinned catalog hash must be SHA-256 hex",
    };
  }
  return {
    success: true,
    data: {
      maxBytes,
      timeoutMs,
      expectedSha256:
        config.expectedSha256 === undefined
          ? null
          : normalizeSha256(config.expectedSha256),
    },
  };
}

function validatedSnapshot(
  value: unknown,
  nowMs: number,
): PortableCatalogSnapshot | null {
  const parsed = parsePortableCatalogSnapshot(value);
  if (!parsed.success) return null;
  const generatedAtMs = Date.parse(parsed.data.generatedAt);
  return generatedAtMs <= nowMs + MAX_CATALOG_FUTURE_SKEW_MS
    ? parsed.data
    : null;
}

function cancelAndReleaseReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: string,
): void {
  // Never await cancel: a hostile/broken stream may never settle. The refresh
  // operation must still return its validated baseline when its timeout fires.
  void reader
    .cancel(reason)
    .catch(() => undefined)
    .finally(() => {
      try {
        reader.releaseLock();
      } catch {
        // A completed reader may already have released its lock.
      }
    });
}

function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  cancel: () => void,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      finish();
      cancel();
      reject(new CatalogTimeoutError("Catalog fetch timed out"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    let pending: Promise<ReadableStreamReadResult<Uint8Array>>;
    try {
      pending = reader.read();
    } catch (error) {
      settled = true;
      finish();
      reject(error);
      return;
    }
    void pending.then(
      (result) => {
        if (settled) return;
        settled = true;
        finish();
        resolve(result);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        finish();
        reject(error);
      },
    );
  });
}

async function readBoundedUtf8(
  response: CatalogFetchResponse,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  if (
    response.contentLength !== undefined &&
    response.contentLength !== null &&
    !isSafeIntegerInRange(response.contentLength, 0, MAX_CATALOG_BYTES)
  ) {
    throw new CatalogPayloadInvalidError("Catalog Content-Length is invalid");
  }
  if ((response.contentLength ?? 0) > maxBytes) {
    throw new CatalogPayloadTooLargeError(
      "Catalog Content-Length exceeds byte cap",
    );
  }
  if (response.body === null) {
    throw new CatalogPayloadInvalidError("Catalog response has no body");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let cancellationStarted = false;
  const cancel = (): void => {
    if (cancellationStarted) return;
    cancellationStarted = true;
    cancelAndReleaseReader(reader, "Catalog stream cancelled");
  };
  try {
    while (true) {
      const { done, value } = await readWithAbort(reader, signal, cancel);
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new CatalogPayloadInvalidError(
          "Catalog stream yielded non-byte data",
        );
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        cancel();
        throw new CatalogPayloadTooLargeError(
          "Catalog payload exceeds byte cap",
        );
      }
      chunks.push(value);
    }
  } finally {
    if (!cancellationStarted) reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CatalogPayloadInvalidError("Catalog payload is not valid UTF-8");
  }
}

/**
 * Attempt a data-only catalog refresh. Every rejected/failed path retains the
 * validated active/stored/bundled baseline; when all candidates are corrupt it
 * explicitly returns `unavailable` so callers cannot poll with invented data.
 */
export async function refreshPortableCatalog(
  deps: CatalogRefreshDeps,
  config: CatalogRefreshConfig,
  active?: unknown,
): Promise<CatalogRefreshResult> {
  let nowMs: number;
  try {
    nowMs = deps.nowMs?.() ?? Date.now();
  } catch {
    nowMs = Number.NaN;
  }
  if (!Number.isFinite(nowMs)) {
    return {
      status: "unavailable",
      catalog: null,
      reason: "Trusted catalog clock is unavailable",
    };
  }
  const stored = await deps.storagePort.loadLastGood().catch(() => null);
  const baseline =
    validatedSnapshot(active, nowMs) ??
    validatedSnapshot(stored, nowMs) ??
    validatedSnapshot(deps.bundledFallback, nowMs);
  if (baseline === null) {
    return {
      status: "unavailable",
      catalog: null,
      reason: "No valid active, stored, or bundled catalog is available",
    };
  }

  if (!config.remoteUpdatesEnabled) {
    return {
      status: "disabled",
      catalog: baseline,
      reason:
        "Remote catalog updates are disabled until a project hosting origin exists; using validated active/stored/bundled catalog",
    };
  }
  if (!config.trustedOrigin || !config.catalogUrl) {
    return {
      status: "rejected",
      catalog: baseline,
      reason:
        "Catalog refresh has no configured trusted origin or document URL",
    };
  }
  if (!isAllowedCatalogUrl(config.catalogUrl, config.trustedOrigin)) {
    return {
      status: "rejected",
      catalog: baseline,
      reason: "Catalog URL is not under the fixed trusted HTTPS origin",
    };
  }
  const limits = validateRefreshLimits(config);
  if (!limits.success) {
    return { status: "rejected", catalog: baseline, reason: limits.reason };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), limits.data.timeoutMs);
  let response: CatalogFetchResponse;
  let rawText: string;
  try {
    response = await deps.fetchPort.fetchCatalog(config.catalogUrl, {
      redirect: "error",
      signal: controller.signal,
    });
    if (
      response.redirected ||
      !isAllowedCatalogUrl(response.url, config.trustedOrigin)
    ) {
      return {
        status: "rejected",
        catalog: baseline,
        reason: "Catalog response redirected or left the trusted origin",
      };
    }
    if (response.httpStatus !== 200) {
      return {
        status: "failed",
        catalog: baseline,
        reason: `Catalog fetch returned HTTP ${response.httpStatus}`,
      };
    }
    rawText = await readBoundedUtf8(
      response,
      limits.data.maxBytes,
      controller.signal,
    );
  } catch (error) {
    if (error instanceof CatalogPayloadTooLargeError) {
      return { status: "rejected", catalog: baseline, reason: error.message };
    }
    if (error instanceof CatalogPayloadInvalidError) {
      return { status: "rejected", catalog: baseline, reason: error.message };
    }
    return {
      status: "failed",
      catalog: baseline,
      reason: `Catalog fetch failed: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  } finally {
    clearTimeout(timeout);
  }

  let sha256: string;
  try {
    sha256 = normalizeSha256(await deps.sha256Hex(rawText)) ?? "";
  } catch (error) {
    return {
      status: "failed",
      catalog: baseline,
      reason: `Catalog hash failed: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }
  if (!sha256) {
    return {
      status: "failed",
      catalog: baseline,
      reason: "Catalog hash function did not return SHA-256 hex",
    };
  }
  if (limits.data.expectedSha256 && sha256 !== limits.data.expectedSha256) {
    return {
      status: "rejected",
      catalog: baseline,
      reason: "Catalog hash does not match the pinned SHA-256",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      status: "rejected",
      catalog: baseline,
      reason: "Catalog payload is not valid JSON",
    };
  }
  const validated = parsePortableCatalogSnapshot(parsed);
  if (!validated.success) {
    const first = validated.issues[0];
    return {
      status: "rejected",
      catalog: baseline,
      reason: `Catalog failed schema validation: ${first?.path ?? ""} ${first?.message ?? "invalid"}`,
    };
  }
  if (
    Date.parse(validated.data.generatedAt) >
    nowMs + MAX_CATALOG_FUTURE_SKEW_MS
  ) {
    return {
      status: "rejected",
      catalog: baseline,
      reason: "Catalog generatedAt exceeds the trusted future-clock skew",
    };
  }
  const freshness = compareCatalogFreshness(baseline, {
    schemaVersion: validated.data.schemaVersion,
    generatedAt: validated.data.generatedAt,
  });
  if (freshness.kind === "unsupported_version") {
    return { status: "rejected", catalog: baseline, reason: freshness.reason };
  }
  if (freshness.kind === "rollback_rejected") {
    return { status: "rejected", catalog: baseline, reason: freshness.reason };
  }
  if (freshness.kind === "current") {
    return { status: "current", catalog: baseline, sha256 };
  }
  try {
    await deps.storagePort.saveLastGood(validated.data);
  } catch (error) {
    return {
      status: "failed",
      catalog: baseline,
      reason: `Catalog validated but last-known-good could not be stored: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }
  return {
    status: "updated",
    catalog: validated.data,
    sha256,
    previousGeneratedAt: baseline.generatedAt,
  };
}
